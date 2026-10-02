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

  const joiningMonth = joiningDate.getUTCMonth() + 1; // 1-indexed, Jan=1
  const remainingMonths = 13 - joiningMonth; // inclusive of the joining month
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
