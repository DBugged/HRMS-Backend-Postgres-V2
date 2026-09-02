/**
 * Pure shift-config resolution for AttendanceService.recalculateAttendanceForDay,
 * ported from the old backend's attendanceController.js getOrgDefaultShiftConfig
 * + its per-department field usage. No DB access — the service fetches the
 * Department/Organization rows and passes plain data in.
 */

// A weekly-off entry is either a plain weekday number (0=Sun..6=Sat, off
// every week — the original/common shape, and what every existing
// Department.weeklyOffs row already contains) or an object naming which
// occurrence(s) of that weekday in the month are off (e.g.
// { day: 6, occurrences: [2, 4] } = "2nd and 4th Saturday off, worked on
// the 1st/3rd/5th"). Mixing both shapes in one array is deliberate — most
// days stay the simple "always off" form, only the alternating one(s)
// (usually just Saturday) need the richer form.
export type WeeklyOffEntry = number | { day: number; occurrences: number[] };

export interface ShiftConfig {
  shiftStartTime: string;
  shiftEndTime: string;
  lateInThresholdMinutes: number;
  earlyOutThresholdMinutes: number;
  minHoursForPresent: number;
  minHoursForHalfDay: number;
  weeklyOffs: WeeklyOffEntry[];
  // Subtracted from punch-in-to-punch-out duration before comparing
  // against minHoursForPresent/minHoursForHalfDay — an unpaid lunch break
  // doesn't count as working time. 0 (the schema default) is a no-op.
  breakMinutes: number;
}

// Subset of Department's shift-config columns (all present with schema
// defaults, so a department row always has a full ShiftConfig-shaped set —
// this type exists only to keep the function signature decoupled from the
// Prisma-generated Department type).
export interface DepartmentShiftFields {
  shiftStartTime: string;
  shiftEndTime: string;
  lateInThresholdMinutes: number;
  earlyOutThresholdMinutes: number;
  minHoursForPresent: number;
  minHoursForHalfDay: number;
  weeklyOffs: unknown;
  breakMinutes: number;
}

export interface OrganizationAttendancePrefs {
  defaultShiftStartTime?: string;
  defaultShiftEndTime?: string;
  defaultLateInThresholdMinutes?: number;
  defaultEarlyOutThresholdMinutes?: number;
  defaultMinHoursForPresent?: number;
  defaultMinHoursForHalfDay?: number;
  weekendDays?: number[];
  defaultBreakMinutes?: number;
}

const HARDCODED_FALLBACK: ShiftConfig = {
  shiftStartTime: '09:30',
  shiftEndTime: '18:30',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 8,
  minHoursForHalfDay: 4,
  weeklyOffs: [0],
  breakMinutes: 0,
};

function isWeeklyOffEntry(v: unknown): v is WeeklyOffEntry {
  if (typeof v === 'number') return true;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { day?: unknown }).day === 'number' &&
    Array.isArray((v as { occurrences?: unknown }).occurrences) &&
    (v as { occurrences: unknown[] }).occurrences.every(
      (o) => typeof o === 'number',
    )
  );
}

function asWeeklyOffArray(
  value: unknown,
  fallback: WeeklyOffEntry[],
): WeeklyOffEntry[] {
  return Array.isArray(value) && value.every(isWeeklyOffEntry)
    ? value
    : fallback;
}

// Department fields win when a department is present (they always carry
// schema defaults so they're never truly "unset"); with no department at
// all, falls back field-by-field to the org's attendancePayrollPrefs, then
// to the hardcoded literal if the org prefs are somehow malformed/missing.
export function resolveShiftConfig(
  department: DepartmentShiftFields | null | undefined,
  orgPrefs: OrganizationAttendancePrefs | null | undefined,
): ShiftConfig {
  if (department) {
    return {
      shiftStartTime: department.shiftStartTime,
      shiftEndTime: department.shiftEndTime,
      lateInThresholdMinutes: department.lateInThresholdMinutes,
      earlyOutThresholdMinutes: department.earlyOutThresholdMinutes,
      minHoursForPresent: department.minHoursForPresent,
      minHoursForHalfDay: department.minHoursForHalfDay,
      weeklyOffs: asWeeklyOffArray(
        department.weeklyOffs,
        HARDCODED_FALLBACK.weeklyOffs,
      ),
      breakMinutes: department.breakMinutes,
    };
  }

  return {
    shiftStartTime:
      orgPrefs?.defaultShiftStartTime ?? HARDCODED_FALLBACK.shiftStartTime,
    shiftEndTime:
      orgPrefs?.defaultShiftEndTime ?? HARDCODED_FALLBACK.shiftEndTime,
    lateInThresholdMinutes:
      orgPrefs?.defaultLateInThresholdMinutes ??
      HARDCODED_FALLBACK.lateInThresholdMinutes,
    earlyOutThresholdMinutes:
      orgPrefs?.defaultEarlyOutThresholdMinutes ??
      HARDCODED_FALLBACK.earlyOutThresholdMinutes,
    minHoursForPresent:
      orgPrefs?.defaultMinHoursForPresent ??
      HARDCODED_FALLBACK.minHoursForPresent,
    minHoursForHalfDay:
      orgPrefs?.defaultMinHoursForHalfDay ??
      HARDCODED_FALLBACK.minHoursForHalfDay,
    // Org-level default weekend stays the simple day-list shape — alternate
    // Saturday-style patterns are only configurable per-department (via
    // Work Schedules), not as an org-wide default.
    weeklyOffs: asWeeklyOffArray(
      orgPrefs?.weekendDays,
      HARDCODED_FALLBACK.weeklyOffs,
    ),
    breakMinutes:
      orgPrefs?.defaultBreakMinutes ?? HARDCODED_FALLBACK.breakMinutes,
  };
}

// Which occurrence of its weekday this date is within its month — the 1st,
// 2nd, 3rd, 4th, or (rarely) 5th Saturday, Sunday, etc. Every date-of-month
// 1-7 is the 1st occurrence, 8-14 the 2nd, and so on.
function nthWeekdayOccurrence(date: Date): number {
  return Math.ceil(date.getUTCDate() / 7);
}

// dateStr: YYYY-MM-DD, interpreted as a UTC calendar date (same convention
// as every other plain-string date in this codebase) — weeklyOffs uses
// 0=Sunday..6=Saturday, matching JS's getUTCDay(). A plain number entry
// means that weekday is off every week; an { day, occurrences } entry means
// it's off only on the given occurrence(s) of the month (e.g.
// { day: 6, occurrences: [2, 4] } = 2nd/4th Saturday off, 1st/3rd/5th
// worked).
export function isWeeklyOff(
  dateStr: string,
  weeklyOffs: WeeklyOffEntry[],
): boolean {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const day = date.getUTCDay();
  return weeklyOffs.some((entry) => {
    if (typeof entry === 'number') return entry === day;
    return (
      entry.day === day &&
      entry.occurrences.includes(nthWeekdayOccurrence(date))
    );
  });
}

// Inclusive YYYY-MM-DD range iteration, UTC-based — matches the punch
// recalculation engine's "UTC day boundaries" convention and every other
// plain-string date field in this codebase.
export function enumerateDateStrings(
  startDate: string,
  endDate: string,
): string[] {
  const dates: string[] = [];
  let current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (current.getTime() <= end.getTime()) {
    dates.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}
