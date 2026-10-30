// Purpose: the pure rules of the pre-shift "mark your attendance" reminder, the pre-end "remember to check out" one and the
//   after-end "you are still checked in" one.
// Responsibilities: reads the Admin's settings (orgPayrollAttendancePrefs.checkInReminder / checkOutReminder), and decides from clock times
//   whether a shift is at its reminder moment.
// Important: the job runs every STEP_MINUTES, so a reminder "N minutes before" fires on the run where the shift is
//   between N-STEP (exclusive) and N (inclusive) minutes away - exactly one run per shift, with no clock-second luck.
export const REMINDER_STEP_MINUTES = 5;

export interface CheckInReminderSettings {
  enabled: boolean;
  minutesBefore: number;
}

export const DEFAULT_CHECK_IN_REMINDER: CheckInReminderSettings = {
  enabled: true,
  minutesBefore: 15,
};

function resolveReminder(
  prefs: unknown,
  key: 'checkInReminder' | 'checkOutReminder',
): CheckInReminderSettings {
  const raw = (
    prefs as Record<string, Record<string, unknown> | undefined> | null
  )?.[key];
  const minutes =
    typeof raw?.minutesBefore === 'number' && Number.isFinite(raw.minutesBefore)
      ? Math.round(raw.minutesBefore)
      : DEFAULT_CHECK_IN_REMINDER.minutesBefore;
  return {
    enabled:
      typeof raw?.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_CHECK_IN_REMINDER.enabled,
    minutesBefore: Math.min(120, Math.max(5, minutes)),
  };
}

// Before the shift starts: "mark your attendance".
export const resolveCheckInReminder = (prefs: unknown) =>
  resolveReminder(prefs, 'checkInReminder');

// Before the shift ends: "remember to check out". Same shape and defaults as the check-in reminder.
export const resolveCheckOutReminder = (prefs: unknown) =>
  resolveReminder(prefs, 'checkOutReminder');

// After the shift has ended and the person is still checked in: "your shift ended, check out (or ask for overtime)".
// On by default, 30 minutes after the end. Stored as orgPayrollAttendancePrefs.stillCheckedInReminder.
export interface StillCheckedInReminderSettings {
  enabled: boolean;
  minutesAfter: number;
}

export const DEFAULT_STILL_CHECKED_IN_REMINDER: StillCheckedInReminderSettings =
  { enabled: true, minutesAfter: 30 };

export function resolveStillCheckedInReminder(
  prefs: unknown,
): StillCheckedInReminderSettings {
  const raw = (
    prefs as Record<string, Record<string, unknown> | undefined> | null
  )?.stillCheckedInReminder;
  const minutes =
    typeof raw?.minutesAfter === 'number' && Number.isFinite(raw.minutesAfter)
      ? Math.round(raw.minutesAfter)
      : DEFAULT_STILL_CHECKED_IN_REMINDER.minutesAfter;
  return {
    enabled:
      typeof raw?.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_STILL_CHECKED_IN_REMINDER.enabled,
    minutesAfter: Math.min(240, Math.max(5, minutes)),
  };
}

// Is this run the one N minutes after the shift ended? Counted round the clock, so a shift ending at 23:45 is reminded
// at 00:15. Same one-run-per-shift window as isReminderMoment.
export function isAfterEndMoment(
  shiftEndMinutes: number,
  nowMinutes: number,
  minutesAfter: number,
  step = REMINDER_STEP_MINUTES,
): boolean {
  const since = (nowMinutes - shiftEndMinutes + 24 * 60) % (24 * 60);
  return since > minutesAfter - step && since <= minutesAfter;
}

// 'HH:mm' -> minutes after midnight, or null when it is not a time.
export function minutesOfDay(hhmm: string | null | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isReminderMoment(
  shiftStartMinutes: number,
  nowMinutes: number,
  minutesBefore: number,
  step = REMINDER_STEP_MINUTES,
): boolean {
  const away = shiftStartMinutes - nowMinutes;
  return away > minutesBefore - step && away <= minutesBefore;
}

// 'HH:mm' -> "9:30 AM" / "09:30", following the organization's 12 / 24 hour choice.
export function shiftTimeLabel(hhmm: string, hour12: boolean): string {
  const total = minutesOfDay(hhmm);
  if (total === null) return hhmm;
  const h = Math.floor(total / 60);
  const mm = String(total % 60).padStart(2, '0');
  if (!hour12) return `${String(h).padStart(2, '0')}:${mm}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}
