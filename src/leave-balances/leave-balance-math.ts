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
}

// Mirrors ensureBalanceRow's credited calculation exactly:
//   - EARNED_MONTHLY: starts at 0, only grows via creditAccrual runs.
//   - FIXED_ANNUAL / PRORATED_ON_JOINING: grants annualQuota upfront,
//     prorated if the employee joined in the same calendar year as the
//     balance AND (allocationType is PRORATED_ON_JOINING OR the type's
//     prorateOnJoining flag is set).
//   - UNLIMITED / NONE: no balance-row credit (callers short-circuit
//     before this is invoked at all, same as the old system).
export function computeUpfrontCredit(
  leaveType: UpfrontCreditLeaveType,
  joiningDate: Date,
  balanceYear: number,
): number {
  if (leaveType.allocationType === AllocationType.EARNED_MONTHLY) return 0;
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
