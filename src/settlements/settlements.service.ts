// Purpose: Computes and processes full & final settlements for departing employees (pending salary, leave
// encashment, gratuity, bonus, minus recoveries/loan balance/notice-period recovery).
// Responsibilities: Owns settlement-figure calculation (calculate(), idempotent DRAFT preview) and
// process() (locks the settlement in, creates a linked isFinalSettlement PayrollRun so the same universal
// payslip renderer works, closes active loans, pays out APPROVED reimbursements) inside one transaction;
// delegates the pending-salary component to PayrollService.calculatePayroll.
// Important: process() does NOT deactivate the employee — that (with the exit gates, manager reassignment and
// final employmentStatus) belongs to OffboardingService.complete(). Pending salary is 0 when a LOCKED/PAID
// regular PayrollRun for the last-working-day month already exists (it was paid there, so paying it again would
// double-pay); while that month's regular run is still open (calculated but not locked) the settlement can't be
// calculated or processed at all — whether it pays the salary (and recovers that month's EMI) isn't settled yet.
// The loan balance recovered is re-checked inside process(). Gratuity is gated by the GRATUITY statutory
// version in force on the last working day (falling back to the legacy payroll-settings flag), like monthly
// payroll. Gratuity requires >= 5 years of service (YEARS_FOR_GRATUITY_ELIGIBILITY, Payment of Gratuity
// Act 1972, ported verbatim); leave-encashment sums every encashment-allowed LeaveType's closing balance
// with no minBalanceToRetain cap since there's no future balance to protect. The settlement notification
// email goes to the employee's personalEmail, not their login email, since by process() time the account is
// already deactivated.
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  ConflictException,
  HttpException,
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
  StatutoryModule,
  User,
} from '@prisma/client';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
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

// Settlement.pendingSalaryBreakdown — the LWD-month payroll lines behind pendingSalaryAmount.
interface PendingSalaryBreakdown {
  earnings: SettlementPayrollLine[];
  deductions: SettlementPayrollLine[];
  employerContributions: (SettlementPayrollLine & {
    breakup?: { eps: number; epf: number };
  })[];
}

