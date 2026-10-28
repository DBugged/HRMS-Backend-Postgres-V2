// Purpose: the numbers behind the day popup in the Attendance Tracker - how long someone worked beyond their shift.
// Responsibilities: pure helper (no database) used by AttendanceService.getDayDetail and its tests.
// Important: this is time worked past the shift length (after the unpaid break), shown beside any overtime that was actually logged and
//   approved; it is information, never a payroll figure - only approved overtime records are paid.
export function extraMinutesBeyondShift(workedMinutes: number, shiftNetMinutes: number): number {
  if (!(workedMinutes > 0) || !(shiftNetMinutes > 0)) return 0;
  return Math.max(0, Math.round(workedMinutes - shiftNetMinutes));
}
