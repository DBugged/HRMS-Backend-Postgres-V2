// Purpose: the reports that can be emailed on a schedule, and how each one is produced for a run.
// Responsibilities: maps a stable key to its label, access rule and the ReportsService / OpsReportsService call; the
//   period for the run comes from scheduled-report-period.ts.
// Important: only reports that build a plain table (ReportPayload) are listed - the statutory returns and payroll
//   registers have their own screens and filing steps and are deliberately not emailed automatically.
import type { User } from '@prisma/client';
import type { OpsReportsService } from './ops-reports.service';
import type { ReportPayload, ReportsService } from './reports.service';
import type { SchedulePeriod } from './scheduled-report-period';

type Actor = Omit<User, 'password'>;

export interface ReportRunContext {
  reports: ReportsService;
  ops: OpsReportsService;
  actor: Actor;
  organizationId: string;
  period: SchedulePeriod;
  department?: string;
}

interface CatalogEntry {
  label: string;
  // What period it follows, shown to the Admin so "weekly" has a clear meaning.
  covers: string;
  run: (c: ReportRunContext) => Promise<ReportPayload>;
}

export const SCHEDULED_REPORTS: Record<string, CatalogEntry> = {
  attendance: {
    label: 'Attendance report',
    covers: 'the period that just ended',
    run: (c) =>
      c.reports.attendanceReport(
        {
          from: c.period.from,
          to: c.period.to,
          department: c.department,
        } as never,
        c.actor,
        c.organizationId,
      ),
  },
  overtime: {
    label: 'Overtime report',
    covers: 'the period that just ended',
    run: (c) =>
      c.ops.overtimeReport(
        {
          from: c.period.from,
          to: c.period.to,
          department: c.department,
        } as never,
        c.actor,
        c.organizationId,
      ),
  },
  regularization: {
    label: 'Regularization report',
    covers: 'the period that just ended',
    run: (c) =>
      c.ops.regularizationReport(
        {
          from: c.period.from,
          to: c.period.to,
          department: c.department,
        } as never,
        c.actor,
        c.organizationId,
      ),
  },
  reimbursements: {
    label: 'Reimbursement report',
    covers: 'the period that just ended',
    run: (c) =>
      c.ops.reimbursementReport(
        {
          from: c.period.from,
          to: c.period.to,
          department: c.department,
        } as never,
        c.actor,
        c.organizationId,
      ),
  },
  'leave-department-summary': {
    label: 'Department leave summary',
    covers: 'the period that just ended',
    run: (c) =>
      c.reports.departmentLeaveSummaryReport(
        { from: c.period.from, to: c.period.to } as never,
        c.actor,
        c.organizationId,
      ),
  },
  'leave-balance': {
    label: 'Leave balance report',
    covers: 'balances as of the run',
    run: (c) =>
      c.reports.leaveBalanceReport({} as never, c.actor, c.organizationId),
  },
  loans: {
    label: 'Loan & advance register',
    covers: 'as of the run',
    run: (c) =>
      c.ops.loanRegisterReport(
        { department: c.department } as never,
        c.actor,
        c.organizationId,
      ),
  },
  'tax-declaration-status': {
    label: 'Tax declaration status',
    covers: 'the current financial year',
    run: (c) =>
      c.ops.taxDeclarationStatusReport(
        { department: c.department } as never,
        c.actor,
        c.organizationId,
      ),
  },
  'payroll-variance': {
    label: 'Payroll variance',
    covers: 'the latest month against the one before',
    run: (c) =>
      c.ops.payrollVarianceReport(
        {
          month: c.period.month,
          year: c.period.year,
          department: c.department,
        } as never,
        c.actor,
        c.organizationId,
      ),
  },
  employees: {
    label: 'Employee report',
    covers: 'as of the run',
    run: (c) => c.reports.employeeReport(c.organizationId),
  },
  departments: {
    label: 'Department report',
    covers: 'as of the run',
    run: (c) => c.reports.departmentReport(c.organizationId),
  },
  'headcount-trend': {
    label: 'Headcount trend report',
    covers: 'the last 12 months',
    run: (c) => c.reports.headcountTrendReport({} as never, c.organizationId),
  },
  attrition: {
    label: 'Attrition / turnover report',
    covers: 'the last 12 months',
    run: (c) => c.reports.attritionReport({} as never, c.organizationId),
  },
};
