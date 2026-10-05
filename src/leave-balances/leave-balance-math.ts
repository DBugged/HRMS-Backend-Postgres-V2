import { AllocationType, AccrualFrequency } from '@prisma/client';

/**
 * Pure port of the balance-math formulas in the old backend's
 * `leavePolicyEngine.js`. No DB access — orchestration (persisting rows,
 * looking up prior-year balances) lives in leave-balance.service.ts.
 */

export interface UpfrontCreditLeaveType {
  allocationType: AllocationType;
  annualQuota: number;
  prorateOnJoining: boolean;
  // Omitted = YEARLY (upfront), for callers/tests that predate it.
  accrualFrequency?: AccrualFrequency;
}

// Whether a leave type is credited cycle by cycle (by creditAccrual / Run
// Accrual) rather than granted upfront. The rule HR sees on the form:
//   - Accrual Frequency = Yearly → whole annual quota upfront.
//   - Any other frequency → nothing upfront; each accrual run credits
//     annualQuota ÷ cycles per year (6 quarterly → 1.5 per quarter).
// EARNED_MONTHLY (legacy "Earned") always accrues; UNLIMITED / NONE never.
// Exactly one of upfront / per-cycle applies, so a type can't be credited
// twice (6 upfront + 4 × 1.5 = 12).
export function accruesPerCycle(leaveType: {
  allocationType: AllocationType;
  accrualFrequency?: AccrualFrequency;
}): boolean {
  if (leaveType.allocationType === AllocationType.EARNED_MONTHLY) return true;
  if (
    leaveType.allocationType === AllocationType.FIXED_ANNUAL ||
    leaveType.allocationType === AllocationType.PRORATED_ON_JOINING
  ) {
    return (
      (leaveType.accrualFrequency ?? AccrualFrequency.YEARLY) !==
      AccrualFrequency.YEARLY
    );
  }
  return false;
}

// Mirrors ensureBalanceRow's credited calculation exactly:
//   - Types that accrue per cycle (see accruesPerCycle): starts at 0, only
//     grows via creditAccrual runs.
//   - FIXED_ANNUAL / PRORATED_ON_JOINING with Yearly frequency: grants
//     annualQuota upfront, prorated if the employee joined in the same
//     calendar year as the balance AND (allocationType is
//     PRORATED_ON_JOINING OR the type's prorateOnJoining flag is set).
//   - UNLIMITED / NONE: no balance-row credit (callers short-circuit
//     before this is invoked at all, same as the old system).
export function computeUpfrontCredit(
  leaveType: UpfrontCreditLeaveType,
  joiningDate: Date,
  balanceYear: number,
): number {
  if (accruesPerCycle(leaveType)) return 0;
  if (
    leaveType.allocationType !== AllocationType.FIXED_ANNUAL &&
    leaveType.allocationType !== AllocationType.PRORATED_ON_JOINING
  ) {
    return 0;
  }

  const joiningYear = joiningDate.getUTCFullYear();
  const shouldProrate =
    joiningYear === balanceYear &&
    (leaveType.allocationType === AllocationType.PRORATED_ON_JOINING ||
      leaveType.prorateOnJoining);

  if (!shouldProrate) return leaveType.annualQuota;

  // The 15th rule (see firstCountedMonthIndex): the joining month counts when they joined on or before the 15th,
  // otherwise counting starts the month after.
  const remainingMonths = Math.max(0, 12 - firstCountedMonthIndex(joiningDate));
  return (
    Math.round(((leaveType.annualQuota * remainingMonths) / 12) * 100) / 100
  );
}

export const ACCRUAL_CYCLES_PER_YEAR: Record<AccrualFrequency, number> = {
  [AccrualFrequency.YEARLY]: 1,
  [AccrualFrequency.HALF_YEARLY]: 2,
  [AccrualFrequency.QUARTERLY]: 4,
  [AccrualFrequency.BI_MONTHLY]: 6,
  [AccrualFrequency.MONTHLY]: 12,
};

