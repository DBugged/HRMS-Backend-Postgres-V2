import { AllocationType } from '@prisma/client';

/**
 * Pure balance-math formulas for leave. No DB access: orchestration (persisting rows, looking up prior-year
 * balances) lives in leave-balance.service.ts.
 *
 * Every quota-based leave type is granted upfront: the whole Annual Quota is credited when the balance row is
 * created, and an employee who joined part-way through the year gets the prorated share (the 15th rule below).
 * There is no per-cycle accrual any more.
 */

export interface UpfrontCreditLeaveType {
  allocationType: AllocationType;
  annualQuota: number;
  prorateOnJoining: boolean;
}

// The days credited to a balance row when it is created for `balanceYear`:
//   - FIXED_ANNUAL / PRORATED_ON_JOINING (and the legacy EARNED_MONTHLY, treated the same): the annual quota, or its
//     prorated share when the employee joined in that same year and the type prorates (checkbox or
//     PRORATED_ON_JOINING).
//   - UNLIMITED / NONE: nothing.
export function computeUpfrontCredit(
  leaveType: UpfrontCreditLeaveType,
  joiningDate: Date,
  balanceYear: number,
): number {
  if (
    leaveType.allocationType !== AllocationType.FIXED_ANNUAL &&
    leaveType.allocationType !== AllocationType.PRORATED_ON_JOINING &&
    leaveType.allocationType !== AllocationType.EARNED_MONTHLY
  ) {
    return 0;
  }

  const shouldProrate =
    joiningDate.getUTCFullYear() === balanceYear &&
    shouldProrateOnJoining(leaveType);
  if (!shouldProrate) return leaveType.annualQuota;

  // The 15th rule (see firstCountedMonthIndex): the joining month counts when they joined on or before the 15th,
  // otherwise counting starts the month after.
  const remainingMonths = Math.max(0, 12 - firstCountedMonthIndex(joiningDate));
  return (
    Math.round(((leaveType.annualQuota * remainingMonths) / 12) * 100) / 100
  );
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

/**
 * Whether the year-end carry-forward run applies to a leave type. Event-based leave never resets - its unused days
 * already stay available in the next year - so a carry-forward cap or expiry must not touch it.
 */
export function usesYearEndCarryForward(leaveType: {
  allocationType: AllocationType;
  carryForward: unknown;
}): boolean {
  if (leaveType.allocationType === AllocationType.EVENT_BASED) return false;
  return !!(leaveType.carryForward as { allowed?: boolean } | null)?.allowed;
}
