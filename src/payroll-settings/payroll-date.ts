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
): string {
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (day === 0) {
    const date = new Date(Date.UTC(year, month - 1, lastDayOfMonth));
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
      date.setUTCDate(date.getUTCDate() - 1);
    }
    return date.toISOString().slice(0, 10);
  }

  const clampedDay = Math.min(Math.max(day, 1), lastDayOfMonth);
  return new Date(Date.UTC(year, month - 1, clampedDay))
    .toISOString()
    .slice(0, 10);
}
