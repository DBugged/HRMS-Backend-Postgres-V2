import { AllocationType } from '@prisma/client';

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
