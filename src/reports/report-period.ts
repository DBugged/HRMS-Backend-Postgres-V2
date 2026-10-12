// Purpose: The period a statutory report covers when the caller does not name one.
// A monthly return (PF ECR, ESIC, PT, LWF) is filed for the month that has just ended, so that is the default; a
// yearly one (Statutory Bonus, Form 16) defaults to the current financial year (April to March).

/** The calendar month before `now`. */
export function previousMonthPeriod(now: Date = new Date()): {
  month: number;
  year: number;
} {
  const month = now.getUTCMonth(); // 0-11: this is last month's 1-12 number, January gives 0
  return month === 0
    ? { month: 12, year: now.getUTCFullYear() - 1 }
    : { month, year: now.getUTCFullYear() };
}

/** The financial year `now` falls in, as YYYY-YY (April to March), e.g. 2026-27. */
export function currentFinancialYear(now: Date = new Date()): string {
  const start =
    now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
