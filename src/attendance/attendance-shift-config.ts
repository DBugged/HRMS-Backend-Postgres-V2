/**
 * Pure shift-config resolution for AttendanceService.recalculateAttendanceForDay,
 * ported from the old backend's attendanceController.js getOrgDefaultShiftConfig
 * + its per-department field usage. No DB access — the service fetches the
 * Department/Organization rows and passes plain data in.
 */

export interface ShiftConfig {
  shiftStartTime: string;
  shiftEndTime: string;
  lateInThresholdMinutes: number;
  earlyOutThresholdMinutes: number;
  minHoursForPresent: number;
  minHoursForHalfDay: number;
  weeklyOffs: number[];
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
}

export interface OrganizationAttendancePrefs {
  defaultShiftStartTime?: string;
  defaultShiftEndTime?: string;
  defaultLateInThresholdMinutes?: number;
  defaultEarlyOutThresholdMinutes?: number;
  defaultMinHoursForPresent?: number;
  defaultMinHoursForHalfDay?: number;
  weekendDays?: number[];
}

const HARDCODED_FALLBACK: ShiftConfig = {
  shiftStartTime: '09:30',
  shiftEndTime: '18:30',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 8,
  minHoursForHalfDay: 4,
  weeklyOffs: [0],
};

function asIntArray(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number')
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
      weeklyOffs: asIntArray(
        department.weeklyOffs,
        HARDCODED_FALLBACK.weeklyOffs,
      ),
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
    weeklyOffs: asIntArray(
      orgPrefs?.weekendDays,
      HARDCODED_FALLBACK.weeklyOffs,
    ),
  };
}

// dateStr: YYYY-MM-DD, interpreted as a UTC calendar date (same convention
// as every other plain-string date in this codebase) — weeklyOffs uses
// 0=Sunday..6=Saturday, matching JS's getUTCDay().
export function isWeeklyOff(dateStr: string, weeklyOffs: number[]): boolean {
  const day = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
  return weeklyOffs.includes(day);
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
