import { CalcType } from '@prisma/client';
import { todayInOrgTz } from '../common/org-date';

/**
 * Pure helpers for the employee salary-structure revision system, ported
 * from the old backend's `employeeSalaryController.js`. No DB access —
 * the service does the queries and passes plain data in.
 */

// Org-timezone date, deliberately not `toISOString()` — the old system's
// `todayStr()` had a comment documenting a real bug: toISOString() shifts
// to UTC, which during IST early-morning hours (00:00-05:29) rolls the
// date back by one, causing effectiveFrom/asOf comparisons to miss
// same-day rows. That bug generalizes beyond IST specifically: any org
// whose configured timezone disagrees with the server's own local clock
// can hit the same one-day skew in either direction, so this now takes
// the org's timezone explicitly rather than assuming server-local time is
// the org's time. Always use this instead of new Date().toISOString() (or
// server-local Date getters) for any effectiveFrom/asOf value in this
// module.
export function localDateStr(
  timezone: string,
  date: Date = new Date(),
): string {
  return todayInOrgTz(timezone, date);
}

// One day before a YYYY-MM-DD string, using UTC internally (pure date
// arithmetic, no timezone ambiguity since we only ever add/subtract whole
// days) — used to close out a revision's old row.
export function dayBefore(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export interface RevisionRow {
  componentCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// The exact revision-range query/dedupe pattern used by both the old
// controller's getEmployeeStructure and payrollEngine.js's
// loadEmployeeComponentValues: filter to rows whose range covers `asOf`,
// then keep one row per componentCode — the most recent effectiveFrom
// wins (rows are assumed pre-sorted effectiveFrom DESC, or this re-sorts
// defensively).
export function resolveCurrentRows<T extends RevisionRow>(
  rows: T[],
  asOf: string,
): T[] {
  const inRange = rows.filter(
    (r) =>
      r.effectiveFrom <= asOf &&
      (r.effectiveTo === null || r.effectiveTo >= asOf),
  );
  const sorted = [...inRange].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? 1 : -1,
  );
  const byCode = new Map<string, T>();
  for (const row of sorted) {
    if (!byCode.has(row.componentCode)) byCode.set(row.componentCode, row);
  }
  return [...byCode.values()];
}

// One day after a YYYY-MM-DD string (UTC date arithmetic, see dayBefore).
export function dayAfter(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export interface PeriodSegment {
  start: string;
  end: string;
}

// Splits [periodStart, periodEnd] into contiguous segments wherever the set
// of revision rows in force changes — i.e. at every row's effectiveFrom, and
// the day after every row's effectiveTo, that falls strictly inside the
// period. Returns a single segment when nothing changes mid-period (the
// common case), so callers can keep their whole-period behaviour for it.
export function splitPeriodAtRevisions(
  rows: RevisionRow[],
  periodStart: string,
  periodEnd: string,
): PeriodSegment[] {
  const boundaries = new Set<string>();
  for (const r of rows) {
    if (r.effectiveFrom > periodStart && r.effectiveFrom <= periodEnd) {
      boundaries.add(r.effectiveFrom);
    }
    if (
      r.effectiveTo !== null &&
      r.effectiveTo >= periodStart &&
      r.effectiveTo < periodEnd
    ) {
      boundaries.add(dayAfter(r.effectiveTo));
    }
  }
  const starts = [periodStart, ...[...boundaries].sort()];
  return starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? dayBefore(starts[i + 1]) : periodEnd,
  }));
}

export interface SynthesizableComponent {
  id: string;
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION';
  calcType: CalcType;
  isEmployerContribution: boolean;
  isActive: boolean;
  percentageOf: string | null;
  percentageValue: number | null;
  formula: string | null;
  displayOrder: number;
}

