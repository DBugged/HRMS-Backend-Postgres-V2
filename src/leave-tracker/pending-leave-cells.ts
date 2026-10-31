// Purpose: how a leave that is still waiting for approval appears in the Attendance Tracker grid.
// Rule: a day covered by a pending leave reads as leave (the person has asked for it, so it is not an absence) when it
//   would otherwise be Absent or blank, and is marked pending so clients can tell it from approved leave. A day worked,
//   a half day, a weekly off, a holiday or an already-approved leave is left exactly as it is.
export type PendingLeaveKind = 'ON_LEAVE' | 'COMP_OFF' | 'LWP';

export interface PendingLeaveInput {
  employeeId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  kind: PendingLeaveKind;
}

/**
 * Writes the leave code into `cells` for each qualifying day and returns which days were marked pending
 * (employee id -> day number -> true). `onBooks` says whether the person is employed on that date.
 */
export function markPendingLeave(
  cells: Record<string, Record<number, string>>,
  leaves: PendingLeaveInput[],
  days: { day: number; dateStr: string }[],
  onBooks: (employeeId: string, date: string) => boolean,
): Record<string, Record<number, true>> {
  const pending: Record<string, Record<number, true>> = {};
  for (const leave of leaves) {
    for (const d of days) {
      if (d.dateStr < leave.startDate || d.dateStr > leave.endDate) continue;
      if (!onBooks(leave.employeeId, d.dateStr)) continue;
      const current = cells[leave.employeeId]?.[d.day];
      if (current !== undefined && current !== 'ABSENT') continue;
      (cells[leave.employeeId] ??= {})[d.day] = leave.kind;
      (pending[leave.employeeId] ??= {})[d.day] = true;
    }
  }
  return pending;
}
