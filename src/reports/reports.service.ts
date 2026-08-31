// Purpose: General-purpose exportable reports — attendance, leave register/balance/history, department
// leave summary, payroll, employee, department, headcount trend, and attrition.
// Responsibilities: Owns per-report row/column shaping and MANAGER dept-scoping (always forced to the
// caller's own department, never a caller-chosen one); delegates headcount/attrition math to
// DashboardService.computeHeadcountTrend so the numbers stay consistent with the Executive Dashboard.
import { Inject, Injectable } from '@nestjs/common';
import { LeaveStatus, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import {
  formatDateDisplay,
  formatDateTimeDisplay,
} from '../payroll/format-date';
import { DashboardService } from '../dashboard/dashboard.service';
import { ReportColumn } from './report-export';
import {
  AttendanceReportQueryDto,
  DepartmentLeaveSummaryReportQueryDto,
  EmployeeLeaveHistoryReportQueryDto,
  HeadcountReportQueryDto,
  LeaveBalanceReportQueryDto,
  LeaveReportQueryDto,
  PayrollReportQueryDto,
} from './dto/report-queries.dto';

type Actor = Omit<User, 'password'>;

export interface ReportPayload {
  title: string;
  // Printed under the title (Excel: a merged row above the column
  // headers; PDF: a line under the title). Used by the statutory
  // compliance reports (PF/ESI/PT/Form 16) to carry the org's own
  // establishment/employer/registration number — the government needs to
  // know which establishment a filing belongs to, so these can't just be
  // a bare table of employee rows. Omitted entirely for reports that
  // don't need it.
  subtitle?: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  filename: string;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly dashboardService: DashboardService,
  ) {}

  async attendanceReport(
    query: AttendanceReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.AttendanceWhereInput = { organizationId };
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = query.from;
      if (query.to) where.date.lte = query.to;
    }
    if (actor.role === Role.MANAGER) {
      // Ignore query.department for MANAGER — always their own, never a
      // caller-chosen one, so a MANAGER can't request another dept's report.
      where.employee = { departmentId: actor.departmentId };
    } else if (query.department) {
      where.employee = { departmentId: query.department };
    }

    const records = await this.scopedPrisma.attendance.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: { date: 'asc' },
    });

    const rows = records.map((r) => ({
      employeeId: r.employee.employeeId,
      name: r.employee.name,
      date: formatDateDisplay(r.date),
      inTime: formatDateTimeDisplay(r.inTime),
      outTime: formatDateTimeDisplay(r.outTime),
      workHours: (r.workDurationMinutes / 60).toFixed(2),
      status: r.status,
    }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'In Time', key: 'inTime', width: 25 },
      { header: 'Out Time', key: 'outTime', width: 25 },
      { header: 'Work Hours', key: 'workHours', width: 12 },
      { header: 'Status', key: 'status', width: 15 },
    ];

    return {
      title: 'Attendance Report',
      columns,
      rows,
      filename: 'attendance_report',
    };
  }

  async leaveReport(
    query: LeaveReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.LeaveWhereInput = { organizationId };
    if (query.status) where.status = query.status;
    if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }

    const leaves = await this.scopedPrisma.leave.findMany({
      where,
      include: {
        employee: { select: { name: true, employeeId: true } },
        leaveType: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = leaves.map((l) => ({
      employeeId: l.employee.employeeId,
      name: l.employee.name,
      leaveType: l.leaveType.name,
      startDate: formatDateDisplay(l.startDate),
      endDate: formatDateDisplay(l.endDate),
      totalDays: l.totalDays,
      halfDay: l.isHalfDay ? 'Yes' : 'No',
      attachment: l.attachmentUrl ? 'Yes' : 'No',
      status: l.status,
    }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Leave Type', key: 'leaveType', width: 16 },
      { header: 'Start Date', key: 'startDate', width: 15 },
      { header: 'End Date', key: 'endDate', width: 15 },
      { header: 'Total Days', key: 'totalDays', width: 12 },
      { header: 'Half Day', key: 'halfDay', width: 10 },
      { header: 'Attachment', key: 'attachment', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
    ];

    return {
      title: 'Leave Register',
      columns,
      rows,
      filename: 'leave_register',
    };
  }

  async leaveBalanceReport(
    query: LeaveBalanceReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const targetYear = query.year ?? new Date().getFullYear();

    const where: Prisma.LeaveBalanceWhereInput = {
      organizationId,
      year: targetYear,
    };
    if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }

    const balances = await this.scopedPrisma.leaveBalance.findMany({
      where,
      include: {
        employee: { select: { name: true, employeeId: true } },
        leaveType: { select: { name: true } },
      },
      orderBy: { employeeId: 'asc' },
    });

    const rows = balances.map((b) => ({
      employeeId: b.employee.employeeId,
      name: b.employee.name,
      leaveType: b.leaveType.name,
      opening: b.opening,
      credited: b.credited,
      availed: b.availed,
      pending: b.pending,
      encashed: b.encashed,
      closing: b.closing,
    }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Leave Type', key: 'leaveType', width: 16 },
      { header: 'Opening', key: 'opening', width: 10 },
      { header: 'Credited', key: 'credited', width: 10 },
      { header: 'Availed', key: 'availed', width: 10 },
      { header: 'Pending', key: 'pending', width: 10 },
      { header: 'Encashed', key: 'encashed', width: 10 },
      { header: 'Closing', key: 'closing', width: 10 },
    ];

    return {
      title: `Leave Balance Report ${targetYear}`,
      columns,
      rows,
      filename: 'leave_balance_report',
    };
  }

  async employeeLeaveHistoryReport(
    query: EmployeeLeaveHistoryReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    if (actor.role === Role.MANAGER) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        query.employeeId,
      );
    }

    const leaves = await this.scopedPrisma.leave.findMany({
      where: { organizationId, employeeId: query.employeeId },
      include: { leaveType: { select: { name: true } } },
      orderBy: { startDate: 'desc' },
    });

    const rows = leaves.map((l) => ({
      leaveType: l.leaveType.name,
      startDate: formatDateDisplay(l.startDate),
      endDate: formatDateDisplay(l.endDate),
      totalDays: l.totalDays,
      status: l.status,
      remarks: l.remarks,
    }));

    const columns: ReportColumn[] = [
      { header: 'Leave Type', key: 'leaveType', width: 16 },
      { header: 'Start Date', key: 'startDate', width: 15 },
      { header: 'End Date', key: 'endDate', width: 15 },
      { header: 'Total Days', key: 'totalDays', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Remarks', key: 'remarks', width: 30 },
    ];

    return {
      title: 'Employee Leave History',
      columns,
      rows,
      filename: 'employee_leave_history',
    };
  }

  async departmentLeaveSummaryReport(
    query: DepartmentLeaveSummaryReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.LeaveWhereInput = {
      organizationId,
      status: LeaveStatus.APPROVED,
    };
    if (query.from) where.endDate = { gte: query.from };
    if (query.to) where.startDate = { lte: query.to };
    if (actor.role === Role.MANAGER) {
      where.employee = { departmentId: actor.departmentId };
    }

    const departmentWhere: Prisma.DepartmentWhereInput =
      actor.role === Role.MANAGER
        ? { organizationId, id: actor.departmentId ?? undefined }
        : { organizationId };

    const [leaves, departments] = await Promise.all([
      this.scopedPrisma.leave.findMany({
        where,
        include: {
          employee: { select: { departmentId: true } },
          leaveType: { select: { name: true } },
        },
      }),
      this.scopedPrisma.department.findMany({
        where: departmentWhere,
        select: { id: true, name: true },
      }),
    ]);
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));

    const totals = new Map<string, number>();
    for (const l of leaves) {
      const deptName = l.employee.departmentId
        ? (deptNameById.get(l.employee.departmentId) ?? 'Unassigned')
        : 'Unassigned';
      const key = `${deptName}::${l.leaveType.name}`;
      totals.set(key, (totals.get(key) ?? 0) + l.totalDays);
    }

    const rows = [...totals.entries()].map(([key, days]) => {
      const [department, leaveType] = key.split('::');
      return { department, leaveType, days: Math.round(days * 100) / 100 };
    });

    const columns: ReportColumn[] = [
      { header: 'Department', key: 'department', width: 22 },
      { header: 'Leave Type', key: 'leaveType', width: 18 },
      { header: 'Total Days Taken', key: 'days', width: 16 },
    ];

    return {
      title: 'Department Leave Summary',
      columns,
      rows,
      filename: 'department_leave_summary',
    };
  }

  async payrollReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.PayrollRunWhereInput = {
      organizationId,
      isFinalSettlement: false,
    };
    if (query.month) where.month = query.month;
    if (query.year) where.year = query.year;

    const runs = await this.scopedPrisma.payrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });

    const rows = runs.map((p) => {
      const attendanceSummary = p.attendanceSummary as { payableDays?: number };
      return {
        employeeId: p.employee.employeeId,
        name: p.employee.name,
        month: p.month,
        year: p.year,
        payableDays: attendanceSummary?.payableDays,
        grossEarnings: p.grossSalary,
        totalDeductions: p.totalDeductions,
        netPay: p.netPay,
        status: p.status,
      };
    });

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Payable Days', key: 'payableDays', width: 14 },
      { header: 'Gross Earnings', key: 'grossEarnings', width: 16 },
      { header: 'Total Deductions', key: 'totalDeductions', width: 16 },
      { header: 'Net Pay', key: 'netPay', width: 14 },
      { header: 'Status', key: 'status', width: 12 },
    ];

    return {
      title: 'Payroll Report',
      columns,
      rows,
      filename: 'payroll_report',
    };
  }

  async employeeReport(organizationId: string): Promise<ReportPayload> {
    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId },
      include: { department: { select: { name: true } } },
    });

    const rows = employees.map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      email: e.email,
      department: e.department?.name ?? '',
      designation: e.designation,
      role: e.role,
      joiningDate: formatDateDisplay(e.joiningDate),
      isActive: e.isActive ? 'Active' : 'Inactive',
    }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Designation', key: 'designation', width: 18 },
      { header: 'Role', key: 'role', width: 16 },
      { header: 'Joining Date', key: 'joiningDate', width: 14 },
      { header: 'Status', key: 'isActive', width: 12 },
    ];

    return {
      title: 'Employee Report',
      columns,
      rows,
      filename: 'employee_report',
    };
  }

  async departmentReport(organizationId: string): Promise<ReportPayload> {
    const departments = await this.scopedPrisma.department.findMany({
      where: { organizationId },
      include: { departmentHead: { select: { name: true } } },
    });

    const rows = await Promise.all(
      departments.map(async (d) => ({
        code: d.code,
        name: d.name,
        head: d.departmentHead?.name ?? '-',
        employeeCount: await this.scopedPrisma.user.count({
          where: { organizationId, departmentId: d.id },
        }),
        shift: `${d.shiftStartTime} - ${d.shiftEndTime}`,
      })),
    );

    const columns: ReportColumn[] = [
      { header: 'Code', key: 'code', width: 10 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Department Head', key: 'head', width: 25 },
      { header: 'Employee Count', key: 'employeeCount', width: 16 },
      { header: 'Shift', key: 'shift', width: 18 },
    ];

    return {
      title: 'Department Report',
      columns,
      rows,
      filename: 'department_report',
    };
  }

  async headcountTrendReport(
    query: HeadcountReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const { rows } = await this.dashboardService.computeHeadcountTrend(
      query.months ?? 12,
      organizationId,
    );

    const columns: ReportColumn[] = [
      { header: 'Month', key: 'label', width: 16 },
      { header: 'Joiners', key: 'joiners', width: 10 },
      { header: 'Leavers', key: 'leavers', width: 10 },
      { header: 'Net Change', key: 'net', width: 12 },
    ];

    return {
      title: 'Headcount Trend Report',
      columns,
      rows,
      filename: 'headcount_trend_report',
    };
  }

  async attritionReport(
    query: HeadcountReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const {
      rows: trend,
      currentActiveHeadcount,
      totalJoiners,
      totalLeavers,
      attritionRatePercent,
    } = await this.dashboardService.computeHeadcountTrend(
      query.months ?? 12,
      organizationId,
    );

    const rows: Record<string, unknown>[] = [
      ...trend,
      { label: '—', joiners: '', leavers: '', net: '' },
      {
        label: 'Total (window)',
        joiners: totalJoiners,
        leavers: totalLeavers,
        net: totalJoiners - totalLeavers,
      },
      {
        label: 'Current Active Headcount',
        joiners: currentActiveHeadcount,
        leavers: '',
        net: '',
      },
      {
        label: 'Attrition Rate (%)',
        joiners: attritionRatePercent,
        leavers: '',
        net: '',
      },
    ];

    const columns: ReportColumn[] = [
      { header: 'Month', key: 'label', width: 22 },
      { header: 'Joiners', key: 'joiners', width: 10 },
      { header: 'Leavers', key: 'leavers', width: 10 },
      { header: 'Net Change', key: 'net', width: 12 },
    ];

    return {
      title: 'Attrition and Turnover Report',
      columns,
      rows,
      filename: 'attrition_report',
    };
  }
}
