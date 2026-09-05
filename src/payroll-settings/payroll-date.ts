import {
  isWeeklyOff,
  WeeklyOffEntry,
} from '../attendance/attendance-shift-config';

/**
 * Resolves PayrollSettings.processingDay/paymentDay (0 = last working day
 * of the month, 1-31 = a fixed calendar day clamped to month length) into
 * an actual YYYY-MM-DD date for a given year/month. Self-contained pure
 * function — does not depend on the old system's payrollEngine.js
 * (getLastWorkingDayOfMonth/resolvePayrollDate), which isn't ported yet
 * (Payroll core, a later batch).
 */
export function resolveDayOfMonth(
  day: number,
  year: number,
  month: number,
  // The org's actual weekly-offs (org-wide default — there's no single
  // department to resolve this against at the org-settings level) rather
  // than assuming every org's weekend is Saturday+Sunday. Defaults to that
  // same Sat+Sun pair only when the caller has nothing more specific.
  weeklyOffs: WeeklyOffEntry[] = [0, 6],
): string {
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (day === 0) {
    const date = new Date(Date.UTC(year, month - 1, lastDayOfMonth));
    while (isWeeklyOff(date.toISOString().slice(0, 10), weeklyOffs)) {
      date.setUTCDate(date.getUTCDate() - 1);
    }
    return date.toISOString().slice(0, 10);
  }

  const clampedDay = Math.min(Math.max(day, 1), lastDayOfMonth);
  return new Date(Date.UTC(year, month - 1, clampedDay))
    .toISOString()
    .slice(0, 10);
}