// Per-cycle amount for every quota-based type, derived from the annual quota
// instead of HR typing it separately — the two used to drift apart (quota 6 +
// 2/quarter silently granted 8 a year). Only credited for types that accrue
// per cycle (see accruesPerCycle). Rounded to 2 decimals, same as every
// other credited amount; a quota that doesn't divide evenly (10 / 12) totals
// slightly under the quota (9.96).
export function computeAccrualPerCycle(
  annualQuota: number,
  frequency: AccrualFrequency,
): number {
  return (
    Math.round((annualQuota / ACCRUAL_CYCLES_PER_YEAR[frequency]) * 100) / 100
  );
}

// What each accrual cycle actually credits: quota ÷ cycles for Fixed Annual /
// Prorated (computed, never a stored value an older form may have typed by
// hand); legacy Earned types keep their stored per-cycle amount (some predate
// annualQuota being used for them at all).
export function accrualCreditPerCycle(leaveType: {
  allocationType: AllocationType;
  annualQuota: number;
  accrualFrequency: AccrualFrequency;
  accrualAmountPerCycle: number;
}): number {
  return leaveType.allocationType === AllocationType.EARNED_MONTHLY
    ? leaveType.accrualAmountPerCycle
    : computeAccrualPerCycle(leaveType.annualQuota, leaveType.accrualFrequency);
}

// Identifies "which accrual cycle does `asOf` fall in" for a given
// frequency — creditAccrual() compares this against a balance row's
// stored lastAccrualPeriod to tell a genuinely new cycle apart from a
// repeat call (double-click, retry) within the same one. UTC throughout,
// matching monthsOfService's convention above.
export function computeAccrualPeriodKey(
  frequency: AccrualFrequency,
  asOf: Date,
): string {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth(); // 0-indexed
  switch (frequency) {
    case AccrualFrequency.YEARLY:
      return `${year}`;
    case AccrualFrequency.HALF_YEARLY:
      return `${year}-H${Math.floor(month / 6) + 1}`;
    case AccrualFrequency.QUARTERLY:
      return `${year}-Q${Math.floor(month / 3) + 1}`;
    case AccrualFrequency.BI_MONTHLY:
      return `${year}-B${Math.floor(month / 2) + 1}`;
    case AccrualFrequency.MONTHLY:
      return `${year}-${String(month + 1).padStart(2, '0')}`;
  }
}

// Parses a computeAccrualPeriodKey() string back into a monotonically
// increasing integer for the given frequency, so two period keys can be
// subtracted to count how many cycles separate them. Returns null if the
// key doesn't match the shape this frequency currently produces (e.g. the
// leave type's accrualFrequency was changed since the key was stored) —
// callers treat that as "gap unknown," not "gap is zero."
function parseAccrualPeriodKey(
  frequency: AccrualFrequency,
  key: string,
): number | null {
  const yearly = /^(\d{4})$/.exec(key);
  const sub = /^(\d{4})-([A-Z])(\d+)$/.exec(key);
  const monthly = /^(\d{4})-(\d{2})$/.exec(key);
  switch (frequency) {
    case AccrualFrequency.YEARLY:
      return yearly ? Number(yearly[1]) : null;
    case AccrualFrequency.HALF_YEARLY:
      return sub && sub[2] === 'H'
        ? Number(sub[1]) * 2 + (Number(sub[3]) - 1)
        : null;
    case AccrualFrequency.QUARTERLY:
      return sub && sub[2] === 'Q'
        ? Number(sub[1]) * 4 + (Number(sub[3]) - 1)
        : null;
    case AccrualFrequency.BI_MONTHLY:
      return sub && sub[2] === 'B'
        ? Number(sub[1]) * 6 + (Number(sub[3]) - 1)
        : null;
    case AccrualFrequency.MONTHLY:
      return monthly
        ? Number(monthly[1]) * 12 + (Number(monthly[2]) - 1)
        : null;
  }
}

// How many accrual cycles separate a stale lastAccrualPeriod from the
// current period — 1 for the ordinary "one cycle since last credit" case,
// more than 1 if the accrual run was missed for one or more whole cycles
// (e.g. the daily cron's host was down across a cycle boundary), so a
// later run backfills every missed cycle instead of only ever crediting
// the single most-recent one. Falls back to 1 (credit just the current
// cycle, same as the pre-backfill behavior) whenever the gap can't be
// determined — a malformed stored value, or the leave type's
// accrualFrequency changed since fromKey was written — rather than
// guessing at a number that could over- or under-credit.
export function countElapsedCycles(
  frequency: AccrualFrequency,
  fromKey: string,
  toKey: string,
): number {
  const from = parseAccrualPeriodKey(frequency, fromKey);
  const to = parseAccrualPeriodKey(frequency, toKey);
  if (from === null || to === null || to <= from) return 1;
  return to - from;
}