export interface SynthesizedRow {
  id: null;
  componentId: string;
  componentCode: string;
  valueType: CalcType;
  fixedAmount: null;
  percentageValue: number | null;
  percentageOf: string | null;
  formula: string | null;
  amountBasis: 'MONTHLY';
  isEnabled: true;
  effectiveFrom: string;
  effectiveTo: null;
  synthesized: true;
  // Same shape/purpose as getStructure's componentRef on real rows — a
  // synthesized row (no per-employee override) still needs its type/
  // payFrequency/isEmployerContribution for buildBreakdown to bucket it
  // correctly, not just its raw calcType/percentageOf/formula.
  componentRef: SynthesizableComponent;
}

// For active EARNING, non-employer-contribution components whose calcType
// is PERCENTAGE or FORMULA and that have no per-employee override row,
// build a read-only synthetic row from the master component. Rationale
// (from the old system): these auto-apply via payrollEngine without
// needing an explicit override, so the UI would otherwise silently omit
// them from the structure view entirely.
export function synthesizeMissingRows(
  currentRows: RevisionRow[],
  activeComponents: SynthesizableComponent[],
  asOf: string,
): SynthesizedRow[] {
  const coveredCodes = new Set(currentRows.map((r) => r.componentCode));
  return activeComponents
    .filter(
      (c) =>
        c.isActive &&
        c.type === 'EARNING' &&
        !c.isEmployerContribution &&
        (c.calcType === CalcType.PERCENTAGE ||
          c.calcType === CalcType.FORMULA) &&
        !coveredCodes.has(c.code),
    )
    .map((c) => ({
      id: null,
      componentId: c.id,
      componentCode: c.code,
      valueType: c.calcType,
      fixedAmount: null,
      percentageValue: c.percentageValue,
      percentageOf: c.percentageOf,
      formula: c.formula,
      amountBasis: 'MONTHLY' as const,
      isEnabled: true as const,
      effectiveFrom: asOf,
      effectiveTo: null,
      synthesized: true as const,
      componentRef: c,
    }));
}

// ---------------------------------------------------------------------------
// The CTC breakdown of a resolved structure - the same split the Salary Details screen shows (frontend
// EmployeeFullProfile buildBreakdown): recurring monthly earnings roll into the fixed CTC, yearly/performance pay and
// one-time amounts sit outside it. Used by the Salary Structure document and the Revised CTC letter, so what they say
// is what the screen says.
// ---------------------------------------------------------------------------
export interface SummarizableRow {
  componentCode: string;
  valueType: string;
  fixedAmount?: unknown;
  percentageValue?: unknown;
  percentageOf?: string | null;
  amountBasis?: string | null;
  isEnabled?: boolean | null;
  effectiveFrom?: string | null;
  componentRef?: {
    name?: string | null;
    type?: string | null;
    payFrequency?: string | null;
    isEmployerContribution?: boolean | null;
    displayOrder?: number | null;
  } | null;
}

export interface StructureLine {
  code: string;
  name: string;
  // Present on a percentage line, e.g. "40% of Basic" - lets a reader see where the amount comes from.
  basis: string | null;
  monthly: number;
  annual: number;
}

export interface StructureBreakdown {
  // Monthly recurring earnings, in the component display order.
  earnings: StructureLine[];
  // Paid less often than monthly or on performance (annual only), and one-time annual amounts.
  variable: StructureLine[];
  oneTime: StructureLine[];
  fixedMonthly: number;
  fixedAnnual: number;
  variableAnnual: number;
  oneTimeAnnual: number;
  annualCTC: number;
  // Latest effective date among the rows - "Salary Effective From" on the document.
  effectiveFrom: string | null;
}

