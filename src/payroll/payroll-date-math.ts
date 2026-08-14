import { PayFrequency } from '@prisma/client';

/**
 * Pure date/period math ported verbatim from the old backend's
 * payrollEngine.js (daysInMonth, clampLeaveDaysToMonth,
 * isComponentPayableThisMonth, round). No DB access.
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// UTC-based (not new Date(year, month, 0).getLocalDate() like the old
// system) — calendar day-counts don't depend on timezone, and UTC matches
// this codebase's established date-math convention (see payroll-date.ts).
export function daysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// YYYY-MM-DD for the last calendar day of the period — used as the
// "as of" date for revision-aware lookups (EmployeeSalaryComponent,
// StatutoryConfigVersion) so a mid-month revision is picked up when that
// month is processed.
export function lastDayOfMonth(month: number, year: number): string {
  return `${year}-${pad(month)}-${pad(daysInMonth(month, year))}`;
}

const CYCLE_LENGTH: Partial<Record<PayFrequency, number>> = {
  [PayFrequency.QUARTERLY]: 3,
  [PayFrequency.HALF_YEARLY]: 6,
  [PayFrequency.YEARLY]: 12,
};

// A non-monthly component (e.g. a yearly bonus) is only payable in the
// last month of its cycle, counted from the FY start month — e.g. a
// quarterly component with FY starting in April is payable in
// June/September/December/March.
export function isComponentPayableThisMonth(
  payFrequency: PayFrequency,
  month: number,
  financialYearStartMonth: number,
): boolean {
  if (!payFrequency || payFrequency === PayFrequency.MONTHLY) return true;
  const offsetInFY = (((month - financialYearStartMonth) % 12) + 12) % 12;
  const cycleLength = CYCLE_LENGTH[payFrequency];
  if (!cycleLength) return true;
  return (offsetInFY + 1) % cycleLength === 0;
}

export interface ClampableLeave {
  isHalfDay: boolean;
  startDate: string;
  endDate: string;
}

// Clamps a Leave's [startDate, endDate] range to the given month/year
// window and returns the inclusive day count within that window. A
// half-day leave is always a single date, already inside one month.
export function clampLeaveDaysToMonth(
  leave: ClampableLeave,
  month: number,
  year: number,
): number {
  if (leave.isHalfDay) return 0.5;
  const monthPrefix = `${year}-${pad(month)}`;
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = `${monthPrefix}-${pad(daysInMonth(month, year))}`;
  const clampedStart =
    leave.startDate > monthStart ? leave.startDate : monthStart;
  const clampedEnd = leave.endDate < monthEnd ? leave.endDate : monthEnd;
  if (clampedStart > clampedEnd) return 0;
  const startMs = new Date(`${clampedStart}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${clampedEnd}T00:00:00.000Z`).getTime();
  return Math.round((endMs - startMs) / 86400000) + 1;
}

export function round(
  value: number,
  roundingRule: string,
  roundingDecimals: number,
): number {
  const factor = 10 ** (roundingDecimals || 0);
  if (roundingRule === 'up') return Math.ceil(value * factor) / factor;
  if (roundingRule === 'down') return Math.floor(value * factor) / factor;
  if (roundingRule === 'none') return value;
  return Math.round(value * factor) / factor; // nearest (default)
}
