import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoanStatus,
  Prisma,
  PayrollRunStatus,
  Role,
  SettlementStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollService } from '../payroll/payroll.service';
import { ListSettlementsQueryDto } from './dto/list-settlements-query.dto';
import { paginate } from '../common/pagination';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { EmployeeSalaryComponentsService } from '../employee-salary-components/employee-salary-components.service';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { amountInWords } from '../payroll/number-to-words';
import { CalculateSettlementDto } from './dto/calculate-settlement.dto';

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

// An employee below this length of service isn't gratuity-eligible (Payment
// of Gratuity Act, 1972) — ported verbatim from the old settlementController.
const YEARS_FOR_GRATUITY_ELIGIBILITY = 5;

@Injectable()
export class SettlementsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollService: PayrollService,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
    private readonly leaveBalanceService: LeaveBalanceService,
  ) {}

  async findAll(
    query: ListSettlementsQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.SettlementWhereInput = { organizationId };
    if (actor.role === Role.EMPLOYEE) where.employeeId = actor.id;

    return paginate(
      () =>
        this.scopedPrisma.settlement.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
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
    const pendingSalaryAmount = calc.netPay;

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
        'BASIC',
        dto.lastWorkingDay,
        organizationId,
      );
    const ratePerDay = basicMonthly / 30;

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
      if (yearsOfService >= YEARS_FOR_GRATUITY_ELIGIBILITY) {
        gratuityAmount = Math.round(basicMonthly * (15 / 26) * yearsOfService);
      }
    }

    const bonusAmount = dto.bonusAmount ?? 0;
    const recoveriesAmount = dto.recoveriesAmount ?? 0;
    const noticePeriodRecovery = dto.noticePeriodRecovery ?? 0;

    const netSettlementAmount = Math.round(
      pendingSalaryAmount +
        leaveEncashmentAmount +
        bonusAmount +
        gratuityAmount -
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
      netSettlementAmount,
      processedById: actor.id,
    };

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
      return this.scopedPrisma.settlement.findFirstOrThrow({
        where: { id: existing.id, organizationId },
      });
    }
    return this.scopedPrisma.settlement.create({
      data: { organizationId, employeeId: dto.employeeId, ...data },
    });
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

    const earnings: SettlementPayrollLine[] = [
      {
        code: 'PENDING_SALARY',
        name: 'Pending Salary',
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

    return this.scopedPrisma.$transaction(async (tx) => {
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
        data: {
          status: SettlementStatus.PROCESSED,
          processedById: actor.id,
          payrollRunId: run.id,
        },
      });
      await tx.user.updateMany({
        where: { id: settlement.employeeId, organizationId },
        data: { isActive: false },
      });
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
      await tx.settlement.updateMany({
        where: { id, organizationId },
        data: { status: SettlementStatus.PAID },
      });
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
      return tx.settlement.findFirstOrThrow({ where: { id, organizationId } });
    });
  }
}
