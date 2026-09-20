// Purpose: Pure notice-period shortfall maths for the settlement's suggested noticePeriodRecovery.
// Responsibilities: Days short of the contractual notice (never negative) and the amount at a daily rate.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Whole calendar days between two YYYY-MM-DD strings (UTC, so DST can't skew it); NaN if either is invalid.
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

// shortfallDays = max(0, noticePeriodDays − (lastWorkingDay − submittedOn)). Unknown/invalid inputs → 0.
export function noticeShortfallDays(
  noticePeriodDays: number | null | undefined,
  submittedOn: string | null | undefined,
  lastWorkingDay: string,
): number {
  if (!noticePeriodDays || noticePeriodDays <= 0 || !submittedOn) return 0;
  const served = daysBetween(submittedOn, lastWorkingDay);
  if (Number.isNaN(served)) return 0;
  return Math.max(0, noticePeriodDays - served);
}

export function noticeRecoveryAmount(
  shortfallDays: number,
  ratePerDay: number,
): number {
  return Math.round(shortfallDays * ratePerDay);
}
