// Purpose: The payroll engine — computes a full monthly payroll snapshot per employee and drives the
// PayrollRun status workflow (Draft -> Calculated -> Verified -> Approved -> Locked -> Paid).
// Responsibilities: Owns calculatePayroll() (pure computation, ported verbatim from the old backend's
// payrollEngine.js — resolves component dependency order, proration, tax, variable-pay scaling, and pending
// leave-encashment folding) and the TRANSITIONS-table-driven status machine shared by single and bulk
// endpoints; delegates statutory config resolution to StatutoryConfigService and payslip PDF/email delivery
// to PayslipPdfService/PayslipEmailQueueService.
// Important: calculatePayroll() never persists — draft()/calculate() decide when to write a PayrollRun row.
// afterLock() marks approved-unprocessed leave encashments PROCESSED so a future run can't double-count
// them. afterPay()'s notification/email failures are swallowed deliberately — the payment transition has
// already committed by that point and must not be rolled back by a PDF/email failure.
import {
  EMPLOYEE_ORDER_BY,
  EMPLOYEE_RELATION_ORDER_BY,
} from '../common/employee-order';
import {
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CalcType,
  EmployeeSalaryComponent,
  LeaveEncashmentStatus,
  LeaveStatus,
  Loan,
  LoanStatus,
  LoanType,
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
  TaxDeclarationStatus,
  TaxRegime,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import {
  resolveCurrentRows,
  splitPeriodAtRevisions,
  type PeriodSegment,
} from '../employee-salary-components/salary-structure-math';
import {
  extractDependencies,
  resolveComponentValue,
} from '../employee-salary-components/component-value-resolution';
import { topoSortComponents } from '../salary-components/formula-engine';
import {
  daysInMonth,
  daysInRange,
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
  cycleKeyOf,
  describeVariablePay,
  parseCycleKey,
  pendingHolds,
  pickCompanyPercent,
  releasedKeys,
  type HeldVariablePay,
} from './variable-pay';
import { todayInOrgTz } from '../common/org-date';
import {
  computeAttendanceSummary,
  payableDaysInRange,
  type AttendanceSummary,
  type DatedAttendanceRowLike,
  type LeaveRowWithType,
} from './attendance-summary';
import {
  dropLeaveRowsOnOffDays,
  employmentWindow,
  missingOffDayRows,
  offDayCalendar,
  splitLeavesAroundOffDays,
  type LeaveRowWithSandwich,
} from './off-days';
import {
  enumerateDateStrings,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import {
  buildBaseContext,
  deriveStatutoryContext,
  splitEmployerPf,
} from './formula-context';
import {
  calculateTax,
  monthsRemainingInFY,
  type TaxDetails,
  type TaxSlab,
} from './tax-engine';
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
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { paginate, skip } from '../common/pagination';
import { mapWithConcurrency } from '../common/concurrency';
import { issueDocumentNumber } from '../organizations/document-numbering';
import { PayslipEmailQueueService } from './payslip-email-queue.service';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { LoansService } from '../loans/loans.service';
import { payoffAmount, splitRepayment } from '../loans/loan-math';

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

// Separation of duties: a non-Admin (HR) can never change or sign off their OWN payslip. An Admin is exempt, the
// same carve-out assertNotSelfApproval makes for leave and loans.
function assertNotOwnPayroll(
  actor: { id: string; role: Role },
  employeeId: string,
  action: string,
): void {
  if (actor.role !== Role.ADMIN && actor.id === employeeId) {
    throw new ForbiddenException(
      `You cannot ${action} your own payslip. Another HR user or an Admin must do it.`,
    );
  }
}

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

// A run transitionMany() did not move, and why. `reason` carries a
// user-facing explanation for the checks that have one (non-numeric amounts,
// a stale loan EMI at lock).
export interface TransitionSkip {
  id: string;
  status: string;
  reason?: string;
}

// The shape the earnings/deductions JSON columns are read back as.
interface PayrollLineRecord {
  code: string;
  name: string;
  amount: number;
  sourceIds?: string[];
}

interface ResolvedLine {
  code: string;
  name: string;
  amount: number;
  taxable?: boolean;
  component?: SalaryComponent;
  // Rows this line was built from (encashment ids on LEAVE_ENCASHMENT, the
  // loan id on LOAN_EMI). Persisted with the line so afterLock() settles
  // exactly what the locked payslip actually contains — see afterLock().
  sourceIds?: string[];
  // Variable pay scaled by company performance: how the amount was worked
  // out ("12000 × 80% company × 110% individual"), and — on a payout released
  // after being held — the original payout month ("2027-03") it settles.
  note?: string;
  cycleKey?: string;
}

export interface CalculatedPayroll {
  attendanceSummary: AttendanceSummary;
  earnings: {
    code: string;
    name: string;
    amount: number;
    taxable?: boolean;
    sourceIds?: string[];
    note?: string;
    cycleKey?: string;
  }[];
  deductions: {
    code: string;
    name: string;
    amount: number;
    sourceIds?: string[];
  }[];
  employerContributions: {
    code: string;
    name: string;
    amount: number;
    // Employer PF only: how the amount splits between EPS (pension) and EPF, for ECR filing.
    breakup?: { eps: number; epf: number };
    // The statutory wage base this contribution was calculated on (PF: capped at the ceiling; ESI: gross) — kept
    // on the run so statutory returns (ECR / ESIC) reproduce it without re-deriving it later.
    wages?: number;
  }[];
  taxDetails: TaxDetails | null;
  grossSalary: number;
  // Sum of the earning lines that are taxable (taxable !== false) — the income-tax base for this month, persisted
  // on the run so later months' YTD taxable income doesn't have to re-derive it from grossSalary.
  taxableGross: number;
  totalDeductions: number;
  totalEmployerContributions: number;
  netPay: number;
  ctcMonthly: number;
  financialYear: string;
  // Variable pay not paid this run because the company performance % isn't
  // entered yet — see variable-pay.ts.
  heldVariablePay: HeldVariablePay[];
}

// What an employee may see of their own payroll. Draft and calculated rows are still being worked on by HR and can
// change, so they are not shown (the payslip PDF is already limited to the same statuses).
const EMPLOYEE_VISIBLE_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

// Why someone is left out of a payroll run for a month, or null when they belong in it: nobody is on payroll for a
// month that ended before they joined, nor (while it is still running) before their joining date arrives.
function notOnPayrollReason(
  joiningDate: Date,
  month: number,
  year: number,
  today: string,
): string | null {
  const joined = joiningDate.toISOString().slice(0, 10);
  if (joined > lastDayOfMonth(month, year)) {
    return `Joined after ${month}/${year} - not on payroll for this month.`;
  }
  if (joined > today) return `Joins on ${joined} - not on payroll yet.`;
  return null;
}

type StatutoryEnabledKey =
  | 'pfEnabled'
  | 'esiEnabled'
  | 'ptEnabled'
  | 'lwfEnabled'
  | 'npsEnabled'
  | 'gratuityEnabled'
  | 'bonusEnabled'
  | 'incomeTaxEnabled';

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
  // EMPLOYER_INSURANCE removed (never seeded/used) — Statutory Key stays
  // selectable in schema.prisma/SalaryComponents.tsx dropdowns for now (see
  // that screen for the removal from the picker), but no longer maps to an
  // org-level enable flag; re-add here (plus the org toggle in
  // update-payroll-settings.dto.ts/PayrollSettingsPage.tsx/
  // statutory-overlay.ts) if this is ever requested again.
};

const MONEY_TOTAL_FIELDS = [
  'grossSalary',
  'totalDeductions',
  'totalEmployerContributions',
  'netPay',
  'ctcMonthly',
] as const;
const MONEY_LINE_FIELDS = [
  'earnings',
  'deductions',
  'employerContributions',
] as const;

// Names the first money figure on a run (a calculated snapshot or a stored
// PayrollRun) that is not a finite number, or returns null when every total
// and line amount is finite. A NaN/Infinity amount used to be saved and could
// be verified, approved, locked and paid like any other run (the netPay < 0
// guard is false for NaN). JSON line amounts that were NaN/Infinity come back
// from Postgres as null, so anything that isn't a finite number counts.
export function nonFiniteMoneyField(run: {
  grossSalary: number;
  totalDeductions: number;
  totalEmployerContributions: number;
  netPay: number;
  ctcMonthly: number;
  earnings: unknown;
  deductions: unknown;
  employerContributions: unknown;
}): string | null {
  for (const field of MONEY_TOTAL_FIELDS) {
    if (!Number.isFinite(run[field])) return field;
  }
  for (const field of MONEY_LINE_FIELDS) {
    const lines = run[field];
    if (!Array.isArray(lines)) continue;
    for (const line of lines as { code?: string; amount?: unknown }[]) {
      if (typeof line?.amount !== 'number' || !Number.isFinite(line.amount)) {
        return `${field} line ${line?.code ?? '?'}`;
      }
    }
  }
  return null;
}

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
    private readonly payslipEmailQueueService: PayslipEmailQueueService,
    private readonly emailTemplatesService: EmailTemplatesService,
    private readonly loansService: LoansService,
  ) {}

  // Whether ESI was already deducted for this employee earlier in the current ESI contribution period
  // (April-September or October-March). Under the ESI Act an employee covered during a period stays covered until
  // it ends even if wages cross the ceiling mid-period — see ESI_APPLICABLE in formula-context.ts.
  private async hadEsiThisContributionPeriod(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
  ): Promise<boolean> {
    const startMonth = month >= 10 ? 10 : month >= 4 ? 4 : 10;
    const startYear = month <= 3 ? year - 1 : year;
    const earlier: { month: number; year: number }[] = [];
    for (
      let m = startMonth, y = startYear;
      y < year || (y === year && m < month);
      m = m === 12 ? 1 : m + 1, y = m === 1 ? y + 1 : y
    ) {
      earlier.push({ month: m, year: y });
    }
    if (earlier.length === 0) return false;
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId,
        isFinalSettlement: false,
        status: { not: PayrollRunStatus.DRAFT },
        OR: earlier,
      },
      select: { deductions: true },
    });
    return runs.some((r) =>
      ((r.deductions ?? []) as { code: string; amount: number }[]).some(
        (d) => d.code === 'ESI' && d.amount > 0,
      ),
    );
  }

  // Computes a full payroll snapshot for one employee for one month/year.
  // Does NOT persist anything — callers (draft/calculate) decide when to
  // write a PayrollRun row. Ported verbatim from the old backend's
  // payrollEngine.js calculatePayroll.
  async calculatePayroll(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
    // lopDaysOverride: used by adjust()'s manual LOP correction to re-run
    // this whole engine — formula components, proration, statutory
    // deductions, tax — against a corrected day count instead of what
    // attendance/leave records alone would have produced. Every other
    // input (attendance rows, leave rows, overtime, salary structure) is
    // still read fresh, exactly as a normal calculate() would.
    options?: {
      lopDaysOverride?: number;
      // Final settlement: the pending-salary preview is allowed to be negative (the settlement nets it against
      // recoveries), tax is trued up on actual income (no projection of months that will not be worked), and
      // one-off taxable settlement payments (leave encashment, bonus) are taxed with it.
      finalSettlement?: {
        extraTaxableEarnings: number;
        // The LWD month was already paid (and taxed) by a locked regular run — only the extras are taxed now.
        monthAlreadyPaid: boolean;
      };
    },
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

    const [
      attendanceRows,
      leaveRows,
      overtimeRows,
      holidayRows,
      department,
      org,
    ] = await Promise.all([
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
          leaveType: {
            select: { isPaid: true, salaryImpactPercent: true, rules: true },
          },
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
      // The holidays that apply to this employee (company-wide plus their own department's), optional ones excluded.
      this.scopedPrisma.holiday.findMany({
        where: {
          organizationId,
          isActive: true,
          isOptional: false,
          date: { startsWith: monthPrefix },
          OR: employee.departmentId
            ? [{ departmentId: null }, { departmentId: employee.departmentId }]
            : [{ departmentId: null }],
        },
        select: { date: true },
      }),
      employee.departmentId
        ? this.scopedPrisma.department.findFirst({
            where: { id: employee.departmentId, organizationId },
          })
        : Promise.resolve(null),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true, timezone: true },
      }),
    ]);

    // Weekly offs and holidays are paid days even when no attendance row was ever written for them (an imported or
    // backfilled month, or one the daily job never ran for). The days before the employee joined are not unpaid
    // leave, they are simply outside their employment. See off-days.ts.
    const { weeklyOffs } = resolveShiftConfig(
      department,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );
    // A month still running is paid for the days that have happened so far (today included), not for days to come:
    // those are neither unpaid nor paid weekly offs yet. A final settlement does its own period handling.
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const employed = employmentWindow(
      employee.joiningDate,
      month,
      year,
      options?.finalSettlement ? undefined : today,
    );
    const elapsedAttendanceRows = attendanceRows.filter(
      (r) => r.date <= employed.to,
    );
    const elapsedOvertimeRows = overtimeRows.filter(
      (o) => o.date <= employed.to,
    );
    const elapsedLeaveRows = leaveRows
      .filter((l) => l.startDate <= employed.to)
      .map((l) => ({
        ...l,
        endDate: l.endDate > employed.to ? employed.to : l.endDate,
      }));
    const calendar = offDayCalendar(
      employed.from,
      employed.to,
      weeklyOffs,
      holidayRows.map((h) => h.date),
    );
    const leaveInputs = elapsedLeaveRows.map((l) => ({
      startDate: l.startDate,
      endDate: l.endDate,
      isHalfDay: l.isHalfDay,
      leaveType: l.leaveType,
      // A weekly off or holiday inside a leave is only part of the leave when its type applies the sandwich rule.
      sandwichApplies: !!(
        l.leaveType.rules as { sandwichLeaveApplies?: boolean } | null
      )?.sandwichLeaveApplies,
    }));
    // Approving a leave stamps ON_LEAVE on its weekends/holidays too; without the sandwich rule those go back to being
    // paid off days.
    const keptRows = dropLeaveRowsOnOffDays(
      elapsedAttendanceRows,
      calendar,
      leaveInputs,
    );
    const attendanceForPay = [
      ...keptRows,
      ...missingOffDayRows(calendar, new Set(keptRows.map((r) => r.date))),
    ];
    const leaves: LeaveRowWithSandwich[] = splitLeavesAroundOffDays(
      leaveInputs,
      new Set([...calendar.weeklyOffDates, ...calendar.holidayDates]),
    );
    const attendanceSummary = computeAttendanceSummary(
      attendanceForPay,
      leaves,
      elapsedOvertimeRows,
      month,
      year,
      employed.daysBeforeJoining + employed.daysNotElapsed,
    );
    attendanceSummary.daysBeforeJoining = employed.daysBeforeJoining;
    attendanceSummary.daysNotElapsed = employed.daysNotElapsed;
    if (options?.lopDaysOverride !== undefined) {
      // Inverse of computeAttendanceSummary's own lopDays formula —
      // payableDays moves opposite LOP so everything downstream (formula
      // proration, LOP_DAYS/PAYABLE_DAYS in formula-context.ts, statutory
      // and tax calculations) sees a fully consistent corrected summary.
      attendanceSummary.lopDays = round(options.lopDaysOverride, 'nearest', 2);
      attendanceSummary.payableDays = Math.max(
        0,
        round(
          attendanceSummary.totalDaysInMonth -
            attendanceSummary.lopDays -
            attendanceSummary.unpaidLeaveDays -
            employed.daysBeforeJoining -
            employed.daysNotElapsed,
          'nearest',
          2,
        ),
      );
    }
    const roundAmount = (n: number) =>
      round(n, settings.roundingRule, settings.roundingDecimals);

    // State-wise statutory rules (LWF, Professional Tax): the employee's state is their effective work
    // location's state (own override, else the department's). Only looked up when the org actually has state rates configured, so orgs on the single
    // org-wide rate pay no extra query.
    let state: string | null = null;
    if (
      (settings.lwfStateRates.length > 0 || settings.ptStateRates.length > 0) &&
      (employee.departmentId || employee.workLocationId)
    ) {
      const loc = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: {
          workLocation: { select: { state: true } },
          department: {
            select: { workLocation: { select: { state: true } } },
          },
        },
      });
      state = (loc && effectiveWorkLocation(loc)?.state) || null;
    }

    const baseContext = buildBaseContext(attendanceSummary, settings, month, {
      state,
      gender: employee.gender,
      lwfExempt: employee.lwfExempt,
    });

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
    // Without a salary structure there is nothing to pay from: HRA and the like are calculated off Basic, so the row
    // would come out as a "calculated" payslip of zeros. Fail this employee with a reason instead.
    if (
      !options?.finalSettlement &&
      !currentOverrides.some((r) => r.isEnabled)
    ) {
      throw new Error(
        'No salary structure is set for this employee for this month - add their salary components (Employees > Salary) before running payroll',
      );
    }
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

    // A formula/percentage component (e.g. the default HRA, 40% of BASIC)
    // can reference a real component's code that exists in the org but
    // isn't applicable *for this employee* — BASIC is FIXED/opt-in, so an
    // employee with no override for it never has BASIC in scope even
    // though HRA still auto-applies. Without this, resolveComponentValue
    // throws "Unknown reference" for every such employee instead of
    // treating the un-opted-in base as 0, which is what "40% of a Basic
    // this employee was never given" actually means.
    const applicableCodes = new Set(applicable.map((c) => c.code));
    for (const c of allComponents) {
      if (!applicableCodes.has(c.code)) baseContext[c.code] = 0;
    }

    const earningComponents = applicable.filter(
      (c) =>
        c.type === SalaryComponentType.EARNING && !c.isEmployerContribution,
    );
    const attendanceProration =
      attendanceSummary.totalDaysInMonth > 0
        ? attendanceSummary.payableDays / attendanceSummary.totalDaysInMonth
        : 1;

    // A salary revision effective partway through the month used to be
    // resolved once, as of month end, so the whole month was paid at the new
    // rate. The month is now split at every revision boundary and each part
    // paid at the rate in force for it; with no mid-month revision (the
    // usual case) there is one segment and the calculation is unchanged.
    // Only earning revisions split the month — deductions and employer
    // contributions are derived from the combined earnings as before.
    const earningCodes = new Set(
      allComponents
        .filter(
          (c) =>
            c.type === SalaryComponentType.EARNING && !c.isEmployerContribution,
        )
        .map((c) => c.code),
    );
    const segments = splitPeriodAtRevisions(
      overrideRows.filter((r) => earningCodes.has(r.componentCode)),
      `${monthPrefix}-01`,
      periodDate,
    );
    const earningsResults =
      segments.length === 1
        ? this.resolveGroup(
            earningComponents,
            overridesByCode,
            baseContext,
            attendanceProration,
            roundAmount,
          ).results
        : this.resolveSegmentedEarnings({
            segments,
            overrideRows,
            allComponents,
            month,
            settings,
            baseContext,
            attendanceRows: attendanceForPay,
            leaves,
            totalDaysInMonth,
            roundAmount,
          });

    const financialYear = getFinancialYear(
      month,
      year,
      settings.financialYearStartMonth,
    );

    // Variable Pay — a non-monthly earning is scaled by the employee's
    // PerformanceRating.payoutPercentage for this financial year (no rating
    // on file -> 100%) and, when Company Performance is enabled, also by the
    // company's achievement % — held until that % is entered. See
    // applyVariablePay and variable-pay.ts.
    const variableEarningCodes = new Set(
      earningsResults
        .filter(
          (l) =>
            l.component && l.component.payFrequency !== PayFrequency.MONTHLY,
        )
        .map((l) => l.code),
    );
    const { held: heldVariablePay, released: releasedVariableLines } =
      await this.applyVariablePay({
        organizationId,
        employeeId,
        departmentId: employee.departmentId,
        month,
        year,
        financialYear,
        enabled: settingsRow.companyPerformanceEnabled,
        roundingRule: settings.roundingRule,
        roundingDecimals: settings.roundingDecimals,
        earningsResults,
        variableEarningCodes,
        allComponents,
        overrideRows,
        baseContext,
        roundAmount,
      });

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
    const rawEarningsLines: ResolvedLine[] = [
      ...earningsResults,
      ...releasedVariableLines,
    ];
    if (encashmentAmount > 0) {
      rawEarningsLines.push({
        code: 'LEAVE_ENCASHMENT',
        name: 'Leave Encashment',
        amount: encashmentAmount,
        taxable: true,
        sourceIds: pendingEncashments.map((e) => e.id),
      });
    }

    // Round every earning line exactly once, here, and use these rounded
    // amounts for everything downstream (the gross total, the context
    // value later components/tax can reference, and the persisted
    // `earnings` array) — previously the gross total was rounded from the
    // *raw* unrounded sum while the displayed `earnings` array rounded
    // each line independently afterward, so "sum of the lines shown on
    // the payslip" could differ from "gross shown on the payslip" by the
    // smallest rounding unit (e.g. three lines of 10.005 each round
    // individually to 10.01, summing to 30.03, while the raw total 30.015
    // rounds to 30.02 — a visible ₹0.01 mismatch).
    const earningsLines: ResolvedLine[] = rawEarningsLines.map((e) => ({
      ...e,
      amount: round(e.amount, settings.roundingRule, settings.roundingDecimals),
    }));

    // NOTE: includeInGross is deliberately NOT applied here. Excluding a
    // line from gross also excludes it from netPay (= gross - deductions),
    // i.e. it would stop being paid at all — and "pay it but keep it out of
    // the statutory base" needs netPay and the payslip's
    // "Gross - Deductions" band to grow a separate non-gross earnings
    // concept first. Every seeded component with includeInGross:false is an
    // employer contribution, which never reaches earningsLines anyway, so
    // this only affects custom components. Flagged rather than guessed.
    const grossSalary = round(
      earningsLines.reduce((s, e) => s + e.amount, 0),
      settings.roundingRule,
      settings.roundingDecimals,
    );
    const taxableGross = round(
      earningsLines
        .filter((e) => e.taxable !== false)
        .reduce((s, e) => s + e.amount, 0),
      settings.roundingRule,
      settings.roundingDecimals,
    );
    // The context the deduction and employer formulas see carries each
    // earning at exactly the amount printed on the payslip. It used to carry
    // the raw unrounded (and, for variable pay, unscaled) value, so e.g. PF
    // was 12% of 14516.13 while the payslip showed Basic 14516.
    const afterEarnings: Record<string, number> = { ...baseContext };
    for (const line of earningsLines) {
      if (line.component) afterEarnings[line.code] = line.amount;
    }
    afterEarnings.GROSS_EARNINGS = grossSalary;
    // ESIC wages exclude non-monthly pay (annual bonus, variable payouts).
    afterEarnings.ESI_WAGES = Math.max(
      0,
      grossSalary -
        earningsLines
          .filter(
            (l) =>
              l.component && l.component.payFrequency !== PayFrequency.MONTHLY,
          )
          .reduce((s, l) => s + l.amount, 0),
    );
    // Wage bases and the ESI coverage flag — all depend on this month's gross, so they're derived here.
    Object.assign(
      afterEarnings,
      deriveStatutoryContext(
        afterEarnings,
        settings,
        settings.esiEnabled
          ? await this.hadEsiThisContributionPeriod(
              employeeId,
              month,
              year,
              organizationId,
            )
          : false,
      ),
    );

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
        attendanceProration,
        roundAmount,
      );

    // Perquisite of a concessional employer loan (below the SBI benchmark rate): taxable, but not paid out. Added to the
    // income base each month (and kept in the run's taxableGross so year-to-date and Form 130 carry it).
    let perquisiteMonthly = 0;
    if (settingsRow.perquisiteLoanBenchmarkRate > 0) {
      const loans = await this.scopedPrisma.loan.findMany({
        where: {
          organizationId,
          employeeId,
          status: LoanStatus.ACTIVE,
          loanType: LoanType.LOAN,
        },
        select: { outstandingBalance: true, interestRate: true },
      });
      // No perquisite while the total outstanding stays within 20,000.
      const total = loans.reduce((s, l) => s + l.outstandingBalance, 0);
      if (total > 20000) {
        perquisiteMonthly = Math.round(
          loans.reduce(
            (s, l) =>
              s +
              (l.outstandingBalance *
                Math.max(
                  0,
                  settingsRow.perquisiteLoanBenchmarkRate - l.interestRate,
                )) /
                100 /
                12,
            0,
          ),
        );
      }
    }
    const taxableForTax = taxableGross + perquisiteMonthly;

    let taxDetails: TaxDetails | null = null;
    const incomeTaxComponent = applicable.find(
      (c) => c.statutoryKey === StatutoryKey.INCOME_TAX,
    );
    if (incomeTaxComponent && settings.incomeTaxEnabled) {
      const storedDeclaration =
        await this.scopedPrisma.employeeTaxDeclaration.findFirst({
          where: { organizationId, employeeId, financialYear },
        });
      // A DRAFT is work in progress and never drives TDS. With "require verification" on, only a VERIFIED
      // declaration does; until then the employee is taxed under the default regime with no declared deductions.
      const declaration =
        storedDeclaration &&
        (storedDeclaration.status === TaxDeclarationStatus.VERIFIED ||
          (storedDeclaration.status === TaxDeclarationStatus.SUBMITTED &&
            !settingsRow.taxDeclarationRequiresVerification))
          ? storedDeclaration
          : null;
      const regime = declaration?.regimeChosen ?? TaxRegime.NEW;
      const taxSlabConfig = await this.scopedPrisma.taxSlabConfig.findFirst({
        where: { organizationId, financialYear, regime, isActive: true },
      });
      // Income tax is on for the org but there's nothing to compute it
      // against. This used to silently skip TDS (paying the month with zero
      // tax withheld); it now fails this employee so the run's failures[]
      // says exactly what to configure.
      if (!taxSlabConfig) {
        const otherRegime = await this.scopedPrisma.taxSlabConfig.findFirst({
          where: { organizationId, financialYear, isActive: true },
          select: { id: true },
        });
        throw new Error(
          otherRegime
            ? `No income tax slabs configured for the ${regime} regime for FY ${financialYear} — add them under Statutory Compliance before running payroll`
            : `No income tax slabs configured for FY ${financialYear} — add them under Statutory Compliance before running payroll`,
        );
      }
      const fs = options?.finalSettlement;
      // When the LWD month is already paid by a locked run, that run is part of the year-to-date.
      const ytdBefore = fs?.monthAlreadyPaid
        ? {
            month: month === 12 ? 1 : month + 1,
            year: month === 12 ? year + 1 : year,
          }
        : { month, year };
      const { ytdGross, ytdTDS, ytdMonths } = await this.getYtdFigures(
        employeeId,
        financialYear,
        ytdBefore.month,
        ytdBefore.year,
        organizationId,
      );
      const remainingMonthsInFY = monthsRemainingInFY(
        month,
        year,
        settings.financialYearStartMonth,
      );
      // Months of this FY the income base spans: what this employer already paid + this month onwards (just this
      // month for a leaver). HRA / Basic annualisation below uses the same span.
      const employmentMonths = Math.min(
        12,
        ytdMonths + (fs ? (fs.monthAlreadyPaid ? 0 : 1) : remainingMonthsInFY),
      );
      const recurringResults = this.recurringMonthlyEarnings(
        earningComponents,
        overridesByCode,
        baseContext,
        roundAmount,
      );
      // Basic/HRA annualized from the regular (non-prorated) monthly
      // structure — not from this month's earningsLines, which on a
      // LOP/joining/exit month are prorated and would understate the HRA
      // exemption and 80CCD2 cap, over-deducting TDS that month. Falls back
      // to earningsLines only if the recurring structure couldn't be
      // resolved (recurringMonthlyEarnings returned undefined).
      const recurringBasicLine = recurringResults?.find(
        (e) => e.code === SALARY_COMPONENT_CODES.BASIC,
      );
      const recurringHraLine = recurringResults?.find(
        (e) => e.code === SALARY_COMPONENT_CODES.HRA,
      );
      const basicMonthly = recurringBasicLine
        ? roundAmount(recurringBasicLine.amount)
        : (earningsLines.find((e) => e.code === SALARY_COMPONENT_CODES.BASIC)
            ?.amount ?? 0);
      const hraMonthly = recurringHraLine
        ? roundAmount(recurringHraLine.amount)
        : (earningsLines.find((e) => e.code === SALARY_COMPONENT_CODES.HRA)
            ?.amount ?? 0);

      taxDetails = calculateTax({
        month,
        year,
        currentMonthGross: fs
          ? (fs.monthAlreadyPaid ? 0 : taxableForTax) + fs.extraTaxableEarnings
          : taxableForTax,
        finalMonth: !!fs,
        refundExcess: !!fs && settingsRow.refundExcessTdsOnExit,
        employmentMonthsInFY: employmentMonths,
        ageAtFYEnd: ageOnFYEnd(
          (employee.personalData as Record<string, unknown> | null)?.dob,
          financialYear,
        ),
        // Remaining months are projected from the regular monthly structure,
        // not from this month's actual (possibly prorated / one-off-inflated)
        // taxable gross.
        recurringMonthlyGross: (() => {
          const r = this.recurringMonthlyTaxableGross(
            recurringResults,
            roundAmount,
          );
          return r === undefined ? undefined : r + perquisiteMonthly;
        })(),
        ytdGross,
        ytdTDS,
        basicAnnual: basicMonthly * employmentMonths,
        hraReceivedAnnual: hraMonthly * employmentMonths,
        declaration,
        taxSlabConfig: {
          regime: taxSlabConfig.regime,
          standardDeduction: taxSlabConfig.standardDeduction,
          slabs: taxSlabConfig.slabs as unknown as TaxSlab[],
          surchargeSlabs: taxSlabConfig.surchargeSlabs as unknown as TaxSlab[],
          cessRate: taxSlabConfig.cessRate,
          rebate87ALimit: taxSlabConfig.rebate87ALimit,
          rebate87AAmount: taxSlabConfig.rebate87AAmount,
        },
        financialYearStartMonth: settings.financialYearStartMonth,
      });
      // No TDS withheld for a month with zero actual taxable gross (e.g. a
      // full month of LOP/0 payable days) — monthlyTDS here is computed by
      // spreading the employee's PROJECTED annual liability evenly across
      // remaining months (see calculateTax's recurringMonthlyGross usage),
      // independent of what was actually earned this specific month. Taking
      // a full month's TDS installment out of ₹0 earned produces a negative
      // net pay for no real income. Skipping it here doesn't lose the tax
      // due — the annualized calc naturally recovers it across the
      // remaining months once ytdGross/ytdTDS reflect this month as a gap.
      // A settlement always settles the year's tax (which may be a refund of excess withholding, a negative amount);
      // a regular month with no taxable pay withholds nothing.
      let incomeTaxAmount = fs
        ? taxDetails.monthlyTDS || 0
        : taxableGross > 0
          ? Math.max(0, taxDetails.monthlyTDS || 0)
          : 0;
      // Section 206AA (switch in Payroll Settings): no valid PAN -> at least 20% of the month's taxable pay.
      const panRaw = (employee.personalData as Record<string, unknown> | null)
        ?.panNumber;
      const validPan =
        typeof panRaw === 'string' &&
        /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panRaw.trim().toUpperCase());
      if (settingsRow.higherTdsWithoutPan && !validPan && taxableGross > 0) {
        incomeTaxAmount = Math.max(
          incomeTaxAmount,
          Math.round(taxableGross * 0.2),
        );
      }
      // What the tax details show for "this month's TDS" is what is actually deducted: a month with no taxable pay
      // withholds nothing, so it must not show the projected instalment.
      taxDetails.monthlyTDS = incomeTaxAmount;
      deductionsResults.push({
        code: SALARY_COMPONENT_CODES.INCOME_TAX,
        name: incomeTaxComponent.name,
        amount: incomeTaxAmount,
        component: incomeTaxComponent,
      });
      afterDeductions.INCOME_TAX = roundAmount(incomeTaxAmount);
    }

    // Same shape as the leave-encashment fold-in above: any ACTIVE loan/
    // advance whose repayment period has started gets its EMI (capped at
    // whatever's still outstanding, for the final installment) shown as a
    // deduction line here — read-only, nothing is persisted until the run
    // is locked (afterLock actually decrements the balance, same
    // calculate-is-a-preview-until-lock rule leave encashment follows).
    for (const { loan, amount } of await this.getDueLoanEmis(
      employeeId,
      month,
      year,
      organizationId,
    )) {
      deductionsResults.push({
        code: 'LOAN_EMI',
        name: `${loan.loanType === LoanType.ADVANCE ? 'Advance' : 'Loan'} EMI`,
        amount,
        sourceIds: [loan.id],
      });
    }

    // Round every deduction line exactly once, now that the group is fully
    // assembled (component-resolved + income tax + loan EMI) — same
    // rounding-order fix as earnings above, so totalDeductions and the
    // persisted `deductions` array always agree with each other.
    for (const d of deductionsResults) {
      d.amount = round(
        d.amount,
        settings.roundingRule,
        settings.roundingDecimals,
      );
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
      attendanceProration,
      roundAmount,
    );
    // Same rounding-order fix as earnings/deductions above.
    for (const e of employerResults) {
      e.amount = round(
        e.amount,
        settings.roundingRule,
        settings.roundingDecimals,
      );
    }
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
    // Fail safe rather than save (and later pay out) a negative net: the run's failures[] names the employee and
    // the amounts so HR can fix the cause (LOP correction, loan EMI, manual deduction) instead of finding a
    // negative payslip.
    if (netPay < 0 && !options?.finalSettlement) {
      throw new Error(
        `Net pay would be negative (gross ${grossSalary}, deductions ${totalDeductions}) — review this employee's deductions (loan EMI, manual deductions) or attendance before running payroll.`,
      );
    }
    const ctcMonthly = round(
      grossSalary + totalEmployerContributions,
      settings.roundingRule,
      settings.roundingDecimals,
    );

    const result: CalculatedPayroll = {
      attendanceSummary,
      // earningsLines/deductionsResults/employerResults are already
      // rounded (see the comments where each is built) — mapped here
      // as-is rather than rounded a second time, so these are exactly the
      // line amounts the gross/deduction/employer totals below were summed
      // from.
      // deductions carries only the lines that make up totalDeductions. The
      // payslip prints this array against run.totalDeductions, so listing an
      // includeInNet:false line here (while the total left it out) made the
      // printed column stop adding up to its own printed total.
      earnings: earningsLines.map((e) => ({
        code: e.code,
        name: e.name,
        amount: e.amount,
        taxable: e.taxable,
        ...(e.sourceIds ? { sourceIds: e.sourceIds } : {}),
        ...(e.note ? { note: e.note } : {}),
        ...(e.cycleKey ? { cycleKey: e.cycleKey } : {}),
      })),
      deductions: includedDeductions.map((d) => ({
        code: d.code,
        name: d.name,
        amount: d.amount,
        ...(d.sourceIds ? { sourceIds: d.sourceIds } : {}),
      })),
      employerContributions: employerResults.map((e) => ({
        code: e.code,
        name: e.name,
        amount: e.amount,
        ...(e.code === SALARY_COMPONENT_CODES.PF_EMPLOYER
          ? {
              breakup: splitEmployerPf(e.amount, afterEarnings, settings),
              wages: Math.min(
                afterEarnings.PF_WAGES ?? 0,
                settings.pfWageCeiling,
              ),
            }
          : {}),
        ...(e.code === 'ESI_EMPLOYER'
          ? {
              wages:
                afterEarnings.ESI_WAGES ?? afterEarnings.GROSS_EARNINGS ?? 0,
            }
          : {}),
      })),
      taxDetails,
      grossSalary,
      taxableGross: taxableForTax,
      totalDeductions,
      totalEmployerContributions,
      netPay,
      ctcMonthly,
      financialYear,
      heldVariablePay,
    };
    // Last line of defence: never hand back a snapshot that would save (and
    // later pay) NaN/Infinity. Thrown as a per-employee error so it lands in
    // calculate()'s failures[] like any other misconfiguration.
    const badField = nonFiniteMoneyField(result);
    if (badField || !Number.isFinite(taxableGross)) {
      throw new Error(
        `Payroll calculation produced a non-numeric amount (${badField ?? 'taxableGross'}) — check this employee's salary component formulas.`,
      );
    }
    return result;
  }

  // "Today" (YYYY-MM-DD) in the organization's own timezone.
  private async orgToday(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
  }

  // Payroll for a month that has not started would pay for days that have not happened at all.
  private assertMonthStarted(month: number, year: number, today: string) {
    if (`${year}-${String(month).padStart(2, '0')}-01` > today) {
      throw new BadRequestException(
        `Payroll cannot be run for ${month}/${year} yet - that month has not started.`,
      );
    }
  }

  async draft(dto: DraftPayrollDto, actor: Actor, organizationId: string) {
    const today = await this.orgToday(organizationId);
    this.assertMonthStarted(dto.month, dto.year, today);
    const skipped: {
      employeeId: string;
      name: string;
      code: string;
      reason: string;
    }[] = [];
    const employees = (
      await this.targetEmployees(
        dto.employeeId,
        organizationId,
        dto.excludeEmployeeIds,
      )
    ).filter((e) => {
      const reason = notOnPayrollReason(
        e.joiningDate,
        dto.month,
        dto.year,
        today,
      );
      if (reason) {
        skipped.push({
          employeeId: e.id,
          name: e.name,
          code: e.employeeId,
          reason,
        });
      }
      return !reason;
    });

    // One batched existence check instead of one findFirst per employee,
    // then one batched createMany for whoever's missing a row — 3 queries
    // total regardless of employee count, instead of up to 2N.
    const existing = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        month: dto.month,
        year: dto.year,
        isFinalSettlement: false,
      },
    });
    const existingByEmployeeId = new Map(
      existing.map((r) => [r.employeeId, r]),
    );
    const missing = employees.filter((e) => !existingByEmployeeId.has(e.id));
    if (missing.length > 0) {
      await this.scopedPrisma.payrollRun.createMany({
        data: missing.map((employee) => ({
          organizationId,
          employeeId: employee.id,
          month: dto.month,
          year: dto.year,
          status: PayrollRunStatus.DRAFT,
        })),
      });
    }
    const runs =
      missing.length > 0
        ? await this.scopedPrisma.payrollRun.findMany({
            where: {
              organizationId,
              employeeId: { in: employees.map((e) => e.id) },
              month: dto.month,
              year: dto.year,
              isFinalSettlement: false,
            },
          })
        : existing;

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_DRAFT_CREATED',
      module: 'PAYROLL',
      organizationId,
      details: { month: dto.month, year: dto.year, count: runs.length },
    });
    return {
      count: runs.length,
      // How many of them were created by this call; the rest already had a row for the month.
      created: missing.length,
      skipped,
      runs,
    };
  }

  async calculate(
    dto: CalculatePayrollDto,
    actor: Actor,
    organizationId: string,
  ) {
    const today = await this.orgToday(organizationId);
    this.assertMonthStarted(dto.month, dto.year, today);
    const employees = await this.targetEmployees(
      dto.employeeId,
      organizationId,
      dto.excludeEmployeeIds,
    );
    const results: PayrollRun[] = [];
    const failures: {
      employeeId: string;
      name: string;
      code: string;
      message: string;
    }[] = [];
    const skipped: {
      employeeId: string;
      name: string;
      code: string;
      reason: string;
    }[] = [];

    // One batched existence check instead of one findFirst per employee —
    // the per-employee calculatePayroll()/create/update below still has to
    // run individually (real computation, and one employee's failure must
    // not abort the batch), but the lookup itself no longer is N+1.
    const existingRuns = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        month: dto.month,
        year: dto.year,
        isFinalSettlement: false,
      },
    });
    const existingRunByEmployeeId = new Map(
      existingRuns.map((r) => [r.employeeId, r]),
    );

    // Department names for the payslip snapshot (PayrollRun.departmentName) — one batched lookup.
    const departmentIds = [
      ...new Set(
        employees.map((e) => e.departmentId).filter((d): d is string => !!d),
      ),
    ];
    const departmentNameById = new Map(
      (
        await this.scopedPrisma.department.findMany({
          where: { organizationId, id: { in: departmentIds } },
          select: { id: true, name: true },
        })
      ).map((d) => [d.id, d.name]),
    );

    // Bounded concurrency, not fully sequential — each employee's
    // calculatePayroll() does several DB round-trips, and a few hundred
    // employees awaited one at a time in a single request is a real
    // timeout risk. Order-independent (results/failures are per-employee,
    // not accumulated), and results.push/failures.push from concurrent
    // workers is safe — JS has no true parallelism, so a synchronous
    // array push is never interleaved by another worker mid-operation.
    await mapWithConcurrency(employees, 8, async (employee) => {
      // Not employed yet: no payroll for a month that ended before the joining date.
      const notOnPayroll = notOnPayrollReason(
        employee.joiningDate,
        dto.month,
        dto.year,
        today,
      );
      if (notOnPayroll) {
        skipped.push({
          employeeId: employee.id,
          name: employee.name,
          code: employee.employeeId,
          reason: notOnPayroll,
        });
        // A row made for this month before the joining date was known (or corrected) is meaningless; drop it unless
        // it has already moved past calculation.
        const stale = existingRunByEmployeeId.get(employee.id);
        if (
          stale &&
          (stale.status === PayrollRunStatus.DRAFT ||
            stale.status === PayrollRunStatus.CALCULATED)
        ) {
          await this.scopedPrisma.payrollRun.deleteMany({
            where: { id: stale.id, organizationId },
          });
        }
        return;
      }
      let run = existingRunByEmployeeId.get(employee.id) ?? null;
      if (
        run &&
        (run.status === PayrollRunStatus.APPROVED ||
          run.status === PayrollRunStatus.LOCKED ||
          run.status === PayrollRunStatus.PAID)
      ) {
        // Not recalculated — reported in skipped[] so callers can tell a
        // no-op from a real recalculation. Still included in payrolls/count
        // for backward compatibility.
        results.push(run);
        skipped.push({
          employeeId: employee.id,
          name: employee.name,
          code: employee.employeeId,
          reason: `Payroll run is ${run.status} — not recalculated.`,
        });
        return;
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
        const badField = nonFiniteMoneyField(calc);
        if (badField) {
          throw new Error(
            `Payroll calculation produced a non-numeric amount (${badField}) — not saved.`,
          );
        }
        // Issued once (stable across recalculation before lock) from the
        // org's documentNumbering.payslip config — a short transaction
        // just for the row-locked issue, not the whole calculation.
        const payslipNumber =
          run?.payslipNumber ??
          (await this.scopedPrisma.$transaction((tx) =>
            // The number's date is the last day of the payroll month, not the day it was calculated.
            issueDocumentNumber(
              tx,
              organizationId,
              'payslip',
              new Date(dto.year, dto.month, 0),
            ),
          ));
        const data = {
          financialYear: calc.financialYear,
          status: PayrollRunStatus.CALCULATED,
          payslipNumber,
          attendanceSummary:
            calc.attendanceSummary as unknown as Prisma.InputJsonValue,
          earnings: calc.earnings as unknown as Prisma.InputJsonValue,
          deductions: calc.deductions as unknown as Prisma.InputJsonValue,
          employerContributions:
            calc.employerContributions as unknown as Prisma.InputJsonValue,
          taxDetails: calc.taxDetails
            ? (calc.taxDetails as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          heldVariablePay:
            calc.heldVariablePay as unknown as Prisma.InputJsonValue,
          grossSalary: calc.grossSalary,
          taxableGross: calc.taxableGross,
          totalDeductions: calc.totalDeductions,
          totalEmployerContributions: calc.totalEmployerContributions,
          netPay: calc.netPay,
          ctcMonthly: calc.ctcMonthly,
          netPayInWords: amountInWords(calc.netPay),
          calculatedAt: new Date(),
          calculatedById: actor.id,
          // Point-in-time snapshot for the payslip (falls back to live values on older runs).
          designation: employee.designation,
          gradeLevel: employee.gradeLevel,
          departmentName: employee.departmentId
            ? (departmentNameById.get(employee.departmentId) ?? null)
            : null,
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
          try {
            run = await this.scopedPrisma.payrollRun.create({
              data: {
                organizationId,
                employeeId: employee.id,
                month: dto.month,
                year: dto.year,
                ...data,
              },
            });
          } catch (createErr) {
            // Two concurrent calculate() calls for the same employee+period
            // can both pass the existingRunByEmployeeId lookup above with no
            // row yet (it's a single findMany taken before this loop, not a
            // lock), then both reach this create() — the
            // @@unique([employeeId, month, year, isFinalSettlement])
            // constraint lets exactly one win; the loser landed here with a
            // raw Prisma constraint-violation error (a stack trace
            // including a local filesystem path) that would otherwise leak
            // straight into the API response's failures[].message. Treat
            // the loss as "someone else just created it" and fall back to
            // updating that row with this call's freshly computed data,
            // same as the `run` (recalculation) branch above — a real
            // upsert instead of a surfaced 500-shaped failure.
            if (
              createErr instanceof Prisma.PrismaClientKnownRequestError &&
              createErr.code === 'P2002'
            ) {
              const winner = await this.scopedPrisma.payrollRun.findFirst({
                where: {
                  organizationId,
                  employeeId: employee.id,
                  month: dto.month,
                  year: dto.year,
                  isFinalSettlement: false,
                },
              });
              if (!winner) throw createErr;
              await this.scopedPrisma.payrollRun.updateMany({
                where: { id: winner.id, organizationId },
                data,
              });
              run = await this.scopedPrisma.payrollRun.findFirstOrThrow({
                where: { id: winner.id, organizationId },
              });
            } else {
              throw createErr;
            }
          }
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
    });

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
        skipped: skipped.length,
      },
    });
    // Heads-up (never blocks): details the payslip and the payout need that an employee has not filled in yet.
    const warnings = employees
      .filter((e) => results.some((r) => r.employeeId === e.id))
      .map((e) => {
        const pd = (e.personalData ?? {}) as Record<string, unknown>;
        const has = (key: string) =>
          typeof pd[key] === 'string' && (pd[key] as string).trim() !== '';
        const missing = [
          !has('bankAccountNo') && 'Bank account number',
          !has('bankIFSC') && 'IFSC code',
          !has('panNumber') && 'PAN',
        ].filter((m): m is string => !!m);
        return {
          employeeId: e.id,
          name: e.name,
          code: e.employeeId,
          missing,
        };
      })
      .filter((w) => w.missing.length > 0);
    return {
      count: results.length,
      payrolls: results,
      failures,
      skipped,
      warnings,
    };
  }

  async findAll(query: QueryPayrollDto, actor: Actor, organizationId: string) {
    const where: Prisma.PayrollRunWhereInput = {
      organizationId,
      isFinalSettlement: false,
    };
    if (query.month) where.month = query.month;
    if (query.year) where.year = query.year;
    if (query.status) where.status = query.status;

    // Only the employee themself (EMPLOYEE or MANAGER acting as an employee), HR and ADMIN may read payslips —
    // a manager never sees their reports' payslips.
    if (actor.role === Role.EMPLOYEE || actor.role === Role.MANAGER) {
      where.employeeId = actor.id;
      where.status = {
        in: query.status
          ? EMPLOYEE_VISIBLE_STATUSES.filter((st) => st === query.status)
          : EMPLOYEE_VISIBLE_STATUSES,
      };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }

    return paginate(
      () =>
        this.scopedPrisma.payrollRun.findMany({
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
          orderBy: [
            ...EMPLOYEE_RELATION_ORDER_BY,
            { year: 'desc' },
            { month: 'desc' },
          ],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.payrollRun.count({ where }),
      query.page,
      query.limit,
    );
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
    if (
      (actor.role === Role.EMPLOYEE || actor.role === Role.MANAGER) &&
      run.employeeId !== actor.id
    ) {
      throw new ForbiddenException('Not authorized to view this payslip.');
    }
    if (
      (actor.role === Role.EMPLOYEE || actor.role === Role.MANAGER) &&
      !EMPLOYEE_VISIBLE_STATUSES.includes(run.status)
    ) {
      throw new NotFoundException('Payslip not found.');
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
  // finalized. Not allowed once approved/locked/paid (unlock a locked/paid
  // run first). Editing an already-verified run invalidates that sign-off,
  // so it drops back to CALCULATED for re-review rather than silently
  // keeping a stale verification on changed numbers.
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
    assertNotOwnPayroll(actor, run.employeeId, 'edit');
    if (
      run.status === PayrollRunStatus.APPROVED ||
      run.status === PayrollRunStatus.LOCKED ||
      run.status === PayrollRunStatus.PAID
    ) {
      throw new BadRequestException(
        'This payroll is approved/locked/paid — it can no longer be edited (unlock a locked/paid run first).',
      );
    }

    // A manual LOP correction re-runs the whole calculation engine against
    // the corrected day count, so the resulting earnings/deductions/tax/
    // employer contributions are what calculate() itself would have
    // produced had attendance genuinely shown that many LOP days — not
    // just a relabeled day count with stale money still attached to it.
    // dto.earnings/dto.deductions (if also sent in the same request) still
    // apply on top of that recalculation, same as they would on top of the
    // run's existing figures below.
    const recalculated =
      dto.lopDaysOverride !== undefined
        ? await this.calculatePayroll(
            run.employeeId,
            run.month,
            run.year,
            organizationId,
            { lopDaysOverride: dto.lopDaysOverride },
          )
        : null;
    const baselineEarnings = (recalculated?.earnings ??
      run.earnings) as unknown as PayrollLineDto[];
    const baselineDeductions = (recalculated?.deductions ??
      run.deductions) as unknown as PayrollLineDto[];

    // The org's configured rounding rule/decimals — not a hardcoded
    // 'nearest'/2 — so a manually-adjusted run rounds the same way a
    // normally-calculated one does (calculate() resolves this same
    // ROUNDING override via applyStatutoryOverrides).
    const settingsRow =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const { version: roundingVersion } =
      await this.statutoryConfigService.getEffective(
        StatutoryModule.ROUNDING,
        lastDayOfMonth(run.month, run.year),
        organizationId,
      );
    const roundingConfig = roundingVersion?.config as
      { rule: string; decimals: number } | undefined;
    const roundingRule = roundingConfig?.rule ?? settingsRow.roundingRule;
    const roundingDecimals =
      roundingConfig?.decimals ?? settingsRow.roundingDecimals;
    const roundTwo = (n: number) => round(n, roundingRule, roundingDecimals);

    // An edited line that doesn't say whether it's taxable keeps the flag the
    // baseline line with the same code had, so the run's taxableGross (the
    // YTD income-tax base) doesn't silently change on a manual correction.
    const previousTaxable = new Map(
      baselineEarnings.map((e) => [e.code, e.taxable]),
    );
    const earnings: PayrollLineDto[] = dto.earnings
      ? dto.earnings.map((e) => {
          const taxable = e.taxable ?? previousTaxable.get(e.code);
          return {
            ...e,
            amount: roundTwo(e.amount),
            ...(taxable !== undefined ? { taxable } : {}),
          };
        })
      : baselineEarnings;
    const deductions: PayrollLineDto[] = dto.deductions
      ? dto.deductions.map((d) => ({ ...d, amount: roundTwo(d.amount) }))
      : baselineDeductions;

    const grossSalary = roundTwo(
      earnings.reduce((s, e) => s + Number(e.amount || 0), 0),
    );
    const totalDeductions = roundTwo(
      deductions.reduce((s, d) => s + Number(d.amount || 0), 0),
    );
    const netPay = roundTwo(grossSalary - totalDeductions);
    // ctcMonthly = grossSalary + employer contributions. Employer
    // contributions aren't part of this DTO directly, but a recalculation
    // refreshes them too (PF/ESI employer-side amounts move with payable
    // days the same way the employee-side ones do) — otherwise they just
    // carry over from the run unchanged, as before.
    const totalEmployerContributions =
      recalculated?.totalEmployerContributions ??
      run.totalEmployerContributions;
    const ctcMonthly = roundTwo(grossSalary + totalEmployerContributions);

    const data: Prisma.PayrollRunUpdateManyMutationInput = {
      earnings: earnings as unknown as Prisma.InputJsonValue,
      deductions: deductions as unknown as Prisma.InputJsonValue,
      grossSalary,
      taxableGross: roundTwo(
        earnings
          .filter((e) => e.taxable !== false)
          .reduce((s, e) => s + Number(e.amount || 0), 0),
      ),
      totalDeductions,
      netPay,
      ctcMonthly,
      netPayInWords: amountInWords(netPay),
    };
    if (run.status === PayrollRunStatus.VERIFIED) {
      data.status = PayrollRunStatus.CALCULATED;
    }
    if (recalculated) {
      data.attendanceSummary =
        recalculated.attendanceSummary as unknown as Prisma.InputJsonValue;
      data.employerContributions = recalculated.employerContributions;
      data.totalEmployerContributions = roundTwo(totalEmployerContributions);
      data.taxDetails = recalculated.taxDetails
        ? (recalculated.taxDetails as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull;
      // A manual LOP correction re-runs the whole engine, so which variable
      // pay is on hold can change with it (see applyVariablePay).
      data.heldVariablePay =
        recalculated.heldVariablePay as unknown as Prisma.InputJsonValue;
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
      details: {
        netPay,
        reason: dto.reason ?? '',
        ...(dto.lopDaysOverride !== undefined
          ? { lopDaysOverride: dto.lopDaysOverride }
          : {}),
      },
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
      // Already delivered for this version of the payslip (unlocking clears the marker) — don't notify twice.
      if (run.payslipEmailSentAt) return;

      const revised = !!run.unlockedAt;
      const title = revised
        ? `Revised payslip for ${run.month}/${run.year}`
        : `Payslip for ${run.month}/${run.year}`;
      const message = revised
        ? `Your payslip for ${run.month}/${run.year} was corrected and re-issued. Net pay: ${run.netPay}.`
        : `Your salary for ${run.month}/${run.year} has been paid. Net pay: ${run.netPay}.`;

      // In-app notification is a fast DB write — always synchronous, the
      // employee should see it immediately regardless of queue state.
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.PAYROLL,
      });

      // PDF rendering + email delivery are the slow/flaky part — queued
      // via BullMQ when REDIS_URL is configured (PayslipEmailWorker does
      // the actual build+send off the request thread, with retries).
      // Falls back to doing it inline here, exactly as before, when the
      // queue isn't configured — same opt-in-with-unchanged-fallback
      // pattern as every other driver in this codebase.
      const queued = await this.payslipEmailQueueService.enqueue({
        runId: run.id,
        organizationId,
      });
      if (!queued) {
        const { buffer, filename } =
          await this.payslipPdfService.buildPayslipPdfBuffer(
            run.id,
            organizationId,
          );
        const rendered = await this.emailTemplatesService.renderOccasion(
          organizationId,
          'PAYSLIP_ISSUED',
          {
            employeeName: employee.name,
            month: String(run.month),
            year: String(run.year),
            netPay: String(run.netPay),
          },
          { subject: title, html: message },
        );
        await this.emailService.send({
          organizationId,
          to: employee.email,
          subject: rendered.subject,
          html: rendered.html,
          attachments: [{ filename, content: buffer }],
        });
        // Same idempotency marker the queue worker sets, so both delivery modes record that it was sent.
        await this.scopedPrisma.payrollRun.updateMany({
          where: { id: run.id, organizationId },
          data: { payslipEmailSentAt: new Date() },
        });
      }
    } catch (err) {
      // Never fails the payment (it has already committed) — but a failed payslip e-mail must not vanish silently.
      new Logger(PayrollService.name).warn(
        `Payslip notification/e-mail for run ${run.id} failed: ${(err as Error).message}`,
      );
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
    assertNotOwnPayroll(actor, run.employeeId, 'unlock');
    if (
      run.status !== PayrollRunStatus.LOCKED &&
      run.status !== PayrollRunStatus.PAID
    ) {
      throw new BadRequestException(
        'Only locked or paid payroll can be unlocked.',
      );
    }
    // Salary already marked PAID has left the building — only an Admin may reopen it.
    if (run.status === PayrollRunStatus.PAID && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only an Admin can unlock payroll that is already marked as paid.',
      );
    }

    // Unlocking takes this run's loan EMIs back. That is only possible while they are the loan's latest repayment; if
    // something was recorded after them the balance cannot be restored safely, and the unlock used to go ahead anyway
    // leaving the loan charged. Refuse it instead, saying why.
    await this.assertLoanRepaymentsReversible(run, organizationId);

    await this.scopedPrisma.payrollRun.updateMany({
      where: { id, organizationId },
      data: {
        status: PayrollRunStatus.CALCULATED,
        unlockedById: actor.id,
        unlockedAt: new Date(),
        unlockReason: dto.reason.trim(),
        // Back to Calculated means none of the later steps have happened any more: leaving their dates behind showed
        // an old Pay Date on the payslip of a run that is not paid (the audit log keeps the history).
        verifiedAt: null,
        verifiedById: null,
        approvedAt: null,
        approvedById: null,
        lockedAt: null,
        lockedById: null,
        paidAt: null,
        paidById: null,
        // A corrected payslip is a new payslip: allow the e-mail to go out again when it is re-paid.
        payslipEmailSentAt: null,
      },
    });
    const updated = await this.scopedPrisma.payrollRun.findFirstOrThrow({
      where: { id, organizationId },
    });
    const reversal = await this.undoAfterLock(run, organizationId, actor.id);
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PAYROLL_UNLOCKED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        reason: dto.reason.trim(),
        previousStatus: run.status,
        reversedLoanRepayments: reversal.reversedLoanRepaymentIds,
        revertedLeaveEncashments: reversal.revertedEncashmentIds,
      },
    });
    // The employee was already paid and sent this payslip: tell them it has been taken back and a corrected one will follow.
    if (run.status === PayrollRunStatus.PAID) {
      await this.notifyPayslipWithdrawn(run, organizationId);
    }
    return updated;
  }

  private async assertLoanRepaymentsReversible(
    run: PayrollRun,
    organizationId: string,
  ): Promise<void> {
    const repayments = await this.scopedPrisma.loanRepayment.findMany({
      where: { organizationId, payrollRunId: run.id },
    });
    for (const repayment of repayments) {
      const latest = await this.scopedPrisma.loanRepayment.findFirst({
        where: { organizationId, loanId: repayment.loanId },
        orderBy: { createdAt: 'desc' },
      });
      if (latest && latest.id !== repayment.id) {
        throw new BadRequestException(
          `This payroll cannot be unlocked: the loan EMI of ${repayment.amount} taken in it cannot be reversed because a later repayment (${latest.month}/${latest.year}, ${latest.amount}) was recorded on the same loan. Unlock the later payroll first.`,
        );
      }
    }
  }

  // Tells the employee that a payslip they already received has been withdrawn for correction. Never fails the unlock
  // (it has committed): a failed notification is only logged.
  private async notifyPayslipWithdrawn(
    run: PayrollRun,
    organizationId: string,
  ) {
    try {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: run.employeeId, organizationId },
      });
      if (!employee) return;
      const title = `Payslip for ${run.month}/${run.year} withdrawn`;
      const message = `The payslip for ${run.month}/${run.year} that you received earlier has been withdrawn for correction. Please disregard it; a revised payslip will be issued to you.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.PAYROLL,
      });
      void this.emailService.send({
        organizationId,
        to: employee.email,
        subject: title,
        html: `<p>Hi ${employee.name},</p><p>${message}</p>`,
      });
    } catch (err) {
      new Logger(PayrollService.name).warn(
        `Payslip-withdrawn notification for run ${run.id} failed: ${(err as Error).message}`,
      );
    }
  }

  // Symmetric undo of afterLock()'s side effects, scoped to exactly this
  // run (by payrollRunId) — called whenever a LOCKED/PAID run is unlocked,
  // so "unlock to fix something, then recalculate" doesn't leave stale
  // financial state behind: previously neither the loan EMI nor the leave
  // encashment afterLock() had charged/processed for this run was ever
  // reversed, so (a) relocking the same run recharged the same loan EMI a
  // second time (draining an extra installment off the real balance for
  // one calendar month), and (b) the recalculated preview silently lost
  // the encashment payout from its total (it had already flipped to
  // PROCESSED and dropped out of the "pending, APPROVED" query afterLock
  // itself reads), with no error or indication of why net pay just
  // dropped.
  private async undoAfterLock(
    run: PayrollRun,
    organizationId: string,
    actorId: string,
  ): Promise<{
    reversedLoanRepaymentIds: string[];
    revertedEncashmentIds: string[];
  }> {
    const revertedEncashments =
      await this.scopedPrisma.leaveEncashment.findMany({
        where: {
          organizationId,
          payrollRunId: run.id,
          status: LeaveEncashmentStatus.PROCESSED,
        },
      });
    if (revertedEncashments.length > 0) {
      await this.scopedPrisma.leaveEncashment.updateMany({
        where: {
          organizationId,
          payrollRunId: run.id,
          status: LeaveEncashmentStatus.PROCESSED,
        },
        data: {
          status: LeaveEncashmentStatus.APPROVED,
          payrollRunId: null,
          processedAt: null,
        },
      });
    }

    const repayments = await this.scopedPrisma.loanRepayment.findMany({
      where: { organizationId, payrollRunId: run.id },
    });
    const reversedLoanRepaymentIds: string[] = [];
    for (const repayment of repayments) {
      await this.scopedPrisma.$transaction(async (tx) => {
        const loan = await tx.loan.findFirst({
          where: { id: repayment.loanId, organizationId },
        });
        if (!loan) return;
        // Only safe to reverse if no later repayment has been recorded
        // against this same loan since — otherwise restoring the balance
        // by simply adding back this repayment's principalComponent could
        // land on the wrong number relative to whatever happened after it.
        // This shouldn't occur for the ordinary same-month unlock/relock
        // flow this exists for; it's a defensive backstop, not the
        // expected path.
        const latest = await tx.loanRepayment.findFirst({
          where: { organizationId, loanId: loan.id },
          orderBy: { createdAt: 'desc' },
        });
        if (latest?.id !== repayment.id) return;

        const restoredBalance =
          loan.outstandingBalance + repayment.principalComponent;
        await tx.loan.updateMany({
          where: { id: loan.id, organizationId },
          data: {
            outstandingBalance: restoredBalance,
            status:
              loan.status === LoanStatus.CLOSED
                ? LoanStatus.ACTIVE
                : loan.status,
          },
        });
        await tx.loanRepayment.deleteMany({
          where: { id: repayment.id, organizationId },
        });
        reversedLoanRepaymentIds.push(repayment.id);
      });
    }

    if (reversedLoanRepaymentIds.length > 0) {
      await this.auditLogService.log({
        actorId,
        action: 'LOAN_REPAYMENT_REVERSED',
        module: 'PAYROLL',
        organizationId,
        targetId: run.id,
        details: { repaymentIds: reversedLoanRepaymentIds },
      });
    }

    return {
      reversedLoanRepaymentIds,
      revertedEncashmentIds: revertedEncashments.map((e) => e.id),
    };
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
    skipped: TransitionSkip[];
  }> {
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { id: { in: runIds }, organizationId },
    });
    // Earliest month first, so a one-off payment (leave encashment) is claimed by the month it belongs to.
    runs.sort((a, b) => a.year - b.year || a.month - b.month);
    const byId = new Map(runs.map((r) => [r.id, r]));
    const skipped: TransitionSkip[] = [];
    for (const id of runIds) {
      if (!byId.has(id)) skipped.push({ id, status: 'not_found' });
    }

    const updated: PayrollRun[] = [];
    // Encashments already claimed by a run locked earlier in this same batch (they only turn PROCESSED after the batch).
    const claimedEncashments = new Set<string>();
    for (const run of runs) {
      if (!config.fromStatuses.includes(run.status)) {
        skipped.push({ id: run.id, status: run.status });
        continue;
      }
      // A payroll run that would pay a negative amount (e.g. a full-LOP
      // month with a loan EMI still due) is blocked from progressing any
      // further — "paying" a negative salary isn't a meaningful instruction
      // to a bank/payroll processor. unlock() is unaffected (it's a
      // separate method, never routed through transitionMany), so a run
      // stuck here can still be unlocked/recalculated to fix the
      // underlying deduction/attendance issue.
      //
      // A NaN/Infinity figure is blocked the same way — `NaN < 0` is false, so
      // the negative check alone let a non-numeric payslip through to paid.
      // Separation of duties (Admin exempt): nobody but an Admin signs off their own payslip, and approval / payment
      // must come from someone other than the person who calculated, verified or approved the run.
      if (actor.role !== Role.ADMIN) {
        let blocked: string | null = null;
        if (run.employeeId === actor.id) {
          blocked = `You cannot ${config.toStatus === PayrollRunStatus.VERIFIED ? 'verify' : config.toStatus === PayrollRunStatus.APPROVED ? 'approve' : config.toStatus === PayrollRunStatus.LOCKED ? 'lock' : 'pay'} your own payslip. Another HR user or an Admin must do it.`;
        } else if (
          config.toStatus === PayrollRunStatus.APPROVED &&
          (run.calculatedById === actor.id || run.verifiedById === actor.id)
        ) {
          blocked =
            'This run must be approved by someone other than the person who calculated or verified it.';
        } else if (
          config.toStatus === PayrollRunStatus.PAID &&
          run.approvedById === actor.id
        ) {
          blocked =
            'This run must be paid by someone other than the person who approved it.';
        }
        if (blocked) {
          skipped.push({
            id: run.id,
            status: 'separation_of_duties',
            reason: blocked,
          });
          continue;
        }
      }
      const badField = nonFiniteMoneyField(run);
      if (badField) {
        skipped.push({
          id: run.id,
          status: 'non_finite_amount',
          reason: `This payroll run has a non-numeric amount (${badField}) — recalculate it before it can proceed.`,
        });
        continue;
      }
      if (run.netPay < 0) {
        skipped.push({ id: run.id, status: 'negative_net_pay' });
        continue;
      }
      // A run with nothing to pay is not something to sign off: it is what an employee with no salary structure (or a
      // month that has not been worked) calculates to. Recalculate it first.
      if (
        config.toStatus === PayrollRunStatus.VERIFIED &&
        run.grossSalary <= 0
      ) {
        skipped.push({
          id: run.id,
          status: 'zero_gross',
          reason:
            "This payroll run has no earnings (gross is 0) - check the employee's salary structure and attendance, then recalculate it before verifying.",
        });
        continue;
      }
      if (config.toStatus === PayrollRunStatus.LOCKED) {
        const loanProblem = await this.staleLoanEmiReason(run, organizationId);
        const lockProblem =
          loanProblem ??
          (await this.staleEncashmentReason(
            run,
            organizationId,
            claimedEncashments,
          ));
        if (lockProblem) {
          // An APPROVED run can't otherwise be recalculated (calculate() and
          // adjust() both leave approved runs alone, and unlock() needs a
          // LOCKED one), so the stale sign-off is dropped — the same way
          // adjust() demotes an edited VERIFIED run — to make "recalculate"
          // actually possible.
          await this.scopedPrisma.payrollRun.updateMany({
            where: {
              id: run.id,
              organizationId,
              status: PayrollRunStatus.APPROVED,
            },
            data: { status: PayrollRunStatus.CALCULATED },
          });
          await this.auditLogService.log({
            actorId: actor.id,
            action: 'PAYROLL_LOCK_REFUSED',
            module: 'PAYROLL',
            organizationId,
            targetId: run.id,
            details: { reason: lockProblem },
          });
          skipped.push({
            id: run.id,
            status: loanProblem ? 'loan_emi_stale' : 'encashment_stale',
            reason: `${lockProblem} It has been moved back to Calculated so it can be recalculated.`,
          });
          continue;
        }
      }

      const data: Prisma.PayrollRunUpdateManyMutationInput = {
        status: config.toStatus,
        [config.actorField]: actor.id,
        [config.atField]: new Date(),
      };
      // Guarded compare-and-swap, done per-run rather than batched across
      // `eligibleIds`: the old batched updateMany's `where` never
      // re-asserted fromStatuses, so two concurrent transitions on the
      // same run (double-click, or two admins acting on the same batch)
      // could both report success — and since verify/approve/lock/pay
      // each drive real side effects (lock charges loan EMIs and marks
      // leave encashments processed; pay emails a payslip), a "successful"
      // second caller meant those side effects could double-fire even
      // though the DB row only actually flipped once. Only the request
      // whose updateMany actually matches a row (count > 0) is reported
      // back as updated — everyone else sees a clean skip instead of a
      // false success.
      const { count } = await this.scopedPrisma.payrollRun.updateMany({
        where: {
          id: run.id,
          organizationId,
          status: { in: config.fromStatuses },
        },
        data,
      });
      if (count === 0) {
        const current = await this.scopedPrisma.payrollRun.findFirst({
          where: { id: run.id, organizationId },
        });
        skipped.push({ id: run.id, status: current?.status ?? 'unknown' });
        continue;
      }
      const fresh = await this.scopedPrisma.payrollRun.findFirstOrThrow({
        where: { id: run.id, organizationId },
      });
      updated.push(fresh);
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
      if (skipped[0]?.status === 'negative_net_pay') {
        throw new BadRequestException(
          'This payroll run has a negative net pay — adjust the underlying deductions or attendance before it can proceed.',
        );
      }
      if (skipped[0]?.reason) {
        throw new BadRequestException(skipped[0].reason);
      }
      throw new BadRequestException(
        `Cannot move payroll from "${skipped[0].status}" to "${config.toStatus}".`,
      );
    }
    return updated[0];
  }

  // Locking freezes the calculation, so everything settled here must be
  // settled against what this run's LOCKED payslip actually contains — not
  // against whatever the world looks like at lock time.
  //
  // Both halves used to re-query live state instead, which broke whenever
  // something changed in the calculate -> lock window:
  //   * an encashment approved after calculate was marked PROCESSED against
  //     a payslip that never paid it, so the employee never got the money;
  //   * a loan that became due after calculate had a real EMI charged
  //     against its balance with no matching line on the locked payslip.
  // The calculate step now records the source row ids on the lines it
  // builds (see ResolvedLine.sourceIds), and this reads them back.
  private async afterLock(run: PayrollRun, organizationId: string) {
    const earnings = (run.earnings ?? []) as unknown as PayrollLineRecord[];
    const deductions = (run.deductions ?? []) as unknown as PayrollLineRecord[];

    const encashmentLine = earnings.find((e) => e.code === 'LEAVE_ENCASHMENT');
    if (encashmentLine) {
      await this.scopedPrisma.leaveEncashment.updateMany({
        where: {
          organizationId,
          employeeId: run.employeeId,
          status: LeaveEncashmentStatus.APPROVED,
          // Runs calculated before sourceIds existed have none; fall back to
          // the old "every approved row" behaviour for those rather than
          // silently paying an encashment line and processing nothing.
          ...(encashmentLine.sourceIds
            ? { id: { in: encashmentLine.sourceIds } }
            : {}),
        },
        data: {
          status: LeaveEncashmentStatus.PROCESSED,
          payrollRunId: run.id,
          processedAt: new Date(),
        },
      });
    }

    // Actually deduct each loan/advance EMI now that the run is locked (not
    // at calculate — a recalculation before lock must stay a free preview,
    // same reasoning as leave encashment above). Reuses
    // LoansService.recordRepayment so the balance-decrement/auto-close-at-
    // zero logic lives in exactly one place, not duplicated here.
    //
    // Idempotent per (loan, payrollRunId): unlocking and re-locking the
    // *same* run (e.g. to fix an attendance mistake) re-runs afterLock()
    // from scratch — without this check, every relock recharged the same
    // EMI again, silently draining the loan balance an extra time per
    // relock. unlock() reverses this run's repayments (see undoAfterLock
    // below), so in the normal unlock-fix-relock flow this guard never
    // actually skips anything real; it only protects against a relock
    // that, for whatever reason, runs before the reversal has landed.
    const emiLines = deductions.filter((d) => d.code === 'LOAN_EMI');
    const charges = emiLines.every((l) => l.sourceIds?.length)
      ? emiLines.map((l) => ({
          loanId: l.sourceIds![0],
          amount: l.amount,
        }))
      : // Legacy run with no sourceIds on its EMI lines — recompute the way
        // this used to, so an old DRAFT locked after this change still has
        // its loans charged.
        (
          await this.getDueLoanEmis(
            run.employeeId,
            run.month,
            run.year,
            organizationId,
          )
        ).map(({ loan, amount }) => ({ loanId: loan.id, amount }));

    for (const { loanId, amount } of charges) {
      const alreadyCharged = await this.scopedPrisma.loanRepayment.findFirst({
        where: { organizationId, loanId, payrollRunId: run.id },
      });
      if (alreadyCharged) continue;
      // A loan closed or repaid between calculate and lock is refused up front
      // by staleLoanEmiReason() (the lock doesn't happen, so the payslip can't
      // keep an EMI that is never charged). This remains only as a guard for a
      // loan closed in the instant between that check and this write;
      // recordRepayment rejects a non-ACTIVE loan.
      const loan = await this.scopedPrisma.loan.findFirst({
        where: { id: loanId, organizationId, status: LoanStatus.ACTIVE },
      });
      if (!loan) continue;
      await this.loansService.recordRepayment(
        loanId,
        { month: run.month, year: run.year, amount, payrollRun: run.id },
        organizationId,
      );
    }
  }

  // Why a run can't be locked because of a loan EMI on its payslip, or null.
  // The EMI line was computed at calculate time; if the loan has since been
  // closed/cancelled, or the balance fell below the EMI (another month's run
  // was locked in between, or a manual repayment was recorded), locking would
  // either keep a deduction that is never charged against the loan or charge
  // more than is owed. Either way the payslip is stale — refuse and ask for a
  // recalculation instead of silently diverging.
  // A leave encashment is paid by whichever run locks first, so a second open month that was calculated before that
  // still carries the same line. Locking it would pay the employee twice; this stops that and asks for a recalculation
  // (which drops the line, since the encashment is no longer pending).
  private async staleEncashmentReason(
    run: PayrollRun,
    organizationId: string,
    claimedInBatch: Set<string>,
  ): Promise<string | null> {
    const earnings = (run.earnings ?? []) as unknown as PayrollLineRecord[];
    const line = earnings.find((e) => e.code === 'LEAVE_ENCASHMENT');
    if (!line?.sourceIds?.length) return null;
    const rows = await this.scopedPrisma.leaveEncashment.findMany({
      where: { organizationId, id: { in: line.sourceIds } },
    });
    const gone =
      line.sourceIds.some((id) => claimedInBatch.has(id)) ||
      rows.length < line.sourceIds.length ||
      rows.some(
        (r) =>
          r.status !== LeaveEncashmentStatus.APPROVED &&
          r.payrollRunId !== run.id,
      );
    if (gone) {
      return 'The leave encashment on this payslip has already been paid in another payroll run (or is no longer approved) - recalculate this payroll run before locking it.';
    }
    for (const id of line.sourceIds) claimedInBatch.add(id);
    return null;
  }

  private async staleLoanEmiReason(
    run: PayrollRun,
    organizationId: string,
  ): Promise<string | null> {
    const deductions = (run.deductions ?? []) as unknown as PayrollLineRecord[];
    for (const line of deductions) {
      if (line.code !== 'LOAN_EMI' || !line.sourceIds?.length) continue;
      const loanId = line.sourceIds[0];
      // Already charged for this very run (a relock) — nothing more to take.
      const charged = await this.scopedPrisma.loanRepayment.findFirst({
        where: { organizationId, loanId, payrollRunId: run.id },
        select: { id: true },
      });
      if (charged) continue;
      const loan = await this.scopedPrisma.loan.findFirst({
        where: { id: loanId, organizationId },
      });
      if (!loan || loan.status !== LoanStatus.ACTIVE) {
        return `The ${line.name || 'loan EMI'} on this payslip is for a loan that is no longer active${loan ? ` (${loan.status.toLowerCase()})` : ''} — recalculate this payroll run before locking it.`;
      }
      const owed = payoffAmount(loan.outstandingBalance, loan.interestRate);
      // Tolerates the payslip's own rounding (under one currency unit).
      if (line.amount - owed >= 1) {
        return `The ${line.name || 'loan EMI'} on this payslip (${line.amount}) is more than is still owed on the loan (${owed}) — recalculate this payroll run before locking it.`;
      }
    }
    return null;
  }

  // ACTIVE loans/advances whose repayment period has started (loan.
  // startYear/startMonth <= this run's year/month) and still have a
  // balance — each one's EMI, capped at whatever's left outstanding so
  // the final installment never overshoots. Shared by calculatePayroll
  // (a read-only preview line) and afterLock (which actually records the
  // repayment), same "approved-but-not-yet-processed" split leave
  // encashment uses.
  //
  // "Outstanding" accounts for EMIs already sitting on this employee's OTHER
  // calculated-but-not-yet-locked regular runs: the balance only drops when a
  // run is locked, so two open months each used to preview the full EMI off
  // the same live balance and, once both were locked, deduct more than was
  // ever owed (e.g. a 1,500 balance recovered as 1,500 + 1,500).
  private async getDueLoanEmis(
    employeeId: string,
    month: number,
    year: number,
    organizationId: string,
  ): Promise<Array<{ loan: Loan; amount: number }>> {
    const loans = await this.scopedPrisma.loan.findMany({
      where: {
        organizationId,
        employeeId,
        status: LoanStatus.ACTIVE,
        outstandingBalance: { gt: 0 },
      },
    });
    const dueLoans = loans.filter(
      (l) =>
        l.startYear < year || (l.startYear === year && l.startMonth <= month),
    );
    if (dueLoans.length === 0) return [];

    const openRuns = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId,
        isFinalSettlement: false,
        status: {
          in: [
            PayrollRunStatus.CALCULATED,
            PayrollRunStatus.VERIFIED,
            PayrollRunStatus.APPROVED,
          ],
        },
        NOT: { month, year },
      },
      select: { month: true, year: true, deductions: true },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });
    const pendingByLoan = new Map<string, number[]>();
    for (const r of openRuns) {
      for (const d of (r.deductions ?? []) as unknown as PayrollLineRecord[]) {
        const loanId = d.code === 'LOAN_EMI' ? d.sourceIds?.[0] : undefined;
        if (!loanId) continue;
        pendingByLoan.set(loanId, [
          ...(pendingByLoan.get(loanId) ?? []),
          d.amount,
        ]);
      }
    }

    return dueLoans
      .map((l) => {
        // Walk the balance forward through the EMIs other open runs will
        // charge, the same interest-first way recordRepayment() will.
        let balance = l.outstandingBalance;
        for (const pending of pendingByLoan.get(l.id) ?? []) {
          const { principalComponent } = splitRepayment(
            pending,
            balance,
            l.interestRate,
          );
          balance = Math.max(0, balance - principalComponent);
        }
        return {
          loan: l,
          // Capped at the full payoff (balance + this month's interest), not
          // the bare balance: the EMI is split interest-first, so a final
          // installment capped at the balance alone would leave the interest
          // unpaid and the balance could never reach zero.
          amount: Math.min(l.emiAmount, payoffAmount(balance, l.interestRate)),
        };
      })
      .filter(({ amount }) => amount > 0);
  }

  // Resolves a group of same-type components (all earnings, or all
  // deductions, etc.) in dependency order. Proration (`prorationFactor`,
  // payable days / days in the period) is applied only to FIXED-type values —
  // PERCENTAGE/FORMULA/MANUAL authors are expected to reference
  // PAYABLE_DAYS/LOP_DAYS themselves if they want proration.
  //
  // Later components in the group (and, via the caller, later groups) read
  // each resolved value back out of the context ROUNDED the way the payslip
  // line will be, so a formula like PF = 12% of BASIC matches the Basic
  // printed on the payslip; the returned line amount stays raw and is rounded
  // exactly once by the caller, giving the same figure.
  private resolveGroup(
    components: SalaryComponent[],
    overridesByCode: Map<string, EmployeeSalaryComponent>,
    context: Record<string, number>,
    prorationFactor: number,
    roundAmount: (n: number) => number,
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

    for (const code of order) {
      const component = byCode.get(code);
      if (!component) continue;
      const override = overridesByCode.get(code) ?? null;
      const valueType = override?.valueType ?? component.calcType;
      let value: number;
      try {
        value = resolveComponentValue(component, override, localContext);
      } catch (err) {
        throw new Error(
          `Salary component "${component.name}" (${code}): ${(err as Error).message}`,
        );
      }

      if (valueType === CalcType.FIXED) {
        value = value * prorationFactor;
      }
      // Math.max(0, NaN) is NaN — this used to carry a NaN straight onto the
      // payslip.
      if (!Number.isFinite(value)) {
        throw new Error(
          `Salary component "${component.name}" (${code}) produced a non-numeric amount (${value}) — check its formula/value.`,
        );
      }
      // MANUAL lines (arrears, one-off corrections) are exempt from the
      // floor: a negative MANUAL amount is a deliberate clawback/recovery
      // entered by HR, not a formula error, and clamping it to 0 silently
      // discards the recovery with no trace on the payslip or in failures[].
      if (valueType !== CalcType.MANUAL) {
        value = Math.max(0, value);
      }
      localContext[code] = roundAmount(value);
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

  // Earnings for a month that a salary revision splits into segments (see
  // splitPeriodAtRevisions). Each segment is resolved against the structure
  // in force for it, as if it were a whole month — FIXED values prorated by
  // the payable days within the segment over its calendar days — and then
  // weighted by its share of the month's calendar days. With a single segment
  // this reduces exactly to the ordinary calculation (weight 1, proration
  // payableDays / daysInMonth), so a full-attendance month revised on the
  // 16th of a 30-day month pays 15/30 at the old rate + 15/30 at the new.
  //
  // MANUAL amounts (bonus, arrears, one-off incentives) are lump sums, not
  // monthly rates: they are never pro-rated by calendar days and are taken as
  // they stand at month end, exactly as before.
  private resolveSegmentedEarnings(args: {
    segments: PeriodSegment[];
    overrideRows: EmployeeSalaryComponent[];
    allComponents: SalaryComponent[];
    month: number;
    settings: OverlaidSettings;
    baseContext: Record<string, number>;
    attendanceRows: DatedAttendanceRowLike[];
    leaves: LeaveRowWithType[];
    totalDaysInMonth: number;
    roundAmount: (n: number) => number;
  }): ResolvedLine[] {
    const combined = new Map<string, ResolvedLine>();
    const lastIndex = args.segments.length - 1;
    args.segments.forEach((segment, index) => {
      const overrides = new Map<string, EmployeeSalaryComponent>(
        resolveCurrentRows(args.overrideRows, segment.end).map((r) => [
          r.componentCode,
          r,
        ]),
      );
      const applicable = args.allComponents.filter((c) =>
        this.isApplicable(
          c,
          overrides.get(c.code) ?? null,
          args.month,
          args.settings,
        ),
      );
      const applicableCodes = new Set(applicable.map((c) => c.code));
      const context = { ...args.baseContext };
      for (const c of args.allComponents) {
        if (!applicableCodes.has(c.code)) context[c.code] = 0;
      }
      const calendarDays = daysInRange(segment.start, segment.end);
      const payableDays = payableDaysInRange(
        args.attendanceRows,
        args.leaves,
        segment.start,
        segment.end,
      );
      const { results } = this.resolveGroup(
        applicable.filter(
          (c) =>
            c.type === SalaryComponentType.EARNING && !c.isEmployerContribution,
        ),
        overrides,
        context,
        calendarDays > 0 ? payableDays / calendarDays : 1,
        args.roundAmount,
      );
      const weight = calendarDays / args.totalDaysInMonth;
      for (const line of results) {
        const valueType =
          overrides.get(line.code)?.valueType ?? line.component?.calcType;
        const isLumpSum = valueType === CalcType.MANUAL;
        if (isLumpSum && index !== lastIndex) continue;
        const amount = isLumpSum ? line.amount : line.amount * weight;
        const existing = combined.get(line.code);
        if (existing) existing.amount += amount;
        else combined.set(line.code, { ...line, amount });
      }
    });
    return [...combined.values()];
  }

  // This employee's regular full-month earnings under the month-end
  // structure: recurring (MONTHLY, non-MANUAL) components resolved for a
  // standard month — no proration, no overtime/holiday work, no LOP. Used
  // both to project the rest of the FY (instead of multiplying this month's
  // actual, possibly prorated or one-off-inflated, gross) and to annualize
  // Basic/HRA for HRA exemption / 80CCD2 without inheriting this month's
  // proration. Returns undefined if the structure can't be resolved that way.
  private recurringMonthlyEarnings(
    earningComponents: SalaryComponent[],
    overridesByCode: Map<string, EmployeeSalaryComponent>,
    baseContext: Record<string, number>,
    roundAmount: (n: number) => number,
  ): ResolvedLine[] | undefined {
    const recurring = earningComponents.filter((c) => {
      const valueType = overridesByCode.get(c.code)?.valueType ?? c.calcType;
      return (
        c.payFrequency === PayFrequency.MONTHLY && valueType !== CalcType.MANUAL
      );
    });
    const recurringCodes = new Set(recurring.map((c) => c.code));
    const totalDays = baseContext.TOTAL_DAYS_IN_MONTH ?? 0;
    const context: Record<string, number> = {
      ...baseContext,
      PRESENT_DAYS: baseContext.WORKING_DAYS ?? totalDays,
      PAYABLE_DAYS: totalDays,
      PAID_LEAVE_DAYS: 0,
      UNPAID_LEAVE_DAYS: 0,
      HALF_DAYS: 0,
      LOP_DAYS: 0,
      LATE_MARKS: 0,
      OT_HOURS: 0,
      OT_WEIGHTED_HOURS: 0,
      HOLIDAY_WORK_DAYS: 0,
      WEEKEND_WORK_DAYS: 0,
    };
    for (const c of earningComponents) {
      if (!recurringCodes.has(c.code)) context[c.code] = 0;
    }
    try {
      const { results } = this.resolveGroup(
        recurring,
        overridesByCode,
        context,
        1,
        roundAmount,
      );
      return results;
    } catch {
      return undefined;
    }
  }

  // Sum of the taxable recurring lines — what the tax engine projects the
  // remaining FY months from.
  private recurringMonthlyTaxableGross(
    recurringResults: ResolvedLine[] | undefined,
    roundAmount: (n: number) => number,
  ): number | undefined {
    if (!recurringResults) return undefined;
    return recurringResults
      .filter((l) => l.taxable !== false)
      .reduce((s, l) => s + roundAmount(l.amount), 0);
  }

  // Scales variable (non-monthly) earnings and handles company-performance
  // holds/releases. With Company Performance off this is exactly the old
  // behaviour: scale by the approved individual payout % and nothing else.
  // With it on:
  //   Variable pay = Target x Company achievement % x Individual payout %
  // The department's % wins over the company-wide one. If no % is entered for
  // the financial year, the variable lines are removed from this run and
  // recorded as held; a later run pays them (stamped with the cycle they
  // settle, so a hold is never paid twice) once the % exists.
  private async applyVariablePay(a: {
    organizationId: string;
    employeeId: string;
    departmentId: string | null;
    month: number;
    year: number;
    financialYear: string;
    enabled: boolean;
    roundingRule: string;
    roundingDecimals: number;
    earningsResults: ResolvedLine[];
    variableEarningCodes: Set<string>;
    allComponents: SalaryComponent[];
    overrideRows: EmployeeSalaryComponent[];
    baseContext: Record<string, number>;
    roundAmount: (n: number) => number;
  }): Promise<{ held: HeldVariablePay[]; released: ResolvedLine[] }> {
    const held: HeldVariablePay[] = [];
    const released: ResolvedLine[] = [];
    const rate = (n: number) => round(n, a.roundingRule, a.roundingDecimals);

    const individualPercentFor = async (fy: string): Promise<number> => {
      const rating = await this.scopedPrisma.performanceRating.findFirst({
        where: {
          organizationId: a.organizationId,
          employeeId: a.employeeId,
          financialYear: fy,
          status: 'APPROVED',
        },
      });
      return rating ? rating.payoutPercentage : 100;
    };

    if (!a.enabled) {
      if (a.variableEarningCodes.size === 0) return { held, released };
      const factor = (await individualPercentFor(a.financialYear)) / 100;
      if (factor !== 1) {
        for (const line of a.earningsResults) {
          if (a.variableEarningCodes.has(line.code)) {
            line.amount = rate(line.amount * factor);
          }
        }
      }
      return { held, released };
    }

    const companyPercentFor = async (fy: string) => {
      const rows = await this.scopedPrisma.companyPerformance.findMany({
        where: {
          organizationId: a.organizationId,
          financialYear: fy,
          OR: [
            { departmentId: null },
            ...(a.departmentId ? [{ departmentId: a.departmentId }] : []),
          ],
        },
        select: { departmentId: true, achievementPercent: true },
      });
      return pickCompanyPercent(rows, a.departmentId);
    };

    // Other months' runs: what's already been paid out, and what's on hold.
    // This month's own run is excluded so recalculating it never counts its
    // own earlier lines as a release.
    const otherRuns = (
      await this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId: a.organizationId,
          employeeId: a.employeeId,
          year: { gte: a.year - 2 },
        },
        select: {
          month: true,
          year: true,
          earnings: true,
          heldVariablePay: true,
        },
      })
    ).filter((r) => !(r.month === a.month && r.year === a.year));
    const paidKeys = releasedKeys(otherRuns);
    const thisCycle = cycleKeyOf(a.month, a.year);

    // 1) This month's variable lines.
    if (a.variableEarningCodes.size > 0) {
      const picked = await companyPercentFor(a.financialYear);
      const individualPercent = await individualPercentFor(a.financialYear);
      for (let i = a.earningsResults.length - 1; i >= 0; i--) {
        const line = a.earningsResults[i];
        if (!a.variableEarningCodes.has(line.code)) continue;
        if (paidKeys.has(`${line.code}|${thisCycle}`)) {
          // Held earlier and already paid by a later run — not paid again
          // here. The hold stays recorded on this run: it is what lets that
          // later run keep (re)paying it when it is recalculated.
          held.push({
            code: line.code,
            name: line.name,
            cycleKey: thisCycle,
            financialYear: a.financialYear,
          });
          a.earningsResults.splice(i, 1);
        } else if (!picked) {
          held.push({
            code: line.code,
            name: line.name,
            cycleKey: thisCycle,
            financialYear: a.financialYear,
          });
          a.earningsResults.splice(i, 1);
        } else {
          const target = line.amount;
          line.amount = rate(
            target * (picked.percent / 100) * (individualPercent / 100),
          );
          line.note = describeVariablePay(
            target,
            picked.percent,
            individualPercent,
            picked.scope,
          );
        }
      }
    }

    // 2) Earlier holds that can now be paid.
    for (const entry of pendingHolds(otherRuns, a.month, a.year, paidKeys)) {
      const cycle = parseCycleKey(entry.cycleKey);
      const component = a.allComponents.find(
        (c) => c.code === entry.code && c.isActive,
      );
      if (!cycle || !component) continue;
      const picked = await companyPercentFor(entry.financialYear);
      if (!picked) continue;
      // The component's amount as it stood at the end of the held month.
      const atCycle = new Map<string, EmployeeSalaryComponent>(
        resolveCurrentRows(
          a.overrideRows,
          lastDayOfMonth(cycle.month, cycle.year),
        ).map((r) => [r.componentCode, r]),
      );
      const line = this.resolveGroup(
        [component],
        atCycle,
        a.baseContext,
        1,
        a.roundAmount,
      ).results[0];
      if (!line || !(line.amount > 0)) continue;
      const individualPercent = await individualPercentFor(entry.financialYear);
      released.push({
        code: entry.code,
        name: `${entry.name} (FY ${entry.financialYear})`,
        amount: rate(
          line.amount * (picked.percent / 100) * (individualPercent / 100),
        ),
        taxable: line.taxable,
        cycleKey: entry.cycleKey,
        note: describeVariablePay(
          line.amount,
          picked.percent,
          individualPercent,
          picked.scope,
        ),
      });
    }

    return { held, released };
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

    // A manually assigned payout (Bonus, ...) is HR's explicit instruction for this employee. The statutory
    // switch controls the statutory *accrual/contribution* components; applying it here silently paid a
    // manually entered Bonus as zero whenever the Bonus module was off.
    const isManualPayout =
      component.type === SalaryComponentType.EARNING &&
      !component.isEmployerContribution &&
      (override?.valueType ?? component.calcType) === CalcType.MANUAL;
    if (component.isStatutory && !isManualPayout) {
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

  // Sums TAXABLE earnings + TDS already recorded for this employee within
  // the given FY, for every month strictly before beforeMonth/beforeYear.
  //
  // ytdGross is the income-tax base, so it must use the same taxable-only
  // figure the current month uses (run.taxableGross) — summing grossSalary
  // counted non-taxable pay (reimbursement-type allowances etc.) in every
  // earlier month and over-withheld TDS for the rest of the year. Runs saved
  // before taxableGross existed are re-derived from their stored lines'
  // `taxable` flags, or fall back to grossSalary if the lines carry none.
  private async getYtdFigures(
    employeeId: string,
    financialYear: string,
    beforeMonth: number,
    beforeYear: number,
    organizationId: string,
  ): Promise<{ ytdGross: number; ytdTDS: number; ytdMonths: number }> {
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
    let ytdMonths = 0;
    for (const run of runs) {
      const isBefore =
        run.year < beforeYear ||
        (run.year === beforeYear && run.month < beforeMonth);
      if (!isBefore) continue;
      const runGross = this.runTaxableGross(run);
      if (runGross > 0) ytdMonths += 1;
      ytdGross += runGross;
      const deductions = run.deductions as unknown as {
        code: string;
        amount: number;
      }[];
      const incomeTaxLine = deductions.find(
        (d) => d.code === SALARY_COMPONENT_CODES.INCOME_TAX,
      );
      ytdTDS += incomeTaxLine ? incomeTaxLine.amount : 0;
    }
    return { ytdGross, ytdTDS, ytdMonths };
  }

  private runTaxableGross(run: PayrollRun): number {
    if (run.taxableGross !== null && run.taxableGross !== undefined) {
      return run.taxableGross;
    }
    const lines = (run.earnings ?? []) as unknown as {
      amount: number;
      taxable?: boolean;
    }[];
    if (
      Array.isArray(lines) &&
      lines.some((l) => typeof l.taxable === 'boolean')
    ) {
      return lines
        .filter((l) => l.taxable !== false)
        .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    }
    return run.grossSalary;
  }

  private async targetEmployees(
    employeeId: string | undefined,
    organizationId: string,
    excludeEmployeeIds?: string[],
  ) {
    if (employeeId) {
      // An explicit single-employee target is a deliberate action —
      // neither the standing excludeFromPayroll flag nor a per-run
      // excludeEmployeeIds list overrides it.
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
        // Bulk payroll runs cover everyone on payroll, Admin included (an Admin is paid like anyone else; one who is
        // not can be left out with the standing excludeFromPayroll flag below).
        role: { in: [Role.EMPLOYEE, Role.MANAGER, Role.HR, Role.ADMIN] },
        // Standing opt-out (e.g. an unpaid intern) — see the field's own
        // schema comment.
        excludeFromPayroll: false,
        ...(excludeEmployeeIds?.length
          ? { id: { notIn: excludeEmployeeIds } }
          : {}),
      },
      orderBy: EMPLOYEE_ORDER_BY,
    });
  }

  // Surfaces, per employee eligible for this month's payroll run, how
  // many calendar days have no attendance record at all — the exact gap
  // that silently becomes unpaid (LOP) once calculatePayroll() runs, with
  // no warning anywhere before that point today. Meant to be checked by
  // the frontend before Draft/Calculate, not during it — a day with a
  // real attendance row (PRESENT/ABSENT/ON_LEAVE/HOLIDAY/WEEKLY_OFF,
  // doesn't matter which) was actually looked at by someone; only a day
  // with no row at all is a genuine blind spot.
  async getAttendanceGaps(month: number, year: number, organizationId: string) {
    const allEmployees = await this.targetEmployees(undefined, organizationId);
    // Days that have not happened yet cannot be blind spots, so only the days up to today are looked at.
    const today = await this.orgToday(organizationId);
    const totalDaysInMonth = daysInMonth(month, year);
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    // Only people who had joined by the end of the month can have a gap in it.
    const monthEnd = lastDayOfMonth(month, year);
    const employees = allEmployees.filter(
      (e) => e.joiningDate.toISOString().slice(0, 10) <= monthEnd,
    );

    const [marked, holidays, departments, org] = await Promise.all([
      this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: { in: employees.map((e) => e.id) },
          date: { startsWith: monthPrefix },
        },
        select: { employeeId: true, date: true },
      }),
      this.scopedPrisma.holiday.findMany({
        where: {
          organizationId,
          isActive: true,
          isOptional: false,
          date: { startsWith: monthPrefix },
        },
        select: { date: true, departmentId: true },
      }),
      this.scopedPrisma.department.findMany({ where: { organizationId } }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      }),
    ]);
    const markedByEmployee = new Map<string, Set<string>>();
    for (const row of marked) {
      const set = markedByEmployee.get(row.employeeId) ?? new Set<string>();
      set.add(row.date);
      markedByEmployee.set(row.employeeId, set);
    }
    const departmentById = new Map(departments.map((d) => [d.id, d]));

    // A day is a real blind spot only when it is a working day the employee was employed for and nobody marked: a
    // weekly off or holiday is paid anyway (see off-days.ts), and days before they joined are not theirs.
    return employees
      .map((e) => {
        const department = e.departmentId
          ? (departmentById.get(e.departmentId) ?? null)
          : null;
        const { weeklyOffs } = resolveShiftConfig(
          department,
          org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
        );
        const employed = employmentWindow(e.joiningDate, month, year, today);
        const calendar = offDayCalendar(
          employed.from,
          employed.to,
          weeklyOffs,
          holidays
            .filter((h) => !h.departmentId || h.departmentId === e.departmentId)
            .map((h) => h.date),
        );
        const markedDates = markedByEmployee.get(e.id) ?? new Set<string>();
        const offDates = new Set([
          ...calendar.weeklyOffDates,
          ...calendar.holidayDates,
        ]);
        let unmarkedDays = 0;
        let daysSoFar = 0;
        if (employed.from <= employed.to) {
          for (const date of enumerateDateStrings(employed.from, employed.to)) {
            daysSoFar += 1;
            if (!markedDates.has(date) && !offDates.has(date))
              unmarkedDays += 1;
          }
        }
        return {
          employeeId: e.id,
          name: e.name,
          employeeCode: e.employeeId,
          unmarkedDays,
          // Days of the month that have happened so far (and the employee was employed for) that were looked at.
          daysSoFar,
          totalDaysInMonth,
        };
      })
      .filter((row) => row.unmarkedDays > 0)
      .sort((a, b) => b.unmarkedDays - a.unmarkedDays);
  }
}

// Age (whole years) on 31 March ending the financial year ("2026-27" -> 31 Mar 2027); null when no valid DOB.
function ageOnFYEnd(dob: unknown, financialYear: string): number | null {
  if (typeof dob !== 'string') return null;
  const born = new Date(dob);
  const startYear = Number(financialYear.slice(0, 4));
  if (Number.isNaN(born.getTime()) || !Number.isFinite(startYear)) return null;
  const end = new Date(Date.UTC(startYear + 1, 2, 31));
  let age = end.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    end.getUTCMonth() < born.getUTCMonth() ||
    (end.getUTCMonth() === born.getUTCMonth() &&
      end.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}
