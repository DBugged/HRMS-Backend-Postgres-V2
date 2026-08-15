import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CalcType,
  EmployeeSalaryComponent,
  LeaveEncashmentStatus,
  LeaveStatus,
  NotificationCategory,
  OvertimeStatus,
  PayFrequency,
  PayrollRun,
  Prisma,
  PayrollRunStatus,
  Role,
  SalaryComponent,
  SalaryComponentType,
  StatutoryKey,
  StatutoryModule,
  TaxRegime,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { resolveCurrentRows } from '../employee-salary-components/salary-structure-math';
import {
  extractDependencies,
  resolveComponentValue,
} from '../employee-salary-components/component-value-resolution';
import { topoSortComponents } from '../salary-components/formula-engine';
import {
  daysInMonth,
  isComponentPayableThisMonth,
  lastDayOfMonth,
  round,
} from './payroll-date-math';
import {
  applyStatutoryOverrides,
  type EffectiveConfigsByModule,
  type OverlaidSettings,
} from './statutory-overlay';
import {
  computeAttendanceSummary,
  type AttendanceSummary,
} from './attendance-summary';
import { buildBaseContext } from './formula-context';
import { calculateTax, type TaxDetails, type TaxSlab } from './tax-engine';
import { amountInWords } from './number-to-words';
import { DraftPayrollDto } from './dto/draft-payroll.dto';
import { CalculatePayrollDto } from './dto/calculate-payroll.dto';
import { QueryPayrollDto } from './dto/query-payroll.dto';
import { AdjustPayrollDto, PayrollLineDto } from './dto/adjust-payroll.dto';
import {
  BulkTransitionPayrollDto,
  type PayrollTransitionAction,
} from './dto/bulk-transition-payroll.dto';
import { UnlockPayrollDto } from './dto/unlock-payroll.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { PayslipPdfService } from './payslip-pdf.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

type Actor = Omit<User, 'password'>;

interface TransitionConfig {
  fromStatuses: PayrollRunStatus[];
  toStatus: PayrollRunStatus;
  atField: 'verifiedAt' | 'approvedAt' | 'lockedAt' | 'paidAt';
  actorField: 'verifiedById' | 'approvedById' | 'lockedById' | 'paidById';
}

// Workflow: Draft -> Calculated -> Verified -> Approved -> Locked -> Paid.
// A single config table (not 4 near-duplicate handlers) drives both the
// single-run and bulk transition endpoints — ported from the old
// backend's TRANSITIONS table.
const PAYROLL_HISTORY_ACTIONS = [
  'PAYROLL_DRAFT_CREATED',
  'PAYROLL_CALCULATED',
  'PAYROLL_ADJUSTED',
  'PAYROLL_VERIFIED',
  'PAYROLL_APPROVED',
  'PAYROLL_LOCKED',
  'PAYROLL_PAID',
  'PAYROLL_UNLOCKED',
];

const TRANSITIONS: Record<PayrollTransitionAction, TransitionConfig> = {
  verify: {
    fromStatuses: [PayrollRunStatus.CALCULATED],
    toStatus: PayrollRunStatus.VERIFIED,
    atField: 'verifiedAt',
    actorField: 'verifiedById',
  },
  approve: {
    fromStatuses: [PayrollRunStatus.VERIFIED],
    toStatus: PayrollRunStatus.APPROVED,
    atField: 'approvedAt',
    actorField: 'approvedById',
  },
  lock: {
    fromStatuses: [PayrollRunStatus.APPROVED],
    toStatus: PayrollRunStatus.LOCKED,
    atField: 'lockedAt',
    actorField: 'lockedById',
  },
  pay: {
    fromStatuses: [PayrollRunStatus.LOCKED],
    toStatus: PayrollRunStatus.PAID,
    atField: 'paidAt',
    actorField: 'paidById',
  },
};

interface ResolvedLine {
  code: string;
  name: string;
  amount: number;
  taxable?: boolean;
  component?: SalaryComponent;
}

export interface CalculatedPayroll {
  attendanceSummary: AttendanceSummary;
  earnings: { code: string; name: string; amount: number; taxable?: boolean }[];
  deductions: { code: string; name: string; amount: number }[];
  employerContributions: { code: string; name: string; amount: number }[];
  taxDetails: TaxDetails | null;
  grossSalary: number;
  totalDeductions: number;
  totalEmployerContributions: number;
  netPay: number;
  ctcMonthly: number;
  financialYear: string;
}