const OCCURRENCES_PER_YEAR: Record<string, number> = {
  YEARLY: 1,
  HALF_YEARLY: 2,
  QUARTERLY: 4,
  MONTHLY: 12,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function breakdownStructure(
  rows: SummarizableRow[],
  nameByCode: Record<string, string> = {},
): StructureBreakdown {
  const earningRows = rows
    .filter(
      (r) =>
        (r.componentRef?.type || 'EARNING') === 'EARNING' &&
        !r.componentRef?.isEmployerContribution &&
        r.isEnabled !== false,
    )
    .sort(
      (a, b) =>
        (a.componentRef?.displayOrder ?? 0) -
        (b.componentRef?.displayOrder ?? 0),
    );
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const nameOf = (r: SummarizableRow) =>
    r.componentRef?.name || nameByCode[r.componentCode] || r.componentCode;
  const monthlyByCode: Record<string, number> = {};
  // A few passes resolve short percentage-of-percentage chains (HRA as % of Basic).
  for (let pass = 0; pass < 3; pass++) {
    for (const r of earningRows) {
      const code = r.componentCode;
      if (
        r.valueType === 'FIXED' ||
        (r.valueType === 'MANUAL' && r.amountBasis !== 'ANNUAL')
      ) {
        monthlyByCode[code] = num(r.fixedAmount);
      } else if (r.valueType === 'PERCENTAGE') {
        const base = monthlyByCode[r.percentageOf ?? ''] ?? 0;
        monthlyByCode[code] = (base * num(r.percentageValue)) / 100;
      } else if (monthlyByCode[code] === undefined) {
        monthlyByCode[code] = 0;
      }
    }
  }

  const earnings: StructureLine[] = [];
  const variable: StructureLine[] = [];
  const oneTime: StructureLine[] = [];
  let fixedMonthly = 0;
  let variableAnnual = 0;
  let oneTimeAnnual = 0;
  for (const r of earningRows) {
    const code = r.componentCode;
    if (r.valueType === 'MANUAL' && r.amountBasis === 'ANNUAL') {
      const annual = num(r.fixedAmount);
      oneTime.push({ code, name: nameOf(r), basis: null, monthly: 0, annual });
      oneTimeAnnual += annual;
      continue;
    }
    const frequency = r.componentRef?.payFrequency || 'MONTHLY';
    if (
      (r.valueType === 'FIXED' || r.valueType === 'MANUAL') &&
      frequency !== 'MONTHLY'
    ) {
      const annual =
        num(r.fixedAmount) * (OCCURRENCES_PER_YEAR[frequency] || 1);
      variable.push({ code, name: nameOf(r), basis: null, monthly: 0, annual });
      variableAnnual += annual;
      continue;
    }
    const monthly = monthlyByCode[code] || 0;
    // A calculated line (Overtime Pay) is worked out per month at payroll: it has no amount in the structure.
    if (r.valueType === 'FORMULA' && monthly === 0) continue;
    fixedMonthly += monthly;
    earnings.push({
      code,
      name: nameOf(r),
      basis:
        r.valueType === 'PERCENTAGE'
          ? `${num(r.percentageValue)}% of ${nameByCode[r.percentageOf ?? ''] ?? r.percentageOf ?? ''}`
          : null,
      monthly: round2(monthly),
      annual: round2(monthly * 12),
    });
  }
  const effectiveFrom =
    rows
      .map((r) => r.effectiveFrom)
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null;
  const fixedAnnual = fixedMonthly * 12;
  return {
    earnings,
    variable,
    oneTime,
    fixedMonthly: round2(fixedMonthly),
    fixedAnnual: round2(fixedAnnual),
    variableAnnual: round2(variableAnnual),
    oneTimeAnnual: round2(oneTimeAnnual),
    annualCTC: round2(fixedAnnual + variableAnnual + oneTimeAnnual),
    effectiveFrom,
  };
}

export interface StructureSummary {
  fixedMonthly: number;
  fixedAnnual: number;
  variableAnnual: number;
  oneTimeAnnual: number;
  annualCTC: number;
}

export function summarizeStructure(rows: SummarizableRow[]): StructureSummary {
  const b = breakdownStructure(rows);
  return {
    fixedMonthly: b.fixedMonthly,
    fixedAnnual: b.fixedAnnual,
    variableAnnual: b.variableAnnual,
    oneTimeAnnual: b.oneTimeAnnual,
    annualCTC: b.annualCTC,
  };
}
