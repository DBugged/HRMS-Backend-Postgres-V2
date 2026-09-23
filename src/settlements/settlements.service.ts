// Purpose: Computes and processes full & final settlements for departing employees (pending salary, leave
// encashment, gratuity, bonus, minus recoveries/loan balance/notice-period recovery).
// Responsibilities: Owns settlement-figure calculation (calculate(), idempotent DRAFT preview) and
// process() (locks the settlement in, creates a linked isFinalSettlement PayrollRun so the same universal
// payslip renderer works, closes active loans, pays out APPROVED reimbursements) inside one transaction;
// delegates the pending-salary component to PayrollService.calculatePayroll.
// Important: process() does NOT deactivate the employee — that (with the exit gates, manager reassignment and
// final employmentStatus) belongs to OffboardingService.complete(). Pending salary is 0 when a non-final
// PayrollRun for the last-working-day month already exists (it was paid there, so paying it again would
// double-pay). Gratuity requires >= 5 years of service (YEARS_FOR_GRATUITY_ELIGIBILITY, Payment of Gratuity
// Act 1972, ported verbatim); leave-encashment sums every encashment-allowed LeaveType's closing balance
// with no minBalanceToRetain cap since there's no future balance to protect. The settlement notification
// email goes to the employee's personalEmail, not their login email, since by process() time the account is
// already deactivated.
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoanStatus,
  NotificationCategory,
  Prisma,
  PayrollRunStatus,
  ReimbursementPaymentMode,
  ReimbursementStatus,
  Role,
  SettlementStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollService } from '../payroll/payroll.service';
import { ListSettlementsQueryDto } from './dto/list-settlements-query.dto';
import { paginate, skip } from '../common/pagination';
import { deptScopedEmployeeIds } from '../common/dept-scope';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { EmployeeSalaryComponentsService } from '../employee-salary-components/employee-salary-components.service';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { amountInWords } from '../payroll/number-to-words';
import { CalculateSettlementDto } from './dto/calculate-settlement.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { dailyRateFromMonthly } from '../payroll/payroll-date-math';
import {
  calculateGratuity,
  gratuityPayoutStatus,
  isFixedTermEmployeeType,
} from './gratuity-math';

type Actor = Omit<User, 'password'>;

interface EncashmentRule {
  allowed?: boolean;
}

interface SettlementPayrollLine {
  code: string;
  name: string;
  amount: number;
  taxable?: boolean;
}

