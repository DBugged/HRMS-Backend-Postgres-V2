// Purpose: Aggregates read-only dashboard views for HR, department-head, employee and executive roles.
// Responsibilities: Owns all cross-model aggregation queries and derived stats (payroll cost summary,
// attendance/leave/reimbursement snapshots, headcount trend, upcoming birthdays/anniversaries); delegates
// payroll settings lookup to PayrollSettingsService and comp-off balance to CompOffService rather than
// recomputing them.
// Important: departmentHeadDashboard() intentionally ports a quirk from the old system — a manager with no
// department matches every other no-department user via departmentId: null, not zero rows.
// computeHeadcountTrend() is shared with the Reports module so headcount numbers stay consistent everywhere.
import { EMPLOYEE_ORDER_BY } from '../common/employee-order';
import { Inject, Injectable } from '@nestjs/common';
import {
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
  Role,
  User,
  WfhApprovalStatus,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { CompOffService } from '../comp-offs/comp-off.service';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { getFinancialYear } from '../payroll-settings/financial-year';
import {
  DashboardRange,
  MONTH_LABELS,
  daysUntilNextOccurrence,
  monthsForRange,
} from './dashboard-date-math';
import { todayInOrgTz } from '../common/org-date';
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
  ) {}

  private async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  // 11.4 Payroll Cost Summary chart: Net Pay / Taxes / Benefits / Deductions
  // per month for the requested range.
  async payrollCostSummary(range: DashboardRange, organizationId: string) {
    const months = monthsForRange(range);

    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        OR: months.map((m) => ({ month: m.month, year: m.year })),
        status: { not: PayrollRunStatus.DRAFT },
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
  async hrDashboard(organizationId: string) {
    const now = new Date();
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId), now);
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthPrefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

    const [
      totalEmployees,
      presentToday,
      absentToday,
      incompleteToday,
      onLeaveToday,
      pendingLeaves,
      pendingRegularizationCount,
      leaveStatsGrouped,
      leaveTypesForStats,
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
      this.scopedPrisma.user.count({
        where: { organizationId, isActive: true },
      }),
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.PRESENT,
        },
      }),
      this.scopedPrisma.attendance.count({
        where: { organizationId, date: today, status: AttendanceStatus.ABSENT },
      }),
      // Punched in, no punch-out, shift already ended — distinct from a
      // plain no-show so HR can see who still needs to regularize today.
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.INCOMPLETE,
        },
      }),
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          date: today,
          status: AttendanceStatus.ON_LEAVE,
        },
      }),
      this.scopedPrisma.leave.count({
        where: { organizationId, status: LeaveStatus.PENDING },
      }),
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          regularization: { path: ['status'], equals: 'pending' },
        },
      }),
      this.scopedPrisma.leave.groupBy({
        by: ['leaveTypeId'],
        where: { organizationId },
        _count: { _all: true },
      }),
      this.scopedPrisma.leaveType.findMany({
        where: { organizationId },
        select: { id: true, name: true, code: true },
      }),
      this.scopedPrisma.payrollRun.count({
        where: {
          organizationId,
          month: currentMonth,
          year: currentYear,
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
      }),
      this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          month: currentMonth,
          year: currentYear,
          status: { not: PayrollRunStatus.DRAFT },
          isFinalSettlement: false,
        },
      }),
      this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          status: PayrollRunStatus.DRAFT,
          isFinalSettlement: false,
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
      this.payrollSettingsService.getOrCreate(organizationId),
      this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.PENDING },
      }),
      this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.APPROVED },
      }),
      this.scopedPrisma.reimbursement.count({
        where: { organizationId, status: ReimbursementStatus.REJECTED },
      }),
      this.scopedPrisma.reimbursement.aggregate({
        where: { organizationId, status: ReimbursementStatus.PENDING },
        _sum: { amount: true },
      }),
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
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, year: currentYear },
        include: {
          employee: { select: { id: true, name: true, employeeId: true } },
        },
      }),
      this.scopedPrisma.leave.findMany({
        where: {
          organizationId,
          status: LeaveStatus.APPROVED,
          startDate: { lte: `${monthPrefix}-31` },
          endDate: { gte: `${monthPrefix}-01` },
        },
        include: { employee: { select: { departmentId: true } } },
      }),
    ]);

    const leaveTypeById = new Map(leaveTypesForStats.map((lt) => [lt.id, lt]));
    const leaveStatsByType = new Map<
      string,
      { name: string; code?: string; count: number }
    >();
    for (const g of leaveStatsGrouped) {
      const leaveType = leaveTypeById.get(g.leaveTypeId);
      const key = leaveType?.name ?? g.leaveTypeId;
      const entry = leaveStatsByType.get(key) ?? {
        name: key,
        code: leaveType?.code,
        count: 0,
      };
      entry.count += g._count._all;
      leaveStatsByType.set(key, entry);
    }

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

    const deptTotals = new Map<string, number>();
    for (const l of deptLeaveSummaryRaw) {
      const deptId = l.employee.departmentId ?? 'unassigned';
      deptTotals.set(deptId, (deptTotals.get(deptId) ?? 0) + l.totalDays);
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

    const taxCompliance = {
      totalTDS: sumDeductionCode(
        currentMonthRuns,
        SALARY_COMPONENT_CODES.INCOME_TAX,
      ),
      totalPF: settings.pfEnabled
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.PF)
        : null,
      totalESI: settings.esiEnabled
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.ESI)
        : null,
      totalPT: settings.ptEnabled
        ? sumDeductionCode(currentMonthRuns, SALARY_COMPONENT_CODES.PT)
        : null,
      totalLWF: settings.lwfEnabled
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
        paymentDate: new Date(year, month, 0).toISOString().slice(0, 10),
      };
    }

    return {
      totalEmployees,
      attendanceSummary: {
        presentToday,
        absentToday,
        incompleteToday,
        onLeaveToday,
      },
      pendingItems: await this.pendingItems(organizationId, null, true),
      pendingApprovals: {
        leaves: pendingLeaves,
        regularizations: pendingRegularizationCount,
      },
      payrollStatus: { processedThisMonth: payrollThisMonth, totalEmployees },
      leaveStatistics: [...leaveStatsByType.values()],
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
  // exactly from the old system's `where: { department: req.user.department }`,
  // including its quirk for a caller with no department: `departmentId: null`
  // matches every other no-department user, not zero rows. Harmless (no
  // dept-scoped data is more exposed than an ADMIN/HR caller already sees
  // elsewhere), but worth knowing before wiring a frontend "my team" widget
  // to this endpoint for a non-manager caller.
  async departmentHeadDashboard(actor: Actor, organizationId: string) {
    const currentYear = new Date().getFullYear();

    // A department-less MANAGER has no team: scope to nobody rather than to every unassigned user.
    // (Other roles keep the documented null-department behaviour above.)
    const deptEmployees =
      actor.departmentId === null && actor.role === Role.MANAGER
        ? []
        : await this.scopedPrisma.user.findMany({
            where: { organizationId, departmentId: actor.departmentId },
            select: { id: true },
          });
    const ids = deptEmployees.map((e) => e.id);

    const [
      pendingLeaves,
      pendingRegularizations,
      leaveTrendsGrouped,
      leaveTypesForTrends,
      teamLeaveBalancesRaw,
    ] = await Promise.all([
      this.scopedPrisma.leave.count({
        where: {
          organizationId,
          employeeId: { in: ids },
          status: LeaveStatus.PENDING,
        },
      }),
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: { in: ids },
          regularization: { path: ['status'], equals: 'pending' },
        },
      }),
      this.scopedPrisma.leave.groupBy({
        by: ['leaveTypeId'],
        where: { organizationId, employeeId: { in: ids } },
        _count: { _all: true },
      }),
      this.scopedPrisma.leaveType.findMany({
        where: { organizationId },
        select: { id: true, name: true, code: true },
      }),
      this.scopedPrisma.leaveBalance.findMany({
        where: {
          organizationId,
          employeeId: { in: ids },
          year: currentYear,
          // Leave types switched off for the Leave Tracker stay hidden here too.
          leaveType: { showInLeaveTracker: true },
        },
        include: {
          employee: { select: { name: true, employeeId: true } },
          leaveType: { select: { name: true, code: true, displayOrder: true } },
        },
        orderBy: { closing: 'asc' },
      }),
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
      pendingItems: await this.pendingItems(organizationId, ids, false),
      leaveTrends: [...leaveTrendsByType.values()],
      teamLeaveBalances,
    };
  }

  // The quick-check list of what is waiting for a decision, oldest first (at most 10).
  // Leave, attendance regularization, Work From Home, overtime and comp-off — the request types a manager can
  // review. Each row carries what the dashboard needs to show it and link to the page where it is actioned.
  // employeeIds = null means the whole organisation (HR/Admin); includeHrQueues adds the request types only HR/Admin
  // review (reimbursement, loan/advance, leave encashment, resignation).
  private async pendingItems(
    organizationId: string,
    employeeIds: string[] | null,
    includeHrQueues: boolean,
  ) {
    const LIMIT = 10;
    const scope = employeeIds
      ? { organizationId, employeeId: { in: employeeIds } }
      : { organizationId };
    const employeeSelect = { select: { name: true, employeeId: true } };
    const [leaves, regularizations, wfh, overtime, compOffs] =
      await Promise.all([
        this.scopedPrisma.leave.findMany({
          where: { ...scope, status: LeaveStatus.PENDING },
          include: {
            employee: employeeSelect,
            leaveType: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        }),
        this.scopedPrisma.attendance.findMany({
          where: {
            ...scope,
            regularization: { path: ['status'], equals: 'pending' },
          },
          include: { employee: employeeSelect },
          orderBy: { updatedAt: 'asc' },
          take: LIMIT,
        }),
        this.scopedPrisma.attendance.findMany({
          where: { ...scope, workArrangementStatus: WfhApprovalStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { updatedAt: 'asc' },
          take: LIMIT,
        }),
        this.scopedPrisma.overtimeRecord.findMany({
          where: { ...scope, status: OvertimeStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        }),
        this.scopedPrisma.compOff.findMany({
          where: { ...scope, status: CompOffStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        }),
      ]);
    const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
    const reimbursements = includeHrQueues
      ? await this.scopedPrisma.reimbursement.findMany({
          where: { ...scope, status: ReimbursementStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        })
      : [];
    const loans = includeHrQueues
      ? await this.scopedPrisma.loan.findMany({
          where: { ...scope, status: LoanStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        })
      : [];
    const encashments = includeHrQueues
      ? await this.scopedPrisma.leaveEncashment.findMany({
          where: { ...scope, status: LeaveEncashmentStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
        })
      : [];
    const resignations = includeHrQueues
      ? await this.scopedPrisma.resignation.findMany({
          where: { ...scope, status: ResignationStatus.PENDING },
          include: { employee: employeeSelect },
          orderBy: { createdAt: 'asc' },
          take: LIMIT,
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
      ...resignations.map((r) => ({
        type: 'RESIGNATION' as const,
        id: r.id,
        employee: r.employee.name,
        employeeId: r.employee.employeeId,
        summary: 'Resignation, last working day',
        date: r.requestedLwd,
        endDate: null as string | null,
        requestedAt: r.createdAt,
      })),
    ];
    const items = [
      ...hrItems,
      ...leaves.map((l) => ({
        type: 'LEAVE' as const,
        id: l.id,
        employee: l.employee.name,
        employeeId: l.employee.employeeId,
        summary: `${l.leaveType.name} (${days(l.totalDays)})`,
        date: l.startDate,
        endDate: l.endDate === l.startDate ? null : l.endDate,
        requestedAt: l.createdAt,
      })),
      ...regularizations.map((a) => ({
        type: 'REGULARIZATION' as const,
        id: a.id,
        employee: a.employee.name,
        employeeId: a.employee.employeeId,
        summary: 'Attendance regularization',
        date: a.date,
        endDate: null,
        requestedAt: a.updatedAt,
      })),
      ...wfh.map((a) => ({
        type: 'WFH' as const,
        id: a.id,
        employee: a.employee.name,
        employeeId: a.employee.employeeId,
        summary: 'Work From Home',
        date: a.date,
        endDate: null,
        requestedAt: a.updatedAt,
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
    return items
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, LIMIT);
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
        isActive: true,
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
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentYear = now.getFullYear();
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId), now);
    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const currentFinancialYear = getFinancialYear(
      now.getMonth() + 1,
      now.getFullYear(),
      settings.financialYearStartMonth,
    );

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
      this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          date: { startsWith: monthPrefix },
        },
      }),
      this.scopedPrisma.payrollRun.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          status: {
            in: [
              PayrollRunStatus.APPROVED,
              PayrollRunStatus.LOCKED,
              PayrollRunStatus.PAID,
            ],
          },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
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
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, employeeId: actor.id, year: currentYear },
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
      }),
      this.compOffService.available(actor.id, organizationId),
      this.scopedPrisma.leave.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LeaveStatus.PENDING,
        },
      }),
      this.scopedPrisma.reimbursement.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: ReimbursementStatus.PENDING,
        },
      }),
      this.scopedPrisma.loan.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LoanStatus.PENDING,
        },
      }),
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: actor.id,
          regularization: { path: ['status'], equals: 'pending' },
        },
      }),
      // Days this month that still need a regularization request submitted
      // (not counted via the `regularization` JSON above — that only
      // tracks requests already made) — this is the "you need to act"
      // nudge, surfaced separately from the "waiting on HR" count.
      this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: actor.id,
          date: { startsWith: monthPrefix },
          status: AttendanceStatus.INCOMPLETE,
        },
      }),
      this.scopedPrisma.compOff.count({
        where: {
          organizationId,
          employeeId: actor.id,
          status: CompOffStatus.PENDING,
        },
      }),
      this.scopedPrisma.reimbursement.findMany({
        where: { organizationId, employeeId: actor.id },
        orderBy: { claimDate: 'desc' },
        take: 5,
      }),
      this.scopedPrisma.reimbursement.aggregate({
        where: {
          organizationId,
          employeeId: actor.id,
          status: ReimbursementStatus.PENDING,
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.scopedPrisma.loan.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          status: LoanStatus.ACTIVE,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.scopedPrisma.employeeTaxDeclaration.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          financialYear: currentFinancialYear,
        },
      }),
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
      attendanceWorkingDays: await this.workingDaysThisMonth(
        actor.id,
        organizationId,
        monthPrefix,
        today,
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
  // instead of an EMPLOYEE_DEACTIVATED audit-log action (the old system's
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
    const today = new Date();
    const windowStart = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
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
          completedAt: { gte: windowStart },
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
          completedAt: { lt: windowStart },
        },
      }),
    ]);

    const joinersByKey = new Map<string, number>();
    for (const j of joiners) {
      const key = `${j.joiningDate.getFullYear()}-${j.joiningDate.getMonth() + 1}`;
      joinersByKey.set(key, (joinersByKey.get(key) ?? 0) + 1);
    }
    const leaversByKey = new Map<string, number>();
    for (const l of leavers) {
      if (!l.completedAt) continue;
      const key = `${l.completedAt.getFullYear()}-${l.completedAt.getMonth() + 1}`;
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
    const today = new Date();

    const [headcount, activeEmployees] = await Promise.all([
      this.computeHeadcountTrend(12, organizationId),
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          name: true,
          employeeId: true,
          joiningDate: true,
          personalData: true,
        },
        orderBy: EMPLOYEE_ORDER_BY,
      }),
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
        jd.getMonth() + 1,
        jd.getDate(),
        today,
      );
      if (days <= WINDOW_DAYS) {
        const anniversaryDate = new Date(today);
        anniversaryDate.setDate(today.getDate() + days);
        const years = anniversaryDate.getFullYear() - jd.getFullYear();
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

      const dob = (e.personalData as Record<string, unknown> | null)
        ?.dateOfBirth;
      if (typeof dob === 'string' && dob) {
        const parsed = new Date(dob);
        if (!Number.isNaN(parsed.getTime())) {
          const birthdayDays = daysUntilNextOccurrence(
            parsed.getMonth() + 1,
            parsed.getDate(),
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
