// Purpose: Aggregates read-only dashboard views for HR, department-head, employee and executive roles.
// Responsibilities: Owns all cross-model aggregation queries and derived stats (payroll cost summary,
// attendance/leave/reimbursement snapshots, headcount trend, upcoming birthdays/anniversaries); delegates
// payroll settings lookup to PayrollSettingsService and comp-off balance to CompOffService rather than
// recomputing them.
// Important: departmentHeadDashboard() intentionally ports a quirk from the original release — a manager with no
// department matches every other no-department user via departmentId: null, not zero rows.
// computeHeadcountTrend() is shared with the Reports module so headcount numbers stay consistent everywhere.
import { employedOnWhere } from '../common/managers';
import { REQUEST_TYPE_MODULE, disabledModulesOf, gate } from '../module-access/module-gate';
import {
  pageRequest,
  slicePage,
  wanted,
  type PageRequest,
} from './pending-page';
import {
  formatTimeInZone,
  resolveOrgTimeContext,
} from '../payroll/format-date';
import { holidayInEffect } from '../holidays/holiday-in-effect';
import { getLeaveYearConfig } from '../leave-balances/leave-year-config';
import { currentLeaveYear } from '../leave-balances/leave-year';
import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  AllocationType,
  AttendanceStatus,
  CompOffStatus,
  LeaveStatus,
  LoanStatus,
  OffboardingStatus,
  LeaveEncashmentStatus,
  OvertimeStatus,
  PayrollRunStatus,
  ReimbursementStatus,
  ResignationStatus,
  WithdrawalRequestStatus,
  Role,
  StatutoryModule,
  User,
  WfhApprovalStatus,
} from '@prisma/client';
import { leaveDaysInRange } from '../leaves/leave-days-in-range';
import { EXPORTABLE_RUN_STATUSES } from '../payroll/exportable-runs';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { CompOffService } from '../comp-offs/comp-off.service';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import {
  applyStatutoryOverrides,
  type EffectiveConfigsByModule,
} from '../payroll/statutory-overlay';
import { lastDayOfMonth } from '../payroll/payroll-date-math';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { getFinancialYear } from '../payroll-settings/financial-year';
import {
  DashboardRange,
  MONTH_LABELS,
  daysUntilNextOccurrence,
  monthsForRange,
} from './dashboard-date-math';
import {
  dateStrInOrgTz,
  startOfDayInOrgTzUtc,
  todayInOrgTz,
} from '../common/org-date';
import {
  enumerateDateStrings,
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';

type Actor = Omit<User, 'password'>;

interface PayrollLine {
  code: string;
  amount: number;
}

const findDeductionAmount = (deductions: unknown, code: string): number => {
  const lines = (deductions ?? []) as PayrollLine[];
  return lines.find((d) => d.code === code)?.amount ?? 0;
};

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly compOffService: CompOffService,
    private readonly statutoryConfigService: StatutoryConfigService,
  ) {}

  // Which statutory deductions apply in a month, resolved the way payroll resolves them: the dated version in force on
  // the month's last day (Statutory Configuration) wins over the plain on/off flag in Payroll Settings. Reading only
  // the flag left the dashboard blank for PF/ESI/PT/LWF when a company had enabled them through Statutory
  // Configuration while payroll was already deducting them.
  private async statutoryEnabledIn(
    settings: Parameters<typeof applyStatutoryOverrides>[0],
    organizationId: string,
    month: number,
    year: number,
  ) {
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
    const resolved = applyStatutoryOverrides(settings, effectiveConfigs);
    return {
      pf: resolved.pfEnabled,
      esi: resolved.esiEnabled,
      pt: resolved.ptEnabled,
      lwf: resolved.lwfEnabled,
    };
  }

  // The leave year now in progress (the key leave balance rows are filed under) - the calendar year unless the
  // organisation's leave year starts in another month.
  private async currentLeaveYearKey(organizationId: string): Promise<number> {
    const [cfg, tz] = await Promise.all([
      getLeaveYearConfig(this.scopedPrisma, organizationId),
      this.getOrgTimezone(organizationId),
    ]);
    return currentLeaveYear(todayInOrgTz(tz), cfg);
  }

  private async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  // "Now" as the organization's own calendar day (a local-midnight Date for that day), so month/year boundaries
  // follow the org's time zone and not the server clock.
  private async orgNow(organizationId: string): Promise<Date> {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const [y, m, d] = today.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // 11.4 Payroll Cost Summary chart: Net Pay / Taxes / Benefits / Deductions
  // per month for the requested range.
  async payrollCostSummary(range: DashboardRange, organizationId: string) {
    const [now, settings] = await Promise.all([
      this.orgNow(organizationId),
      this.payrollSettingsService.getOrCreate(organizationId),
    ]);
    const months = monthsForRange(range, now, settings.financialYearStartMonth);

    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        OR: months.map((m) => ({ month: m.month, year: m.year })),
        // Final payroll only (locked or paid), the same runs the Reports are built from: a run that is still
        // calculated / verified / approved can change, so it is not counted here yet.
        status: { in: EXPORTABLE_RUN_STATUSES },
        isFinalSettlement: false,
      },
    });

    const byKey = new Map<
      string,
      { netPay: number; taxes: number; benefits: number; deductions: number }
    >();
    for (const run of runs) {
      const key = `${run.year}-${run.month}`;
      const agg = byKey.get(key) ?? {
        netPay: 0,
        taxes: 0,
        benefits: 0,
        deductions: 0,
      };
      const taxAmount = findDeductionAmount(
        run.deductions,
        SALARY_COMPONENT_CODES.INCOME_TAX,
      );
      agg.netPay += run.netPay;
      agg.benefits += run.totalEmployerContributions;
      agg.taxes += taxAmount;
      agg.deductions += run.totalDeductions - taxAmount;
      byKey.set(key, agg);
    }

    const chart = months.map((m) => {
      const agg = byKey.get(`${m.year}-${m.month}`) ?? {
        netPay: 0,
        taxes: 0,
        benefits: 0,
        deductions: 0,
      };
      return {
        month: m.month,
        year: m.year,
        label: `${MONTH_LABELS[m.month - 1]} ${m.year}`,
        ...agg,
      };
    });

    return { range, chart };
  }

  // 11.1 HR Dashboard: total employees, attendance summary, pending
  // approvals, payroll status, leave stats.
  async hrDashboard(
    organizationId: string,
    viewer?: { id: string; role: Role },
  ) {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const now = new Date(`${today}T00:00:00`);
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthPrefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

    const off = await disabledModulesOf(organizationId);
    const [
      totalEmployees,
      presentToday,
      checkedInToday,
      absentToday,
      incompleteToday,
      onLeaveToday,
      pendingLeaves,
      pendingRegularizationCount,
      payrollThisMonth,
      currentMonthRuns,
      draftRuns,
      settings,
      reimbPending,
      reimbApproved,
      reimbRejected,
      reimbAmountPendingAgg,
      upcomingHolidays,
      leaveBalanceRows,
      deptLeaveSummaryRaw,
    ] = await Promise.all([
      // Headcount: on the books today - joined, and not past the last working day (the account stays open until the exit
      // is completed).
      this.scopedPrisma.user.count({
        where: { organizationId, isActive: true, ...employedOnWhere(today) },
      }),
      // Present = a finished punch pair (or a regularized day). Someone who has only punched in so far is counted
      // separately as Checked in until their punch-out arrives.
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.PRESENT,
          // Everything Present except a bare punch-in (a regularized or manually entered day with no punch pair still
          // counts as Present).
          NOT: { inTime: { not: null }, outTime: null },
        },
      }), 0),
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.PRESENT,
          inTime: { not: null },
          outTime: null,
        },
      }), 0),
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: { organizationId, date: today, status: AttendanceStatus.ABSENT },
      }), 0),
      // Punched in, no punch-out, shift already ended — distinct from a
      // plain no-show so HR can see who still needs to regularize today.
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.INCOMPLETE,
        },
      }), 0),
      gate(off, 'module.leave', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.ON_LEAVE,
        },
      }), 0),
      gate(off, 'module.leave', async () => this.scopedPrisma.leave.count({
        where: { organizationId, status: LeaveStatus.PENDING },
      }), 0),
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          regularization: { path: ['status'], equals: 'pending' },
        },
      }), 0),
      gate(off, 'module.payroll', async () => this.scopedPrisma.payrollRun.count({
        where: {
          organizationId,
          month: currentMonth,
          year: currentYear,
          isFinalSettlement: false,
          runSequence: 0,
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
      }), 0),
      gate(off, 'module.payroll', async () => this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          month: currentMonth,
          year: currentYear,
          // Final payroll only (locked or paid) - see payrollCostSummary.
          status: { in: EXPORTABLE_RUN_STATUSES },
          isFinalSettlement: false,
          runSequence: 0,
        },
      }), []),
      gate(off, 'module.payroll', async () => this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          status: PayrollRunStatus.DRAFT,
          isFinalSettlement: false,
          runSequence: 0,
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }), []),
      gate(off, 'module.payroll', async () => this.payrollSettingsService.getOrCreate(organizationId), null as never),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.PENDING },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.APPROVED },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.REJECTED },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.aggregate({
        where: { organizationId, status: ReimbursementStatus.PENDING },
        _sum: { amount: true },
      }), { _sum: { amount: 0 } } as never),
      this.scopedPrisma.holiday.findMany({
        where: { organizationId, isActive: true, date: { gte: today } },
        orderBy: { date: 'asc' },
        take: 3,
      }),
      // Unfiltered — a single low-quota leave type (e.g. a 1-day "Birthday
      // Leave") would otherwise dominate this list every time regardless of
      // how much leave the employee actually has left overall. Grouped into
      // one total per employee below, same convention the mobile Dashboard
      // already uses for its own "Leave Balance" stat.
      gate(off, 'module.leave', async () => this.scopedPrisma.leaveBalance.findMany({
        where: {
          organizationId,
          year: await this.currentLeaveYearKey(organizationId),
          // Same rule as the total shown on the employee's own dashboard and profile: only types that count toward the
          // total (so not one-off event-based leave), and only people who still work here.
          leaveType: {
            countInTotalBalance: true,
            allocationType: { not: AllocationType.EVENT_BASED },
          },
          employee: { isActive: true, ...employedOnWhere(today) },
        },
        include: {
          employee: { select: { id: true, name: true, employeeId: true } },
        },
      }), []),
      gate(off, 'module.leave', async () => this.scopedPrisma.leave.findMany({
        where: {
          organizationId,
          status: LeaveStatus.APPROVED,
          startDate: { lte: `${monthPrefix}-31` },
          endDate: { gte: `${monthPrefix}-01` },
        },
        include: { employee: { select: { departmentId: true } } },
      }), []),
    ]);

    // Total remaining leave per employee across every leave type they have a
    // balance row for this year, not any single type's own closing figure —
    // an employee with 1 day of "Birthday Leave" left but 15 days of Earned
    // Leave isn't actually low on leave. Threshold (5 days) is a flat cutoff
    // across all leave types combined, not per-type.
    const LOW_TOTAL_BALANCE_THRESHOLD = 5;
    const balanceTotalsByEmployee = new Map<
      string,
      {
        employee: { id: string; name: string; employeeId: string };
        totalDays: number;
      }
    >();
    for (const b of leaveBalanceRows) {
      const entry = balanceTotalsByEmployee.get(b.employeeId) ?? {
        employee: b.employee,
        totalDays: 0,
      };
      entry.totalDays += b.closing;
      balanceTotalsByEmployee.set(b.employeeId, entry);
    }
    const lowBalanceEmployees = [...balanceTotalsByEmployee.entries()]
      .filter(([, v]) => v.totalDays < LOW_TOTAL_BALANCE_THRESHOLD)
      .sort((a, b) => a[1].totalDays - b[1].totalDays)
      .slice(0, 10)
      .map(([employeeId, v]) => ({
        id: employeeId,
        employee: v.employee,
        totalDays: Math.round(v.totalDays * 100) / 100,
      }));

    // Only the days that fall in this month count (a leave from 28 Sep to 6 Oct is split between the months), under the
    // department the leave was filed for (falling back to the employee's current one for old rows).
    const monthLastDay = new Date(
      Date.UTC(currentYear, currentMonth, 0),
    ).getUTCDate();
    const deptTotals = new Map<string, number>();
    for (const l of deptLeaveSummaryRaw) {
      const days = leaveDaysInRange(
        l,
        `${monthPrefix}-01`,
        `${monthPrefix}-${String(monthLastDay).padStart(2, '0')}`,
      );
      if (days <= 0) continue;
      const deptId = l.departmentId ?? l.employee.departmentId ?? 'unassigned';
      deptTotals.set(deptId, (deptTotals.get(deptId) ?? 0) + days);
    }
    const deptIds = [...deptTotals.keys()].filter((id) => id !== 'unassigned');
    const depts = deptIds.length
      ? await this.scopedPrisma.department.findMany({
          where: { organizationId, id: { in: deptIds } },
          select: { id: true, name: true },
        })
      : [];
    const deptNameById = new Map(depts.map((d) => [d.id, d.name]));
    const departmentLeaveSummary = [...deptTotals.entries()].map(
      ([deptId, days]) => ({
        department:
          deptId === 'unassigned'
            ? 'Unassigned'
            : (deptNameById.get(deptId) ?? 'Unknown'),
        days: Math.round(days * 100) / 100,
      }),
    );

    const sumDeductionCode = (runs: { deductions: unknown }[], code: string) =>
      runs.reduce(
        (total, r) => total + findDeductionAmount(r.deductions, code),
        0,
      );

    // With Payroll switched off there are no payroll settings or runs to read: nothing is shown as enabled.
    const statutoryOn = off.has('module.payroll')
      ? { pf: false, esi: false, pt: false, lwf: false }
      : await this.statutoryEnabledIn(
          settings,
          organizationId,
          currentMonth,
          currentYear,
        );
    const taxCompliance = {
      totalTDS: sumDeductionCode(
        currentMonthRuns,
        SALARY_COMPONENT_CODES.INCOME_TAX,
      ),
      totalPF: statutoryOn.pf
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.PF)
        : null,
      totalESI: statutoryOn.esi
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.ESI)
        : null,
      totalPT: statutoryOn.pt
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.PT)
        : null,
      totalLWF: statutoryOn.lwf
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.LWF)
        : null,
    };

    let upcomingPayrun: {
      month: number;
      year: number;
      label: string;
      employeeCount: number;
      netPay: number;
      paymentDate: string;
    } | null = null;
    if (draftRuns.length > 0) {
      const { month, year } = draftRuns[0];
      const monthRuns = draftRuns.filter(
        (r) => r.month === month && r.year === year,
      );
      upcomingPayrun = {
        month,
        year,
        label: `${MONTH_LABELS[month - 1]} ${year}`,
        employeeCount: monthRuns.length,
        netPay: monthRuns.reduce((sum, r) => sum + r.netPay, 0),
        paymentDate: new Date(Date.UTC(year, month, 0))
          .toISOString()
          .slice(0, 10),
      };
    }

    return {
      totalEmployees,
      attendanceSummary: {
        presentToday,
        checkedInToday,
        absentToday,
        incompleteToday,
        onLeaveToday,
      },
      pendingItems: await this.pendingItems(organizationId, null, true, viewer),
      pendingApprovals: {
        leaves: pendingLeaves,
        regularizations: pendingRegularizationCount,
      },
      payrollStatus: { processedThisMonth: payrollThisMonth, totalEmployees },
      taxCompliance,
      reimbursementsSummary: {
        pendingClaims: reimbPending,
        approvedClaims: reimbApproved,
        rejectedClaims: reimbRejected,
        amountPending: reimbAmountPendingAgg._sum.amount ?? 0,
      },
      upcomingPayrun,
      upcomingHolidays,
      lowBalanceEmployees,
      departmentLeaveSummary,
    };
  }

  // 11.2 Department Head Dashboard: team attendance, pending approvals,
  // leave trends. Self-scoped to the caller's own department — ported
  // exactly from the original release's `where: { department: req.user.department }`,
  // including its quirk for a caller with no department: `departmentId: null`
  // matches every other no-department user, not zero rows. Harmless (no
  // dept-scoped data is more exposed than an ADMIN/HR caller already sees
  // elsewhere), but worth knowing before wiring a frontend "my team" widget
  // to this endpoint for a non-manager caller.
  async departmentHeadDashboard(actor: Actor, organizationId: string) {
    // A department-less MANAGER has no team: scope to nobody rather than to every unassigned user.
    // (Other roles keep the documented null-department behaviour above.)
    const deptEmployees =
      actor.departmentId === null && actor.role === Role.MANAGER
        ? []
        : await this.scopedPrisma.user.findMany({
            // Active people only: a deactivated colleague is not part of the team any more (the manager still counts).
            where: {
              organizationId,
              departmentId: actor.departmentId,
              isActive: true,
              ...employedOnWhere(todayInOrgTz(await this.getOrgTimezone(organizationId))),
            },
            select: { id: true },
          });
    const ids = deptEmployees.map((e) => e.id);

    const off = await disabledModulesOf(organizationId);
    const [
      pendingLeaves,
      pendingRegularizations,
      leaveTrendsGrouped,
      leaveTypesForTrends,
      teamLeaveBalancesRaw,
    ] = await Promise.all([
      gate(off, 'module.leave', async () => this.scopedPrisma.leave.count({
        where: {
          organizationId,
          employeeId: { in: ids },
          status: LeaveStatus.PENDING,
        },
      }), 0),
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: { in: ids },
          regularization: { path: ['status'], equals: 'pending' },
        },
      }), 0),
      gate(off, 'module.leave', async () => this.scopedPrisma.leave.groupBy({
        by: ['leaveTypeId'],
        where: { organizationId, employeeId: { in: ids } },
        _count: { _all: true },
      }), []),
      gate(off, 'module.leave', async () => this.scopedPrisma.leaveType.findMany({
        where: { organizationId },
        select: { id: true, name: true, code: true },
      }), []),
      gate(off, 'module.leave', async () => this.scopedPrisma.leaveBalance.findMany({
        where: {
          organizationId,
          employeeId: { in: ids },
          year: await this.currentLeaveYearKey(organizationId),
          // Leave types switched off for the Leave Tracker stay hidden here too.
          leaveType: { showInLeaveTracker: true },
        },
        include: {
          employee: { select: { name: true, employeeId: true } },
          leaveType: { select: { name: true, code: true, displayOrder: true } },
        },
        orderBy: { closing: 'asc' },
      }), []),
    ]);

    const leaveTypeByIdForTrends = new Map(
      leaveTypesForTrends.map((lt) => [lt.id, lt]),
    );
    const leaveTrendsByType = new Map<
      string,
      { name: string; code?: string; count: number }
    >();
    for (const g of leaveTrendsGrouped) {
      const leaveType = leaveTypeByIdForTrends.get(g.leaveTypeId);
      const key = leaveType?.name ?? g.leaveTypeId;
      const entry = leaveTrendsByType.get(key) ?? {
        name: key,
        code: leaveType?.code,
        count: 0,
      };
      entry.count += g._count._all;
      leaveTrendsByType.set(key, entry);
    }

    const teamLeaveBalances = teamLeaveBalancesRaw.map((b) => ({
      id: b.id,
      employee: b.employee.name,
      employeeId: b.employee.employeeId,
      leaveType: b.leaveType.name,
      leaveTypeCode: b.leaveType.code,
      leaveTypeOrder: b.leaveType.displayOrder,
      closing: b.closing,
    }));

    return {
      teamSize: ids.length,
      pendingApprovals: {
        leaves: pendingLeaves,
        regularizations: pendingRegularizations,
      },
      pendingItems: await this.pendingItems(organizationId, ids, false, {
        id: actor.id,
        role: actor.role,
      }),
      leaveTrends: [...leaveTrendsByType.values()],
      teamLeaveBalances,
    };
  }

  // Pending Work From Home rows -> requests: the days of one multi-day request (same wfhRequestId) are one entry, a
  // single day stands alone. Days are in date order within a request; requests keep the oldest-first order.
  private groupWfhRows<
    T extends { wfhRequestId: string | null; date: string; id: string },
  >(rows: T[]): { requestId: string | null; rows: T[] }[] {
    const groups: { requestId: string | null; rows: T[] }[] = [];
    const byRequest = new Map<
      string,
      { requestId: string | null; rows: T[] }
    >();
    for (const row of rows) {
      if (!row.wfhRequestId) {
        groups.push({ requestId: null, rows: [row] });
        continue;
      }
      let g = byRequest.get(row.wfhRequestId);
      if (!g) {
        g = { requestId: row.wfhRequestId, rows: [] };
        byRequest.set(row.wfhRequestId, g);
        groups.push(g);
      }
      g.rows.push(row);
    }
    for (const g of groups) g.rows.sort((a, b) => a.date.localeCompare(b.date));
    return groups;
  }

  // Who a pending queue is scoped to: employeeIds = null is the whole organization (HR/Admin).
  private pendingScope(organizationId: string, employeeIds: string[] | null) {
    return employeeIds
      ? { organizationId, employeeId: { in: employeeIds } }
      : { organizationId };
  }

  // The ONE definition of "waiting for a decision" for each request type. The Approvals list (pendingItems) and the
  // sidebar badge counts (pendingCounts) both use it, so a badge can never disagree with the list behind it.
  //
  // A request is not waiting for a person's decision when they are not allowed to decide it: nobody, Admin included,
  // may review their own leave, comp-off or encashment (assertNotOwnRequest), and only an Admin may review their own
  // other requests (assertNotSelfApproval). Those are left out of the count and the list when the viewer is known, so
  // the badge never promises an action the person cannot take.
  private pendingWhere(
    scope: {
      organizationId: string;
      employeeId?: { in?: string[]; not?: string };
    },
    viewer?: { id: string; role: Role },
  ) {
    const withoutOwn = (strict: boolean) => {
      if (!viewer || (!strict && viewer.role === Role.ADMIN)) return scope;
      return {
        ...scope,
        employeeId: { ...(scope.employeeId ?? {}), not: viewer.id },
      };
    };
    return {
      // Pending leave requests, plus approved leaves the employee has asked to have cancelled (the approver decides
      // those too, from the same list).
      leaves: {
        ...withoutOwn(true),
        OR: [
          { status: LeaveStatus.PENDING },
          {
            status: LeaveStatus.APPROVED,
            cancelRequestedAt: { not: null },
          },
        ],
      },
      regularizations: {
        ...withoutOwn(false),
        regularization: { path: ['status'], equals: 'pending' },
      },
      wfh: {
        ...withoutOwn(false),
        workArrangementStatus: WfhApprovalStatus.PENDING,
      },
      overtime: { ...withoutOwn(false), status: OvertimeStatus.PENDING },
      compOffs: { ...withoutOwn(true), status: CompOffStatus.PENDING },
      reimbursements: {
        ...withoutOwn(false),
        status: ReimbursementStatus.PENDING,
      },
      loans: { ...withoutOwn(false), status: LoanStatus.PENDING },
      encashments: {
        ...withoutOwn(true),
        status: LeaveEncashmentStatus.PENDING,
      },
      // Pending resignations, plus approved ones whose employee asked to withdraw (HR/Admin answer those too).
      resignations: {
        ...withoutOwn(false),
        OR: [
          { status: ResignationStatus.PENDING },
          {
            status: ResignationStatus.APPROVED,
            withdrawalStatus: WithdrawalRequestStatus.REQUESTED,
          },
        ],
      },
    };
  }

  // Pending Work From Home REQUESTS (not days): single days count one each, and all days of a multi-day request count
  // one together - the same unit the approver sees in the list.
  private async countPendingWfhRequests(
    where: Prisma.AttendanceWhereInput,
  ): Promise<number> {
    const [singles, groups] = await Promise.all([
      this.scopedPrisma.attendance.count({
        where: { ...where, wfhRequestId: null },
      }),
      this.scopedPrisma.attendance.groupBy({
        by: ['wfhRequestId'],
        where: { ...where, wfhRequestId: { not: null } },
      }),
    ]);
    return singles + groups.length;
  }

  // How many requests are waiting on THIS person, per type, for the sidebar badges. HR/Admin: the whole organization
  // and every queue; a manager: their department's team and the queues a manager reviews; anyone else: nothing.
  async pendingCounts(actor: Actor, organizationId: string) {
    const empty = {
      leaves: 0,
      regularizations: 0,
      wfh: 0,
      overtime: 0,
      compOffs: 0,
      reimbursements: 0,
      loans: 0,
      encashments: 0,
      resignations: 0,
      total: 0,
    };
    const isHr = actor.role === Role.ADMIN || actor.role === Role.HR;
    if (!isHr && actor.role !== Role.MANAGER) return empty;

    let employeeIds: string[] | null = null;
    if (!isHr) {
      // Same team the manager's dashboard uses: active people in their department (none when they have no department).
      const team =
        actor.departmentId === null
          ? []
          : await this.scopedPrisma.user.findMany({
              where: {
                organizationId,
                departmentId: actor.departmentId,
                isActive: true,
              },
              select: { id: true },
            });
      employeeIds = team.map((e) => e.id);
    }
    const where = this.pendingWhere(
      this.pendingScope(organizationId, employeeIds),
      { id: actor.id, role: actor.role },
    );
    const off = await disabledModulesOf(organizationId);
    const [leaves, regularizations, wfh, overtime, compOffs] =
      await Promise.all([
        gate(off, 'module.leave', async () => this.scopedPrisma.leave.count({ where: where.leaves }), 0),
        gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({ where: where.regularizations }), 0),
        gate(off, 'module.attendance', async () => this.countPendingWfhRequests(where.wfh), 0),
        gate(off, 'module.attendance', async () => this.scopedPrisma.overtimeRecord.count({ where: where.overtime }), 0),
        gate(off, 'module.leave', async () => this.scopedPrisma.compOff.count({ where: where.compOffs }), 0),
      ]);
    const [reimbursements, loans, encashments, resignations] = isHr
      ? await Promise.all([
          gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.count({ where: where.reimbursements }), 0),
          gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.loan.count({ where: where.loans }), 0),
          gate(off, 'module.leave', async () => this.scopedPrisma.leaveEncashment.count({ where: where.encashments }), 0),
          gate(off, 'module.offboarding', async () => this.scopedPrisma.resignation.count({ where: where.resignations }), 0),
        ])
      : [0, 0, 0, 0];
    // A switched-off module has nothing to approve: its queries above were skipped, so its counts read 0 (and the
    // sidebar badges hide too).
    const counts = {
      leaves,
      regularizations,
      wfh,
      overtime,
      compOffs,
      reimbursements,
      loans,
      encashments,
      resignations,
    };
    return {
      ...counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  }

  // The quick-check list of what is waiting for a decision, oldest first (at most 10).
  // Leave, attendance regularization, Work From Home, overtime and comp-off — the request types a manager can
  // review. Each row carries what the dashboard needs to show it and link to the page where it is actioned.
  // employeeIds = null means the whole organisation (HR/Admin); includeHrQueues adds the request types only HR/Admin
  // review (reimbursement, loan/advance, leave encashment, resignation).
  // The waiting requests of ONE type for the caller (a manager: their department; HR/Admin: everyone), newest first, up to
  // 50 - the mobile Approvals screen's per-type tabs, where the 10-newest mixed list would hide older ones.
  //
  // Without `paging` the answer is the plain list of the newest 50 (what every existing client reads). With it, the answer
  // is { items, hasMore, offset, limit }: one page of that newest-first list and whether more follow, so a backlog longer
  // than 50 can be read to the end ("Load more") instead of being cut off.
  async pendingItemsByType(
    actor: Actor,
    organizationId: string,
    type: string,
    paging?: { offset?: number; limit?: number },
  ) {
    const viewer = { id: actor.id, role: actor.role };
    const page = pageRequest(paging?.offset, paging?.limit);
    const options = { type, limit: 50, page: paging ? page : undefined };
    if (actor.role === Role.MANAGER) {
      // Same team as the department-head dashboard: a department-less manager has no team.
      const team =
        actor.departmentId === null
          ? []
          : await this.scopedPrisma.user.findMany({
              where: {
                organizationId,
                departmentId: actor.departmentId,
                isActive: true,
              },
              select: { id: true },
            });
      return this.pendingItems(
        organizationId,
        team.map((e) => e.id),
        false,
        viewer,
        options,
      );
    }
    return this.pendingItems(organizationId, null, true, viewer, options);
  }

  // The Work From Home rows of the waiting requests, newest request first: single days one row each, and a multi-day
  // request all of its rows together (so it is never cut in the middle). Reads `want` requests of each kind.
  private async wfhRowsForPending(
    where: Prisma.AttendanceWhereInput,
    include: { employee: { select: { name: true; employeeId: true } } },
    want: number,
  ) {
    const [singles, groups] = await Promise.all([
      this.scopedPrisma.attendance.findMany({
        where: { ...where, wfhRequestId: null },
        include,
        orderBy: { updatedAt: 'desc' },
        take: want,
      }),
      this.scopedPrisma.attendance.groupBy({
        by: ['wfhRequestId'],
        where: { ...where, wfhRequestId: { not: null } },
        _max: { updatedAt: true },
        orderBy: { _max: { updatedAt: 'desc' } },
        take: want,
      }),
    ]);
    const ids = groups.map((g) => g.wfhRequestId as string);
    const grouped = ids.length
      ? await this.scopedPrisma.attendance.findMany({
          where: { ...where, wfhRequestId: { in: ids } },
          include,
          orderBy: { updatedAt: 'desc' },
        })
      : [];
    return [...singles, ...grouped];
  }

  private async pendingItems(
    organizationId: string,
    employeeIds: string[] | null,
    includeHrQueues: boolean,
    viewer?: { id: string; role: Role },
    // `type`: only that kind of request, up to `limit` of them (default: all kinds mixed, the 10 newest). `page`: one
    // page of that list with a "more follow" flag instead of just the first `limit`.
    options?: { type?: string; limit?: number; page?: PageRequest },
  ) {
    const LIMIT = options?.limit ?? 10;
    // Rows read from each source: enough for the first LIMIT, or for the requested page plus one to know if more follow.
    const WANT = options?.page ? wanted(options.page) : LIMIT;
    const scope = this.pendingScope(organizationId, employeeIds);
    const where = this.pendingWhere(scope, viewer);
    const employeeSelect = { select: { name: true, employeeId: true } } as const;
    const off = await disabledModulesOf(organizationId);
    const [leaves, regularizations, wfh, overtime, compOffs] =
      await Promise.all([
        gate(off, 'module.leave', async () => this.scopedPrisma.leave.findMany({
          where: where.leaves,
          include: {
            employee: employeeSelect,
            leaveType: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        }), [] as never),
        gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.findMany({
          where: where.regularizations,
          include: { employee: employeeSelect },
          orderBy: { updatedAt: 'desc' },
          take: WANT,
        }), [] as never),
        // A multi-day request is several rows shown as ONE item below, so the cap counts requests, not days.
        gate(off, 'module.attendance', async () => this.wfhRowsForPending(where.wfh, { employee: employeeSelect }, WANT), [] as never),
        gate(off, 'module.attendance', async () => this.scopedPrisma.overtimeRecord.findMany({
          where: where.overtime,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        }), [] as never),
        gate(off, 'module.leave', async () => this.scopedPrisma.compOff.findMany({
          where: where.compOffs,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        }), [] as never),
      ]);
    const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
    const timeCtx = await resolveOrgTimeContext(
      this.scopedPrisma,
      organizationId,
    );
    const reimbursements = includeHrQueues && !off.has('module.loans_reimbursements')
      ? await this.scopedPrisma.reimbursement.findMany({
          where: where.reimbursements,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        })
      : [];
    const loans = includeHrQueues && !off.has('module.loans_reimbursements')
      ? await this.scopedPrisma.loan.findMany({
          where: where.loans,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        })
      : [];
    const encashments = includeHrQueues && !off.has('module.leave')
      ? await this.scopedPrisma.leaveEncashment.findMany({
          where: where.encashments,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        })
      : [];
    const resignations = includeHrQueues && !off.has('module.offboarding')
      ? await this.scopedPrisma.resignation.findMany({
          // For one kind only, so the page is not filled by the other kind: a pending resignation, or an approved one
          // whose employee asked to withdraw it.
          where:
            options?.type === 'RESIGNATION'
              ? { ...where.resignations, OR: undefined, status: ResignationStatus.PENDING }
              : options?.type === 'RESIGNATION_WITHDRAWAL'
                ? {
                    ...where.resignations,
                    OR: undefined,
                    status: ResignationStatus.APPROVED,
                    withdrawalStatus: WithdrawalRequestStatus.REQUESTED,
                  }
                : where.resignations,
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'desc' },
          take: WANT,
        })
      : [];
    const hrItems = [
      ...reimbursements.map((r) => ({
        type: 'REIMBURSEMENT' as const,
        id: r.id,
        employee: r.employee.name,
        employeeId: r.employee.employeeId,
        summary: `Reimbursement (${r.amount})`,
        date: r.claimDate,
        endDate: null as string | null,
        requestedAt: r.createdAt,
      })),
      ...loans.map((l) => ({
        type: 'LOAN' as const,
        id: l.id,
        employee: l.employee.name,
        employeeId: l.employee.employeeId,
        summary: `${l.loanType === 'ADVANCE' ? 'Advance' : 'Loan'} (${l.principal})`,
        date: l.createdAt.toISOString().slice(0, 10),
        endDate: null as string | null,
        requestedAt: l.createdAt,
      })),
      ...encashments.map((e) => ({
        type: 'ENCASHMENT' as const,
        id: e.id,
        employee: e.employee.name,
        employeeId: e.employee.employeeId,
        summary: `Leave encashment (${days(e.days)})`,
        date: e.createdAt.toISOString().slice(0, 10),
        endDate: null as string | null,
        requestedAt: e.createdAt,
      })),
      ...resignations.map((r) =>
        r.status === ResignationStatus.APPROVED
          ? {
              type: 'RESIGNATION_WITHDRAWAL' as const,
              id: r.id,
              employee: r.employee.name,
              employeeId: r.employee.employeeId,
              summary: 'Withdrawal of approved resignation',
              date: (r.withdrawalRequestedAt ?? r.createdAt)
                .toISOString()
                .slice(0, 10),
              endDate: null as string | null,
              requestedAt: r.withdrawalRequestedAt ?? r.createdAt,
            }
          : {
              type: 'RESIGNATION' as const,
              id: r.id,
              employee: r.employee.name,
              employeeId: r.employee.employeeId,
              summary: 'Resignation, last working day',
              date: r.requestedLwd,
              endDate: null as string | null,
              requestedAt: r.createdAt,
            },
      ),
    ];
    const items = [
      ...hrItems,
      ...leaves.map((l) => ({
        type: 'LEAVE' as const,
        id: l.id,
        employee: l.employee.name,
        employeeId: l.employee.employeeId,
        // An approved leave in this list is a cancellation request: it is decided on its own endpoint.
        cancellation: l.status === LeaveStatus.APPROVED,
        cancelReason:
          l.status === LeaveStatus.APPROVED ? l.cancelRequestReason : null,
        summary: `${l.status === LeaveStatus.APPROVED ? 'Cancel request: ' : ''}${l.leaveType.name} (${days(l.totalDays)})`,
        date: l.startDate,
        endDate: l.endDate === l.startDate ? null : l.endDate,
        requestedAt:
          l.status === LeaveStatus.APPROVED
            ? (l.cancelRequestedAt ?? l.createdAt)
            : l.createdAt,
        // Set once the reporting manager has signed off level 1 of a two-level leave type; the request then waits
        // for HR/Admin's final decision, so the list can say so instead of offering the manager Approve again.
        levelOneApprovedAt: l.level1ApprovedAt,
      })),
      ...regularizations.map((a) => {
        // What was actually punched and what is being asked for, in the organization's own clock, so the reviewer sees
        // both without opening the request (the Approvals dialog and the mobile card both show this line).
        const reg = a.regularization as unknown as {
          requestedInTime?: string | null;
          requestedOutTime?: string | null;
        } | null;
        const clock = (v: Date | string | null | undefined, none: string) =>
          v
            ? formatTimeInZone(
                new Date(v),
                timeCtx.timezone,
                timeCtx.timeFormat,
              )
            : none;
        const actual =
          a.inTime || a.outTime
            ? `${clock(a.inTime, 'no check-in')} - ${clock(a.outTime, 'no check-out')}`
            : 'no punch';
        const asked = `${clock(reg?.requestedInTime, '-')} - ${clock(reg?.requestedOutTime, '-')}`;
        return {
          type: 'REGULARIZATION' as const,
          id: a.id,
          employee: a.employee.name,
          employeeId: a.employee.employeeId,
          summary: `Attendance regularization (actual ${actual}; requested ${asked})`,
          date: a.date,
          endDate: null,
          requestedAt: a.updatedAt,
        };
      }),
      ...this.groupWfhRows(wfh).map((g) => ({
        type: 'WFH' as const,
        // A multi-day request is decided as one, through its request id (groupId); a single day by its row id.
        id: g.rows[0].id,
        groupId: g.requestId,
        employee: g.rows[0].employee.name,
        employeeId: g.rows[0].employee.employeeId,
        summary:
          g.rows.length > 1
            ? `Work From Home (${days(g.rows.length)})`
            : 'Work From Home',
        date: g.rows[0].date,
        endDate: g.rows.length > 1 ? g.rows[g.rows.length - 1].date : null,
        requestedAt: g.rows[0].updatedAt,
      })),
      ...overtime.map((o) => ({
        type: 'OVERTIME' as const,
        id: o.id,
        employee: o.employee.name,
        employeeId: o.employee.employeeId,
        summary: `Overtime (${o.hours}h)`,
        date: o.date,
        endDate: null,
        requestedAt: o.createdAt,
      })),
      ...compOffs.map((c) => ({
        type: 'COMP_OFF' as const,
        id: c.id,
        employee: c.employee.name,
        employeeId: c.employee.employeeId,
        summary: `Comp-off (${days(c.daysEarned)})`,
        date: c.earnedForDate,
        endDate: null,
        requestedAt: c.createdAt,
      })),
    ];
    // Newest first: the latest request is on top. With more than LIMIT waiting the list is the LIMIT newest (each
    // type was also read newest first), and the counts beside it come from pending-counts, so nothing is hidden
    // silently.
    // Requests of a module the Super Admin switched off for this company are not shown.
    const sorted = items
      .filter((i) => !off.has(REQUEST_TYPE_MODULE[i.type] ?? ''))
      .filter((i) => !options?.type || i.type === options.type)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    if (options?.page) {
      return { ...slicePage(sorted, options.page), ...options.page };
    }
    return sorted.slice(0, LIMIT);
  }

  // Working days = every date of the month that is neither one of the employee's weekly offs (department schedule,
  // else the org default) nor a holiday that applies to them, and not before their joining date.
  private async workingDaysThisMonth(
    employeeId: string,
    organizationId: string,
    monthPrefix: string,
    today: string,
  ): Promise<{ total: number; elapsed: number }> {
    const [employee, org] = await Promise.all([
      this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        include: { department: true },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      }),
    ]);
    const [year, month] = monthPrefix.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dates = enumerateDateStrings(
      `${monthPrefix}-01`,
      `${monthPrefix}-${String(lastDay).padStart(2, '0')}`,
    );
    const holidays = await this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        AND: [holidayInEffect],
        date: { startsWith: monthPrefix },
        OR: employee?.departmentId
          ? [{ departmentId: null }, { departmentId: employee.departmentId }]
          : [{ departmentId: null }],
      },
      select: { date: true },
    });
    const holidayDates = new Set(holidays.map((h) => h.date));
    const shiftConfig = resolveShiftConfig(
      employee?.department,
      (org?.attendancePayrollPrefs ??
        null) as OrganizationAttendancePrefs | null,
    );
    const joined = employee?.joiningDate?.toISOString().slice(0, 10) ?? '';
    const working = dates.filter(
      (d) =>
        d >= joined &&
        !holidayDates.has(d) &&
        !isWeeklyOff(d, shiftConfig.weeklyOffs),
    );
    return {
      total: working.length,
      elapsed: working.filter((d) => d <= today).length,
    };
  }

  // 11.3 Employee Dashboard: attendance summary, leave balance, payroll
  // snapshot, upcoming holidays.
  async employeeDashboard(actor: Actor, organizationId: string) {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const now = new Date(`${today}T00:00:00`);
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const currentFinancialYear = getFinancialYear(
      now.getMonth() + 1,
      now.getFullYear(),
      settings.financialYearStartMonth,
    );

    const off = await disabledModulesOf(organizationId);
    const [
      attendanceThisMonth,
      latestPayroll,
      upcomingHolidays,
      leaveBalances,
      compOffAvailable,
      pendingLeaveCount,
      pendingReimbursementCount,
      pendingLoanCount,
      pendingRegularizationCount,
      incompleteAttendanceCount,
      pendingCompOffCount,
      recentReimbursements,
      reimbursementPending,
      activeLoan,
      taxDeclaration,
    ] = await Promise.all([
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          date: { startsWith: monthPrefix },
        },
      }), []),
      gate(off, 'module.payroll', async () => this.scopedPrisma.payrollRun.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          // Final payslips only: an approved one can still change (see EMPLOYEE_VISIBLE_STATUSES in payroll.service.ts).
          status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }), null),
      this.scopedPrisma.holiday.findMany({
        where: {
          organizationId,
          isActive: true,
          date: { gte: today },
          // Same department-scoping HolidaysService.findAll applies — an
          // employee's own dashboard must not surface another
          // department's department-specific holidays alongside org-wide
          // (departmentId: null) ones.
          OR: actor.departmentId
            ? [{ departmentId: null }, { departmentId: actor.departmentId }]
            : [{ departmentId: null }],
        },
        orderBy: { date: 'asc' },
        take: 5,
      }),
      gate(off, 'module.leave', async () => this.scopedPrisma.leaveBalance.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          year: await this.currentLeaveYearKey(organizationId),
        },
        include: {
          leaveType: {
            select: {
              name: true,
              code: true,
              color: true,
              countInTotalBalance: true,
            },
          },
        },
      }), []),
      gate(off, 'module.leave', async () => this.compOffService.available(actor.id, organizationId), 0),
      gate(off, 'module.leave', async () => this.scopedPrisma.leave.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LeaveStatus.PENDING,
        },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: ReimbursementStatus.PENDING,
        },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.loan.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LoanStatus.PENDING,
        },
      }), 0),
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: actor.id,
          regularization: { path: ['status'], equals: 'pending' },
        },
      }), 0),
      // Days this month that still need a regularization request submitted
      // (not counted via the `regularization` JSON above — that only
      // tracks requests already made) — this is the "you need to act"
      // nudge, surfaced separately from the "waiting on HR" count.
      gate(off, 'module.attendance', async () => this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: actor.id,
          date: { startsWith: monthPrefix },
          status: AttendanceStatus.INCOMPLETE,
        },
      }), 0),
      gate(off, 'module.leave', async () => this.scopedPrisma.compOff.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: CompOffStatus.PENDING,
        },
      }), 0),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.findMany({
        where: { organizationId, employeeId: actor.id },
        orderBy: { claimDate: 'desc' },
        take: 5,
      }), []),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.reimbursement.aggregate({
        where: {
          organizationId,
          employeeId: actor.id,
          status: ReimbursementStatus.PENDING,
        },
        _sum: { amount: true },
        _count: true,
      }), { _sum: { amount: 0 }, _count: 0 } as never),
      gate(off, 'module.loans_reimbursements', async () => this.scopedPrisma.loan.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LoanStatus.ACTIVE,
        },
        orderBy: { createdAt: 'desc' },
      }), null),
      gate(off, 'module.statutory', async () => this.scopedPrisma.employeeTaxDeclaration.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          financialYear: currentFinancialYear,
        },
      }), null),
    ]);

    const summary: Record<string, number> = {
      PRESENT: 0,
      HALF_DAY: 0,
      ABSENT: 0,
      ON_LEAVE: 0,
      HOLIDAY: 0,
      WEEKLY_OFF: 0,
      INCOMPLETE: 0,
    };
    for (const row of attendanceThisMonth) {
      summary[row.status] = (summary[row.status] ?? 0) + 1;
    }

    return {
      attendanceSummary: summary,
      // Working days in this month for the employee's own schedule (weekly offs + holidays excluded), and how many
      // of them have passed — the "x / working days" figure on the attendance card.
      attendanceWorkingDays: await gate(
        off,
        'module.attendance',
        async () =>
          this.workingDaysThisMonth(actor.id, organizationId, monthPrefix, today),
        { total: 0, elapsed: 0 },
      ),
      leaveBalances,
      compOffAvailable,
      payrollSnapshot: latestPayroll,
      upcomingHolidays,
      // "What am I still waiting on" — rolled up across every module an
      // employee can submit a request through, so the dashboard answers
      // that without a trip to five separate pages.
      pendingRequests: {
        leave: pendingLeaveCount,
        reimbursement: pendingReimbursementCount,
        loan: pendingLoanCount,
        regularization: pendingRegularizationCount,
        compOff: pendingCompOffCount,
      },
      // Days this month marked Incomplete (punch-out missing) that the
      // employee hasn't yet requested regularization for — drives the
      // "N day(s) need your attention" dashboard nudge.
      incompleteAttendanceCount,
      reimbursements: {
        recent: recentReimbursements,
        pendingCount: reimbursementPending._count,
        pendingAmount: reimbursementPending._sum.amount ?? 0,
      },
      activeLoan,
      taxDeclaration: {
        financialYear: currentFinancialYear,
        status: taxDeclaration?.status ?? null,
      },
    };
  }

  // 11.4 Executive Dashboard: company-wide headcount trend, upcoming
  // birthdays, and upcoming work anniversaries. Admin/HR only, distinct
  // from the operational HR dashboard (today/this-month focused vs.
  // trend/company-health focused).
  //
  // Headcount "leavers" are sourced from OffboardingCase.completedAt
  // instead of an EMPLOYEE_DEACTIVATED audit-log action (the original release's
  // source) — OffboardingCase is actually a more precise signal anyway (a
  // dedicated event, not an inferred one). This deliberately does NOT
  // attempt to reconstruct exact historical total headcount for each past
  // month — it reports joiners, leavers, and net change per month, which
  // is honest given what's actually recorded, plus the current live
  // headcount, total joiners/leavers, and an attrition rate as reference
  // figures (all straight from computeHeadcountTrend below, shared with
  // the Reports module's headcount-trend/attrition reports — one DB
  // round-trip, reused everywhere headcount trend numbers are needed).
  //
  // Birthdays read personalData.dateOfBirth (added in the Employee
  // rich-profile batch, after this method was first written — an employee
  // with no dateOfBirth set just never appears in the widget, same as an
  // employee with no personalData at all).
  async computeHeadcountTrend(months: number, organizationId: string) {
    // "Now" is the organisation's calendar day, not the server clock. Joining dates are calendar dates stored at UTC
    // midnight, so they are bucketed by their UTC fields; a completed offboarding is an instant, so it is bucketed by
    // its date in the organisation's time zone.
    const timezone = await this.getOrgTimezone(organizationId);
    const today = await this.orgNow(organizationId);
    const windowStart = new Date(
      Date.UTC(today.getFullYear(), today.getMonth() - (months - 1), 1),
    );
    const windowStartDateStr = windowStart.toISOString().slice(0, 10);
    const windowStartInstant = startOfDayInOrgTzUtc(
      windowStartDateStr,
      timezone,
    );

    const [
      joiners,
      leavers,
      currentActiveHeadcount,
      joinedBeforeWindow,
      leftBeforeWindow,
    ] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, joiningDate: { gte: windowStart } },
        select: { joiningDate: true },
      }),
      this.scopedPrisma.offboardingCase.findMany({
        where: {
          organizationId,
          status: OffboardingStatus.COMPLETED,
          completedAt: { gte: windowStartInstant },
        },
        select: { completedAt: true },
      }),
      this.scopedPrisma.user.count({
        where: { organizationId, isActive: true },
      }),
      this.scopedPrisma.user.count({
        where: { organizationId, joiningDate: { lt: windowStart } },
      }),
      this.scopedPrisma.offboardingCase.count({
        where: {
          organizationId,
          status: OffboardingStatus.COMPLETED,
          completedAt: { lt: windowStartInstant },
        },
      }),
    ]);

    const joinersByKey = new Map<string, number>();
    for (const j of joiners) {
      const key = `${j.joiningDate.getUTCFullYear()}-${j.joiningDate.getUTCMonth() + 1}`;
      joinersByKey.set(key, (joinersByKey.get(key) ?? 0) + 1);
    }
    const leaversByKey = new Map<string, number>();
    for (const l of leavers) {
      if (!l.completedAt) continue;
      const [cy, cm] = dateStrInOrgTz(timezone, l.completedAt)
        .split('-')
        .map(Number);
      const key = `${cy}-${cm}`;
      leaversByKey.set(key, (leaversByKey.get(key) ?? 0) + 1);
    }

    const rows: {
      year: number;
      month: number;
      label: string;
      joiners: number;
      leavers: number;
      net: number;
    }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      const j = joinersByKey.get(key) ?? 0;
      const l = leaversByKey.get(key) ?? 0;
      rows.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        label: `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`,
        joiners: j,
        leavers: l,
        net: j - l,
      });
    }

    const totalJoiners = rows.reduce((s, r) => s + r.joiners, 0);
    const totalLeavers = rows.reduce((s, r) => s + r.leavers, 0);
    // Average-headcount-based attrition rate over the window: leavers
    // divided by the average of (current headcount) and (headcount at
    // window start).
    //
    // Headcount at window start is queried directly (employees who joined
    // before the window, minus those already offboarded before the
    // window) rather than back-solved as `current - (joiners - leavers)`.
    // The back-solved version breaks down for any organization younger
    // than the trend window (very common — new/demo/QA orgs, or any
    // startup under a year old): once joiners-in-window minus
    // leavers-in-window reaches or exceeds current headcount, the
    // back-solved start clamps to 0, which collapses avgHeadcount to
    // roughly half of current headcount and inflates the attrition rate
    // to well above what any standard formula would produce — e.g. 9
    // active / 12 joiners / 3 leavers over 12mo back-solved to 66.7%
    // instead of a sane figure.
    const startHeadcount = Math.max(0, joinedBeforeWindow - leftBeforeWindow);
    const avgHeadcount = (currentActiveHeadcount + startHeadcount) / 2;
    const attritionRatePercent =
      avgHeadcount > 0
        ? Math.round((totalLeavers / avgHeadcount) * 1000) / 10
        : 0;

    return {
      rows,
      currentActiveHeadcount,
      totalJoiners,
      totalLeavers,
      attritionRatePercent,
    };
  }

  async executiveDashboard(organizationId: string) {
    const WINDOW_DAYS = 30;
    const today = await this.orgNow(organizationId);
    const todayStr = todayInOrgTz(await this.getOrgTimezone(organizationId));

    // Birthdays only need the date of birth, which is stored as plain text inside personalData. Reading the whole
    // personalData would decrypt every employee's PAN / Aadhaar / bank fields just to throw them away, so the one key is
    // read in SQL (organizationId is a bound parameter).
    const [headcount, activeEmployees] = await Promise.all([
      this.computeHeadcountTrend(12, organizationId),
      this.scopedPrisma.$queryRaw<
        {
          id: string;
          name: string;
          employeeId: string;
          joiningDate: Date;
          dateOfBirth: string | null;
        }[]
      >`SELECT "id", "name", "employeeId", "joiningDate",
               "personalData"->>'dateOfBirth' AS "dateOfBirth"
          FROM "users"
         WHERE "organizationId" = ${organizationId} AND "isActive" = true
           AND "joiningDate" <= ${today}
           AND ("exitDate" IS NULL OR "exitDate" >= ${todayStr})
         ORDER BY "employeeId" ASC`,
    ]);

    const upcomingAnniversaries: {
      id: string;
      name: string;
      employeeId: string;
      daysAway: number;
      years: number;
    }[] = [];
    const upcomingBirthdays: {
      id: string;
      name: string;
      employeeId: string;
      daysAway: number;
    }[] = [];
    for (const e of activeEmployees) {
      const jd = e.joiningDate;
      const days = daysUntilNextOccurrence(
        jd.getUTCMonth() + 1,
        jd.getUTCDate(),
        today,
      );
      if (days <= WINDOW_DAYS) {
        const anniversaryDate = new Date(today);
        anniversaryDate.setDate(today.getDate() + days);
        const years = anniversaryDate.getFullYear() - jd.getUTCFullYear();
        if (years >= 1) {
          upcomingAnniversaries.push({
            id: e.id,
            name: e.name,
            employeeId: e.employeeId,
            daysAway: days,
            years,
          });
        }
      }

      const dob = e.dateOfBirth;
      // YYYY-MM-DD, read as the calendar date it is (not through a time zone).
      const dobParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? '');
      if (dobParts) {
        const birthdayDays = daysUntilNextOccurrence(
          Number(dobParts[2]),
          Number(dobParts[3]),
          today,
        );
        if (birthdayDays <= WINDOW_DAYS) {
          upcomingBirthdays.push({
            id: e.id,
            name: e.name,
            employeeId: e.employeeId,
            daysAway: birthdayDays,
          });
        }
      }
    }
    upcomingAnniversaries.sort((a, b) => a.daysAway - b.daysAway);
    upcomingBirthdays.sort((a, b) => a.daysAway - b.daysAway);

    return {
      headcount,
      upcomingBirthdays: upcomingBirthdays.slice(0, 10),
      upcomingAnniversaries: upcomingAnniversaries.slice(0, 10),
    };
  }
}
