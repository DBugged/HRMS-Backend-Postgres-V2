// Purpose: Payroll-specific exportable reports — salary register, bank transfer, income tax, PF/ESI/PT,
// employer contributions, bonus, CTC, Form 16 summary, and payroll audit trail.
// Responsibilities: Owns per-report row/column shaping only; all read from already-persisted, already-
// calculated PayrollRun snapshots (or the audit log) rather than recomputing anything.
// Important: reports filter by each run's own snapshot data (e.g. "has an INCOME_TAX deduction line") rather
// than re-deriving current settings/statutory-overlay for the period, since a run's own snapshot is
// authoritative for what applied at that time even if settings changed since. bankTransferReport's account
// fields always render '-' since no bank-details fields exist on User yet (same gap as the payslip PDF).
import { Inject, Injectable } from '@nestjs/common';
import {
  AuditModule,
  PayrollRunStatus,
  Prisma,
  TaxRegime,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { ReportColumn } from './report-export';
import {
  PayrollAuditReportQueryDto,
  PayrollReportQueryDto,
} from './dto/report-queries.dto';
import { Form16ReportQueryDto } from './dto/form16-report-query.dto';
import { ReportPayload } from './reports.service';
import { formatDateTimeDisplay } from '../payroll/format-date';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';

interface PayrollLine {
  code: string;
  name: string;
  amount: number;
}

interface TaxDetailsShape {
  regime?: TaxRegime;
  taxableIncome?: number;
  totalAnnualTax?: number;
}

const FINALIZED_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.CALCULATED,
  PayrollRunStatus.VERIFIED,
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];
const PAID_OUT_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

const linesOf = (json: unknown): PayrollLine[] =>
  (json as PayrollLine[] | null) ?? [];
const findLine = (lines: unknown, code: string): PayrollLine | undefined =>
  linesOf(lines).find((l) => l.code === code);
const lineAmount = (lines: unknown, code: string): number =>
  findLine(lines, code)?.amount ?? 0;

