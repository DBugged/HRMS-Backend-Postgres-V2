// Purpose: how many days of a leave fall inside a window (a month, a leave year) - counted the way the leave itself was charged.
// Responsibilities: pure rules, no database. A leave wholly inside the window is its stored charged days (the same number the
//   balance, the reports and the application screen show); a leave that runs across the window's edge is re-counted for just the
//   window's dates with the leave type's own sandwich rule, so holidays and weekly offs inside it are charged only if the type says so.
// Important: replaces counting every calendar day between the two dates, which charged holidays and weekly offs even when the
//   sandwich rule is off (9-12 Nov with 10 and 11 holidays is 2 days, not 4).
import type { WeeklyOffEntry } from '../attendance/attendance-shift-config';
import { countChargedDaysInclusive, type SandwichKinds } from './leave-rules';

export interface WindowLeave {
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  /** What the leave was charged when it was applied for or recorded. */
  totalDays?: number | null;
}

export interface WindowRules {
  holidayDates: Set<string>;
  weeklyOffs: WeeklyOffEntry[];
  kinds: SandwichKinds;
}

/** True when the leave's days cannot be read straight from its stored charge for this window (it crosses an edge). */
export function crossesWindow(
  leave: WindowLeave,
  from: string,
  to: string,
): boolean {
  return !leave.isHalfDay && (leave.startDate < from || leave.endDate > to);
}

/**
 * Days of `leave` that fall in [from, to] (inclusive, YYYY-MM-DD). `rules` is read only when the leave crosses the window's edge.
 */
export function chargedDaysInWindow(
  leave: WindowLeave,
  from: string,
  to: string,
  rules: () => WindowRules,
): number {
  if (leave.isHalfDay) {
    return leave.startDate >= from && leave.startDate <= to ? 0.5 : 0;
  }
  if (leave.endDate < from || leave.startDate > to) return 0;
  if (!crossesWindow(leave, from, to) && leave.totalDays != null) {
    return leave.totalDays;
  }
  const lo = leave.startDate > from ? leave.startDate : from;
  const hi = leave.endDate < to ? leave.endDate : to;
  const r = rules();
  return countChargedDaysInclusive(
    lo,
    hi,
    r.holidayDates,
    r.weeklyOffs,
    r.kinds,
  );
}
