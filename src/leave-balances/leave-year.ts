// Purpose: One definition of the "leave year" - the period a leave balance row belongs to - for the whole app.
// Responsibilities: Maps a date to its leave-year key, gives a key's start/end dates and length, and labels it.
// Important: pure and DB-free. An organisation either keeps the calendar year (start month 1, the default and what the
//   app always did) or starts its leave year in another month (April = 4). Moving from January to another month is a
//   one-off transition (see LeaveYearService): the calendar year in progress is EXTENDED until the day before the new
//   start, so its balance row spans more than 12 months, and from the next year on every year starts in that month.
//   `anchorYear` is the first year whose leave year starts in the new month; before it the calendar year applies, except
//   that the months of the anchor year ahead of the start month still belong to the previous (extended) year.

export interface LeaveYearConfig {
  /** 1-12. 1 = the calendar year. */
  startMonth: number;
  /** First year that starts in `startMonth`; null / irrelevant when startMonth is 1. */
  anchorYear: number | null;
}

export const CALENDAR_LEAVE_YEAR: LeaveYearConfig = {
  startMonth: 1,
  anchorYear: null,
};

const pad = (n: number) => String(n).padStart(2, '0');

function usesCalendar(cfg: LeaveYearConfig): boolean {
  return cfg.startMonth === 1 || cfg.anchorYear === null;
}

/** The leave-year key a date (YYYY-MM-DD) belongs to. For the calendar year it is the date's own year. */
export function leaveYearOf(dateStr: string, cfg: LeaveYearConfig): number {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  if (usesCalendar(cfg) || y < (cfg.anchorYear as number)) return y;
  return m >= cfg.startMonth ? y : y - 1;
}

export interface LeaveYearBounds {
  /** YYYY-MM-DD, first day. */
  start: string;
  /** YYYY-MM-DD, last day. */
  end: string;
  /** Length in months: 12, or more for the one extended year of a transition. */
  months: number;
}

/** First and last day of a leave year, and how many months it has. */
export function leaveYearBounds(
  key: number,
  cfg: LeaveYearConfig,
): LeaveYearBounds {
  if (usesCalendar(cfg) || key < (cfg.anchorYear as number) - 1) {
    return { start: `${key}-01-01`, end: `${key}-12-31`, months: 12 };
  }
  const anchor = cfg.anchorYear as number;
  const s = cfg.startMonth;
  if (key === anchor - 1) {
    // The extended year: from 1 January to the day before the new start month of the anchor year.
    return {
      start: `${key}-01-01`,
      end: lastDayBefore(anchor, s),
      months: 12 + (s - 1),
    };
  }
  return {
    start: `${key}-${pad(s)}-01`,
    end: lastDayBefore(key + 1, s),
    months: 12,
  };
}

// The day before the 1st of `month` in `year`.
function lastDayBefore(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "2026" for a calendar leave year, "2026-27" for one that runs across two calendar years. */
export function leaveYearLabel(key: number, cfg: LeaveYearConfig): string {
  const b = leaveYearBounds(key, cfg);
  const startYear = Number(b.start.slice(0, 4));
  const endYear = Number(b.end.slice(0, 4));
  return startYear === endYear
    ? String(startYear)
    : `${startYear}-${String(endYear).slice(2)}`;
}

/** The leave year containing `todayStr`. */
export function currentLeaveYear(
  todayStr: string,
  cfg: LeaveYearConfig,
): number {
  return leaveYearOf(todayStr, cfg);
}

/**
 * The months (0-based, from the year's first day) that elapse before a joining date's first counted month: the
 * "15th rule" - joining on or before the 15th counts the joining month, after it counting starts next month. 0 when the
 * employee was there from the start; `months` (nothing left) when the first counted month is past the year's end.
 */
export function monthsBeforeFirstCountedMonth(
  joiningDateStr: string,
  bounds: LeaveYearBounds,
): number {
  const jy = Number(joiningDateStr.slice(0, 4));
  const jm = Number(joiningDateStr.slice(5, 7));
  const jd = Number(joiningDateStr.slice(8, 10));
  const sy = Number(bounds.start.slice(0, 4));
  const sm = Number(bounds.start.slice(5, 7));
  const monthsIn = (jy - sy) * 12 + (jm - sm) + (jd > 15 ? 1 : 0);
  return Math.min(bounds.months, Math.max(0, monthsIn));
}

/** Whether a date string lies inside the bounds (inclusive). */
export function inBounds(dateStr: string, bounds: LeaveYearBounds): boolean {
  return dateStr >= bounds.start && dateStr <= bounds.end;
}

/**
 * The days of [startDate, endDate] split by leave year: one entry per leave-year key the range touches, with the
 * first and last date inside that year. Used to charge a leave to each year's balance.
 */
export function splitRangeByLeaveYear(
  startDate: string,
  endDate: string,
  cfg: LeaveYearConfig,
): { key: number; from: string; to: string }[] {
  const startKey = leaveYearOf(startDate, cfg);
  const endKey = leaveYearOf(endDate, cfg);
  const out: { key: number; from: string; to: string }[] = [];
  for (let key = startKey; key <= endKey; key += 1) {
    const b = leaveYearBounds(key, cfg);
    out.push({
      key,
      from: startDate > b.start ? startDate : b.start,
      to: endDate < b.end ? endDate : b.end,
    });
  }
  return out;
}