@Injectable()
export class PayrollReportsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  private async fetchRuns(
    query: PayrollReportQueryDto,
    organizationId: string,
  ) {
    const where: Prisma.PayrollRunWhereInput = {
      organizationId,
      isFinalSettlement: false,
      status: { in: FINALIZED_STATUSES },
    };
    if (query.month) where.month = query.month;
    if (query.year) where.year = query.year;

    return this.scopedPrisma.payrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  // Every earning/deduction code that appears anywhere in the selected
  // period becomes its own column, auto-detected (no hardcoded component
  // list, since components are fully configurable).
  async salaryRegisterReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);

    const earningCodes = [
      ...new Set(runs.flatMap((r) => linesOf(r.earnings).map((e) => e.code))),
    ];
    const deductionCodes = [
      ...new Set(runs.flatMap((r) => linesOf(r.deductions).map((d) => d.code))),
    ];

    const rows = runs.map((r) => {
      const row: Record<string, unknown> = {
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
      };
      earningCodes.forEach((code) => {
        row[`e_${code}`] = lineAmount(r.earnings, code);
      });
      deductionCodes.forEach((code) => {
        row[`d_${code}`] = lineAmount(r.deductions, code);
      });
      row.grossSalary = r.grossSalary;
      row.totalDeductions = r.totalDeductions;
      row.netPay = r.netPay;
      return row;
    });

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      ...earningCodes.map((code) => ({
        header: code,
        key: `e_${code}`,
        width: 14,
      })),
      ...deductionCodes.map((code) => ({
        header: code,
        key: `d_${code}`,
        width: 14,
      })),
      { header: 'Gross Salary', key: 'grossSalary', width: 14 },
      { header: 'Total Deductions', key: 'totalDeductions', width: 16 },
      { header: 'Net Pay', key: 'netPay', width: 14 },
    ];

    return {
      title: 'Salary Register',
      columns,
      rows,
      filename: 'salary_register',
    };
  }

  // No bank fields exist on backend-v2's User model yet (same gap as the
  // payslip PDF's PAN/UAN/bank rows) — every account field renders '-',
  // preserving the report's shape so it lights up automatically once a
  // future "Employee Statutory & Bank Details" batch adds them.
  async bankTransferReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const rows = runs
      .filter((r) => PAID_OUT_STATUSES.includes(r.status))
      .map((r) => ({
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        bankAccountNo: '-',
        bankIFSC: '-',
        bankName: '-',
        netPay: r.netPay,
      }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Account Number', key: 'bankAccountNo', width: 20 },
      { header: 'IFSC', key: 'bankIFSC', width: 14 },
      { header: 'Bank Name', key: 'bankName', width: 20 },
      { header: 'Net Pay', key: 'netPay', width: 14 },
    ];

    return {
      title: 'Bank Transfer Report',
      columns,
      rows,
      filename: 'bank_transfer_report',
    };
  }

  // Includes only runs that actually carry an INCOME_TAX deduction line,
  // rather than re-checking current PayrollSettings/statutory-overlay for
  // the queried period — the run's own snapshot is authoritative for what
  // applied that period (settings may have changed since), and this
  // avoids re-deriving the overlay for an arbitrary date range.
  async incomeTaxReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const rows = runs
      .filter((r) => findLine(r.deductions, SALARY_COMPONENT_CODES.INCOME_TAX))
      .map((r) => {
        const taxDetails = r.taxDetails as TaxDetailsShape | null;
        return {
          employeeId: r.employee.employeeId,
          name: r.employee.name,
          month: r.month,
          year: r.year,
          regime: taxDetails?.regime ?? '-',
          taxableIncome: taxDetails?.taxableIncome ?? 0,
          monthlyTDS: lineAmount(
            r.deductions,
            SALARY_COMPONENT_CODES.INCOME_TAX,
          ),
          annualTaxProjection: taxDetails?.totalAnnualTax ?? 0,
        };
      });

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Regime', key: 'regime', width: 10 },
      { header: 'Taxable Income', key: 'taxableIncome', width: 16 },
      { header: 'Monthly TDS', key: 'monthlyTDS', width: 14 },
      {
        header: 'Annual Tax Projection',
        key: 'annualTaxProjection',
        width: 18,
      },
    ];

    return {
      title: 'Income Tax Report',
      columns,
      rows,
      filename: 'income_tax_report',
    };
  }

  // These reports are meant to be handed to (or filed with) the
  // corresponding government body — without the org's own establishment/
  // registration number printed on them, there's nothing tying the report
  // to a specific employer. Returns undefined (no subtitle line at all)
  // when the org hasn't filled that field in yet, rather than printing a
  // misleading "Not set".
  private async registrationSubtitle(
    organizationId: string,
    label: string,
    field:
      | 'epfoEstablishmentCode'
      | 'esicEmployerCode'
      | 'ptRegistrationNumber'
      | 'tan'
      | 'pan',
  ): Promise<string | undefined> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { [field]: true },
    });
    const value = (org as Record<string, string | null> | null)?.[field];
    return value ? `${label}: ${value}` : undefined;
  }

  // Shared shape for PF / ESI / PT — each just filters on a different
  // deduction/employer-contribution code pair, including only runs that
  // actually carry that line (same reasoning as incomeTaxReport).
  private async statutoryContributionReport(
    query: PayrollReportQueryDto,
    organizationId: string,
    code: string,
    employerCode: string | null,
    title: string,
    filename: string,
    subtitle?: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const rows = runs
      .filter(
        (r) =>
          findLine(r.deductions, code) ||
          (employerCode && findLine(r.employerContributions, employerCode)),
      )
      .map((r) => ({
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
        employeeContribution: lineAmount(r.deductions, code),
        employerContribution: employerCode
          ? lineAmount(r.employerContributions, employerCode)
          : 0,
      }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      {
        header: 'Employee Contribution',
        key: 'employeeContribution',
        width: 18,
      },
      {
        header: 'Employer Contribution',
        key: 'employerContribution',
        width: 18,
      },
    ];

    return { title, subtitle, columns, rows, filename };
  }

  async pfReport(query: PayrollReportQueryDto, organizationId: string) {
    return this.statutoryContributionReport(
      query,
      organizationId,
      SALARY_COMPONENT_CODES.PF,
      SALARY_COMPONENT_CODES.PF_EMPLOYER,
      'PF Report',
      'pf_report',
      await this.registrationSubtitle(
        organizationId,
        'EPFO Establishment Code',
        'epfoEstablishmentCode',
      ),
    );
  }

  async esiReport(query: PayrollReportQueryDto, organizationId: string) {
    return this.statutoryContributionReport(
      query,
      organizationId,
      SALARY_COMPONENT_CODES.ESI,
      SALARY_COMPONENT_CODES.ESI_EMPLOYER,
      'ESI Report',
      'esi_report',
      await this.registrationSubtitle(
        organizationId,
        'ESIC Employer Code',
        'esicEmployerCode',
      ),
    );
  }

  async ptReport(query: PayrollReportQueryDto, organizationId: string) {
    return this.statutoryContributionReport(
      query,
      organizationId,
      SALARY_COMPONENT_CODES.PT,
      null,
      'Professional Tax Report',
      'pt_report',
      await this.registrationSubtitle(
        organizationId,
        'PT Registration Number',
        'ptRegistrationNumber',
      ),
    );
  }

  async employerContributionsReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const codes = [
      ...new Set(
        runs.flatMap((r) =>
          linesOf(r.employerContributions).map((e) => e.code),
        ),
      ),
    ];

    const rows = runs.map((r) => {
      const row: Record<string, unknown> = {
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
      };
      codes.forEach((code) => {
        row[code] = lineAmount(r.employerContributions, code);
      });
      row.total = r.totalEmployerContributions;
      return row;
    });

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      ...codes.map((code) => ({ header: code, key: code, width: 16 })),
      { header: 'Total', key: 'total', width: 14 },
    ];

    return {
      title: 'Employer Contributions Report',
      columns,
      rows,
      filename: 'employer_contributions_report',
    };
  }

  async bonusReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const rows = runs
      .map((r) => ({
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
        bonus: lineAmount(r.earnings, 'BONUS'),
      }))
      .filter((r) => r.bonus > 0);

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Bonus', key: 'bonus', width: 14 },
    ];

    return { title: 'Bonus Report', columns, rows, filename: 'bonus_report' };
  }

  async ctcReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const rows = runs.map((r) => ({
      employeeId: r.employee.employeeId,
      name: r.employee.name,
      month: r.month,
      year: r.year,
      grossSalary: r.grossSalary,
      employerContributions: r.totalEmployerContributions,
      ctcMonthly: r.ctcMonthly,
      ctcAnnual: Math.round(r.ctcMonthly * 12),
    }));

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Gross Salary', key: 'grossSalary', width: 14 },
      {
        header: 'Employer Contributions',
        key: 'employerContributions',
        width: 18,
      },
      { header: 'CTC (Monthly)', key: 'ctcMonthly', width: 14 },
      { header: 'CTC (Annualized)', key: 'ctcAnnual', width: 16 },
    ];

    return { title: 'CTC Report', columns, rows, filename: 'ctc_report' };
  }

  // Simplified annual tax-summary report in the spirit of Form 16 (Part B)
  // — not the official e-filing XML format, but the same figures HR needs
  // to hand an employee: gross pay and total tax deducted across the
  // financial year.
  async form16Report(
    query: Form16ReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    // Form 16 requires the deductor's TAN and PAN printed alongside the
    // figures — without them there's no way to verify which employer
    // deducted the tax being summarized here.
    const [runs, deductor] = await Promise.all([
      this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          financialYear: query.financialYear,
          isFinalSettlement: false,
          status: { in: PAID_OUT_STATUSES },
        },
        include: { employee: { select: { name: true, employeeId: true } } },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { tan: true, pan: true },
      }),
    ]);
    const deductorBits = [
      deductor?.tan && `Deductor TAN: ${deductor.tan}`,
      deductor?.pan && `Deductor PAN: ${deductor.pan}`,
    ].filter(Boolean);
    const subtitle =
      deductorBits.length > 0 ? deductorBits.join('  |  ') : undefined;

    const byEmployee = new Map<
      string,
      {
        employeeId: string;
        name: string;
        financialYear: string;
        grossSalary: number;
        totalTaxDeducted: number;
        regime: string;
        taxableIncome: number;
      }
    >();
    for (const r of runs) {
      const taxDetails = r.taxDetails as TaxDetailsShape | null;
      const existing = byEmployee.get(r.employeeId) ?? {
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        financialYear: query.financialYear,
        grossSalary: 0,
        totalTaxDeducted: 0,
        regime: taxDetails?.regime ?? '-',
        taxableIncome: taxDetails?.taxableIncome ?? 0,
      };
      existing.grossSalary += r.grossSalary;
      existing.totalTaxDeducted += lineAmount(
        r.deductions,
        SALARY_COMPONENT_CODES.INCOME_TAX,
      );
      byEmployee.set(r.employeeId, existing);
    }

    const rows = [...byEmployee.values()];
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Financial Year', key: 'financialYear', width: 14 },
      { header: 'Regime', key: 'regime', width: 10 },
      { header: 'Gross Salary (Annual)', key: 'grossSalary', width: 18 },
      { header: 'Taxable Income', key: 'taxableIncome', width: 16 },
      { header: 'Total Tax Deducted', key: 'totalTaxDeducted', width: 18 },
    ];

    return {
      title: `Form 16 Summary — FY ${query.financialYear}`,
      subtitle,
      columns,
      rows,
      filename: 'form16_summary',
    };
  }

  async payrollAuditReport(
    query: PayrollAuditReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      module: AuditModule.PAYROLL,
    };
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lte: new Date(query.to) }),
      };
    }

    const logs = await this.scopedPrisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true, employeeId: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const rows = logs.map((l) => ({
      timestamp: formatDateTimeDisplay(l.createdAt),
      actor: l.actor?.name || '-',
      action: l.action,
      targetId: l.targetId || '-',
      details: JSON.stringify(l.details || {}),
    }));

    const columns: ReportColumn[] = [
      { header: 'Timestamp', key: 'timestamp', width: 20 },
      { header: 'Actor', key: 'actor', width: 20 },
      { header: 'Action', key: 'action', width: 26 },
      { header: 'Target ID', key: 'targetId', width: 26 },
      { header: 'Details', key: 'details', width: 40 },
    ];

    return {
      title: 'Payroll Audit Report',
      columns,
      rows,
      filename: 'payroll_audit_report',
    };
  }
}
