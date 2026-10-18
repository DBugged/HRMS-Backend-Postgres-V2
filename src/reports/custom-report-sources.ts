import {
  AttendanceStatus,
  EmploymentStatus,
  LeaveStatus,
  PayrollRunStatus,
  Prisma,
} from '@prisma/client';
import {
  EMPLOYEE_ORDER_BY,
  EMPLOYEE_RELATION_ORDER_BY,
} from '../common/employee-order';
import { dateStrInOrgTz } from '../common/org-date';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { REPORT_ROW_LIMIT, assertWithinReportLimit } from './report-limits';
import {
  formatDateDisplay,
  formatTimeInZone,
  resolveOrgTimeContext,
  type TimeFormatPattern,
} from '../payroll/format-date';

// Ad-hoc report builder — HR picks a data source, a subset of its allowed
// columns, and a few generic filters (department/date range/status), and
// gets the same Excel/CSV/PDF export every other report in this app uses.
// Deliberately small: an allow-listed column set per source rather than an
// arbitrary query builder, so this can't be used to pull columns beyond
// what these sources already expose elsewhere in the product.

export interface ReportTimeContext {
  timezone: string;
  timeFormat: TimeFormatPattern;
}

export interface CustomReportFilters {
  department?: string;
  from?: string;
  to?: string;
  status?: string;
}

interface CustomReportColumn<Row> {
  header: string;
  // `ctx` carries the org's timezone/time format so punch times print in the org's clock, not the server's.
  get: (row: Row, ctx: ReportTimeContext) => unknown;
}

interface CustomReportSource<Row> {
  label: string;
  // The choices the builder offers for the Status filter of this source (omitted = no Status filter shown).
  statuses?: { value: string; label: string }[];
  columns: Record<string, CustomReportColumn<Row>>;
  fetch: (
    filters: CustomReportFilters,
    organizationId: string,
    prisma: ExtendedPrismaClient,
  ) => Promise<Row[]>;
}

// Type-erased view used by the service, which only ever iterates
// `Object.entries(columns)` and calls `get(row)` with the row `fetch`
// itself produced — the per-source generic above keeps every column
// definition checked against its own fetch's actual return shape.
export type AnyCustomReportSource = CustomReportSource<never> & {
  columns: Record<string, CustomReportColumn<never>>;
};

// Same cap as every other report: fetch one past it and refuse, rather than silently truncating the export.
const FETCH_LIMIT = REPORT_ROW_LIMIT + 1;

const employeesSource: CustomReportSource<
  Prisma.UserGetPayload<{ include: { department: { select: { name: true } } } }>
> = {
  label: 'Employees',
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employeeId },
    name: { header: 'Name', get: (r) => r.name },
    email: { header: 'Email', get: (r) => r.email },
    department: { header: 'Department', get: (r) => r.department?.name ?? '' },
    designation: { header: 'Designation', get: (r) => r.designation },
    role: { header: 'Role', get: (r) => r.role },
    employeeType: { header: 'Employee Type', get: (r) => r.employeeType },
    joiningDate: {
      header: 'Joining Date',
      get: (r) => formatDateDisplay(r.joiningDate),
    },
    status: {
      header: 'Status',
      get: (r) => (r.isActive ? 'Active' : 'Inactive'),
    },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.UserWhereInput = { organizationId };
    if (filters.department) where.departmentId = filters.department;
    if (filters.status) where.isActive = filters.status === 'active';
    return prisma.user.findMany({
      where,
      include: { department: { select: { name: true } } },
      orderBy: EMPLOYEE_ORDER_BY,
    });
  },
};

const attendanceSource: CustomReportSource<
  Prisma.AttendanceGetPayload<{
    include: { employee: { select: { name: true; employeeId: true } } };
  }>