type StatutoryEnabledKey =
  | 'pfEnabled'
  | 'esiEnabled'
  | 'ptEnabled'
  | 'lwfEnabled'
  | 'npsEnabled'
  | 'gratuityEnabled'
  | 'bonusEnabled'
  | 'incomeTaxEnabled'
  | 'employerInsuranceEnabled';

const STATUTORY_ENABLED_KEY: Partial<
  Record<StatutoryKey, StatutoryEnabledKey>
> = {
  [StatutoryKey.PF]: 'pfEnabled',
  [StatutoryKey.ESI]: 'esiEnabled',
  [StatutoryKey.PT]: 'ptEnabled',
  [StatutoryKey.LWF]: 'lwfEnabled',
  [StatutoryKey.NPS]: 'npsEnabled',
  [StatutoryKey.GRATUITY]: 'gratuityEnabled',
  [StatutoryKey.BONUS]: 'bonusEnabled',
  [StatutoryKey.INCOME_TAX]: 'incomeTaxEnabled',
  [StatutoryKey.EMPLOYER_INSURANCE]: 'employerInsuranceEnabled',
};

@Injectable()
export class PayrollService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly statutoryConfigService: StatutoryConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly payslipPdfService: PayslipPdfService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  // Computes a full payroll snapshot for one employee for one month/year.
  // Does NOT persist anything — callers (draft/calculate) decide when to
  // write a PayrollRun row. Ported verbatim from the old backend's
  // payrollEngine.js calculatePayroll.
  async calculatePayroll(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
  ): Promise<CalculatedPayroll> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const settingsRow =
      await this.payrollSettingsService.getOrCreate(organizationId);
    // Last day of the period (not the 1st) so a revision effective any
    // time during the month is picked up when that month is processed.
    const periodDate = lastDayOfMonth(month, year);

    const effectiveConfigs: EffectiveConfigsByModule = {};
    for (const statutoryModule of Object.values(StatutoryModule)) {
      const { version } = await this.statutoryConfigService.getEffective(
        statutoryModule,
        periodDate,
        organizationId,
      );
      if (version) {
        effectiveConfigs[statutoryModule] = {
          config: version.config,
          isEnabled: version.isEnabled,
        };
      }
    }
    const settings = applyStatutoryOverrides(settingsRow, effectiveConfigs);

    const totalDaysInMonth = daysInMonth(month, year);
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    const monthEndStr = `${monthPrefix}-${String(totalDaysInMonth).padStart(2, '0')}`;

    const [attendanceRows, leaveRows, overtimeRows] = await Promise.all([
      this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId,
          date: { startsWith: monthPrefix },
        },
      }),
      this.scopedPrisma.leave.findMany({
        where: {
          organizationId,
          employeeId,
          status: LeaveStatus.APPROVED,
          startDate: { lte: monthEndStr },
          endDate: { gte: `${monthPrefix}-01` },
        },
        include: {
          leaveType: { select: { isPaid: true, salaryImpactPercent: true } },
        },
      }),
      this.scopedPrisma.overtimeRecord.findMany({
        where: {
          organizationId,
          employeeId,
          status: OvertimeStatus.APPROVED,
          date: { gte: `${monthPrefix}-01`, lte: monthEndStr },
        },
      }),
    ]);

    const attendanceSummary = computeAttendanceSummary(
      attendanceRows,
      leaveRows.map((l) => ({
        startDate: l.startDate,
        endDate: l.endDate,
        isHalfDay: l.isHalfDay,
        leaveType: l.leaveType,
      })),
      overtimeRows,
      month,
      year,
    );

    const baseContext = buildBaseContext(attendanceSummary, settings, month);

    const [allComponents, overrideRows] = await Promise.all([
      this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
        orderBy: { displayOrder: 'asc' },
      }),
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId, employeeId },
      }),
    ]);
    const currentOverrides = resolveCurrentRows(overrideRows, periodDate);
    const overridesByCode = new Map<string, EmployeeSalaryComponent>(
      currentOverrides.map((r) => [r.componentCode, r]),
    );

    const applicable = allComponents.filter((c) =>
      this.isApplicable(
        c,
        overridesByCode.get(c.code) ?? null,
        month,
        settings,
      ),
    );

    const earningComponents = applicable.filter(
      (c) =>
        c.type === SalaryComponentType.EARNING && !c.isEmployerContribution,
    );
    const { results: earningsResults, context: afterEarnings } =
      this.resolveGroup(
        earningComponents,
        overridesByCode,
        baseContext,
        attendanceSummary,
      );

    const financialYear = getFinancialYear(
      month,
      year,
      settings.financialYearStartMonth,
    );

    // Variable Pay — a non-monthly earning is scaled by the employee's
    // PerformanceRating.payoutPercentage for this financial year. No
    // rating on file -> 100% (unscaled).
    const variableEarningCodes = new Set(
      earningComponents
        .filter((c) => c.payFrequency !== PayFrequency.MONTHLY)
        .map((c) => c.code),
    );
    if (variableEarningCodes.size > 0) {
      const perfRating = await this.scopedPrisma.performanceRating.findFirst({
        where: { organizationId, employeeId, financialYear },
      });
      const payoutFactor = perfRating ? perfRating.payoutPercentage / 100 : 1;
      if (payoutFactor !== 1) {
        for (const line of earningsResults) {
          if (variableEarningCodes.has(line.code)) {
            line.amount = round(
              line.amount * payoutFactor,
              settings.roundingRule,
              settings.roundingDecimals,
            );
          }
        }
      }
    }

    // Any approved-but-not-yet-processed leave encashment gets folded in
    // as an earning line — stays APPROVED (not PROCESSED) until the run
    // that pays it out is locked (Batch 8b), so recalculating before lock
    // always reflects the current approved-unprocessed total.
    const pendingEncashments = await this.scopedPrisma.leaveEncashment.findMany(
      {
        where: {
          organizationId,
          employeeId,
          status: LeaveEncashmentStatus.APPROVED,
        },
      },
    );
    const encashmentAmount = pendingEncashments.reduce(
      (s, r) => s + r.amount,
      0,
    );
    const earningsLines: ResolvedLine[] = [...earningsResults];
    if (encashmentAmount > 0) {
      earningsLines.push({
        code: 'LEAVE_ENCASHMENT',
        name: 'Leave Encashment',
        amount: encashmentAmount,
        taxable: true,
      });
    }

    const grossSalary = round(
      earningsLines.reduce((s, e) => s + e.amount, 0),
      settings.roundingRule,
      settings.roundingDecimals,
    );
    afterEarnings.GROSS_EARNINGS = grossSalary;

    const deductionComponents = applicable.filter(
      (c) =>
        c.type === SalaryComponentType.DEDUCTION &&
        !c.isEmployerContribution &&
        c.statutoryKey !== StatutoryKey.INCOME_TAX,
    );
    const { results: deductionsResults, context: afterDeductions } =
      this.resolveGroup(
        deductionComponents,
        overridesByCode,
        afterEarnings,
        attendanceSummary,
      );

    let taxDetails: TaxDetails | null = null;
    const incomeTaxComponent = applicable.find(
      (c) => c.statutoryKey === StatutoryKey.INCOME_TAX,
    );
    if (incomeTaxComponent && settings.incomeTaxEnabled) {
      const declaration =
        await this.scopedPrisma.employeeTaxDeclaration.findFirst({
          where: { organizationId, employeeId, financialYear },
        });
      const regime = declaration?.regimeChosen ?? TaxRegime.NEW;
      const taxSlabConfig = await this.scopedPrisma.taxSlabConfig.findFirst({
        where: { organizationId, financialYear, regime, isActive: true },
      });
      // No slab config yet for this FY/regime -> income tax is silently
      // skipped, ported as-is (not an error).
      if (taxSlabConfig) {
        const { ytdGross, ytdTDS } = await this.getYtdFigures(
          employeeId,
          financialYear,
          month,
          year,
          organizationId,
        );
        const taxableGross = earningsLines
          .filter((e) => e.taxable !== false)
          .reduce((s, e) => s + e.amount, 0);
        const basicLine = earningsLines.find((e) => e.code === 'BASIC');
        const hraLine = earningsLines.find((e) => e.code === 'HRA');

        taxDetails = calculateTax({
          month,
          year,
          currentMonthGross: taxableGross,
          ytdGross,
          ytdTDS,
          basicAnnual: (basicLine?.amount ?? 0) * 12,
          hraReceivedAnnual: (hraLine?.amount ?? 0) * 12,
          declaration,
          taxSlabConfig: {
            regime: taxSlabConfig.regime,
            standardDeduction: taxSlabConfig.standardDeduction,
            slabs: taxSlabConfig.slabs as unknown as TaxSlab[],
            surchargeSlabs:
              taxSlabConfig.surchargeSlabs as unknown as TaxSlab[],
            cessRate: taxSlabConfig.cessRate,
            rebate87ALimit: taxSlabConfig.rebate87ALimit,
            rebate87AAmount: taxSlabConfig.rebate87AAmount,
          },
          financialYearStartMonth: settings.financialYearStartMonth,
        });
        const incomeTaxAmount = Math.max(0, taxDetails.monthlyTDS || 0);
        deductionsResults.push({
          code: 'INCOME_TAX',
          name: incomeTaxComponent.name,
          amount: incomeTaxAmount,
          component: incomeTaxComponent,
        });
        afterDeductions.INCOME_TAX = incomeTaxAmount;
      }
    }

    const includedDeductions = deductionsResults.filter(
      (d) => d.component?.includeInNet !== false,
    );
    const totalDeductions = round(
      includedDeductions.reduce((s, d) => s + d.amount, 0),
      settings.roundingRule,
      settings.roundingDecimals,
    );

    const employerComponents = applicable.filter(
      (c) => c.isEmployerContribution,
    );
    const { results: employerResults } = this.resolveGroup(
      employerComponents,
      overridesByCode,
      { ...afterDeductions, TOTAL_DEDUCTIONS: totalDeductions },
      attendanceSummary,
    );
    const totalEmployerContributions = round(
      employerResults.reduce((s, e) => s + e.amount, 0),
      settings.roundingRule,
      settings.roundingDecimals,
    );

    const netPay = round(
      grossSalary - totalDeductions,
      settings.roundingRule,
      settings.roundingDecimals,
    );
    const ctcMonthly = round(
      grossSalary + totalEmployerContributions,
      settings.roundingRule,
      settings.roundingDecimals,
    );

    return {
      attendanceSummary,
      earnings: earningsLines.map((e) => ({
        code: e.code,
        name: e.name,
        amount: round(
          e.amount,
          settings.roundingRule,
          settings.roundingDecimals,
        ),
        taxable: e.taxable,
      })),
      deductions: deductionsResults.map((d) => ({
        code: d.code,
        name: d.name,
        amount: round(
          d.amount,
          settings.roundingRule,
          settings.roundingDecimals,
        ),
      })),
      employerContributions: employerResults.map((e) => ({
        code: e.code,
        name: e.name,
        amount: round(
          e.amount,
          settings.roundingRule,
          settings.roundingDecimals,
        ),
      })),
      taxDetails,
      grossSalary,
      totalDeductions,
      totalEmployerContributions,
      netPay,
      ctcMonthly,
      financialYear,
    };
  }

  async draft(dto: DraftPayrollDto, actor: Actor, organizationId: string) {
    const employees = await this.targetEmployees(
      dto.employeeId,
      organizationId,
    );
    const runs: PayrollRun[] = [];
    for (const employee of employees) {
      let run = await this.scopedPrisma.payrollRun.findFirst({
        where: {
          organizationId,
          employeeId: employee.id,
          month: dto.month,
          year: dto.year,
          isFinalSettlement: false,
        },
      });
      if (!run) {
        run = await this.scopedPrisma.payrollRun.create({
          data: {
            organizationId,
            employeeId: employee.id,
            month: dto.month,
            year: dto.year,
            status: PayrollRunStatus.DRAFT,
          },
        });
      }
      runs.push(run);
    }
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_DRAFT_CREATED',
      module: 'PAYROLL',
      organizationId,
      details: { month: dto.month, year: dto.year, count: runs.length },
    });
    return { count: runs.length, runs };
  }

  async calculate(
    dto: CalculatePayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employees = await this.targetEmployees(
      dto.employeeId,
      organizationId,
    );
    const results: PayrollRun[] = [];
    const failures: {
      employeeId: string;
      name: string;
      code: string;
      message: string;
    }[] = [];

    for (const employee of employees) {
      let run = await this.scopedPrisma.payrollRun.findFirst({
        where: {
          organizationId,
          employeeId: employee.id,
          month: dto.month,
          year: dto.year,
          isFinalSettlement: false,
        },
      });
      if (
        run &&
        (run.status === PayrollRunStatus.LOCKED ||
          run.status === PayrollRunStatus.PAID)
      ) {
        results.push(run);
        continue;
      }

      // One employee's misconfigured/missing salary structure must not
      // abort the whole company's payroll run — isolate it.
      try {
        const calc = await this.calculatePayroll(
          employee.id,
          dto.month,
          dto.year,
          organizationId,
        );
        const data = {
          financialYear: calc.financialYear,
          status: PayrollRunStatus.CALCULATED,
          attendanceSummary:
            calc.attendanceSummary as unknown as Prisma.InputJsonValue,
          earnings: calc.earnings as unknown as Prisma.InputJsonValue,
          deductions: calc.deductions as unknown as Prisma.InputJsonValue,
          employerContributions:
            calc.employerContributions as unknown as Prisma.InputJsonValue,
          taxDetails: calc.taxDetails
            ? (calc.taxDetails as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          grossSalary: calc.grossSalary,
          totalDeductions: calc.totalDeductions,
          totalEmployerContributions: calc.totalEmployerContributions,
          netPay: calc.netPay,
          ctcMonthly: calc.ctcMonthly,
          netPayInWords: amountInWords(calc.netPay),
          calculatedAt: new Date(),
          calculatedById: actor.id,
        };
        if (run) {
          await this.scopedPrisma.payrollRun.updateMany({
            where: { id: run.id, organizationId },
            data,
          });
          run = await this.scopedPrisma.payrollRun.findFirstOrThrow({
            where: { id: run.id, organizationId },
          });
        } else {
          run = await this.scopedPrisma.payrollRun.create({
            data: {
              organizationId,
              employeeId: employee.id,
              month: dto.month,
              year: dto.year,
              ...data,
            },
          });
        }
        results.push(run);
      } catch (err) {
        failures.push({
          employeeId: employee.id,
          name: employee.name,
          code: employee.employeeId,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_CALCULATED',
      module: 'PAYROLL',
      organizationId,
      details: {
        month: dto.month,
        year: dto.year,
        count: results.length,
        failed: failures.length,
      },
    });
    return { count: results.length, payrolls: results, failures };
  }

  async findAll(query: QueryPayrollDto, actor: Actor, organizationId: string) {
    const where: Prisma.PayrollRunWhereInput = {
      organizationId,
      isFinalSettlement: false,
    };
    if (query.month) where.month = query.month;
    if (query.year) where.year = query.year;
    if (query.status) where.status = query.status;

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: actor.departmentId },
        select: { id: true },
      });
      const allowedIds = deptEmployees.map((e) => e.id);
      where.employeeId =
        query.employeeId && allowedIds.includes(query.employeeId)
          ? query.employeeId
          : { in: allowedIds };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }

    return this.scopedPrisma.payrollRun.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            departmentId: true,
          },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  async findOne(id: string, actor: Actor, organizationId: string) {
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: { id, organizationId },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            departmentId: true,
            designation: true,
            joiningDate: true,
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payslip not found.');
    if (actor.role === Role.EMPLOYEE && run.employeeId !== actor.id) {
      throw new ForbiddenException('Not authorized to view this payslip.');
    }
    return run;
  }

  // Every draft/calculate/adjust/verify/approve/lock/pay/unlock action,
  // newest first — sourced from the audit log rather than a dedicated
  // table, same as LeavesService.getCreditHistory. Batch-level actions
  // (draft/calculate) have no targetId, so they're only resolvable to a
  // run via the query filters below; per-run actions always carry one.
  async getHistory(
    query: QueryPayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      module: 'PAYROLL',
      action: { in: PAYROLL_HISTORY_ACTIONS },
    };

    if (query.employeeId || query.month || query.year) {
      const runWhere: Prisma.PayrollRunWhereInput = {
        organizationId,
        isFinalSettlement: false,
        ...(query.employeeId && { employeeId: query.employeeId }),
        ...(query.month && { month: query.month }),
        ...(query.year && { year: query.year }),
      };
      const runs = await this.scopedPrisma.payrollRun.findMany({
        where: runWhere,
        select: { id: true },
      });
      const runIds = runs.map((r) => r.id);
      where.OR = [
        { targetId: { in: runIds } },
        ...(!query.employeeId
          ? [
              {
                targetId: null,
                action: { in: ['PAYROLL_DRAFT_CREATED', 'PAYROLL_CALCULATED'] },
              },
            ]
          : []),
      ];
    }

    if (actor.role === Role.MANAGER) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: actor.departmentId },
        select: { id: true },
      });
      const deptRuns = await this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          employeeId: { in: deptEmployees.map((e) => e.id) },
        },
        select: { id: true },
      });
      where.targetId = { in: deptRuns.map((r) => r.id) };
      delete where.OR;
    }

    const logs = await this.scopedPrisma.auditLog.findMany({
      where,
      include: {
        actor: {
          select: { id: true, name: true, employeeId: true, role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const targetIds = [
      ...new Set(
        logs.map((l) => l.targetId).filter((id): id is string => !!id),
      ),
    ];
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { id: { in: targetIds }, organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
    });
    const runById = new Map(runs.map((r) => [r.id, r]));

    return {
      history: logs.map((log) => ({
        ...log,
        run: log.targetId ? (runById.get(log.targetId) ?? null) : null,
      })),
    };
  }

  // Manual correction of a run's computed earnings/deductions before it's
  // finalized. Not allowed once locked/paid (unlock first). Editing an
  // already-verified/approved run invalidates that sign-off, so it drops
  // back to CALCULATED for re-review rather than silently keeping a stale
  // approval on changed numbers.
  async adjust(
    id: string,
    dto: AdjustPayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: { id, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found.');
    if (
      run.status === PayrollRunStatus.LOCKED ||
      run.status === PayrollRunStatus.PAID
    ) {
      throw new BadRequestException(
        'This payroll is locked/paid — unlock it before editing.',
      );
    }

    const roundTwo = (n: number) => round(n, 'nearest', 2);
    const earnings: PayrollLineDto[] = dto.earnings
      ? dto.earnings.map((e) => ({ ...e, amount: roundTwo(e.amount) }))
      : (run.earnings as unknown as PayrollLineDto[]);
    const deductions: PayrollLineDto[] = dto.deductions
      ? dto.deductions.map((d) => ({ ...d, amount: roundTwo(d.amount) }))
      : (run.deductions as unknown as PayrollLineDto[]);

    const grossSalary = roundTwo(
      earnings.reduce((s, e) => s + Number(e.amount || 0), 0),
    );
    const totalDeductions = roundTwo(
      deductions.reduce((s, d) => s + Number(d.amount || 0), 0),
    );
    const netPay = roundTwo(grossSalary - totalDeductions);

    const data: Prisma.PayrollRunUpdateManyMutationInput = {
      earnings: earnings as unknown as Prisma.InputJsonValue,
      deductions: deductions as unknown as Prisma.InputJsonValue,
      grossSalary,
      totalDeductions,
      netPay,
      netPayInWords: amountInWords(netPay),
    };
    if (
      run.status === PayrollRunStatus.VERIFIED ||
      run.status === PayrollRunStatus.APPROVED
    ) {
      data.status = PayrollRunStatus.CALCULATED;
    }

    await this.scopedPrisma.payrollRun.updateMany({
      where: { id, organizationId },
      data,
    });
    const updated = await this.scopedPrisma.payrollRun.findFirstOrThrow({
      where: { id, organizationId },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_ADJUSTED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: { netPay, reason: dto.reason ?? '' },
    });
    return updated;
  }

  async verify(id: string, actor: Actor, organizationId: string) {
    const run = await this.transitionOne(
      id,
      TRANSITIONS.verify,
      actor,
      organizationId,
    );
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_VERIFIED',
      module: 'PAYROLL',
      organizationId,
      targetId: run.id,
      details: { employeeId: run.employeeId, month: run.month, year: run.year },
    });
    return run;
  }

  async approve(id: string, actor: Actor, organizationId: string) {
    const run = await this.transitionOne(
      id,
      TRANSITIONS.approve,
      actor,
      organizationId,
    );
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_APPROVED',
      module: 'PAYROLL',
      organizationId,
      targetId: run.id,
      details: { employeeId: run.employeeId, month: run.month, year: run.year },
    });
    return run;
  }

  async lock(id: string, actor: Actor, organizationId: string) {
    const run = await this.transitionOne(
      id,
      TRANSITIONS.lock,
      actor,
      organizationId,
    );
    await this.afterLock(run, organizationId);
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_LOCKED',
      module: 'PAYROLL',
      organizationId,
      targetId: run.id,
      details: { employeeId: run.employeeId, month: run.month, year: run.year },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: run.employeeId,
      eventKey: 'PAYROLL_PROCESSED',
      performedById: actor.id,
      description: `${run.month}/${run.year} payroll locked`,
    });
    return run;
  }

  async pay(id: string, actor: Actor, organizationId: string) {
    const run = await this.transitionOne(
      id,
      TRANSITIONS.pay,
      actor,
      organizationId,
    );
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_PAID',
      module: 'PAYROLL',
      organizationId,
      targetId: run.id,
      details: { employeeId: run.employeeId, month: run.month, year: run.year },
    });
    await this.afterPay(run, organizationId);
    return run;
  }

  // Notifies the employee + emails them their payslip with the generated
  // PDF attached — ported from the old system's afterPay side effect.
  // A failure here (e.g. PDF generation choking on bad data) must never
  // fail the payment transition itself, which has already committed.
  private async afterPay(run: PayrollRun, organizationId: string) {
    try {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: run.employeeId, organizationId },
      });
      if (!employee) return;

      const title = `Payslip for ${run.month}/${run.year}`;
      const message = `Your salary for ${run.month}/${run.year} has been paid. Net pay: ${run.netPay}.`;

      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.PAYROLL,
      });

      const { buffer, filename } =
        await this.payslipPdfService.buildPayslipPdfBuffer(
          run.id,
          organizationId,
        );
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
        attachments: [{ filename, content: buffer }],
      });
    } catch {
      // Swallowed deliberately — see method doc.
    }
  }

  // Multi-select version of verify/approve/lock/pay. Runs not currently in
  // the right status for the requested action are skipped and reported
  // back rather than silently dropped, since a mixed-status selection is
  // expected (not every employee reaches each step together).
  async bulkTransition(
    dto: BulkTransitionPayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const config = TRANSITIONS[dto.action];
    const { updated, skipped } = await this.transitionMany(
      dto.ids,
      config,
      actor,
      organizationId,
    );
    if (dto.action === 'lock') {
      for (const run of updated) await this.afterLock(run, organizationId);
    }
    return { updatedCount: updated.length, skipped, runs: updated };
  }

  // Reverts a Locked/Paid run back to Calculated so it can be corrected
  // and re-run through the workflow.
  async unlock(
    id: string,
    dto: UnlockPayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: { id, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found.');
    if (
      run.status !== PayrollRunStatus.LOCKED &&
      run.status !== PayrollRunStatus.PAID
    ) {
      throw new BadRequestException(
        'Only locked or paid payroll can be unlocked.',
      );
    }

    await this.scopedPrisma.payrollRun.updateMany({
      where: { id, organizationId },
      data: {
        status: PayrollRunStatus.CALCULATED,
        unlockedById: actor.id,
        unlockedAt: new Date(),
        unlockReason: dto.reason ?? '',
      },
    });
    const updated = await this.scopedPrisma.payrollRun.findFirstOrThrow({
      where: { id, organizationId },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_UNLOCKED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: { reason: dto.reason ?? '' },
    });
    return updated;
  }

  // Core of both the single-row and bulk transition endpoints — moves
  // every run in `runIds` that's currently in `fromStatuses` to
  // `toStatus`, reporting which ones were skipped (wrong status, or not
  // found) instead of silently ignoring them.
  private async transitionMany(
    runIds: string[],
    config: TransitionConfig,
    actor: Actor,
    organizationId: string,
  ): Promise<{
    updated: PayrollRun[];
    skipped: { id: string; status: string }[];
  }> {
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { id: { in: runIds }, organizationId },
    });
    const updated: PayrollRun[] = [];
    const skipped: { id: string; status: string }[] = [];

    for (const run of runs) {
      if (!config.fromStatuses.includes(run.status)) {
        skipped.push({ id: run.id, status: run.status });
        continue;
      }
      const data: Prisma.PayrollRunUpdateManyMutationInput = {
        status: config.toStatus,
        [config.actorField]: actor.id,
        [config.atField]: new Date(),
      };
      await this.scopedPrisma.payrollRun.updateMany({
        where: { id: run.id, organizationId },
        data,
      });
      updated.push(
        await this.scopedPrisma.payrollRun.findFirstOrThrow({
          where: { id: run.id, organizationId },
        }),
      );
    }

    const foundIds = new Set(runs.map((r) => r.id));
    for (const id of runIds) {
      if (!foundIds.has(id)) skipped.push({ id, status: 'not_found' });
    }
    return { updated, skipped };
  }

  private async transitionOne(
    id: string,
    config: TransitionConfig,
    actor: Actor,
    organizationId: string,
  ): Promise<PayrollRun> {
    const { updated, skipped } = await this.transitionMany(
      [id],
      config,
      actor,
      organizationId,
    );
    if (updated.length === 0) {
      if (skipped[0]?.status === 'not_found') {
        throw new NotFoundException('Payroll run not found.');
      }
      throw new BadRequestException(
        `Cannot move payroll from "${skipped[0].status}" to "${config.toStatus}".`,
      );
    }
    return updated[0];
  }

  // Locking freezes the calculation — any approved-but-unprocessed leave
  // encashment folded into this run's earnings at calculate time is now
  // final; mark it processed so it doesn't get picked up again by a
  // future run.
  private async afterLock(run: PayrollRun, organizationId: string) {
    const encashments = await this.scopedPrisma.leaveEncashment.findMany({
      where: {
        organizationId,
        employeeId: run.employeeId,
        status: LeaveEncashmentStatus.APPROVED,
      },
    });
    for (const enc of encashments) {
      await this.scopedPrisma.leaveEncashment.updateMany({
        where: { id: enc.id, organizationId },
        data: {
          status: LeaveEncashmentStatus.PROCESSED,
          payrollRunId: run.id,
          processedAt: new Date(),
        },
      });
    }
  }

  // Resolves a group of same-type components (all earnings, or all
  // deductions, etc.) in dependency order. Proration is applied only to
  // FIXED-type values — PERCENTAGE/FORMULA/MANUAL authors are expected to
  // reference PAYABLE_DAYS/LOP_DAYS themselves if they want proration.
  private resolveGroup(
    components: SalaryComponent[],
    overridesByCode: Map<string, EmployeeSalaryComponent>,
    context: Record<string, number>,
    attendance: AttendanceSummary,
  ): { results: ResolvedLine[]; context: Record<string, number> } {
    const byCode = new Map(components.map((c) => [c.code, c]));
    const edges: Record<string, string[]> = {};
    for (const c of components) {
      const override = overridesByCode.get(c.code) ?? null;
      edges[c.code] = extractDependencies(c, override).filter((code) =>
        byCode.has(code),
      );
    }
    const order = topoSortComponents(edges);

    const results: ResolvedLine[] = [];
    const localContext = { ...context };
    const prorationFactor =
      attendance.totalDaysInMonth > 0
        ? attendance.payableDays / attendance.totalDaysInMonth
        : 1;

    for (const code of order) {
      const component = byCode.get(code);
      if (!component) continue;
      const override = overridesByCode.get(code) ?? null;
      const valueType = override?.valueType ?? component.calcType;
      let value = resolveComponentValue(component, override, localContext);

      if (valueType === CalcType.FIXED) {
        value = value * prorationFactor;
      }
      value = Math.max(0, value);
      localContext[code] = value;
      results.push({
        code,
        name: component.name,
        amount: value,
        taxable: component.isTaxable,
        component,
      });
    }
    return { results, context: localContext };
  }

  private isApplicable(
    component: SalaryComponent,
    override: EmployeeSalaryComponent | null,
    month: number,
    settings: OverlaidSettings,
  ): boolean {
    if (
      !isComponentPayableThisMonth(
        component.payFrequency,
        month,
        settings.financialYearStartMonth,
      )
    ) {
      return false;
    }

    if (component.isStatutory) {
      const key = component.statutoryKey
        ? STATUTORY_ENABLED_KEY[component.statutoryKey]
        : undefined;
      if (key && !settings[key]) return false;
      if (override && override.isEnabled === false) return false;
      return true;
    }

    if (
      component.calcType === CalcType.PERCENTAGE ||
      component.calcType === CalcType.FORMULA
    ) {
      return !override || override.isEnabled !== false;
    }

    return !!override && override.isEnabled !== false;
  }

  // Sums gross earnings + TDS already recorded for this employee within
  // the given FY, for every month strictly before beforeMonth/beforeYear.
  private async getYtdFigures(
    employeeId: string,
    financialYear: string,
    beforeMonth: number,
    beforeYear: number,
    organizationId: string,
  ): Promise<{ ytdGross: number; ytdTDS: number }> {
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId,
        financialYear,
        isFinalSettlement: false,
        status: {
          in: [
            PayrollRunStatus.CALCULATED,
            PayrollRunStatus.VERIFIED,
            PayrollRunStatus.APPROVED,
            PayrollRunStatus.LOCKED,
            PayrollRunStatus.PAID,
          ],
        },
      },
    });

    let ytdGross = 0;
    let ytdTDS = 0;
    for (const run of runs) {
      const isBefore =
        run.year < beforeYear ||
        (run.year === beforeYear && run.month < beforeMonth);
      if (!isBefore) continue;
      ytdGross += run.grossSalary;
      const deductions = run.deductions as unknown as {
        code: string;
        amount: number;
      }[];
      const incomeTaxLine = deductions.find((d) => d.code === 'INCOME_TAX');
      ytdTDS += incomeTaxLine ? incomeTaxLine.amount : 0;
    }
    return { ytdGross, ytdTDS };
  }

  private async targetEmployees(
    employeeId: string | undefined,
    organizationId: string,
  ) {
    if (employeeId) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId, isActive: true },
      });
      if (!employee) throw new NotFoundException('Employee not found.');
      return [employee];
    }
    return this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: [Role.EMPLOYEE, Role.MANAGER] },
      },
    });
  }
}