// How many cycles an employee is owed on their very first-ever accrual
// credit for a leave type — every cycle from the one they joined in
// through the current one, inclusive, rather than just the current one.
// Without this, an employee who joined long before accrual was ever run
// for them (the normal case for every employee that already existed when
// this org started actually running its accrual cron/HR's Run Accrual)
// permanently loses everything they earned between joining and whenever
// the first run happened — same missed-cycle problem countElapsedCycles
// fixes for gaps between runs, just for the very first one. Falls back to
// 1 (today's current-cycle-only credit) if the joining cycle can't be
// parsed for some reason.
export function cyclesSinceJoining(
  frequency: AccrualFrequency,
  joiningDate: Date,
  asOf: Date,
): number {
  const from = parseAccrualPeriodKey(
    frequency,
    computeAccrualPeriodKey(frequency, joiningDate),
  );
  const to = parseAccrualPeriodKey(
    frequency,
    computeAccrualPeriodKey(frequency, asOf),
  );
  if (from === null || to === null || to < from) return 1;
  return to - from + 1;
}

/**
 * What an employee should have been credited by `asOf` for a per-cycle type in `year`: one cycle's credit for every
 * cycle from their joining cycle (or Jan 1, whichever is later — a prior year is a different balance row) through
 * the cycle `asOf` falls in. The same figure creditAccrual's first-ever credit and a new balance row use, exposed so
 * a balance can be checked against it. Zero for someone who has not joined yet.
 */
export function expectedAccrualToDate(
  leaveType: {
    allocationType: AllocationType;
    annualQuota: number;
    accrualFrequency: AccrualFrequency;
    accrualAmountPerCycle: number;
    prorateOnJoining: boolean;
  },
  joiningDate: Date,
  year: number,
  asOf: Date,
): number {
  if (joiningDate > asOf) return 0;
  const cycles = accrualCyclesDue(
    leaveType.accrualFrequency,
    joiningDate,
    year,
    asOf,
    shouldProrateOnJoining(leaveType),
  );
  return Math.round(accrualCreditPerCycle(leaveType) * cycles * 100) / 100;
}

// ---- Joining-date proration (the "15th rule") -----------------------------------------------------------------
// Someone who joins on or before the 15th counts their joining month in full; someone who joins after the 15th starts
// counting from the next month. This is the one rule behind "Prorate on Joining" for every leave type, so the same
// joining date gives the same entitlement whichever way the type is credited.
export const PRORATION_CUTOFF_DAY = 15;

/** Index (0 = January) of the first month that counts toward proration in the joining year; 12 = none left. */
export function firstCountedMonthIndex(joiningDate: Date): number {
  return (
    joiningDate.getUTCMonth() +
    (joiningDate.getUTCDate() > PRORATION_CUTOFF_DAY ? 1 : 0)
  );
}

/** Whether a leave type prorates on joining: the checkbox, or the Prorated on Joining allocation type itself. */
export function shouldProrateOnJoining(leaveType: {
  allocationType: AllocationType;
  prorateOnJoining: boolean;
}): boolean {
  return (
    leaveType.allocationType === AllocationType.PRORATED_ON_JOINING ||
    leaveType.prorateOnJoining
  );
}

/**
 * The share (0 to 1) of the joining cycle that counts: the months from the first counted month to the end of that
 * cycle, over the months in the cycle. Quarterly, joined 7 Feb: Feb and Mar of Jan-Mar = 2/3. Joined 20 Feb: only Mar
 * = 1/3. A Yearly frequency has no cycle to split, so it is 1.
 */
export function joiningCycleFraction(
  frequency: AccrualFrequency,
  joiningDate: Date,
): number {
  const cyclesPerYear = ACCRUAL_CYCLES_PER_YEAR[frequency];
  if (cyclesPerYear <= 1) return 1;
  const monthsInCycle = 12 / cyclesPerYear;
  const cycleStart =
    Math.floor(joiningDate.getUTCMonth() / monthsInCycle) * monthsInCycle;
  const counted = Math.max(
    0,
    Math.min(
      monthsInCycle,
      cycleStart + monthsInCycle - firstCountedMonthIndex(joiningDate),
    ),
  );
  return counted / monthsInCycle;
}