> = {
  label: 'Attendance',
  statuses: [
    // "Late & early exits" views: HR's monthly look at who is regularly late or leaves early.
    { value: 'LATE', label: 'Late arrivals only' },
    { value: 'EARLY_OUT', label: 'Early exits only' },
    { value: 'LATE_OR_EARLY', label: 'Late arrivals and early exits' },
    ...Object.values(AttendanceStatus).map((v) => ({
      value: v,
      label: v
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase()),
    })),
  ],
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employee.employeeId },
    employeeName: { header: 'Employee Name', get: (r) => r.employee.name },
    date: { header: 'Date', get: (r) => formatDateDisplay(r.date) },
    status: { header: 'Status', get: (r) => r.status },
    inTime: {
      header: 'In Time',
      get: (r, ctx) => formatTimeInZone(r.inTime, ctx.timezone, ctx.timeFormat),
    },
    outTime: {
      header: 'Out Time',
      get: (r, ctx) =>
        formatTimeInZone(r.outTime, ctx.timezone, ctx.timeFormat),
    },
    late: { header: 'Late', get: (r) => (r.isLate ? 'Yes' : 'No') },
    earlyOut: {
      header: 'Early Out',
      get: (r) => (r.isEarlyOut ? 'Yes' : 'No'),
    },
    workArrangement: {
      header: 'Work Arrangement',
      get: (r) => r.workArrangement,
    },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.AttendanceWhereInput = { organizationId };
    if (filters.from || filters.to) {
      where.date = {};
      if (filters.from) where.date.gte = filters.from;
      if (filters.to) where.date.lte = filters.to;
    }
    if (filters.status === 'LATE') where.isLate = true;
    else if (filters.status === 'EARLY_OUT') where.isEarlyOut = true;
    else if (filters.status === 'LATE_OR_EARLY')
      where.OR = [{ isLate: true }, { isEarlyOut: true }];
    else if (filters.status) where.status = filters.status as AttendanceStatus;
    if (filters.department)
      where.employee = { departmentId: filters.department };
    const rows = await prisma.attendance.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
      take: FETCH_LIMIT,
    });
    assertWithinReportLimit(rows);
    return rows;
  },
};

type ProbationRow = Prisma.UserGetPayload<{
  include: { department: { select: { name: true } } };
}>;

const PROBATION_DUE_SOON_DAYS = 30;

// Whole days from `today` to the probation end date (negative = already past it); null when no end date is set.
function daysToProbationEnd(row: ProbationRow, today: string): number | null {
  if (!row.probationEndDate) return null;
  return Math.round(
    (Date.parse(`${row.probationEndDate}T00:00:00Z`) -
      Date.parse(`${today}T00:00:00Z`)) /
      86_400_000,
  );
}

// Employees still on probation (or on an extended one), with how far each is from the confirmation date - the weekly
// list HR chases. Status filter: overdue / due in the next 30 days / extended; From-To narrows the end date.
const probationSource: CustomReportSource<ProbationRow> = {
  label: 'Probation & Confirmation',
  statuses: [
    { value: 'overdue', label: 'Overdue (end date passed)' },
    { value: 'due_30', label: 'Due in the next 30 days' },
    { value: 'extended', label: 'Extended probation' },
  ],
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employeeId },
    name: { header: 'Name', get: (r) => r.name },
    department: { header: 'Department', get: (r) => r.department?.name ?? '' },
    designation: { header: 'Designation', get: (r) => r.designation },
    joiningDate: {
      header: 'Joining Date',
      get: (r) => formatDateDisplay(r.joiningDate),
    },
    probationEndDate: {
      header: 'Probation Ends',
      get: (r) =>
        r.probationEndDate ? formatDateDisplay(r.probationEndDate) : '',
    },
    daysLeft: {
      header: 'Days Left',
      get: (r, ctx) =>
        daysToProbationEnd(r, dateStrInOrgTz(ctx.timezone)) ?? '',
    },
    stage: {
      header: 'Stage',
      get: (r) =>
        r.employmentStatus === EmploymentStatus.EXTENDED_PROBATION
          ? 'Extended probation'
          : 'Probation',
    },
    due: {
      header: 'Confirmation',
      get: (r, ctx) => {
        const days = daysToProbationEnd(r, dateStrInOrgTz(ctx.timezone));
        if (days === null) return 'No end date set';
        if (days < 0) return `Overdue by ${-days} day(s)`;
        return days <= PROBATION_DUE_SOON_DAYS
          ? `Due in ${days} day(s)`
          : 'Later';
      },
    },
  },
  fetch: async (filters, organizationId, prisma) => {
    const { timezone } = await resolveOrgTimeContext(prisma, organizationId);
    const today = dateStrInOrgTz(timezone);
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + PROBATION_DUE_SOON_DAYS);
    const soonStr = soon.toISOString().slice(0, 10);
    const where: Prisma.UserWhereInput = {
      organizationId,
      isActive: true,
      employmentStatus: {
        in: [EmploymentStatus.PROBATION, EmploymentStatus.EXTENDED_PROBATION],
      },
    };
    if (filters.department) where.departmentId = filters.department;
    const end: Prisma.StringNullableFilter = {};
    if (filters.from) end.gte = filters.from;
    if (filters.to) end.lte = filters.to;
    if (filters.status === 'overdue') end.lt = today;
    if (filters.status === 'due_30') {
      end.gte = end.gte && end.gte > today ? end.gte : today;
      end.lte = end.lte && end.lte < soonStr ? end.lte : soonStr;
    }
    if (filters.status === 'extended') {
      where.employmentStatus = EmploymentStatus.EXTENDED_PROBATION;
    }
    if (Object.keys(end).length > 0) where.probationEndDate = end;
    const rows = await prisma.user.findMany({
      where,
      include: { department: { select: { name: true } } },
      // Soonest end date first - the most urgent at the top; people with no end date last.
      orderBy: [{ probationEndDate: { sort: 'asc', nulls: 'last' } }],
      take: FETCH_LIMIT,
    });
    assertWithinReportLimit(rows);
    return rows;
  },
};

