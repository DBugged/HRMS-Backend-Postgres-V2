// Purpose: The calendar and punch checks a logged overtime record must pass before it can be approved for pay.
// Responsibilities: Pure rules only - the service gathers the day's facts (weekly off, holiday, worked minutes) and asks here.
// Important: The overtime type decides the pay rate, so it must follow the calendar, not the employee's choice; the
//   hours must be backed by time actually worked that day.
import { OvertimeType } from '@prisma/client';

export type DayKind = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY';

export interface OvertimeDayFacts {
  type: OvertimeType;
  date: string;
  /** Today in the organisation's timezone (YYYY-MM-DD). */
  today: string;
  dayKind: DayKind;
  /** Minutes worked that day per attendance; 0 when there is no punch / attendance record. */
  workedMinutes: number;
  hours: number;
  /** Unpaid break to leave out of a day with no regular shift (weekly off / holiday). */
  breakMinutes: number;
}

const EXPECTED_TYPE: Record<DayKind, OvertimeType> = {
  WORKING: OvertimeType.REGULAR,
  WEEKLY_OFF: OvertimeType.WEEKEND,
  HOLIDAY: OvertimeType.HOLIDAY,
};

const DAY_LABEL: Record<DayKind, string> = {
  WORKING: 'a working day',
  WEEKLY_OFF: 'a weekly off',
  HOLIDAY: 'a holiday',
};

/** A message saying why this overtime cannot be logged, or null when it is fine. */
export function overtimeDayProblem(f: OvertimeDayFacts): string | null {
  if (f.date > f.today) {
    return 'Overtime cannot be logged for a date that has not happened yet.';
  }
  const expected = EXPECTED_TYPE[f.dayKind];
  // Night overtime is an ordinary working day's extra hours at a different rate, so it is only valid on one.
  const typeOk =
    f.dayKind === 'WORKING'
      ? f.type === OvertimeType.REGULAR || f.type === OvertimeType.NIGHT
      : f.type === expected;
  if (!typeOk) {
    return `${f.date} is ${DAY_LABEL[f.dayKind]}, so overtime for it must be logged as ${expected.toLowerCase()} overtime, not ${f.type.toLowerCase()}.`;
  }
  if (f.workedMinutes <= 0) {
    return 'There is no attendance (punch) for that day. Get the day regularized first, then log the overtime.';
  }
  const claimable =
    f.dayKind === 'WORKING'
      ? f.workedMinutes
      : Math.max(0, f.workedMinutes - f.breakMinutes);
  // A minute of slack so a rounded hours figure (e.g. 2.5 for 2h29m50s) is not rejected.
  if (f.hours * 60 > claimable + 1) {
    const worked = Math.round((claimable / 60) * 100) / 100;
    return `Only ${worked} hour(s) were worked that day, so ${f.hours} hour(s) of overtime cannot be logged.`;
  }
  return null;
}
