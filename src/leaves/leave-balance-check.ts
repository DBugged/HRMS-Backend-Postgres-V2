/**
 * Pure port of the old backend's `checkBalance` affordability math
 * (`leavePolicyEngine.js`), for the non-comp-off/non-unlimited case —
 * LeavesService branches to CompOffService.available()/true respectively
 * for those two cases before ever reaching this function.
 */

export interface AffordabilityBalanceRow {
  opening: number;
  credited: number;
  availed: number;
  pending: number;
  encashed: number;
  adjusted: number;
  carriedInExpiresOn: string | null; // YYYY-MM-DD
}

export interface NegativeBalanceRule {
  allowed: boolean;
  maxNegativeDays: number;
}

export interface AffordabilityResult {
  ok: boolean;
  available: number;
  shortfall: number;
}

export function checkAffordability(
  row: AffordabilityBalanceRow,
  negativeBalance: NegativeBalanceRule,
  requestedDays: number,
  today: string,
): AffordabilityResult {
  const effectiveOpening =
    row.carriedInExpiresOn !== null && today > row.carriedInExpiresOn
      ? 0
      : row.opening;

  // `pending` IS subtracted here (unlike LeaveBalance.closing's formula)
  // to block a second concurrent request from double-booking the same
  // balance — see leave-balances/leave-balance.service.ts's comment on
  // why the two formulas deliberately differ.
  const available =
    effectiveOpening +
    row.credited -
    row.availed -
    row.encashed +
    row.adjusted -
    row.pending;

  const shortfall = Math.max(0, requestedDays - available);
  const ok =
    shortfall === 0 ||
    (negativeBalance.allowed && shortfall <= negativeBalance.maxNegativeDays);

  return { ok, available, shortfall };
}