@Injectable()
export class SettlementsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollService: PayrollService,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  // Adds the Code on Social Security's 30-day gratuity deadline (from the last working day) to a settlement, and
  // whether it is / was paid late — informational, computed on read (paid date is when the row last changed to PAID).
  private withGratuityPayout<
    T extends {
      gratuityAmount: number;
      lastWorkingDay: string;
      status: SettlementStatus;
      updatedAt: Date;
    },
  >(settlement: T) {
    return {
      ...settlement,
      gratuityPayout:
        settlement.gratuityAmount > 0
          ? gratuityPayoutStatus(
              settlement.lastWorkingDay,
              settlement.status === SettlementStatus.PAID
                ? settlement.updatedAt
                : null,
            )
          : null,
    };
  }

  async findAll(
    query: ListSettlementsQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.SettlementWhereInput = { organizationId };
    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }

    return paginate(
      async () =>
        (
          await this.scopedPrisma.settlement.findMany({
            where,
            include: {
              employee: { select: { id: true, name: true, employeeId: true } },
            },
            orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { createdAt: 'desc' }],
            skip: skip(query.page, query.limit),
            take: query.limit,
          })
        ).map((row) => this.withGratuityPayout(row)),
      () => this.scopedPrisma.settlement.count({ where }),
      query.page,
      query.limit,
    );
  }

  // Computes the full settlement breakdown and stores/updates it as a
  // DRAFT — separate from process() so HR can preview numbers before
  // committing to a run. Re-calling this while a DRAFT already exists for
  // the employee updates that row in place (idempotent preview), matching
  // the old system.
  async calculate(
    dto: CalculateSettlementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const lwd = new Date(dto.lastWorkingDay);
    if (Number.isNaN(lwd.getTime())) {
      throw new BadRequestException('lastWorkingDay is not a valid date.');
    }
    const month = lwd.getMonth() + 1;
    const year = lwd.getFullYear();

    const calc = await this.payrollService.calculatePayroll(
      dto.employeeId,
      month,
      year,
      organizationId,
    );
    // calculatePayroll() (a plain preview — it never calls
    // LoansService.recordRepayment, that only happens when a normal
    // payroll run is actually locked) includes a LOAN_EMI deduction line
    // for this month if the employee has a due EMI, since that's what a
    // regular month's payslip would show. A settlement recovers the
    // loan's full outstandingBalance separately below (loanBalanceRecovered),
    // so if this month's EMI deduction were left inside pendingSalaryAmount
    // too, the employee would be charged for it twice — once via reduced
    // pending salary, once via the full balance recovery. Add it back.
    const loanEmiDeduction = calc.deductions
      .filter((d) => d.code === 'LOAN_EMI')
      .reduce((sum, d) => sum + d.amount, 0);
    // A regular (non-final) payroll run already booked for the LWD month has paid that salary — paying it
    // again through the settlement would double-pay. A bare DRAFT row has no figures, so it doesn't count.
    const monthAlreadyPaid = await this.hasNonFinalPayrollRun(
      dto.employeeId,
      month,
      year,
      organizationId,
    );
    const pendingSalaryAmount = monthAlreadyPaid
      ? 0
      : calc.netPay + loanEmiDeduction;

    const activeLoans = await this.scopedPrisma.loan.findMany({
      where: {
        employeeId: dto.employeeId,
        organizationId,
        status: LoanStatus.ACTIVE,
      },
    });
    const loanBalanceRecovered = activeLoans.reduce(
      (sum, loan) => sum + loan.outstandingBalance,
      0,
    );

    const basicMonthly =
      await this.employeeSalaryComponentsService.getCurrentMonthlyValue(
        dto.employeeId,
        SALARY_COMPONENT_CODES.BASIC,
        dto.lastWorkingDay,
        organizationId,
      );
    const ratePerDay = dailyRateFromMonthly(basicMonthly);

    // Sums the closing balance (in days) across every LeaveType that
    // allows encashment — no minBalanceToRetain cap, since the employee is
    // leaving and there's no future balance to protect. See the schema
    // comment on Settlement.leaveEncashmentAmount for why this differs
    // from the old system's dead employee.leaveBalance.el field.
    const encashableTypes = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId },
    });
    let leaveDaysEncashed = 0;
    await this.scopedPrisma.$transaction(async (tx) => {
      for (const leaveType of encashableTypes) {
        const rule = (leaveType.encashment ?? {}) as EncashmentRule;
        if (!rule.allowed) continue;
        const balanceRow = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          dto.employeeId,
          leaveType.id,
          year,
          organizationId,
        );
        leaveDaysEncashed += balanceRow.closing;
      }
    });
    const leaveEncashmentAmount = Math.round(leaveDaysEncashed * ratePerDay);

    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    let gratuityAmount = 0;
    if (settings.gratuityEnabled) {
      const yearsOfService =
        (lwd.getTime() - employee.joiningDate.getTime()) /
        (1000 * 60 * 60 * 24 * 365.25);
      // Completed years (part-year over six months rounds up) and the
      // 20-lakh statutory ceiling — see gratuity-math.ts.
      gratuityAmount = calculateGratuity(basicMonthly, yearsOfService, {
        fixedTerm: isFixedTermEmployeeType(employee.employeeType),
      });
    }

    const reimbursementAmount = await this.sumApprovedReimbursements(
      this.scopedPrisma,
      dto.employeeId,
      organizationId,
    );
    const bonusAmount = dto.bonusAmount ?? 0;
    const recoveriesAmount = dto.recoveriesAmount ?? 0;
    const noticePeriodRecovery = dto.noticePeriodRecovery ?? 0;

    const netSettlementAmount = Math.round(
      pendingSalaryAmount +
        leaveEncashmentAmount +
        bonusAmount +
        gratuityAmount +
        reimbursementAmount -
        recoveriesAmount -
        loanBalanceRecovered -
        noticePeriodRecovery,
    );

    const data = {
      lastWorkingDay: dto.lastWorkingDay,
      pendingSalaryAmount,
      leaveEncashmentAmount,
      bonusAmount,
      recoveriesAmount,
      loanBalanceRecovered,
      noticePeriodRecovery,
      gratuityAmount,
      reimbursementAmount,
      netSettlementAmount,
      processedById: actor.id,
    };
    const pendingSalaryNote = monthAlreadyPaid
      ? `Pending salary is 0 — the ${month}/${year} salary was already covered by a regular payroll run.`
      : null;

    const existing = await this.scopedPrisma.settlement.findFirst({
      where: {
        employeeId: dto.employeeId,
        organizationId,
        status: SettlementStatus.DRAFT,
      },
    });
    if (existing) {
      await this.scopedPrisma.settlement.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      return {
        ...this.withGratuityPayout(
          await this.scopedPrisma.settlement.findFirstOrThrow({
            where: { id: existing.id, organizationId },
          }),
        ),
        pendingSalaryNote,
      };
    }
    const created = await this.scopedPrisma.settlement.create({
      data: { organizationId, employeeId: dto.employeeId, ...data },
    });
    // FNF_INITIATED — only on the first calculate() for this employee (the
    // `existing` branch above is a re-preview of the same in-flight draft,
    // not a new initiation), so re-calculating doesn't spam the timeline.
    await this.timelineService.logEvent({
      organizationId,
      employeeId: dto.employeeId,
      eventKey: 'FNF_INITIATED',
      performedById: actor.id,
    });
    return { ...this.withGratuityPayout(created), pendingSalaryNote };
  }

  private async hasNonFinalPayrollRun(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
  ): Promise<boolean> {
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        employeeId,
        month,
        year,
        isFinalSettlement: false,
        status: { not: PayrollRunStatus.DRAFT },
      },
      select: { id: true },
    });
    return !!run;
  }

  private async sumApprovedReimbursements(
    db: Pick<ExtendedPrismaClient, 'reimbursement'>,
    employeeId: string,
    organizationId: string,
  ): Promise<number> {
    const agg = await db.reimbursement.aggregate({
      where: {
        organizationId,
        employeeId,
        status: ReimbursementStatus.APPROVED,
      },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  // Locks in the settlement: creates the linked PayrollRun (isFinalSettlement)
  // with a full earnings/deductions snapshot so the same universal payslip
  // renderer/PDF can be used, closes out any active loans (they've just been
  // fully recovered via the deduction line above), and deactivates the
  // employee.
  async process(id: string, actor: Actor, organizationId: string) {
    const settlement = await this.scopedPrisma.settlement.findFirst({
      where: { id, organizationId },
    });
    if (!settlement) throw new NotFoundException('Settlement not found.');
    if (settlement.status !== SettlementStatus.DRAFT) {
      throw new BadRequestException(
        'Only a draft settlement can be processed.',
      );
    }

    const lwd = new Date(settlement.lastWorkingDay);
    const month = lwd.getMonth() + 1;
    const year = lwd.getFullYear();

    const salaryAlreadyPaid =
      settlement.pendingSalaryAmount === 0 &&
      (await this.hasNonFinalPayrollRun(
        settlement.employeeId,
        month,
        year,
        organizationId,
      ));
    const earnings: SettlementPayrollLine[] = [
      {
        code: 'PENDING_SALARY',
        name: salaryAlreadyPaid
          ? `Pending Salary (already paid in ${month}/${year} payroll)`
          : 'Pending Salary',
        amount: settlement.pendingSalaryAmount,
        taxable: true,
      },
      {
        code: 'LEAVE_ENCASHMENT',
        name: 'Leave Encashment',
        amount: settlement.leaveEncashmentAmount,
        taxable: true,
      },
    ];
    if (settlement.bonusAmount > 0) {
      earnings.push({
        code: 'BONUS',
        name: 'Bonus',
        amount: settlement.bonusAmount,
        taxable: true,
      });
    }
    if (settlement.reimbursementAmount > 0) {
      earnings.push({
        code: 'REIMBURSEMENT',
        name: 'Approved Reimbursements',
        amount: settlement.reimbursementAmount,
        taxable: false,
      });
    }
    if (settlement.gratuityAmount > 0) {
      earnings.push({
        code: 'GRATUITY',
        name: 'Gratuity',
        amount: settlement.gratuityAmount,
        taxable: false,
      });
    }

    const deductions: SettlementPayrollLine[] = [];
    if (settlement.recoveriesAmount > 0) {
      deductions.push({
        code: 'RECOVERIES',
        name: 'Recoveries',
        amount: settlement.recoveriesAmount,
      });
    }
    if (settlement.loanBalanceRecovered > 0) {
      deductions.push({
        code: 'LOAN_RECOVERY',
        name: 'Loan Balance Recovery',
        amount: settlement.loanBalanceRecovered,
      });
    }
    if (settlement.noticePeriodRecovery > 0) {
      deductions.push({
        code: 'NOTICE_PERIOD_RECOVERY',
        name: 'Notice Period Recovery',
        amount: settlement.noticePeriodRecovery,
      });
    }

    const grossSalary = earnings.reduce((sum, e) => sum + e.amount, 0);
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
    const now = new Date();

    const result = await this.scopedPrisma.$transaction(async (tx) => {
      // Guarded status flip runs FIRST, re-asserting DRAFT in the `where`
      // (not just the separate check above, which ran outside any lock)
      // — only the caller that wins this compare-and-swap goes on to
      // create the PayrollRun below. Without this ordering, two
      // concurrent process() calls (double-click "Process", or a retried
      // request) could both pass the pre-transaction DRAFT check and both
      // create their own PayrollRun — a duplicate isFinalSettlement
      // payslip, i.e. the employee's settlement paid out twice.
      const { count } = await tx.settlement.updateMany({
        where: { id, organizationId, status: SettlementStatus.DRAFT },
        data: { status: SettlementStatus.PROCESSED, processedById: actor.id },
      });
      if (count === 0) {
        throw new ConflictException('This settlement was already processed.');
      }

      const run = await tx.payrollRun.create({
        data: {
          organizationId,
          employeeId: settlement.employeeId,
          month,
          year,
          isFinalSettlement: true,
          // Settlements go straight to APPROVED so they can be paid
          // promptly, same as the old system.
          status: PayrollRunStatus.APPROVED,
          earnings: earnings as unknown as Prisma.InputJsonValue,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          employerContributions: [],
          grossSalary,
          totalDeductions,
          netPay: settlement.netSettlementAmount,
          netPayInWords: amountInWords(settlement.netSettlementAmount),
          calculatedById: actor.id,
          calculatedAt: now,
          verifiedById: actor.id,
          verifiedAt: now,
          approvedById: actor.id,
          approvedAt: now,
        },
      });

      await tx.settlement.updateMany({
        where: { id, organizationId },
        data: { payrollRunId: run.id },
      });
      // Approved reimbursements are paid out with this settlement. If the set changed since calculate(),
      // the figure baked into the payslip would be wrong — force a recalculation instead.
      const reimbursementNow = await this.sumApprovedReimbursements(
        tx,
        settlement.employeeId,
        organizationId,
      );
      if (reimbursementNow !== settlement.reimbursementAmount) {
        throw new ConflictException(
          'Approved reimbursements changed since this settlement was calculated — recalculate it first.',
        );
      }
      if (reimbursementNow > 0) {
        await tx.reimbursement.updateMany({
          where: {
            organizationId,
            employeeId: settlement.employeeId,
            status: ReimbursementStatus.APPROVED,
          },
          data: {
            status: ReimbursementStatus.PAID,
            paidDate: now.toISOString().slice(0, 10),
            paidById: actor.id,
            paymentMode: ReimbursementPaymentMode.TRANSFER,
            payrollRunId: run.id,
          },
        });
      }
      await tx.loan.updateMany({
        where: {
          employeeId: settlement.employeeId,
          organizationId,
          status: LoanStatus.ACTIVE,
        },
        data: { status: LoanStatus.CLOSED, outstandingBalance: 0 },
      });

      return {
        settlement: await tx.settlement.findFirstOrThrow({
          where: { id, organizationId },
        }),
        payrollRun: run,
      };
    });

    // Sent to the personal email on file, not the login email — by this
    // point the employee is deactivated and the login inbox (if it was
    // even a personal mailbox to begin with) may no longer be checked.
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: settlement.employeeId, organizationId },
    });
    if (employee) {
      const personalData = (employee.personalData ?? {}) as Record<
        string,
        unknown
      >;
      const personalEmail =
        typeof personalData.personalEmail === 'string' &&
        personalData.personalEmail
          ? personalData.personalEmail
          : employee.email;
      const title = 'Full & Final Settlement Processed';
      const message = `Your full & final settlement has been processed. Net settlement amount: ${settlement.netSettlementAmount} (${amountInWords(settlement.netSettlementAmount)}). Your payslip for this settlement will follow separately.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.PAYROLL,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'SETTLEMENT_PROCESSED',
        {
          employeeName: employee.name,
          netSettlementAmount: String(settlement.netSettlementAmount),
          netSettlementAmountInWords: amountInWords(
            settlement.netSettlementAmount,
          ),
        },
        { subject: title, html: message },
      );
      // Fire-and-forget — the settlement has already been processed.
      void this.emailService.send({
        organizationId,
        to: personalEmail,
        subject: rendered.subject,
        html: rendered.html,
      });
    }
    await this.timelineService.logEvent({
      organizationId,
      employeeId: settlement.employeeId,
      eventKey: 'FNF_COMPLETED',
      performedById: actor.id,
    });

    return result;
  }

  async markPaid(id: string, actor: Actor, organizationId: string) {
    const settlement = await this.scopedPrisma.settlement.findFirst({
      where: { id, organizationId },
    });
    if (!settlement || settlement.status !== SettlementStatus.PROCESSED) {
      throw new BadRequestException(
        'Settlement must be processed before it can be marked paid.',
      );
    }

    return this.scopedPrisma.$transaction(async (tx) => {
      // Re-asserts PROCESSED in the `where` — a second concurrent
      // markPaid() call (double-click) would otherwise still pass the
      // pre-transaction check and silently overwrite paidAt/paidById a
      // second time.
      const { count } = await tx.settlement.updateMany({
        where: { id, organizationId, status: SettlementStatus.PROCESSED },
        data: { status: SettlementStatus.PAID },
      });
      if (count === 0) {
        throw new ConflictException('This settlement was already paid.');
      }
      if (settlement.payrollRunId) {
        await tx.payrollRun.updateMany({
          where: { id: settlement.payrollRunId, organizationId },
          data: {
            status: PayrollRunStatus.PAID,
            paidById: actor.id,
            paidAt: new Date(),
          },
        });
      }
      return this.withGratuityPayout(
        await tx.settlement.findFirstOrThrow({ where: { id, organizationId } }),
      );
    });
  }
}
