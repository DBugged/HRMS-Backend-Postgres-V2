// Purpose: Monthly ESIC contribution upload sheet and Professional Tax return working papers, built from locked
//   payroll.
// Responsibilities: reads finalized PayrollRun snapshots (regular and final-settlement runs merged per employee),
//   decrypts the ESIC number through a top-level user read, resolves each employee's work-location state for PT, and
//   hands the rows to the pure builders (esic-return.ts / pt-return.ts).
// Important: the wages and contributions are the ones payroll stored on each run; nothing is recomputed here.
import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PayrollRunStatus, SettlementStatus } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { effectiveWorkLocation } from '../common/effective-work-location';
import {
  buildEsicRows,
  ESIC_HEADERS,
  type EsicMemberInput,
} from './esic-return';
import { buildPtReturn, NO_STATE, type PtMemberInput } from './pt-return';
import type { ReportPayload } from './reports.service';

interface Line {
  code: string;
  amount: number;
  wages?: number;
}

const PAID_OUT: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];
const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const linesOf = (json: unknown): Line[] => (json as Line[] | null) ?? [];
const amountOf = (lines: unknown, code: string): number =>
  linesOf(lines).find((l) => l.code === code)?.amount ?? 0;
const hasLine = (lines: unknown, code: string): boolean =>
  linesOf(lines).some((l) => l.code === code);
const pad = (n: number) => String(n).padStart(2, '0');

