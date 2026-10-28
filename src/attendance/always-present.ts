// Purpose: the rule for employees who are marked present on every working day without punching.
// Responsibilities: pure decisions (no database) - whether the rule applies to a calculated day, and the shift-timed day it produces.
// Important: it only turns a day that would be Absent, Half day or Incomplete into Present. A day of approved leave stays leave (their leave
//   balance and pay follow the normal leave rules); weekly offs and holidays are left as the schedule says. Real punches are kept (their times stay); with none, the day shows the person's own shift start and end.
import { AttendanceStatus } from '@prisma/client';

const OVERRIDDEN: AttendanceStatus[] = [AttendanceStatus.ABSENT, AttendanceStatus.HALF_DAY, AttendanceStatus.INCOMPLETE];

/** True when the day should be written as Present: the person is marked, the day is on or after the effective date, and it was not already Present, On leave, Holiday or Weekly off. */
export function alwaysPresentApplies(
  person: { alwaysPresent: boolean; alwaysPresentFrom: string | null },
  dateStr: string,
  status: AttendanceStatus,
): boolean {
  return person.alwaysPresent && (!person.alwaysPresentFrom || dateStr >= person.alwaysPresentFrom) && OVERRIDDEN.includes(status);
}

/** Minutes between the shift start and end (across midnight when the shift does), less the unpaid break; never negative. */
export function shiftMinutes(startHhmm: string, endHhmm: string, crossesMidnight: boolean, breakMinutes: number): number {
  const m = (t: string) => {
    const [h, mm] = t.split(':').map(Number);
    return (h || 0) * 60 + (mm || 0);
  };
  let span = m(endHhmm) - m(startHhmm);
  if (span <= 0 && crossesMidnight) span += 24 * 60;
  return Math.max(0, span - (breakMinutes || 0));
}
