// Purpose: The arithmetic of periodic leave accrual - which periods a leave year has, what each credits and when it is due.
// Responsibilities: Pure functions only (no DB); LeaveAccrualService applies the result.
// Important: money-like rounding rule - every period's credit is derived from the CUMULATIVE entitlement rounded to 2
//   decimals minus the cumulative already credited, so the credits over a year add up to the entitlement exactly however the
//   periods round, and the figure for a period never depends on whether earlier periods happened to be credited by this run
//   or a previous one.
import { AccrualFrequency } from '@prisma/client';
import { LeaveYearBounds, monthsBeforeFirstCountedMonth } from './leave-year';

export interface AccrualRule {
  annualQuota: number;
  /** MONTHLY / BI_MONTHLY / QUARTERLY / HALF_YEARLY (YEARLY degenerates to one credit a year). */
  accrualFrequency: AccrualFrequency;
  /** Days credited per FULL period; 0 = derive from the quota: quota x periodMonths / 12. */
  accrualAmountPerCycle: number;
  /** When in its period a credit is made. */
  accrueAt: 'START' | 'END';
  /** Joining inside the year prorates (15th rule); false = counted from the year's start. */
  prorate: boolean;
  /**
   * LEAVE_YEAR (default): periods are cut from the leave year's start, the same dates for everyone.
   * JOINING_ANNIVERSARY: each employee's cycles run from their own joining date (joined 12 Feb + quarterly = cycles
   * from 12 Feb, 12 May, 12 Aug, 12 Nov...). Cycles are always whole, so no joining proration applies.
   */
  basis?: 'LEAVE_YEAR' | 'JOINING_ANNIVERSARY';
}

export interface AccrualPeriod {
  /** First and last day, YYYY-MM-DD. */
  start: string;
  end: string;
  /** Months the period spans (the last one of a longer year can be shorter than the frequency). */
  months: number;
  /** Index of its first month within the leave year (0-based). */
  monthIndex: number;
}