// A regular run in one of these states has not paid anything yet and can still change.
const OPEN_REGULAR_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.CALCULATED,
  PayrollRunStatus.VERIFIED,
  PayrollRunStatus.APPROVED,
];
// ...and in these it has — the LWD month's salary is covered by it.
const SETTLED_REGULAR_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

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
    private readonly statutoryConfigService: StatutoryConfigService,
    private readonly auditLogService: AuditLogService,
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

    await this.assertNoOpenRegularRun(
      dto.employeeId,
      month,
      year,
      organizationId,
    );

    let calc: Awaited<ReturnType<PayrollService['calculatePayroll']>>;
    try {
      calc = await this.payrollService.calculatePayroll(
        dto.employeeId,
        month,
        year,
        organizationId,
      );
    } catch (err) {
      // A payroll misconfiguration (missing tax slabs, a broken formula) is
      // the caller's to fix, not a server error.
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(
        `Could not calculate the ${month}/${year} pending salary: ${(err as Error).message}`,
      );
    }
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
    // A LOCKED/PAID regular (non-final) payroll run for the LWD month has paid that salary — paying it again
    // through the settlement would double-pay. Only a locked/paid run counts: a CALCULATED one used to count
    // too, so the settlement dropped the salary AND (since the loan is recovered in full below) the regular run,
    // once locked, deducted that month's EMI a second time. Open runs are refused above instead.
    const monthAlreadyPaid = await this.hasSettledRegularRun(
      dto.employeeId,
      month,
      year,
      organizationId,
    );
    const pendingSalaryAmount = monthAlreadyPaid
      ? 0
      : calc.netPay + loanEmiDeduction;
    // The real lines behind that figure, carried onto the final-settlement payroll run by process() so its
    // payslip (and statutory reports) show the actual earnings, PF/ESI/PT/TDS and employer contributions. The
    // EMI line is left out for the same reason it is added back above.
    const pendingSalaryBreakdown: PendingSalaryBreakdown | null =
      monthAlreadyPaid
        ? null
        : {
            earnings: calc.earnings.map((e) => ({
              code: e.code,
              name: e.name,
              amount: e.amount,
              ...(e.taxable !== undefined ? { taxable: e.taxable } : {}),
            })),
            deductions: calc.deductions
              .filter((d) => d.code !== 'LOAN_EMI')
              .map((d) => ({ code: d.code, name: d.name, amount: d.amount })),
            employerContributions: calc.employerContributions.map((e) => ({
              code: e.code,
              name: e.name,
              amount: e.amount,
              ...(e.breakup ? { breakup: e.breakup } : {}),
            })),
          };

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

    // Same source of truth as monthly payroll (applyStatutoryOverrides): the GRATUITY statutory version in
    // force on the last working day decides, and only an org with no version for that date falls back to the
    // legacy payroll-settings flag. Reading only the legacy flag made gratuity 0 for every org that switched it
    // on under Statutory Compliance.
    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const { version: gratuityVersion } =
      await this.statutoryConfigService.getEffective(
        StatutoryModule.GRATUITY,
        dto.lastWorkingDay.slice(0, 10),
        organizationId,
      );
    const gratuityEnabled = gratuityVersion
      ? gratuityVersion.isEnabled
      : settings.gratuityEnabled;
    let gratuityAmount = 0;
    if (gratuityEnabled) {
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
      pendingSalaryBreakdown: pendingSalaryBreakdown
        ? (pendingSalaryBreakdown as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
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
      await this.logSettlementCalculated(
        actor.id,
        organizationId,
        existing.id,
        data,
        dto.employeeId,
      );
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
    await this.logSettlementCalculated(
      actor.id,
      organizationId,
      created.id,
      data,
      dto.employeeId,
    );
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

  // Whether a LOCKED/PAID regular payroll run already paid the LWD month.
  private async hasSettledRegularRun(
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
        status: { in: SETTLED_REGULAR_RUN_STATUSES },
      },
      select: { id: true },
    });
    return !!run;
  }

  // A regular run for the LWD month that is calculated but not yet locked
  // hasn't paid anything, but may still be locked and paid — so neither
  // "the settlement pays this month's salary" nor "the regular run does" is
  // safe to assume. (Treating it as paid dropped the salary from the
  // settlement while the run, once locked, charged that month's EMI on top of
  // the settlement's full loan recovery.) A bare DRAFT row carries no figures
  // and is not counted, as before.
  private async assertNoOpenRegularRun(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
  ): Promise<void> {
    const open = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        employeeId,
        month,
        year,
        isFinalSettlement: false,
        status: { in: OPEN_REGULAR_RUN_STATUSES },
      },
      select: { status: true },
    });
    if (open) {
      throw new BadRequestException(
        `The regular ${month}/${year} payroll run for this employee is ${open.status.toLowerCase()} but not locked — lock that run first (it then pays the ${month}/${year} salary), then calculate the settlement.`,
      );
    }
  }

  private async logSettlementCalculated(
    actorId: string,
    organizationId: string,
    settlementId: string,
    data: {
      lastWorkingDay: string;
      pendingSalaryAmount: number;
      gratuityAmount: number;
      loanBalanceRecovered: number;
      netSettlementAmount: number;
    },
    employeeId: string,
  ) {
    await this.auditLogService.log({
      actorId,
      action: 'SETTLEMENT_CALCULATED',
      module: 'PAYROLL',
      organizationId,
      targetId: settlementId,
      details: {
        employeeId,
        lastWorkingDay: data.lastWorkingDay,
        pendingSalaryAmount: data.pendingSalaryAmount,
        gratuityAmount: data.gratuityAmount,
        loanBalanceRecovered: data.loanBalanceRecovered,
        netSettlementAmount: data.netSettlementAmount,
      },
    });
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

    // The LWD month's regular run may have moved since calculate(): still
    // open -> can't tell who pays the salary yet; now locked/paid while this
    // draft still pays the salary -> it would be paid twice.
    await this.assertNoOpenRegularRun(
      settlement.employeeId,
      month,
      year,
      organizationId,
    );
    const regularRunSettled = await this.hasSettledRegularRun(
      settlement.employeeId,
      month,
      year,
      organizationId,
    );
    if (regularRunSettled && settlement.pendingSalaryAmount > 0) {
      throw new ConflictException(
        `The regular ${month}/${year} payroll run was locked after this settlement was calculated, so it already pays that salary — recalculate the settlement first.`,
      );
    }
    const salaryAlreadyPaid =
      settlement.pendingSalaryAmount === 0 && regularRunSettled;
    const breakdown =
      settlement.pendingSalaryAmount > 0
        ? (settlement.pendingSalaryBreakdown as unknown as PendingSalaryBreakdown | null)
        : null;
    // The pending salary goes onto the final payslip as the LWD month's real
    // lines (Basic, HRA, ..., PF/ESI/PT/TDS and the employer contributions)
    // when calculate() recorded them; a draft calculated before that fall back
    // to the single net PENDING_SALARY line it always had. Either way the
    // pending-salary portion nets to settlement.pendingSalaryAmount.
    const earnings: SettlementPayrollLine[] = [
      ...(breakdown
        ? breakdown.earnings
        : [
            {
              code: 'PENDING_SALARY',
              name: salaryAlreadyPaid
                ? `Pending Salary (already paid in ${month}/${year} payroll)`
                : 'Pending Salary',
              amount: settlement.pendingSalaryAmount,
              taxable: true,
            },
          ]),
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

    const deductions: SettlementPayrollLine[] = [
      ...(breakdown?.deductions ?? []),
    ];
    const employerContributions = breakdown?.employerContributions ?? [];
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
    const taxableGross = earnings
      .filter((e) => e.taxable !== false)
      .reduce((sum, e) => sum + e.amount, 0);
    const totalDeductions = deductions.reduce((sum, d) => sum + d.amount, 0);
    const totalEmployerContributions = employerContributions.reduce(
      (sum, e) => sum + e.amount,
      0,
    );
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

      // The loan balance recovered was captured at calculate() time; a
      // regular run locked since then (charging an EMI) or a manual repayment
      // lowers it, and recovering the stale figure would take that EMI twice.
      // Re-read it here, inside the transaction that closes the loans.
      const activeLoans = await tx.loan.findMany({
        where: {
          employeeId: settlement.employeeId,
          organizationId,
          status: LoanStatus.ACTIVE,
        },
        select: { outstandingBalance: true },
      });
      const loanBalanceNow = activeLoans.reduce(
        (sum, loan) => sum + loan.outstandingBalance,
        0,
      );
      if (Math.abs(loanBalanceNow - settlement.loanBalanceRecovered) > 0.005) {
        throw new ConflictException(
          `Outstanding loan balance changed since this settlement was calculated (${settlement.loanBalanceRecovered} then, ${loanBalanceNow} now) — recalculate it first.`,
        );
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
          employerContributions:
            employerContributions as unknown as Prisma.InputJsonValue,
          grossSalary,
          taxableGross,
          totalDeductions,
          totalEmployerContributions,
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

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'SETTLEMENT_PROCESSED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        employeeId: settlement.employeeId,
        payrollRunId: result.payrollRun.id,
        netSettlementAmount: settlement.netSettlementAmount,
        loanBalanceRecovered: settlement.loanBalanceRecovered,
      },
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

    const paid = await this.scopedPrisma.$transaction(async (tx) => {
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
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'SETTLEMENT_PAID',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        employeeId: settlement.employeeId,
        payrollRunId: settlement.payrollRunId,
        netSettlementAmount: settlement.netSettlementAmount,
      },
    });
    return paid;
  }
}
