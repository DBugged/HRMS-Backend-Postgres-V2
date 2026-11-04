import { AttendanceStatus } from '@prisma/client';
import {
  enumerateDateStrings,
  isWeeklyOff,
  type WeeklyOffEntry,
} from '../attendance/attendance-shift-config';
import {
  resolveDayPay,
  type DatedAttendanceRowLike,
  type LeaveRowWithType,
} from './attendance-summary';

/**
 * Pure helpers that make payroll treat weekly offs and holidays as paid days even when no attendance row was ever
 * created for them, and that keep days before the employee's joining date out of the picture.
 *
 * The daily attendance job writes WEEKLY_OFF/HOLIDAY rows going forward, but a month that was imported, backfilled or
 * simply never had that job running has none. Without them every such day was counted as unpaid (LOP).
 */

export interface SyntheticOffDayRow {
  status: AttendanceStatus;
  isLate: false;
  date: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** First and last calendar day (YYYY-MM-DD) of a payroll month. */
export function monthBounds(
  month: number,
  year: number,
): { from: string; to: string } {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(last)}`,
  };
}

/**
 * The last day a month still running is paid for: yesterday. Today is not over - the person may still punch in - so
 * counting it would show them as unmarked (and unpaid) before the day has even finished. On the 1st of the month it
 * stays the 1st, so a month is never left with no days at all.
 */
export function lastCountedDay(
  today: string,
  month: number,
  year: number,
): string {
  const yesterday = new Date(
    new Date(`${today}T00:00:00.000Z`).getTime() - 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const first = `${year}-${pad(month)}-01`;
  return yesterday < first ? first : yesterday;
}

/**
 * The days of the month the employee counts for. `from` is the joining date when they joined inside the month (else the
 * first of the month); `to` is the last day that has actually happened - the month's end, or `through` (yesterday, see lastCountedDay) while
 * the month is still running. `daysBeforeJoining` is how many days of the month fall before `from` (the whole month
 * when they joined after it ended) and `daysNotElapsed` how many fall after `to`. Neither kind is unpaid leave: they
 * are days the person was not employed yet, or that have not happened yet, so they stay out of LOP and out of the
 * paid weekly offs.
 */
export function employmentWindow(
  joiningDate: Date | string,
  month: number,
  year: number,
  through?: string,
): {
  from: string;
  to: string;
  daysBeforeJoining: number;
  daysNotElapsed: number;
} {
  const { from, to: monthEnd } = monthBounds(month, year);
  const joined =
    typeof joiningDate === 'string'
      ? joiningDate.slice(0, 10)
      : joiningDate.toISOString().slice(0, 10);
  const to = through !== undefined && through < monthEnd ? through : monthEnd;
  const daysNotElapsed =
    to < monthEnd
      ? Number(monthEnd.slice(8, 10)) - Math.max(0, dayOfMonth(to, from))
      : 0;
  if (joined <= from) return { from, to, daysBeforeJoining: 0, daysNotElapsed };
  if (joined > monthEnd) {
    const total = Number(monthEnd.slice(8, 10));
    return { from: joined, to, daysBeforeJoining: total, daysNotElapsed: 0 };
  }
  return {
    from: joined,
    to,
    daysBeforeJoining: Number(joined.slice(8, 10)) - 1,
    daysNotElapsed,
  };
}

// Day of the month (1-31) of `date` when it falls inside the month starting at `monthStart`, 0 when it is before it.
function dayOfMonth(date: string, monthStart: string): number {
  if (date < monthStart) return 0;
  return Number(date.slice(8, 10));
}

export interface OffDayCalendar {
  weeklyOffDates: Set<string>;
  holidayDates: Set<string>;
}

/** Every weekly-off and holiday date inside [from, to]. A day that is both counts as a weekly off. */
export function offDayCalendar(
  from: string,
  to: string,
  weeklyOffs: WeeklyOffEntry[],
  holidayDates: Iterable<string>,
): OffDayCalendar {
  const holidays = new Set(holidayDates);
  const weeklyOffDates = new Set<string>();
  const holidayOnly = new Set<string>();
  if (from > to) return { weeklyOffDates, holidayDates: holidayOnly };
  for (const date of enumerateDateStrings(from, to)) {
    if (isWeeklyOff(date, weeklyOffs)) weeklyOffDates.add(date);
    else if (holidays.has(date)) holidayOnly.add(date);
  }
  return { weeklyOffDates, holidayDates: holidayOnly };
}

/** Rows to add for weekly-off/holiday dates that have no attendance row, so they are paid like any recorded off day. */
export function missingOffDayRows(
  calendar: OffDayCalendar,
  existingDates: Set<string>,
): SyntheticOffDayRow[] {
  const rows: SyntheticOffDayRow[] = [];
  for (const date of calendar.weeklyOffDates) {
    if (!existingDates.has(date)) {
      rows.push({ status: AttendanceStatus.WEEKLY_OFF, isLate: false, date });
    }
  }
  for (const date of calendar.holidayDates) {
    if (!existingDates.has(date)) {
      rows.push({ status: AttendanceStatus.HOLIDAY, isLate: false, date });
    }
  }
  return rows;
}

/**
 * True when the employee has at least one working day in [from, to] but did not work on, or take paid leave on, any of
 * them. Weekly offs and holidays between absences are then not paid: a person who never came in all month is not paid
 * for the Saturdays and Sundays of that month. A window with no working day at all (the first days of a joiner's or a
 * running month falling on a weekend) is not judged.
 */
export function hasNoAttendedDay(
  rows: { status: AttendanceStatus; date: string }[],
  leaves: LeaveRowWithType[],
  calendar: OffDayCalendar,
  from: string,
  to: string,
): boolean {
  if (from > to) return false;
  let workingDays = 0;
  for (const date of enumerateDateStrings(from, to)) {
    if (
      !calendar.weeklyOffDates.has(date) &&
      !calendar.holidayDates.has(date)
    ) {
      workingDays += 1;
    }
  }
  if (workingDays === 0) return false;
  if (
    rows.some(
      (r) =>
        r.status === AttendanceStatus.PRESENT ||
        r.status === AttendanceStatus.HALF_DAY,
    )
  ) {
    return false;
  }
  return !leaves.some(
    (l) =>
      l.endDate >= from &&
      l.startDate <= to &&
      l.leaveType.isPaid &&
      (l.leaveType.salaryImpactPercent ?? 100) > 0,
  );
}

export type LeaveRowWithSandwich = LeaveRowWithType & {
  // The leave type's sandwich rule. When it is off, a weekly off or holiday inside a leave is not a leave day and stays
  // paid; when it is on, those days belong to the leave (unpaid if the leave is unpaid). `sandwich` chooses weekly offs
  // and holidays separately; without it `sandwichApplies` means both.
  sandwichApplies?: boolean;
  sandwich?: { weeklyOffs: boolean; holidays: boolean };
};

// Is this off day part of the leave (its kind is one the leave's sandwich rule takes in)? A day that is both a holiday
// and a weekly off belongs to the leave when either kind does.
function offDayInLeave(
  leave: Pick<LeaveRowWithSandwich, 'sandwichApplies' | 'sandwich'>,
  date: string,
  calendar: OffDayCalendar,
): boolean {
  const kinds = leave.sandwich ?? {
    weeklyOffs: !!leave.sandwichApplies,
    holidays: !!leave.sandwichApplies,
  };
  return (
    (kinds.weeklyOffs && calendar.weeklyOffDates.has(date)) ||
    (kinds.holidays && calendar.holidayDates.has(date))
  );
}

/**
 * Cuts the weekly-off/holiday days a leave's sandwich rule does not take in out of multi-day leaves, so e.g. an unpaid
 * leave from Friday to Monday costs two days, not four. Off days the rule does take in, and half-day leaves, are left
 * exactly as they are. A plain set of dates is treated as off days of both kinds.
 */
export function splitLeavesAroundOffDays<T extends LeaveRowWithSandwich>(
  leaves: T[],
  offDays: Set<string> | OffDayCalendar,
): T[] {
  const calendar: OffDayCalendar =
    offDays instanceof Set
      ? { weeklyOffDates: offDays, holidayDates: offDays }
      : offDays;
  if (calendar.weeklyOffDates.size === 0 && calendar.holidayDates.size === 0) return leaves;
  const isOff = (date: string) =>
    calendar.weeklyOffDates.has(date) || calendar.holidayDates.has(date);
  const out: T[] = [];
  for (const leave of leaves) {
    if (leave.isHalfDay) {
      out.push(leave);
      continue;
    }
    // Walk the leave's dates and emit one leave row per run of days that belong to the leave.
    let runStart = '';
    let runEnd = '';
    for (const date of enumerateDateStrings(leave.startDate, leave.endDate)) {
      if (isOff(date) && !offDayInLeave(leave, date, calendar)) {
        if (runStart !== '') {
          out.push({ ...leave, startDate: runStart, endDate: runEnd });
          runStart = '';
        }
      } else {
        if (runStart === '') runStart = date;
        runEnd = date;
      }
    }
    if (runStart !== '') {
      out.push({ ...leave, startDate: runStart, endDate: runEnd });
    }
  }
  return out;
}

/**
 * Approving a leave writes an ON_LEAVE attendance row for every date in its range, weekends and holidays included, which
 * replaces the WEEKLY_OFF/HOLIDAY row that was there. When the leave's type does not apply the sandwich rule those days
 * are not leave days (splitLeavesAroundOffDays cuts them out), so the ON_LEAVE row is dropped here and the day goes back
 * to being the paid off day it is. Rows on off days a leave's sandwich rule takes in are kept.
 */
export function dropLeaveRowsOnOffDays<
  T extends { status: AttendanceStatus; date: string },
>(
  rows: T[],
  calendar: OffDayCalendar,
  leaves: Pick<LeaveRowWithSandwich, 'startDate' | 'endDate' | 'sandwichApplies' | 'sandwich'>[],
): T[] {
  const sandwiched = new Set<string>();
  for (const leave of leaves) {
    for (const date of enumerateDateStrings(leave.startDate, leave.endDate)) {
      if (offDayInLeave(leave, date, calendar)) sandwiched.add(date);
    }
  }
  return rows.filter(
    (r) =>
      !(
        r.status === AttendanceStatus.ON_LEAVE &&
        (calendar.weeklyOffDates.has(r.date) ||
          calendar.holidayDates.has(r.date)) &&
        !sandwiched.has(r.date)
      ),
  );
}

/**
 * The sandwich rule for absences (Organization Settings > Attendance, orgPayrollAttendancePrefs.absenceSandwich): when
 * the working day just before a run of weekly offs / holidays and the working day just after both pay nothing (absent,
 * unmarked, or unpaid leave), the off days in between of the kinds the company chose are not paid either. Off by
 * default for both kinds.
 */
export interface AbsenceSandwichRule {
  weeklyOffs: boolean;
  holidays: boolean;
}

export function resolveAbsenceSandwich(prefs: unknown): AbsenceSandwichRule {
  const raw = (prefs as { absenceSandwich?: Partial<AbsenceSandwichRule> } | null)
    ?.absenceSandwich;
  return {
    weeklyOffs: raw?.weeklyOffs === true,
    holidays: raw?.holidays === true,
  };
}

/**
 * The off days the absence sandwich rule makes unpaid, inside [from, to]. Only a run whose both neighbours fall inside
 * the window is judged (a neighbour in another month is not known here). A run in which any off day was worked, or is
 * covered by a leave, is left alone: the person came in, or the leave's own sandwich rule decides it.
 */
export function absenceSandwichedDates(
  rows: (DatedAttendanceRowLike & { workDurationMinutes?: number | null; inTime?: Date | null })[],
  leaves: LeaveRowWithType[],
  calendar: OffDayCalendar,
  from: string,
  to: string,
  rule: AbsenceSandwichRule,
): Set<string> {
  const out = new Set<string>();
  if (!rule.weeklyOffs && !rule.holidays) return out;
  const isOff = (d: string) =>
    calendar.weeklyOffDates.has(d) || calendar.holidayDates.has(d);
  const pay = resolveDayPay(rows, leaves, from, to);
  const worked = new Set(
    rows.filter((r) => r.inTime || (r.workDurationMinutes ?? 0) > 0).map((r) => r.date),
  );
  const onLeave = new Set<string>();
  for (const l of leaves) {
    for (const d of enumerateDateStrings(l.startDate, l.endDate)) onLeave.add(d);
  }
  const dates = [...enumerateDateStrings(from, to)];
  let i = 0;
  while (i < dates.length) {
    if (!isOff(dates[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < dates.length && isOff(dates[j + 1])) j += 1;
    const before = i > 0 ? dates[i - 1] : null;
    const after = j + 1 < dates.length ? dates[j + 1] : null;
    const run = dates.slice(i, j + 1);
    if (
      before &&
      after &&
      (pay.get(before) ?? 0) === 0 &&
      (pay.get(after) ?? 0) === 0 &&
      !run.some((d) => worked.has(d) || onLeave.has(d))
    ) {
      for (const d of run) {
        if (
          (rule.weeklyOffs && calendar.weeklyOffDates.has(d)) ||
          (rule.holidays && calendar.holidayDates.has(d))
        ) {
          out.add(d);
        }
      }
    }
    i = j + 1;
  }
  return out;
}
