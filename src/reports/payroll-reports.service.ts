// Purpose: Payroll-specific exportable reports — salary register, bank transfer, income tax, PF/ESI/PT,
// employer contributions, bonus, CTC, Form 16 summary, and payroll audit trail.
// Responsibilities: Owns per-report row/column shaping only; all read from already-persisted, already-
// calculated PayrollRun snapshots (or the audit log) rather than recomputing anything.
// Important: reports filter by each run's own snapshot data (e.g. "has an INCOME_TAX deduction line") rather
// than re-deriving current settings/statutory-overlay for the period, since a run's own snapshot is
// authoritative for what applied at that time even if settings changed since. bankTransferReport's account
// fields read from personalData.bank* (see that method).
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
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
import { REPORT_ROW_LIMIT, assertWithinReportLimit } from './report-limits';

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

    const runs = await this.scopedPrisma.payrollRun.findMany({
      where,
      include: { employee: { select: { name: true, employeeId: true } } },
      take: REPORT_ROW_LIMIT + 1,
      orderBy: [
        ...EMPLOYEE_RELATION_ORDER_BY,
        { year: 'desc' },
        { month: 'desc' },
      ],
    });
    assertWithinReportLimit(runs);
    return runs;
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
  // Bank account fields read from personalData.bank* — fetched separately
  // here (not via fetchRuns' shared employee select, which every other
  // report method also uses and shouldn't carry this JSON blob for no
  // reason) rather than joined onto the run itself.
  async bankTransferReport(
    query: PayrollReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    const runs = await this.fetchRuns(query, organizationId);
    const paidRuns = runs.filter((r) => PAID_OUT_STATUSES.includes(r.status));
    const employeeIds = [...new Set(paidRuns.map((r) => r.employeeId))];
    const personalDataById = new Map(
      employeeIds.length
        ? (
            await this.scopedPrisma.user.findMany({
              where: { organizationId, id: { in: employeeIds } },
              select: { id: true, personalData: true },
            })
          ).map((e) => [e.id, e.personalData as Record<string, unknown> | null])
        : [],
    );
    const bankField = (employeeId: string, key: string): string => {
      const v = personalDataById.get(employeeId)?.[key];
      return typeof v === 'string' && v.trim() ? v.trim() : '-';
    };
    const rows = paidRuns.map((r) => ({
      employeeId: r.employee.employeeId,
      name: r.employee.name,
      bankAccountNo: bankField(r.employeeId, 'bankAccountNo'),
      bankIFSC: bankField(r.employeeId, 'bankIFSC'),
      bankName: bankField(r.employeeId, 'bankName'),
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

  // Personal identifiers (UAN, ESIC IP number) for the employees in a report — stored encrypted inside
  // personalData, so they are read through the tenant-scoped client (which decrypts) rather than joined in SQL.
  private async identifiersFor(
    employeeIds: string[],
    organizationId: string,
  ): Promise<(employeeId: string, key: string) => string> {
    const ids = [...new Set(employeeIds)];
    const byId = new Map(
      ids.length
        ? (
            await this.scopedPrisma.user.findMany({
              where: { organizationId, id: { in: ids } },
              select: { id: true, personalData: true },
            })
          ).map((e) => [e.id, e.personalData as Record<string, unknown> | null])
        : [],
    );
    return (employeeId, key) => {
      const v = byId.get(employeeId)?.[key];
      return typeof v === 'string' && v.trim() ? v.trim() : '-';
    };
  }

  // PF contribution report laid out in the order of the EPFO ECR (Electronic Challan cum Return): UAN, wages
  // (gross, EPF, EPS, EDLI), the employee's EPF share, the employer's EPS and EPF-difference shares, non-
  // contributing days — plus the employer-only EDLI and administration charges. Every figure comes from the
  // run's own snapshot.
  async pfReport(query: PayrollReportQueryDto, organizationId: string) {
    const runs = (await this.fetchRuns(query, organizationId)).filter(
      (r) =>
        findLine(r.deductions, SALARY_COMPONENT_CODES.PF) ||
        findLine(r.employerContributions, SALARY_COMPONENT_CODES.PF_EMPLOYER),
    );
    const ident = await this.identifiersFor(
      runs.map((r) => r.employeeId),
      organizationId,
    );
    const rows = runs.map((r) => {
      const employerLine = linesOf(r.employerContributions).find(
        (e) => e.code === SALARY_COMPONENT_CODES.PF_EMPLOYER,
      ) as
        | {
            amount: number;
            wages?: number;
            breakup?: { eps: number; epf: number };
          }
        | undefined;
      const employeePf = lineAmount(r.deductions, SALARY_COMPONENT_CODES.PF);
      // Runs saved before wages were recorded: back out the wage base from the 12% employee share.
      const wages = employerLine?.wages ?? Math.round(employeePf / 0.12);
      const att = (r.attendanceSummary ?? {}) as { lopDays?: number };
      return {
        uan: ident(r.employeeId, 'uanNumber'),
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
        grossWages: r.grossSalary,
        epfWages: wages,
        epsWages: wages,
        edliWages: wages,
        epfEmployee: employeePf,
        eps: employerLine?.breakup?.eps ?? 0,
        epfDifference: employerLine?.breakup?.epf ?? 0,
        employerContribution: employerLine?.amount ?? 0,
        edli: lineAmount(r.employerContributions, 'EDLI_EMPLOYER'),
        adminCharges: lineAmount(r.employerContributions, 'EPF_ADMIN_EMPLOYER'),
        ncpDays: att.lopDays ?? 0,
      };
    });
    const columns: ReportColumn[] = [
      { header: 'UAN', key: 'uan', width: 16 },
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Gross Wages', key: 'grossWages', width: 14 },
      { header: 'EPF Wages', key: 'epfWages', width: 14 },
      { header: 'EPS Wages', key: 'epsWages', width: 14 },
      { header: 'EDLI Wages', key: 'edliWages', width: 14 },
      { header: 'EPF Contribution (Employee)', key: 'epfEmployee', width: 18 },
      { header: 'EPS Contribution (Employer)', key: 'eps', width: 18 },
      {
        header: 'EPF-EPS Difference (Employer)',
        key: 'epfDifference',
        width: 18,
      },
      {
        header: 'Employer Contribution (Total)',
        key: 'employerContribution',
        width: 18,
      },
      { header: 'EDLI', key: 'edli', width: 10 },
      { header: 'Admin Charges', key: 'adminCharges', width: 14 },
      { header: 'NCP Days', key: 'ncpDays', width: 10 },
    ];
    return {
      title: 'PF Report - ECR layout',
      subtitle: await this.registrationSubtitle(
        organizationId,
        'EPFO Establishment Code',
        'epfoEstablishmentCode',
      ),
      columns,
      rows,
      filename: 'pf_report',
    };
  }

  // ESIC contribution report: IP number, days worked, total wages and both contributions per employee.
  async esiReport(query: PayrollReportQueryDto, organizationId: string) {
    const runs = (await this.fetchRuns(query, organizationId)).filter(
      (r) =>
        findLine(r.deductions, SALARY_COMPONENT_CODES.ESI) ||
        findLine(r.employerContributions, SALARY_COMPONENT_CODES.ESI_EMPLOYER),
    );
    const ident = await this.identifiersFor(
      runs.map((r) => r.employeeId),
      organizationId,
    );
    const rows = runs.map((r) => {
      const employerLine = linesOf(r.employerContributions).find(
        (e) => e.code === SALARY_COMPONENT_CODES.ESI_EMPLOYER,
      ) as { amount: number; wages?: number } | undefined;
      const att = (r.attendanceSummary ?? {}) as { payableDays?: number };
      return {
        ipNumber: ident(r.employeeId, 'esicNumber'),
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        month: r.month,
        year: r.year,
        daysWorked: att.payableDays ?? 0,
        totalWages: employerLine?.wages ?? r.grossSalary,
        employeeContribution: lineAmount(
          r.deductions,
          SALARY_COMPONENT_CODES.ESI,
        ),
        employerContribution: employerLine?.amount ?? 0,
      };
    });
    const columns: ReportColumn[] = [
      { header: 'ESIC IP Number', key: 'ipNumber', width: 16 },
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Month', key: 'month', width: 8 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Days Worked', key: 'daysWorked', width: 12 },
      { header: 'Total Wages', key: 'totalWages', width: 14 },
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
    return {
      title: 'ESI Report',
      subtitle: await this.registrationSubtitle(
        organizationId,
        'ESIC Employer Code',
        'esicEmployerCode',
      ),
      columns,
      rows,
      filename: 'esi_report',
    };
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

  // Annual tax-summary per employee for the financial year — the figures a Form 16 (Form 130 from 1-Apr-2026)
  // is built from: PAN, taxable salary, the regime and the final annual tax position, and the total TDS
  // withheld. Final-settlement runs are included (their income and TDS belong to the year); regime / taxable
  // income / annual tax come from the employee's LATEST run of the year, not whichever row happened to sort
  // first. Not the official e-filing format.
  async form16Report(
    query: Form16ReportQueryDto,
    organizationId: string,
  ): Promise<ReportPayload> {
    // The certificate must name the deductor (TAN and PAN) next to the figures.
    const [runs, deductor] = await Promise.all([
      this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          financialYear: query.financialYear,
          status: { in: PAID_OUT_STATUSES },
        },
        include: {
          employee: {
            select: { name: true, employeeId: true },
          },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
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

    // Identifiers are encrypted at rest; only a top-level read decrypts them (a nested include returns ciphertext).
    const ident = await this.identifiersFor(
      runs.map((r) => r.employeeId),
      organizationId,
    );
    const byEmployee = new Map<
      string,
      {
        employeeId: string;
        name: string;
        pan: string;
        financialYear: string;
        grossSalary: number;
        taxableSalary: number;
        totalTaxDeducted: number;
        regime: string;
        taxableIncome: number;
        annualTax: number;
      }
    >();
    for (const r of runs) {
      const taxDetails = r.taxDetails as TaxDetailsShape | null;
      const existing = byEmployee.get(r.employeeId) ?? {
        employeeId: r.employee.employeeId,
        name: r.employee.name,
        pan: ident(r.employeeId, 'panNumber'),
        financialYear: query.financialYear,
        grossSalary: 0,
        taxableSalary: 0,
        totalTaxDeducted: 0,
        regime: '-',
        taxableIncome: 0,
        annualTax: 0,
      };
      existing.grossSalary += r.grossSalary;
      existing.taxableSalary += r.taxableGross ?? r.grossSalary;
      existing.totalTaxDeducted += lineAmount(
        r.deductions,
        SALARY_COMPONENT_CODES.INCOME_TAX,
      );
      // Runs arrive oldest-first, so the last one with a computation wins.
      if (taxDetails) {
        existing.regime = taxDetails.regime ?? existing.regime;
        existing.taxableIncome =
          taxDetails.taxableIncome ?? existing.taxableIncome;
        existing.annualTax =
          (taxDetails as { totalAnnualTax?: number }).totalAnnualTax ??
          existing.annualTax;
      }
      byEmployee.set(r.employeeId, existing);
    }

    const rows = [...byEmployee.values()].sort((a, b) =>
      a.employeeId.localeCompare(b.employeeId),
    );
    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'PAN', key: 'pan', width: 14 },
      { header: 'Financial Year', key: 'financialYear', width: 14 },
      { header: 'Regime', key: 'regime', width: 10 },
      { header: 'Gross Salary (Annual)', key: 'grossSalary', width: 18 },
      { header: 'Taxable Salary', key: 'taxableSalary', width: 16 },
      { header: 'Taxable Income (final)', key: 'taxableIncome', width: 18 },
      { header: 'Annual Tax (final)', key: 'annualTax', width: 16 },
      { header: 'Total Tax Deducted', key: 'totalTaxDeducted', width: 18 },
    ];

    return {
      title:
        Number(query.financialYear.slice(0, 4)) >= 2026
          ? `Form 130 Summary — Tax Year ${query.financialYear}`
          : `Form 16 Summary — FY ${query.financialYear}`,
      subtitle,
      columns,
      rows,
      filename:
        Number(query.financialYear.slice(0, 4)) >= 2026
          ? 'form130_summary'
          : 'form16_summary',
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
      take: REPORT_ROW_LIMIT + 1,
      orderBy: { createdAt: 'desc' },
    });
    assertWithinReportLimit(logs);

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
