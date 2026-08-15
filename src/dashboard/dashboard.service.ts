import { Inject, Injectable } from '@nestjs/common';
import {
  AttendanceStatus,
  LeaveStatus,
  OffboardingStatus,
  PayrollRunStatus,
  ReimbursementStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { CompOffService } from '../comp-offs/comp-off.service';
import {
  DashboardRange,
  MONTH_LABELS,
  daysUntilNextOccurrence,
  monthsForRange,
} from './dashboard-date-math';

type Actor = Omit<User, 'password'>;

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
      const taxAmount = findDeductionAmount(run.deductions, 'INCOME_TAX');
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
    const today = localDateStr();
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const monthPrefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

    const [
      totalEmployees,
      presentToday,
      absentToday,
      onLeaveToday,
      pendingLeaves,
      pendingRegularizations,
      leaveStatsRaw,
      payrollThisMonth,
      currentMonthRuns,
      draftRuns,
      settings,
      reimbPending,
      reimbApproved,
      reimbRejected,
      reimbAmountPendingAgg,
      upcomingHolidays,
      lowBalanceRows,
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
      this.scopedPrisma.attendance.findMany({
        where: { organizationId },
        select: { regularization: true },
      }),
      this.scopedPrisma.leave.findMany({
        where: { organizationId },
        include: { leaveType: { select: { name: true, code: true } } },
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
        where: { organizationId, date: { gte: today } },
        orderBy: { date: 'asc' },
        take: 3,
      }),
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, year: currentYear, closing: { lt: 2 } },
        include: {
          employee: { select: { id: true, name: true, employeeId: true } },
          leaveType: { select: { id: true, name: true, code: true } },
        },
        orderBy: { closing: 'asc' },
        take: 10,
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

    const leaveStatsByType = new Map<
      string,
      { name: string; code?: string; count: number }
    >();
    for (const l of leaveStatsRaw) {
      const key = l.leaveType.name;
      const entry = leaveStatsByType.get(key) ?? {
        name: key,
        code: l.leaveType.code,
        count: 0,
      };
      entry.count += 1;
      leaveStatsByType.set(key, entry);
    }

    const pendingRegularizationCount = pendingRegularizations.filter(
      (r) => (r.regularization as { status?: string })?.status === 'pending',
    ).length;

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
      totalTDS: sumDeductionCode(currentMonthRuns, 'INCOME_TAX'),
      totalPF: settings.pfEnabled
        ? sumDeductionCode(currentMonthRuns, 'PF')
        : null,
      totalESI: settings.esiEnabled
        ? sumDeductionCode(currentMonthRuns, 'ESI')
        : null,
      totalPT: settings.ptEnabled
        ? sumDeductionCode(currentMonthRuns, 'PT')
        : null,
      totalLWF: settings.lwfEnabled
        ? sumDeductionCode(currentMonthRuns, 'LWF')
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
      attendanceSummary: { presentToday, absentToday, onLeaveToday },
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
      lowBalanceEmployees: lowBalanceRows,
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
    const today = localDateStr();
    const currentYear = new Date().getFullYear();

    const deptEmployees = await this.scopedPrisma.user.findMany({
      where: { organizationId, departmentId: actor.departmentId },
      select: { id: true },
    });
    const ids = deptEmployees.map((e) => e.id);

    const [
      teamAttendanceToday,
      pendingLeaves,
      pendingRegularizationRows,
      leaveTrendsRaw,
      teamLeaveBalancesRaw,
    ] = await Promise.all([
      this.scopedPrisma.attendance.findMany({
        where: { organizationId, employeeId: { in: ids }, date: today },
        include: {
          employee: { select: { id: true, name: true, employeeId: true } },
        },
      }),
      this.scopedPrisma.leave.count({
        where: {
          organizationId,
          employeeId: { in: ids },
          status: LeaveStatus.PENDING,
        },
      }),
      this.scopedPrisma.attendance.findMany({
        where: { organizationId, employeeId: { in: ids } },
        select: { regularization: true },
      }),
      this.scopedPrisma.leave.findMany({
        where: { organizationId, employeeId: { in: ids } },
        include: { leaveType: { select: { name: true, code: true } } },
      }),
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, employeeId: { in: ids }, year: currentYear },
        include: {
          employee: { select: { name: true, employeeId: true } },
          leaveType: { select: { name: true } },
        },
        orderBy: { closing: 'asc' },
      }),
    ]);

    const pendingRegularizations = pendingRegularizationRows.filter(
      (r) => (r.regularization as { status?: string })?.status === 'pending',
    ).length;

    const leaveTrendsByType = new Map<
      string,
      { name: string; code?: string; count: number }
    >();
    for (const l of leaveTrendsRaw) {
      const key = l.leaveType.name;
      const entry = leaveTrendsByType.get(key) ?? {
        name: key,
        code: l.leaveType.code,
        count: 0,
      };
      entry.count += 1;
      leaveTrendsByType.set(key, entry);
    }

    const teamLeaveBalances = teamLeaveBalancesRaw.map((b) => ({
      id: b.id,
      employee: b.employee.name,
      employeeId: b.employee.employeeId,
      leaveType: b.leaveType.name,
      closing: b.closing,
    }));

    return {
      teamSize: ids.length,
      teamAttendanceToday,
      pendingApprovals: {
        leaves: pendingLeaves,
        regularizations: pendingRegularizations,
      },
      leaveTrends: [...leaveTrendsByType.values()],
      teamLeaveBalances,
    };
  }

  // 11.3 Employee Dashboard: attendance summary, leave balance, payroll
  // snapshot, upcoming holidays.
  async employeeDashboard(actor: Actor, organizationId: string) {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currentYear = now.getFullYear();
    const today = localDateStr(now);

    const [
      attendanceThisMonth,
      latestPayroll,
      upcomingHolidays,
      leaveBalances,
      compOffAvailable,
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
        where: { organizationId, date: { gte: today } },
        orderBy: { date: 'asc' },
        take: 5,
      }),
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, employeeId: actor.id, year: currentYear },
        include: {
          leaveType: { select: { name: true, code: true, color: true } },
        },
      }),
      this.compOffService.available(actor.id, organizationId),
    ]);

    const summary: Record<string, number> = {
      PRESENT: 0,
      HALF_DAY: 0,
      ABSENT: 0,
      ON_LEAVE: 0,
      HOLIDAY: 0,
      WEEKLY_OFF: 0,
    };
    for (const row of attendanceThisMonth) {
      summary[row.status] = (summary[row.status] ?? 0) + 1;
    }

    return {
      attendanceSummary: summary,
      leaveBalances,
      compOffAvailable,
      payrollSnapshot: latestPayroll,
      upcomingHolidays,
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

    const [joiners, leavers, currentActiveHeadcount] = await Promise.all([
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
    // Simple average-headcount-based attrition rate over the window:
    // leavers divided by the average of (current headcount) and
    // (headcount at window start, estimated by working backward from
    // current using net changes).
    const estimatedStartHeadcount = Math.max(
      0,
      currentActiveHeadcount - (totalJoiners - totalLeavers),
    );
    const avgHeadcount = (currentActiveHeadcount + estimatedStartHeadcount) / 2;
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
