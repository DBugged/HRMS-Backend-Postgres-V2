// Purpose: What the Probation Tracker shows for each person on probation: days left to the end date and which group
//   that puts them in, so the ones who need a decision first are at the top.
// Important: pure. Days are counted in the organization's own calendar day (the caller passes `today`).
export type ProbationBucket = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'NO_DATE';

/** Anyone whose end date is within this many days (and not past) is "due soon". */
export const PROBATION_DUE_SOON_DAYS = 30;

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);

/** End date minus today in whole days: negative once the end date has passed, null when there is no end date. */
export function probationDaysLeft(today: string, endDate: string | null | undefined): number | null {
  if (!endDate) return null;
  return dayNumber(endDate) - dayNumber(today);
}

export function probationBucket(daysLeft: number | null): ProbationBucket {
  if (daysLeft === null) return 'NO_DATE';
  if (daysLeft < 0) return 'OVERDUE';
  return daysLeft <= PROBATION_DUE_SOON_DAYS ? 'DUE_SOON' : 'UPCOMING';
}

const ORDER: Record<ProbationBucket, number> = { OVERDUE: 0, DUE_SOON: 1, UPCOMING: 2, NO_DATE: 3 };

/** Overdue first (longest overdue at the top), then by how soon the end date is; people without a date last. */
export function compareProbation(
  a: { bucket: ProbationBucket; daysLeft: number | null; name: string },
  b: { bucket: ProbationBucket; daysLeft: number | null; name: string },
): number {
  return (
    ORDER[a.bucket] - ORDER[b.bucket] ||
    (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
    a.name.localeCompare(b.name)
  );
}