/**
 * Cycles of credit due in `year` as of `asOf` (can be fractional). Every cycle from the joining cycle (or Jan 1,
 * whichever is later) through the current one counts in full, except that when the type prorates and the employee
 * joined in `year`, the joining cycle counts only for its share (joiningCycleFraction). Someone who joined in an
 * earlier year gets full cycles: their joining date does not matter any more.
 */
export function accrualCyclesDue(
  frequency: AccrualFrequency,
  joiningDate: Date,
  year: number,
  asOf: Date,
  prorate: boolean,
): number {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const whole = cyclesSinceJoining(
    frequency,
    joiningDate > yearStart ? joiningDate : yearStart,
    asOf,
  );
  if (!prorate || joiningDate.getUTCFullYear() !== year) return whole;
  return Math.max(0, whole - 1 + joiningCycleFraction(frequency, joiningDate));
}

export interface BalanceRowLike {
  opening: number;
  credited: number;
  availed: number;
  encashed: number;
  adjusted: number;
}

// Single source-of-truth closing formula — `pending` is deliberately
// excluded (see schema.prisma's comment on LeaveBalance.pending).
export function recalcClosing(row: BalanceRowLike): number {
  return row.opening + row.credited - row.availed - row.encashed + row.adjusted;
}

// Clamps how much of a closing balance rolls into next year's opening —
// never negative, never more than the leave type's carryForward.maxDays.
export function computeCarryOut(closing: number, maxDays: number): number {
  return Math.max(0, Math.min(closing, maxDays || 0));
}

// A carried-in balance expires ON `expiresOn` (computeCarriedInExpiry returns Jan 1 + N months, i.e. the first day
// the days are gone): "3 months" from Jan 1 means usable through 31 Mar, expired on 1 Apr. `asOf` is YYYY-MM-DD.
export function isCarriedInExpired(
  expiresOn: string | null | undefined,
  asOf: string,
): boolean {
  return !!expiresOn && asOf >= expiresOn;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (d: string) =>
  Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);

/**
 * Days of approved leave taken before a carried-in balance expired. The oldest days are used first (carried-in
 * before this year's credit), so these are the days that came out of the carried-in pool. A leave that straddles the
 * expiry date counts for the share of its calendar days that fall before it.
 */
export function availedBeforeExpiry(
  leaves: { startDate: string; endDate: string; totalDays: number }[],
  expiresOn: string,
): number {
  let total = 0;
  for (const l of leaves) {
    if (l.startDate >= expiresOn) continue;
    if (l.endDate < expiresOn) {
      total += l.totalDays;
      continue;
    }
    const span = dayNumber(l.endDate) - dayNumber(l.startDate) + 1;
    const before = dayNumber(expiresOn) - dayNumber(l.startDate);
    total += l.totalDays * (before / span);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Carried-in days that went unused and lapsed with the expiry date: the carried-in opening minus what leave already
 * took from it. Zero before expiry, and zero when leave had used all of it — those days were spent, not lost, so they
 * must not be charged a second time against this year's credit.
 */
export function forfeitedCarryIn(
  opening: number,
  availedBeforeExpiryDays: number,
  expired: boolean,
): number {
  if (!expired || opening <= 0) return 0;
  const used = Math.min(opening, Math.max(0, availedBeforeExpiryDays));
  return Math.round((opening - used) * 100) / 100;
}

// Jan 1 of `rolloverYear` plus `expiryMonths`, as YYYY-MM-DD — null if the
// leave type doesn't set an expiry (carried-in balance never expires).
export function computeCarriedInExpiry(
  rolloverYear: number,
  expiryMonths: number | null | undefined,
): string | null {
  if (expiryMonths === null || expiryMonths === undefined) return null;
  const expiry = new Date(Date.UTC(rolloverYear, 0, 1));
  expiry.setUTCMonth(expiry.getUTCMonth() + expiryMonths);
  return expiry.toISOString().slice(0, 10);
}
