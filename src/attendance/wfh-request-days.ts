// Purpose: Which days of a multi-day Work From Home request are actually requested.
// Responsibilities: pure date logic, no database - the service feeds it the employee's weekly offs, holidays and leave.
// Important: weekly offs, holidays and full-day leave are left out (there is no working day to work from home on), and
//   each left-out day is reported with its reason so the person sees why; the range itself is capped.

export const MAX_WFH_RANGE_DAYS = 31;

export type WfhSkipReason =
  | 'WEEKLY_OFF'
  | 'HOLIDAY'
  | 'LEAVE'
  // Set by the service: that day already has a pending or approved Work From Home request.
  | 'ALREADY_REQUESTED';

export interface WfhRequestDays {
  /** The working days that will be requested, in date order (YYYY-MM-DD). */
  days: string[];
  /** Days inside the range that were left out, with why. */
  skipped: { date: string; reason: WfhSkipReason }[];
}

const DAY_MS = 86_400_000;

function utcMs(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getTime();
}

/** Calendar days from `from` to `to` inclusive (0 when to < from). */
export function calendarSpan(from: string, to: string): number {
  if (to < from) return 0;
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS) + 1;
}

export function wfhRequestDays(input: {
  from: string;
  to: string;
  /** Whether a date (YYYY-MM-DD) is the employee's weekly off (the shift config can say "2nd Saturday"). */
  isWeeklyOff: (date: string) => boolean;
  holidayDates: Set<string>;
  /** Dates already covered by a full-day leave. */
  leaveDates: Set<string>;
}): WfhRequestDays {
  const days: string[] = [];
  const skipped: WfhRequestDays['skipped'] = [];
  const span = calendarSpan(input.from, input.to);
  for (let i = 0; i < span; i += 1) {
    const d = new Date(utcMs(input.from) + i * DAY_MS);
    const date = d.toISOString().slice(0, 10);
    if (input.isWeeklyOff(date)) {
      skipped.push({ date, reason: 'WEEKLY_OFF' });
    } else if (input.holidayDates.has(date)) {
      skipped.push({ date, reason: 'HOLIDAY' });
    } else if (input.leaveDates.has(date)) {
      skipped.push({ date, reason: 'LEAVE' });
    } else {
      days.push(date);
    }
  }
  return { days, skipped };
}
