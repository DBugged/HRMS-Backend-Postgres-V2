import { AttendanceStatus } from '@prisma/client';
import {
  enumerateDateStrings,
  isWeeklyOff,
  type WeeklyOffEntry,
} from '../attendance/attendance-shift-config';
import type { LeaveRowWithType } from './attendance-summary';

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
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

/**
 * The first day of the month the employee counts for: the joining date when they joined inside the month, the first
 * of the month otherwise. `daysBeforeJoining` is how many days of the month fall before that (the whole month when
 * they joined after it ended). Those days are not unpaid leave, just days the person was not employed.
 */
export function employmentWindow(
  joiningDate: Date | string,
  month: number,
  year: number,
): { from: string; to: string; daysBeforeJoining: number } {
  const { from, to } = monthBounds(month, year);
  const joined =
    typeof joiningDate === 'string'
      ? joiningDate.slice(0, 10)
      : joiningDate.toISOString().slice(0, 10);
  if (joined <= from) return { from, to, daysBeforeJoining: 0 };
  if (joined > to) {
    const total = Number(to.slice(8, 10));
    return { from: joined, to, daysBeforeJoining: total };
  }
  return { from: joined, to, daysBeforeJoining: Number(joined.slice(8, 10)) - 1 };
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

export type LeaveRowWithSandwich = LeaveRowWithType & {
  // The leave type's "sandwich leave applies" rule. When it is off, a weekly off or holiday inside a leave is not a
  // leave day and stays paid; when it is on, those days belong to the leave (unpaid if the leave is unpaid).
  sandwichApplies?: boolean;
};

/**
 * Cuts weekly-off/holiday days out of multi-day leaves whose type does not apply the sandwich rule, so e.g. an unpaid
 * leave from Friday to Monday costs two days, not four. Leaves of types that do apply it, and half-day leaves, are
 * left exactly as they are.
 */
export function splitLeavesAroundOffDays<T extends LeaveRowWithSandwich>(
  leaves: T[],
  offDates: Set<string>,
): T[] {
  if (offDates.size === 0) return leaves;
  const out: T[] = [];
  for (const leave of leaves) {
    if (leave.isHalfDay || leave.sandwichApplies) {
      out.push(leave);
      continue;
    }
    // Walk the leave's dates and emit one leave row per run of consecutive non-off days.
    let runStart = '';
    let runEnd = '';
    for (const date of enumerateDateStrings(leave.startDate, leave.endDate)) {
      if (offDates.has(date)) {
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
