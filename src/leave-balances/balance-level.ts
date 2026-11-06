// Purpose: how healthy a balance is, for the red / yellow / green colouring on Leave Balances (web and mobile use the
//   same rule). NONE = nothing left, LOW = running low, OK = plenty left, NA = nothing was ever entitled.
// Important: "left" is what remains after days already waiting for approval are set aside, since those days are spoken
//   for. A balance is LOW at 25% of its total or less; for a small total (4 days or fewer) a percentage is too coarse,
//   so 1 day or less is LOW instead. An untouched balance (nothing used) is always OK.
export type BalanceLevel = 'NONE' | 'LOW' | 'OK' | 'NA';

export const LOW_BALANCE_FRACTION = 0.25;
export const SMALL_TOTAL_DAYS = 4;
export const SMALL_TOTAL_LOW_DAYS = 1;

export function balanceLevel(
  left: number,
  total: number,
  pending = 0,
): BalanceLevel {
  if (!(total > 0)) return 'NA';
  const remaining = Math.max(0, Math.round((left - pending) * 100) / 100);
  if (remaining <= 0) return 'NONE';
  // Nothing used yet is never "low", however small the entitlement.
  if (remaining >= total) return 'OK';
  const lowAt =
    total <= SMALL_TOTAL_DAYS
      ? SMALL_TOTAL_LOW_DAYS
      : total * LOW_BALANCE_FRACTION;
  return remaining <= lowAt ? 'LOW' : 'OK';
}
