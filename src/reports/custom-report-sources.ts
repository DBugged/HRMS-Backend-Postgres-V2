import {
  AttendanceStatus,
  LeaveStatus,
  PayrollRunStatus,
  Prisma,
} from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { formatDateDisplay } from '../payroll/format-date';

// Ad-hoc report builder — HR picks a data source, a subset of its allowed
// columns, and a few generic filters (department/date range/status), and
// gets the same Excel/CSV/PDF export every other report in this app uses.
// Deliberately small: an allow-listed column set per source rather than an
// arbitrary query builder, so this can't be used to pull columns beyond
// what these sources already expose elsewhere in the product.

export interface CustomReportFilters {
  department?: string;
  from?: string;
  to?: string;
  status?: string;
}

interface CustomReportColumn<Row> {
  header: string;
  get: (row: Row) => unknown;
}

interface CustomReportSource<Row> {
  label: string;
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

const FETCH_LIMIT = 5000;

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
      orderBy: { name: 'asc' },
    });
  },
};

const attendanceSource: CustomReportSource<
  Prisma.AttendanceGetPayload<{
    include: { employee: { select: { name: true; employeeId: true } } };
  }>
> = {
  label: 'Attendance',
  columns: {
    employeeId: { header: 'Employee ID', get: (r) => r.employee.employeeId },
    employeeName: { header: 'Employee Name', get: (r) => r.employee.name },
    date: { header: 'Date', get: (r) => formatDateDisplay(r.date) },
    status: { header: 'Status', get: (r) => r.status },
    inTime: {
      header: 'In Time',
      get: (r) => (r.inTime ? r.inTime.toLocaleTimeString() : ''),
    },
    outTime: {
      header: 'Out Time',
      get: (r) => (r.outTime ? r.outTime.toLocaleTimeString() : ''),
    },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.AttendanceWhereInput = { organizationId };
    if (filters.from || filters.to) {
      where.date = {};
      if (filters.from) where.date.gte = filters.from;
      if (filters.to) where.date.lte = filters.to;
    }
    if (filters.status) where.status = filters.status as AttendanceStatus;
    if (filters.department)
      where.employee = { departmentId: filters.department };
    return prisma.attendance.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: { date: 'desc' },
      take: FETCH_LIMIT,
    });
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
    return prisma.leave.findMany({
      where,
      include: {
        employee: { select: { name: true, employeeId: true } },
        leaveType: { select: { name: true } },
      },
      orderBy: { startDate: 'desc' },
      take: FETCH_LIMIT,
    });
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
    grossSalary: { header: 'Gross Salary', get: (r) => r.grossSalary },
    netPay: { header: 'Net Pay', get: (r) => r.netPay },
    status: { header: 'Status', get: (r) => r.status },
  },
  fetch: async (filters, organizationId, prisma) => {
    const where: Prisma.PayrollRunWhereInput = { organizationId };
    if (filters.status) where.status = filters.status as PayrollRunStatus;
    if (filters.department)
      where.employee = { departmentId: filters.department };
    return prisma.payrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: FETCH_LIMIT,
    });
  },
};

export const CUSTOM_REPORT_SOURCES: Record<string, AnyCustomReportSource> = {
  employees: employeesSource as unknown as AnyCustomReportSource,
  attendance: attendanceSource as unknown as AnyCustomReportSource,
  leaves: leavesSource as unknown as AnyCustomReportSource,
  payroll: payrollSource as unknown as AnyCustomReportSource,
};
