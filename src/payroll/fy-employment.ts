// Purpose: two small facts the tax figures need about one employee in one financial year.
// Responsibilities: pure functions (no database).

/** The date of birth saved on an employee's personal data (the profile form stores it as `dateOfBirth`; an older `dob` key is still read). */
export function employeeDob(personalData: unknown): unknown {
  const pd = (personalData ?? {}) as Record<string, unknown>;
  return pd.dateOfBirth ?? pd.dob;
}

/**
 * Whole months of this financial year the person was employed BEFORE the current month (start of the year, or the joining
 * month when they joined later). Months the system holds no payroll for - because they pre-date the system - are
 * `employedBefore - monthsAlreadyCounted`, never below zero.
 */
export function missingPastMonths(opts: {
  joiningDate: Date | string | null | undefined;
  fyStartYear: number; // calendar year in which the FY starts (2026 for "2026-27")
  fyStartMonth: number; // 1-12
  currentMonth: number;
  currentYear: number;
  monthsAlreadyCounted: number; // months of pay the system already holds (payroll runs and opening balances)
}): number {
  const idx = (y: number, m: number) => y * 12 + (m - 1);
  const fyStart = idx(opts.fyStartYear, opts.fyStartMonth);
  const joined = opts.joiningDate ? new Date(opts.joiningDate) : null;
  const joinIdx = joined && !Number.isNaN(joined.getTime()) ? idx(joined.getUTCFullYear(), joined.getUTCMonth() + 1) : fyStart;
  const employedFrom = Math.max(fyStart, joinIdx);
  const employedBefore = Math.max(0, idx(opts.currentYear, opts.currentMonth) - employedFrom);
  return Math.max(0, employedBefore - opts.monthsAlreadyCounted);
}
