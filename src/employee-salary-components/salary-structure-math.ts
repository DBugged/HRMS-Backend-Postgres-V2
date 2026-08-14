import { CalcType } from '@prisma/client';

/**
 * Pure helpers for the employee salary-structure revision system, ported
 * from the old backend's `employeeSalaryController.js`. No DB access —
 * the service does the queries and passes plain data in.
 */

// Server-LOCAL date, deliberately not `toISOString()` — the old system's
// `todayStr()` has a comment documenting a real bug: toISOString() shifts
// to UTC, which during IST early-morning hours (00:00-05:29) rolls the
// date back by one, causing effectiveFrom/asOf comparisons to miss
// same-day rows. Always use this instead of new Date().toISOString() for
// any effectiveFrom/asOf value in this module.
export function localDateStr(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    }));
}
