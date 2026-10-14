// Purpose: How many of a leave's days fall inside a date window (YYYY-MM-DD, inclusive) - for month-by-month summaries.
// Important: a leave that spans two months must be split between them, not counted in full in both. `totalDays` is the
//   leave's own day count (it already leaves out weekly offs/holidays), so it is shared out in proportion to the calendar
//   days of the leave that fall in the window. A half day is a single date: all of it, or none of it.

const DAY_MS = 86_400_000;
const toMs = (d: string) => new Date(`${d}T00:00:00.000Z`).getTime();

export function leaveDaysInRange(
  leave: {
    startDate: string;
    endDate: string;
    isHalfDay: boolean;
    totalDays: number;
  },
  from: string,
  to: string,
): number {
  if (leave.isHalfDay) {
    return leave.startDate >= from && leave.startDate <= to
      ? leave.totalDays
      : 0;
  }
  const start = leave.startDate > from ? leave.startDate : from;
  const end = leave.endDate < to ? leave.endDate : to;
  if (start > end) return 0;
  const overlap = Math.round((toMs(end) - toMs(start)) / DAY_MS) + 1;
  const span =
    Math.round((toMs(leave.endDate) - toMs(leave.startDate)) / DAY_MS) + 1;
  if (span <= 0) return 0;
  if (overlap >= span) return leave.totalDays;
  return Math.round(((leave.totalDays * overlap) / span) * 100) / 100;
}