@Injectable()
export class StatutoryReturnsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // ── ESIC ────────────────────────────────────────────────────────────────

  async esic(month: number, year: number, organizationId: string) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, month, year, status: { in: PAID_OUT } },
      orderBy: [{ isFinalSettlement: 'asc' }, { createdAt: 'asc' }],
    });
    const esiRuns = runs.filter(
      (r) =>
        hasLine(r.deductions, SALARY_COMPONENT_CODES.ESI) ||
        hasLine(r.employerContributions, SALARY_COMPONENT_CODES.ESI_EMPLOYER),
    );

    // Contribution periods are Apr-Sep and Oct-Mar: someone covered earlier in the period stays on the sheet even
    // in a month with no wages.
    const periodMonths: { year: number; month: number }[] = [];
    const periodFirst = month >= 4 && month <= 9 ? 4 : 10;
    for (let i = 0; i < 6; i += 1) {
      const m = ((periodFirst - 1 + i) % 12) + 1;
      const y =
        m >= 4 ? (month >= 4 ? year : year - 1) : month >= 4 ? year + 1 : year;
      if (y * 12 + m < year * 12 + month)
        periodMonths.push({ year: y, month: m });
    }
    const earlier = periodMonths.length
      ? await this.scopedPrisma.payrollRun.findMany({
          where: {
            organizationId,
            status: { in: PAID_OUT },
            employeeId: { in: [...new Set(esiRuns.map((r) => r.employeeId))] },
            OR: periodMonths,
          },
          select: { employeeId: true, deductions: true },
        })
      : [];
    const coveredEarlier = new Set(
      earlier
        .filter((r) => amountOf(r.deductions, SALARY_COMPONENT_CODES.ESI) > 0)
        .map((r) => r.employeeId),
    );

    const ids = [...new Set(esiRuns.map((r) => r.employeeId))];
    const [users, settlements] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, name: true, personalData: true },
      }),
      this.scopedPrisma.settlement.findMany({
        where: {
          organizationId,
          employeeId: { in: ids },
          status: SettlementStatus.PROCESSED,
          lastWorkingDay: {
            lte: `${year}-${pad(month)}-${pad(daysInMonth)}`,
          },
        },
        select: { employeeId: true, lastWorkingDay: true },
        orderBy: { lastWorkingDay: 'desc' },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const lwdById = new Map<string, string>();
    for (const s of settlements)
      if (!lwdById.has(s.employeeId))
        lwdById.set(s.employeeId, s.lastWorkingDay.slice(0, 10));

    const merged = new Map<
      string,
      EsicMemberInput & { contribution: number }
    >();
    for (const r of esiRuns) {
      const u = userById.get(r.employeeId);
      const pd = (u?.personalData ?? {}) as Record<string, unknown>;
      const att = (r.attendanceSummary ?? {}) as {
        payableDays?: number;
        unpaidLeaveDays?: number;
      };
      const employerLine = linesOf(r.employerContributions).find(
        (l) => l.code === SALARY_COMPONENT_CODES.ESI_EMPLOYER,
      );
      const lwd = lwdById.get(r.employeeId) ?? null;
      const cur = merged.get(r.employeeId) ?? {
        ipNumber: typeof pd.esicNumber === 'string' ? pd.esicNumber.trim() : '',
        name: u?.name ?? '',
        payableDays: 0,
        wages: 0,
        unpaidLeaveDays: 0,
        lastWorkingDay: lwd,
        contribution: 0,
      };
      cur.contribution += amountOf(r.deductions, SALARY_COMPONENT_CODES.ESI);
      cur.wages += employerLine?.wages ?? r.grossSalary;
      cur.unpaidLeaveDays += att.unpaidLeaveDays ?? 0;
      // A final-settlement run carries no attendance: the days worked are those up to the last working day.
      cur.payableDays +=
        r.isFinalSettlement && att.payableDays === undefined
          ? lwd && lwd.startsWith(`${year}-${pad(month)}`)
            ? Number(lwd.slice(8, 10))
            : 0
          : (att.payableDays ?? 0);
      merged.set(r.employeeId, cur);
    }
    // Only people actually covered: a contribution this month, or covered earlier in the period.
    const members = [...merged.entries()]
      .filter(([id, m]) => m.contribution > 0 || coveredEarlier.has(id))
      .map(([, m]) => m);

    const built = buildEsicRows(members, { daysInMonth, month, year });
    const errors = built.issues.filter((i) => i.level === 'error');
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { esicEmployerCode: true },
    });
    const code = (org?.esicEmployerCode ?? '').replace(/[^A-Za-z0-9]/g, '');
    const due =
      month === 12 ? `${year + 1}-01-15` : `${year}-${pad(month + 1)}-15`;
    return {
      month,
      year,
      monthLabel: `${MONTH_NAMES[month]} ${year}`,
      employerCode: org?.esicEmployerCode ?? '',
      fileBase: `ESIC_MC_${code || 'EMPLOYER'}_${pad(month)}${year}`,
      dueDate: due,
      members: members.length,
      rows: built.rows,
      issues: built.issues,
      errors,
      ready: errors.length === 0 && built.rows.length > 0,
      totals: built.totals,
      employeeContribution: members.reduce((s, m) => s + m.contribution, 0),
    };
  }

  // The upload sheet itself — the portal's column order, header row first, data from row 2.
  esicWorkbook(
    rows: ReturnType<typeof buildEsicRows>['rows'],
  ): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('MC Template');
    sheet.addRow([...ESIC_HEADERS]);
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { wrapText: true, vertical: 'top' };
    sheet.getRow(1).height = 60;
    sheet.columns = [
      { width: 16 },
      { width: 30 },
      { width: 22 },
      { width: 18 },
      { width: 28 },
      { width: 22 },
    ];
    for (const r of rows) {
      const row = sheet.addRow([
        r.ipNumber,
        r.name,
        r.days,
        r.wages,
        r.reasonCode,
        r.lastWorkingDay,
      ]);
      // IP number and date stay text so no zero or format is lost.
      row.getCell(1).numFmt = '@';
      row.getCell(6).numFmt = '@';
    }
    return wb;
  }

  // ── Professional Tax ────────────────────────────────────────────────────

  async pt(month: number, year: number, organizationId: string) {
    const runs = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, month, year, status: { in: PAID_OUT } },
    });
    const ptRuns = runs.filter((r) =>
      hasLine(r.deductions, SALARY_COMPONENT_CODES.PT),
    );
    const ids = [...new Set(ptRuns.map((r) => r.employeeId))];
    const users = await this.scopedPrisma.user.findMany({
      where: { organizationId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        employeeId: true,
        gender: true,
        workLocation: { select: { state: true } },
        department: { select: { workLocation: { select: { state: true } } } },
      },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const merged = new Map<string, PtMemberInput>();
    for (const r of ptRuns) {
      const u = userById.get(r.employeeId);
      const state = (u && effectiveWorkLocation(u)?.state) || NO_STATE;
      const cur = merged.get(r.employeeId) ?? {
        state,
        employeeCode: u?.employeeId ?? '',
        name: u?.name ?? '',
        gender: u?.gender ?? null,
        wages: 0,
        pt: 0,
      };
      cur.wages += r.isFinalSettlement
        ? linesOf(r.earnings)
            .filter(
              (l) =>
                ![
                  'GRATUITY',
                  'LEAVE_ENCASHMENT',
                  'REIMBURSEMENT',
                  'BONUS',
                ].includes(l.code),
            )
            .reduce((s, l) => s + (l.amount || 0), 0)
        : r.grossSalary;
      cur.pt += amountOf(r.deductions, SALARY_COMPONENT_CODES.PT);
      merged.set(r.employeeId, cur);
    }
    const members = [...merged.values()].sort(
      (a, b) =>
        a.state.localeCompare(b.state) ||
        a.employeeCode.localeCompare(b.employeeCode),
    );
    return {
      month,
      year,
      monthLabel: `${MONTH_NAMES[month]} ${year}`,
      members,
      ...buildPtReturn(members, month, year),
    };
  }

  async ptMemberReport(
    month: number,
    year: number,
    organizationId: string,
  ): Promise<ReportPayload> {
    const r = await this.pt(month, year, organizationId);
    return {
      title: `Professional Tax — Employee-wise (${r.monthLabel})`,
      subtitle:
        r.states
          .map(
            (s) =>
              `${s.state}: PT ${s.totalPt}${s.dueDate ? ` (due ${s.dueDate})` : ''}`,
          )
          .join(' | ') || undefined,
      columns: [
        { header: 'State', key: 'state', width: 18 },
        { header: 'Employee ID', key: 'employeeCode', width: 14 },
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Gender', key: 'gender', width: 10 },
        { header: 'Wages', key: 'wages', width: 14 },
        { header: 'Professional Tax', key: 'pt', width: 16 },
      ],
      rows: r.members.map((m) => ({ ...m, gender: m.gender ?? '-' })),
      filename: `pt_employee_wise_${year}_${pad(month)}`,
    };
  }

  async ptSummaryReport(
    month: number,
    year: number,
    organizationId: string,
  ): Promise<ReportPayload> {
    const r = await this.pt(month, year, organizationId);
    return {
      title: `Professional Tax Return Summary (${r.monthLabel})`,
      subtitle:
        'Slab-wise head-count and tax per state — the figures a state PT return asks for.',
      columns: [
        { header: 'State', key: 'state', width: 18 },
        { header: 'PT per employee', key: 'amount', width: 16 },
        { header: 'Employees', key: 'employees', width: 12 },
        { header: 'Tax', key: 'tax', width: 14 },
        { header: 'State total wages', key: 'totalWages', width: 18 },
        { header: 'State total PT', key: 'totalPt', width: 16 },
        { header: 'Due date', key: 'dueDate', width: 14 },
      ],
      rows: r.states.flatMap((s) =>
        s.slabs.map((sl, i) => ({
          state: s.state,
          amount: sl.amount,
          employees: sl.employees,
          tax: sl.tax,
          totalWages: i === 0 ? s.totalWages : '',
          totalPt: i === 0 ? s.totalPt : '',
          dueDate: i === 0 ? (s.dueDate ?? 'per state rules') : '',
        })),
      ),
      filename: `pt_return_summary_${year}_${pad(month)}`,
    };
  }
}
