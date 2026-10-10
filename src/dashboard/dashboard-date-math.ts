// Pure date-math helpers ported verbatim from the old backend's
// dashboardController.js — financial-year month windows and
// days-until-next-occurrence, both used by the read-only dashboard
// aggregation endpoints.

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
// Default financial-year start month (April); callers pass the organization's own financialYearStartMonth.
export const DEFAULT_FY_START_MONTH = 4;

export interface MonthYear {
  month: number;
  year: number;
}

// 12 {month, year} entries for the financial year `fysBack` FYs before the
// current one.
export function buildFyMonths(
  fysBack: number,
  now = new Date(),
  fyStartMonth: number = DEFAULT_FY_START_MONTH,
): MonthYear[] {
  const currentFyStartYear =
    now.getMonth() + 1 >= fyStartMonth
      ? now.getFullYear()
      : now.getFullYear() - 1;
  const fyStartYear = currentFyStartYear - fysBack;
  const months: MonthYear[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((fyStartMonth - 1 + i) % 12) + 1;
    const year = fyStartMonth + i <= 12 ? fyStartYear : fyStartYear + 1;
    months.push({ month, year });
  }
  return months;
}

export type DashboardRange =
  'this_year' | 'previous_year' | 'this_quarter' | 'previous_quarter';

export function monthsForRange(
  range: DashboardRange,
  now = new Date(),
  fyStartMonth: number = DEFAULT_FY_START_MONTH,
): MonthYear[] {
  if (range === 'previous_year') return buildFyMonths(1, now, fyStartMonth);
  if (range === 'this_quarter' || range === 'previous_quarter') {
    const prevFY = buildFyMonths(1, now, fyStartMonth);
    const curFY = buildFyMonths(0, now, fyStartMonth);
    const all = [...prevFY, ...curFY];
    const fyMonthIndex = curFY.findIndex(
      (m) => m.month === now.getMonth() + 1 && m.year === now.getFullYear(),
    );
    const currentQuarterIdx = Math.floor(fyMonthIndex / 3);
    let globalStart = 12 + currentQuarterIdx * 3;
    if (range === 'previous_quarter') globalStart -= 3;
    return all.slice(globalStart, globalStart + 3);
  }
  return buildFyMonths(0, now, fyStartMonth); // this_year
}

// Days from `today` until the next occurrence of (month, day), wrapping
// around year-end. Used for the executive dashboard's upcoming-anniversary
// widget.
export function daysUntilNextOccurrence(
  month: number,
  day: number,
  today: Date,
): number {
  const year = today.getFullYear();
  let next = new Date(year, month - 1, day);
  if (next < today) next = new Date(year + 1, month - 1, day);
  return Math.round((next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
