// Purpose: operational reports built on data the app already stores - overtime, regularization, loans,
//   reimbursements, tax declaration status and payroll variance (this month vs the one before).
// Responsibilities: shapes rows/columns for the shared export pipeline (xlsx/csv/pdf), applies Manager department
//   scoping where a Manager may see the report, and caps result size like every other report.
// Important: read-only. Loans, reimbursements, tax declarations and payroll variance are Admin/HR only (money / tax
//   data); overtime and regularization also allow a Manager, limited to their own department.
import { employedOnWhere } from '../common/managers';
import { todayInOrgTz } from '../common/org-date';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { deptScopedEmployeeIds } from '../common/dept-scope';
import { ReportColumn } from './report-export';
import { OpsReportQueryDto } from './dto/ops-report-queries.dto';
import {
  REPORT_ROW_LIMIT,
  assertValidDateRange,
  assertWithinReportLimit,
} from './report-limits';
import type { ReportPayload } from './reports.service';

type Actor = Omit<User, 'password'>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
const label = (v: string) =>
  v
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

@Injectable()
export class OpsReportsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // The employee ids a caller may see: everyone for Admin/HR (optionally one department), the caller's own
  // department for a Manager. undefined = no restriction.
  private async employeeScope(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<string[] | undefined> {
    if (actor.role === Role.MANAGER) {
      return deptScopedEmployeeIds(this.scopedPrisma, actor, organizationId);
    }
    if (query.department) {
      const rows = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: query.department },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    return undefined;
  }

  private monthStart(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  async overtimeReport(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    assertValidDateRange(query.from, query.to);
    const from = query.from ?? (query.to ? undefined : this.monthStart());
    const where: Prisma.OvertimeRecordWhereInput = { organizationId };
    if (from || query.to) {
      where.date = {
        ...(from && { gte: from }),
        ...(query.to && { lte: query.to }),
      };
    }
    if (query.status) where.status = query.status as never;
    const scope = await this.employeeScope(query, actor, organizationId);
    if (scope) where.employeeId = { in: scope };

    const records = await this.scopedPrisma.overtimeRecord.findMany({
      where,
      include: {
        employee: {
          select: {
            name: true,
            employeeId: true,
            department: { select: { name: true } },
          },
        },
        approvedBy: { select: { name: true } },
      },
      orderBy: [{ date: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
    });
    assertWithinReportLimit(records);

    const rows = records.map((r) => ({
      employeeId: r.employee.employeeId,
      name: r.employee.name,
      department: r.employee.department?.name ?? '',
      date: r.date,
      type: label(r.type),
      hours: r.hours,
      rate: r.rateMultiplier,
      weightedHours: round2(r.hours * r.rateMultiplier),
      source: label(r.source),
      status: label(r.status),
      decidedBy: r.approvedBy?.name ?? '',
      note: r.decisionNote ?? '',
    }));
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Hours', key: 'hours', width: 8 },
      { header: 'Rate (x)', key: 'rate', width: 9 },
      { header: 'Hours x rate', key: 'weightedHours', width: 12 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Decided by', key: 'decidedBy', width: 18 },
      { header: 'Note', key: 'note', width: 28 },
    ];
    return {
      title: 'Overtime Report',
      columns,
      rows,
      filename: 'overtime_report',
    };
  }

  async regularizationReport(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    assertValidDateRange(query.from, query.to);
    const from = query.from ?? (query.to ? undefined : this.monthStart());
    const where: Prisma.AttendanceRegularizationRequestWhereInput = {
      organizationId,
    };
    if (from || query.to) {
      where.date = {
        ...(from && { gte: from }),
        ...(query.to && { lte: query.to }),
      };
    }
    if (query.status) where.status = query.status as never;
    const scope = await this.employeeScope(query, actor, organizationId);
    if (scope) where.employeeId = { in: scope };

    const requests =
      await this.scopedPrisma.attendanceRegularizationRequest.findMany({
        where,
        include: {
          employee: {
            select: {
              name: true,
              employeeId: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        take: REPORT_ROW_LIMIT + 1,
      });
    assertWithinReportLimit(requests);

    // "Attempt": how many times this employee has asked for this same date (1 = first request, 2+ = re-sent after a
    // rejection) - the figure the Admin's re-send cap is about.
    const attempts = new Map<string, number>();
    const reviewerIds = [
      ...new Set(requests.map((r) => r.reviewedById).filter(Boolean)),
    ] as string[];
    const reviewers = reviewerIds.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, id: { in: reviewerIds } },
          select: { id: true, name: true },
        })
      : [];
    const reviewerName = new Map(reviewers.map((u) => [u.id, u.name]));
    const rows = requests.map((r) => {
      const key = `${r.employeeId}:${r.date}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      return {
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        department: r.employee.department?.name ?? '',
        date: r.date,
        attempt,
        requestedIn: iso(r.requestedInTime),
        requestedOut: iso(r.requestedOutTime),
        reason: r.reason,
        status: label(r.status),
        autoApproved: r.autoApproved ? 'Yes' : 'No',
        decidedBy: r.reviewedById
          ? (reviewerName.get(r.reviewedById) ?? '')
          : '',
        comments: r.reviewComments ?? '',
      };
    });
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Attempt', key: 'attempt', width: 8 },
      { header: 'Requested in', key: 'requestedIn', width: 17 },
      { header: 'Requested out', key: 'requestedOut', width: 17 },
      { header: 'Reason', key: 'reason', width: 30 },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Auto-approved', key: 'autoApproved', width: 13 },
      { header: 'Decided by', key: 'decidedBy', width: 18 },
      { header: 'Comments', key: 'comments', width: 28 },
    ];
    return {
      title: 'Regularization Report',
      columns,
      rows,
      filename: 'regularization_report',
    };
  }

  async loanRegisterReport(
    query: OpsReportQueryDto,
    _actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.LoanWhereInput = { organizationId };
    if (query.status) where.status = query.status as never;
    const scope = await this.employeeScope(query, _actor, organizationId);
    if (scope) where.employeeId = { in: scope };
    const loans = await this.scopedPrisma.loan.findMany({
      where,
      include: {
        employee: {
          select: {
            name: true,
            employeeId: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: EMPLOYEE_LOAN_ORDER,
      take: REPORT_ROW_LIMIT + 1,
    });
    assertWithinReportLimit(loans);
    const rows = loans.map((l) => ({
      employeeId: l.employee.employeeId,
      name: l.employee.name,
      department: l.employee.department?.name ?? '',
      type: label(l.loanType),
      principal: l.principal,
      interestRate: l.interestRate,
      tenure: l.tenureMonths,
      emi: l.emiAmount,
      start: `${l.startYear}-${String(l.startMonth).padStart(2, '0')}`,
      repaid: round2(Math.max(0, l.principal - l.outstandingBalance)),
      outstanding: l.outstandingBalance,
      status: label(l.status),
    }));
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Principal', key: 'principal', width: 12 },
      { header: 'Interest %', key: 'interestRate', width: 10 },
      { header: 'Tenure (months)', key: 'tenure', width: 14 },
      { header: 'EMI', key: 'emi', width: 11 },
      { header: 'Starts', key: 'start', width: 9 },
      { header: 'Repaid', key: 'repaid', width: 12 },
      { header: 'Outstanding', key: 'outstanding', width: 12 },
      { header: 'Status', key: 'status', width: 11 },
    ];
    return {
      title: 'Loan & Advance Register',
      columns,
      rows,
      filename: 'loan_register',
    };
  }

  async reimbursementReport(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    assertValidDateRange(query.from, query.to);
    const from = query.from ?? (query.to ? undefined : this.monthStart());
    const where: Prisma.ReimbursementWhereInput = { organizationId };
    if (from || query.to) {
      where.claimDate = {
        ...(from && { gte: from }),
        ...(query.to && { lte: query.to }),
      };
    }
    if (query.status) where.status = query.status as never;
    if (query.category) where.category = query.category as never;
    const scope = await this.employeeScope(query, actor, organizationId);
    if (scope) where.employeeId = { in: scope };
    const claims = await this.scopedPrisma.reimbursement.findMany({
      where,
      include: {
        employee: {
          select: {
            name: true,
            employeeId: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ claimDate: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
    });
    assertWithinReportLimit(claims);
    const rows = claims.map((c) => ({
      employeeId: c.employee.employeeId,
      name: c.employee.name,
      department: c.employee.department?.name ?? '',
      claimDate: c.claimDate,
      category: label(c.category),
      amount: c.amount,
      description: c.description,
      status: label(c.status),
      approvedDate: c.approvedDate ?? '',
      paidDate: c.paidDate ?? '',
      paymentMode: c.paymentMode ? label(c.paymentMode) : '',
      comments: c.reviewComments ?? '',
    }));
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Claim date', key: 'claimDate', width: 12 },
      { header: 'Category', key: 'category', width: 14 },
      { header: 'Amount', key: 'amount', width: 12 },
      { header: 'Description', key: 'description', width: 28 },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Approved on', key: 'approvedDate', width: 12 },
      { header: 'Paid on', key: 'paidDate', width: 12 },
      { header: 'Payment mode', key: 'paymentMode', width: 13 },
      { header: 'Comments', key: 'comments', width: 28 },
    ];
    return {
      title: 'Reimbursement Report',
      columns,
      rows,
      filename: 'reimbursement_report',
    };
  }

  // Every active employee for the year, including those who have not started - "Not started" is the row HR chases.
  async taxDeclarationStatusReport(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const financialYear =
      query.financialYear ?? (await this.currentFinancialYear(organizationId));
    const scope = await this.employeeScope(query, actor, organizationId);
    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        // Still working: declarations are not chased from people who have left or not yet joined.
        ...employedOnWhere(
          todayInOrgTz((await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } }))?.timezone ?? 'Asia/Kolkata'),
        ),
        ...(scope && { id: { in: scope } }),
      },
      select: {
        id: true,
        name: true,
        employeeId: true,
        department: { select: { name: true } },
      },
      orderBy: [{ employeeId: 'asc' }],
      take: REPORT_ROW_LIMIT + 1,
    });
    assertWithinReportLimit(employees);
    const declarations =
      await this.scopedPrisma.employeeTaxDeclaration.findMany({
        where: { organizationId, financialYear },
      });
    const byEmployee = new Map(declarations.map((d) => [d.employeeId, d]));
    const rows = employees
      .map((e) => {
        const d = byEmployee.get(e.id);
        const deductions = d
          ? d.section80C +
            d.section80CCD1B +
            d.section80CCD2 +
            d.section80D +
            d.section80E +
            d.section80G +
            d.section80TTA +
            d.homeLoanInterest +
            d.otherDeductions
          : 0;
        return {
          employeeId: e.employeeId,
          name: e.name,
          department: e.department?.name ?? '',
          status: d ? label(d.status) : 'Not started',
          regime: d ? label(d.regimeChosen) : '',
          deductions: round2(deductions),
          rent: d?.hraRentPaidAnnual ?? 0,
          updated: d ? iso(d.updatedAt) : '',
        };
      })
      .filter(
        (r) =>
          !query.status ||
          r.status.toUpperCase().replace(/ /g, '_') === query.status,
      );
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Status', key: 'status', width: 13 },
      { header: 'Regime', key: 'regime', width: 9 },
      { header: 'Declared deductions', key: 'deductions', width: 18 },
      { header: 'Annual rent paid', key: 'rent', width: 15 },
      { header: 'Last updated', key: 'updated', width: 17 },
    ];
    return {
      title: `Tax Declaration Status FY ${financialYear}`,
      columns,
      rows,
      filename: 'tax_declaration_status',
    };
  }

  private async currentFinancialYear(organizationId: string): Promise<string> {
    const settings = await this.scopedPrisma.payrollSettings.findFirst({
      where: { organizationId },
      select: { financialYearStartMonth: true },
    });
    const start = settings?.financialYearStartMonth ?? 4;
    const now = new Date();
    const m = now.getUTCMonth() + 1;
    const y = now.getUTCFullYear();
    const first = m >= start ? y : y - 1;
    return `${first}-${String((first + 1) % 100).padStart(2, '0')}`;
  }

  // Net pay this month against the month before, per employee - the quick check before approving a payroll.
  async payrollVarianceReport(
    query: OpsReportQueryDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const now = new Date();
    const month = query.month ?? now.getUTCMonth() + 1;
    const year = query.year ?? now.getUTCFullYear();
    const prev =
      month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
    const scope = await this.employeeScope(query, actor, organizationId);
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        OR: [
          { month, year },
          { month: prev.month, year: prev.year },
        ],
        ...(scope && { employeeId: { in: scope } }),
      },
      include: {
        employee: {
          select: {
            name: true,
            employeeId: true,
            department: { select: { name: true } },
          },
        },
      },
      take: REPORT_ROW_LIMIT + 1,
    });
    assertWithinReportLimit(runs);
    type Entry = {
      employee: (typeof runs)[number]['employee'];
      now?: number;
      before?: number;
      gross?: number;
    };
    const byEmployee = new Map<string, Entry>();
    for (const r of runs) {
      const e = byEmployee.get(r.employeeId) ?? { employee: r.employee };
      if (r.month === month && r.year === year) {
        e.now = r.netPay;
        e.gross = r.grossSalary;
      } else {
        e.before = r.netPay;
      }
      byEmployee.set(r.employeeId, e);
    }
    const rows = [...byEmployee.values()]
      .map((e) => {
        const diff = round2((e.now ?? 0) - (e.before ?? 0));
        const pct = e.before ? round2((diff / e.before) * 100) : null;
        const note =
          e.before === undefined
            ? 'New this month'
            : e.now === undefined
              ? 'Not in this month'
              : '';
        return {
          employeeId: e.employee.employeeId,
          name: e.employee.name,
          department: e.employee.department?.name ?? '',
          previous: e.before ?? 0,
          current: e.now ?? 0,
          difference: diff,
          percent: pct ?? '',
          note,
        };
      })
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      {
        header: `Net pay ${prev.month}-${prev.year}`,
        key: 'previous',
        width: 16,
      },
      { header: `Net pay ${month}-${year}`, key: 'current', width: 16 },
      { header: 'Difference', key: 'difference', width: 12 },
      { header: 'Change %', key: 'percent', width: 10 },
      { header: 'Note', key: 'note', width: 18 },
    ];
    return {
      // No slashes: the title becomes the Excel sheet name, which may not contain them.
      title: `Payroll Variance ${month}-${year} vs ${prev.month}-${prev.year}`,
      subtitle: 'Largest changes first.',
      columns,
      rows,
      filename: 'payroll_variance',
    };
  }
}

const EMPLOYEE_LOAN_ORDER: Prisma.LoanOrderByWithRelationInput[] = [
  { employee: { employeeId: 'asc' } },
  { startYear: 'asc' },
  { startMonth: 'asc' },
];
