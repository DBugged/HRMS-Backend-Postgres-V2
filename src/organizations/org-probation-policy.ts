// Purpose: The company's default probation length (Organization Settings > Policies), in months. A probation end date is worked out
//   as the joining date plus this many months, so HR does not type it for every new joiner.
// Important: unset or invalid falls back to 6 months; HR can still set any end date on one employee, or extend it later.
export const DEFAULT_PROBATION_MONTHS = 6;

export function probationMonthsOf(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : DEFAULT_PROBATION_MONTHS;
}

/** YYYY-MM-DD plus whole months, keeping the day (clamped to the end of a shorter month). */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