const leavesSource: CustomReportSource<
  Prisma.LeaveGetPayload<{
    include: {
      employee: { select: { name: true; employeeId: true } };
      leaveType: { select: { name: true } };
    };
  }>
> = {
  label: 'Leave Requests',
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employee.employeeId },
    employeeName: { header: 'Employee Name', get: (r) => r.employee.name },
    leaveType: { header: 'Leave Type', get: (r) => r.leaveType.name },
    startDate: {
      header: 'Start Date',
      get: (r) => formatDateDisplay(r.startDate),
    },
    endDate: { header: 'End Date', get: (r) => formatDateDisplay(r.endDate) },
    totalDays: { header: 'Total Days', get: (r) => r.totalDays },
    status: { header: 'Status', get: (r) => r.status },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.LeaveWhereInput = { organizationId };
    if (filters.from || filters.to) {
      where.startDate = {};
      if (filters.from) where.startDate.gte = filters.from;
      if (filters.to) where.startDate.lte = filters.to;
    }
    if (filters.status) where.status = filters.status as LeaveStatus;
    if (filters.department)
      where.employee = { departmentId: filters.department };
    const rows = await prisma.leave.findMany({
      where,
      include: {
        employee: { select: { name: true, employeeId: true } },
        leaveType: { select: { name: true } },
      },
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { startDate: 'desc' }],
      take: FETCH_LIMIT,
    });
    assertWithinReportLimit(rows);
    return rows;
  },
};

const payrollSource: CustomReportSource<
  Prisma.PayrollRunGetPayload<{
    include: { employee: { select: { name: true; employeeId: true } } };
  }>
> = {
  label: 'Payroll Runs',
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employee.employeeId },
    employeeName: { header: 'Employee Name', get: (r) => r.employee.name },
    month: { header: 'Month', get: (r) => r.month },
    year: { header: 'Year', get: (r) => r.year },
    type: {
      header: 'Type',
      get: (r) =>
        r.isFinalSettlement
          ? 'Final Settlement'
          : r.runSequence > 0
            ? 'Supplementary'
            : 'Regular',
    },
    grossSalary: { header: 'Gross Salary', get: (r) => r.grossSalary },
    netPay: { header: 'Net Pay', get: (r) => r.netPay },
    status: { header: 'Status', get: (r) => r.status },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.PayrollRunWhereInput = { organizationId };
    // Draft runs are not payroll yet; a status filter, when given, narrows within the rest.
    where.status = filters.status
      ? (filters.status as PayrollRunStatus)
      : { not: PayrollRunStatus.DRAFT };
    // From/To are dates; a run belongs to a month, so include every run whose month overlaps the range.
    const fromKey = filters.from ? filters.from.slice(0, 7) : undefined;
    const toKey = filters.to ? filters.to.slice(0, 7) : undefined;
    if (fromKey || toKey) {
      const months: { month: number; year: number }[] = [];
      let [y, m] = (fromKey ?? '2000-01').split('-').map(Number);
      const [ey, em] = (toKey ?? '2100-12').split('-').map(Number);
      while ((y < ey || (y === ey && m <= em)) && months.length < 1200) {
        months.push({ month: m, year: y });
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
      where.OR = months.length ? months : [{ month: 0, year: 0 }];
    }
    if (filters.department)
      where.employee = { departmentId: filters.department };
    const rows = await prisma.payrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: [
        ...EMPLOYEE_RELATION_ORDER_BY,
        { year: 'desc' },
        { month: 'desc' },
      ],
      take: FETCH_LIMIT,
    });
    assertWithinReportLimit(rows);
    return rows;
  },
};

export const CUSTOM_REPORT_SOURCES: Record<string, AnyCustomReportSource> = {
  employees: employeesSource as unknown as AnyCustomReportSource,
  attendance: attendanceSource as unknown as AnyCustomReportSource,
  leaves: leavesSource as unknown as AnyCustomReportSource,
  probation: probationSource as unknown as AnyCustomReportSource,
  payroll: payrollSource as unknown as AnyCustomReportSource,
};
