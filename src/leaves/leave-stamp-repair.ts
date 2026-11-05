// Purpose: works out which attendance days an already-approved leave wrongly marked as On Leave, so they can be put back.
// Responsibilities: pure rules, no database. Until now, approving a leave marked EVERY date in its range as On Leave, including a
//   holiday or weekly off that the leave type's sandwich rule leaves out (9-12 Nov with 10 and 11 holidays showed four days of
//   leave). New approvals mark only the charged days; this finds the days older approvals marked by mistake.
// Important: only rows the leave integration wrote (On Leave, source SYSTEM) are candidates. A day another approved leave still
//   charges is left alone. Each fix mirrors cancelling a leave: the day goes back to what it was before the leave stamped it,
//   or the row is removed when the leave itself created it (it then reads from the holiday / weekly-off calendar).
import type { WeeklyOffEntry } from '../attendance/attendance-shift-config';
import { chargedDatesInclusive, type SandwichKinds } from './leave-rules';

export interface RepairLeave {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  /** What the leave type's sandwich rule charges (see chargedKindsOf). */
  kinds: SandwichKinds;
  /** What the leave was charged when it was approved. A leave charged more than today's rule would charge is left alone. */
  totalDays?: number | null;
}

export interface RepairCalendar {
  holidayDates: Set<string>;
  weeklyOffs: WeeklyOffEntry[];
}

export interface RepairRow {
  id: string;
  employeeId: string;
  date: string;
  status: string;
  source: string;
  leaveOverriddenStatus: string | null;
  leaveOverriddenSource: string | null;
}

export interface RepairAction {
  rowId: string;
  employeeId: string;
  date: string;
  leaveId: string;
  /** RESTORE = back to the status it had before the leave; DELETE = the leave created the row, so it goes. */
  action: 'RESTORE' | 'DELETE';
  restoreStatus: string | null;
  restoreSource: string | null;
}

export function planStampRepair(
  leaves: RepairLeave[],
  calendarOf: (employeeId: string) => RepairCalendar,
  rows: RepairRow[],
): RepairAction[] {
  // Per leave: the dates it is charged for, and the dates in its range it is not.
  const charged = new Map<string, Set<string>>();
  const unchargedOf = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (l.isHalfDay) {
      charged.set(l.id, new Set([l.startDate]));
      continue;
    }
    const cal = calendarOf(l.employeeId);
    const dates = chargedDatesInclusive(
      l.startDate,
      l.endDate,
      cal.holidayDates,
      cal.weeklyOffs,
      l.kinds,
    );
    // The leave was charged for a different number of days than today's rule gives (for example the rule was switched off after it
    // was approved on a sandwich-on basis): its days were charged, so nothing is marked wrongly - leave it exactly as it is.
    if (l.totalDays != null && Math.abs(l.totalDays - dates.length) > 0.001) {
      charged.set(
        l.id,
        new Set(
          chargedDatesInclusive(l.startDate, l.endDate, new Set(), [], {
            weeklyOffs: true,
            holidays: true,
          }),
        ),
      );
      continue;
    }
    const set = new Set(dates);
    charged.set(l.id, set);
    const all = chargedDatesInclusive(l.startDate, l.endDate, new Set(), [], {
      weeklyOffs: true,
      holidays: true,
    });
    unchargedOf.set(l.id, new Set(all.filter((d) => !set.has(d))));
  }
  const byEmployee = new Map<string, RepairLeave[]>();
  for (const l of leaves)
    byEmployee.set(l.employeeId, [...(byEmployee.get(l.employeeId) ?? []), l]);

  const actions: RepairAction[] = [];
  for (const row of rows) {
    if (row.status !== 'ON_LEAVE' || row.source !== 'SYSTEM') continue;
    const mine = byEmployee.get(row.employeeId) ?? [];
    const covering = mine.filter(
      (l) => l.startDate <= row.date && l.endDate >= row.date,
    );
    if (covering.length === 0) continue;
    // Wrongly marked only if EVERY leave covering the day leaves it out; one that still charges it keeps the mark.
    if (covering.some((l) => charged.get(l.id)?.has(row.date))) continue;
    const leave = covering.find((l) => unchargedOf.get(l.id)?.has(row.date));
    if (!leave) continue;
    actions.push({
      rowId: row.id,
      employeeId: row.employeeId,
      date: row.date,
      leaveId: leave.id,
      action: row.leaveOverriddenStatus ? 'RESTORE' : 'DELETE',
      restoreStatus: row.leaveOverriddenStatus,
      restoreSource: row.leaveOverriddenSource,
    });
  }
  return actions;
}