export function periodMonthsOf(freq: AccrualFrequency): number {
  switch (freq) {
    case AccrualFrequency.MONTHLY:
      return 1;
    case AccrualFrequency.BI_MONTHLY:
      return 2;
    case AccrualFrequency.QUARTERLY:
      return 3;
    case AccrualFrequency.HALF_YEARLY:
      return 6;
    default:
      return 12;
  }
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// The same day-of-month `months` later, clamped to the end of a shorter month (31 Jan + 1 month = 28/29 Feb). Always
// counted from the joining date itself, so a clamp never drifts later cycles (31 Jan + 2 months = 31 Mar, not 28 Mar).
function addMonthsClamped(dateStr: string, months: number): string {
  const [y, m, day] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const dd = Math.min(day, last);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The accrual periods of a leave year, in order. A year longer than a multiple of the period ends with a shorter one. */
export function buildPeriods(
  bounds: LeaveYearBounds,
  freq: AccrualFrequency,
): AccrualPeriod[] {
  const step = Math.min(periodMonthsOf(freq), bounds.months);
  const periods: AccrualPeriod[] = [];
  for (let i = 0; i < bounds.months; i += step) {
    const months = Math.min(step, bounds.months - i);
    const start = addMonths(bounds.start, i);
    // The last period always ends on the year's own last day.
    const end =
      i + months >= bounds.months
        ? bounds.end
        : dayBefore(addMonths(bounds.start, i + months));
    periods.push({ start, end, months, monthIndex: i });
  }
  return periods;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Months of `period` the employee counts for: none before their first counted month. */
export function countedMonths(
  period: AccrualPeriod,
  monthsBeforeStart: number,
): number {
  return Math.max(
    0,
    period.monthIndex +
      period.months -
      Math.max(period.monthIndex, monthsBeforeStart),
  );
}

export interface AccrualCredit {
  period: AccrualPeriod;
  days: number;
  /** The date the credit falls due (the period's start or end). */
  dueOn: string;
}

/**
 * Every credit of the leave year for one employee, with the amount of each (cumulative-rounded) - due or not.
 * `joiningDate` prorates the first year through the 15th rule when the rule says so.
 */
export function accrualSchedule(
  rule: AccrualRule,
  bounds: LeaveYearBounds,
  joiningDateStr: string,
): AccrualCredit[] {
  if (rule.basis === 'JOINING_ANNIVERSARY') {
    return anniversarySchedule(rule, bounds, joiningDateStr);
  }
  const periods = buildPeriods(bounds, rule.accrualFrequency);
  const joinedInside =
    joiningDateStr >= bounds.start && joiningDateStr <= bounds.end;
  const before =
    joinedInside && rule.prorate
      ? monthsBeforeFirstCountedMonth(joiningDateStr, bounds)
      : 0;
  const nominal = periodMonthsOf(rule.accrualFrequency);
  let cumulativeExact = 0;
  let creditedSoFar = 0;
  const out: AccrualCredit[] = [];
  for (const period of periods) {
    const counted = countedMonths(period, before);
    const exact =
      rule.accrualAmountPerCycle > 0
        ? (rule.accrualAmountPerCycle * counted) / nominal
        : (rule.annualQuota * counted) / 12;
    cumulativeExact += exact;
    const target = round2(cumulativeExact);
    const days = round2(target - creditedSoFar);
    creditedSoFar = target;
    out.push({
      period,
      days,
      dueOn: rule.accrueAt === 'START' ? period.start : period.end,
    });
  }
  return out;
}

/**
 * Anniversary basis: the credits whose due date falls inside the leave year. A cycle is `months` long from the joining
 * date; it credits `accrualAmountPerCycle`, or quota x months / 12. A credit belongs to the leave year it falls due in.
 */
function anniversarySchedule(
  rule: AccrualRule,
  bounds: LeaveYearBounds,
  joiningDateStr: string,
): AccrualCredit[] {
  const months = periodMonthsOf(rule.accrualFrequency);
  const days =
    rule.accrualAmountPerCycle > 0
      ? round2(rule.accrualAmountPerCycle)
      : round2((rule.annualQuota * months) / 12);
  const out: AccrualCredit[] = [];
  for (let k = 0; k < 12 * 80; k++) {
    const start = addMonthsClamped(joiningDateStr, k * months);
    const end = dayBefore(addMonthsClamped(joiningDateStr, (k + 1) * months));
    const dueOn = rule.accrueAt === 'START' ? start : end;
    if (dueOn > bounds.end) break;
    if (dueOn < bounds.start) continue;
    out.push({
      period: { start, end, months, monthIndex: 0 },
      days,
      dueOn,
    });
  }
  return out;
}

/** The credits that have fallen due by `today` and are not yet recorded. Zero-day credits (before joining) are skipped. */
export function dueCredits(
  rule: AccrualRule,
  bounds: LeaveYearBounds,
  joiningDateStr: string,
  today: string,
  alreadyCredited: Set<string>,
): AccrualCredit[] {
  return accrualSchedule(rule, bounds, joiningDateStr).filter(
    (c) =>
      c.days > 0 && c.dueOn <= today && !alreadyCredited.has(c.period.start),
  );
}

/** The next credit that has not fallen due yet. */
export function nextCredit(
  rule: AccrualRule,
  bounds: LeaveYearBounds,
  joiningDateStr: string,
  today: string,
): AccrualCredit | null {
  return (
    accrualSchedule(rule, bounds, joiningDateStr).find(
      (c) => c.days > 0 && c.dueOn > today,
    ) ?? null
  );
}

/** What the employee will have accrued by the end of the leave year. */
export function annualEntitlement(
  rule: AccrualRule,
  bounds: LeaveYearBounds,
  joiningDateStr: string,
): number {
  if (rule.basis === 'JOINING_ANNIVERSARY') {
    // Cycles do not line up with the leave year, so state the yearly rate instead of counting credits in it.
    const months = periodMonthsOf(rule.accrualFrequency);
    return round2(
      rule.accrualAmountPerCycle > 0
        ? (rule.accrualAmountPerCycle * 12) / months
        : rule.annualQuota,
    );
  }
  return round2(
    accrualSchedule(rule, bounds, joiningDateStr).reduce(
      (sum, c) => sum + c.days,
      0,
    ),
  );
}
