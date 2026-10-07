import { AttendanceStatus, OvertimeType } from '@prisma/client';
import { clampLeaveDaysToMonth, daysInMonth } from './payroll-date-math';

/**
 * Pure port of the old backend's payrollEngine.js computeAttendanceSummary
 * — derives the attendance summary an employee is paid against for one
 * month. Takes pre-fetched plain rows; all DB access stays in the caller
 * (PayrollService).
 *
 * Deliberate simplification vs. the old system: the old controller had a
 * legacy fallback for pre-migration Leave rows with no LeaveType link
 * (`leave.leaveType === 'LWP'` string check). backend-v2's Leave.leaveTypeId
 * is a required FK — every row always has a LeaveType — so that branch is
 * unreachable here and has been dropped rather than ported as dead code.
 */

export interface AttendanceRowLike {
  status: AttendanceStatus;
  isLate: boolean;
  // YYYY-MM-DD. When every row carries it, payable days are resolved per calendar day so a day can never be
  // paid twice (attendance row + approved leave) — see resolveDayPay. Rows without it fall back to the plain sum.
  date?: string;
}

export interface LeaveRowWithType {
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  leaveType: {
    isPaid: boolean;
    salaryImpactPercent: number;
  };
}

export interface OvertimeRowLike {
  hours: number;
  type: OvertimeType;
  // Fixed per record at log time from its type (see OvertimeService). A row
  // without one counts at 1x.
  rateMultiplier?: number;
}

export interface AttendanceSummary {
  totalDaysInMonth: number;
  workingDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  halfDays: number;
  overtimeHours: number;
  // Σ hours × rateMultiplier over the approved overtime — the OT_WEIGHTED_HOURS formula variable. rateMultiplier
  // was stored on every OvertimeRecord but never read, so holiday/weekend OT was paid at the regular rate.
  overtimeWeightedHours: number;
  lateMarks: number;
  holidayWorkDays: number;
  weekendWorkDays: number;
  holidays: number;
  weeklyOffs: number;
  lopDays: number;
  payableDays: number;
  // Days this month still marked INCOMPLETE (punch-in with no punch-out) —
  // paid as LOP exactly like ABSENT until regularized (same as before this
  // status existed), but called out separately so payroll can warn HR
  // instead of silently paying out a day that's still pending resolution.
  incompleteDays: number;
}

export function computeAttendanceSummary(
  attendanceRows: AttendanceRowLike[],
  leaveRows: LeaveRowWithType[],
  overtimeRows: OvertimeRowLike[],
  month: number,
  year: number,
): AttendanceSummary {
  const totalDaysInMonth = daysInMonth(month, year);

  const counts: Record<AttendanceStatus, number> = {
    [AttendanceStatus.PRESENT]: 0,
    [AttendanceStatus.HALF_DAY]: 0,
    [AttendanceStatus.ON_LEAVE]: 0,
    [AttendanceStatus.HOLIDAY]: 0,
    [AttendanceStatus.WEEKLY_OFF]: 0,
    [AttendanceStatus.ABSENT]: 0,
    [AttendanceStatus.INCOMPLETE]: 0,
  };
  let lateMarks = 0;
  for (const row of attendanceRows) {
    counts[row.status] += 1;
    if (row.isLate) lateMarks += 1;
  }

  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  for (const leave of leaveRows) {
    const days = clampLeaveDaysToMonth(leave, month, year);
    if (!leave.leaveType.isPaid) {
      unpaidLeaveDays += days;
      continue;
    }
    const pct = (leave.leaveType.salaryImpactPercent ?? 100) / 100;
    paidLeaveDays += days * pct;
    unpaidLeaveDays += days * (1 - pct);
  }

  const overtimeHours = overtimeRows.reduce((s, o) => s + o.hours, 0);
  const overtimeWeightedHours = overtimeRows.reduce(
    (s, o) => s + o.hours * (o.rateMultiplier ?? 1),
    0,
  );
  const holidayWorkDays = overtimeRows.filter(
    (o) => o.type === OvertimeType.HOLIDAY,
  ).length;
  const weekendWorkDays = overtimeRows.filter(
    (o) => o.type === OvertimeType.WEEKEND,
  ).length;

  const presentDays = counts[AttendanceStatus.PRESENT];
  const halfDays = counts[AttendanceStatus.HALF_DAY];
  const holidays = counts[AttendanceStatus.HOLIDAY];
  const weeklyOffs = counts[AttendanceStatus.WEEKLY_OFF];
  const incompleteDays = counts[AttendanceStatus.INCOMPLETE];
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const dated =
    attendanceRows.length > 0 && attendanceRows.every((r) => r.date);
  let payableDays: number;
  if (dated || attendanceRows.length === 0) {
    // Per-day resolution: an attendance row and an approved leave on the same date are ONE day, and the
    // total can never exceed the calendar days of the month.
    payableDays = Math.min(
      totalDaysInMonth,
      sumDayPay(
        attendanceRows as DatedAttendanceRowLike[],
        leaveRows,
        `${monthPrefix}-01`,
        `${monthPrefix}-${String(totalDaysInMonth).padStart(2, '0')}`,
      ),
    );
  } else {
    payableDays = Math.min(
      totalDaysInMonth,
      presentDays + halfDays * 0.5 + holidays + weeklyOffs + paidLeaveDays,
    );
  }
  const lopDays = Math.max(0, totalDaysInMonth - payableDays - unpaidLeaveDays);
  const workingDays = totalDaysInMonth - holidays - weeklyOffs;

  return {
    totalDaysInMonth,
    workingDays,
    presentDays,
    paidLeaveDays,
    unpaidLeaveDays,
    halfDays,
    overtimeHours,
    overtimeWeightedHours,
    lateMarks,
    holidayWorkDays,
    weekendWorkDays,
    holidays,
    weeklyOffs,
    lopDays,
    payableDays,
    incompleteDays,
  };
}

export interface DatedAttendanceRowLike {
  date: string;
  status: AttendanceStatus;
}

const rowPay = (status: AttendanceStatus): number =>
  status === AttendanceStatus.PRESENT ||
  status === AttendanceStatus.HOLIDAY ||
  status === AttendanceStatus.WEEKLY_OFF
    ? 1
    : status === AttendanceStatus.HALF_DAY
      ? 0.5
      : 0;

function* datesBetween(from: string, to: string): Generator<string> {
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  for (
    let t = new Date(`${from}T00:00:00.000Z`).getTime();
    t <= end;
    t += 86400000
  ) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

/**
 * Pay fraction (0..1) of every calendar day in [from, to] (one YYYY-MM-DD window): the attendance row's pay plus
 * the paid share of any approved leave on that date, capped at one day, and reduced by the unpaid share of leave on
 * it. A day is one day however many rows/leaves touch it — the old plain sum paid a day twice when a punch (or an
 * import) re-marked an approved-leave day as PRESENT, and could pay more days than the month has.
 */
export function resolveDayPay(
  attendanceRows: DatedAttendanceRowLike[],
  leaveRows: LeaveRowWithType[],
  from: string,
  to: string,
): Map<string, number> {
  const rowByDate = new Map<string, number>();
  for (const r of attendanceRows) {
    if (r.date < from || r.date > to) continue;
    // Duplicate rows for one date must not add up.
    rowByDate.set(
      r.date,
      Math.max(rowByDate.get(r.date) ?? 0, rowPay(r.status)),
    );
  }
  const paid = new Map<string, number>();
  const unpaid = new Map<string, number>();
  for (const leave of leaveRows) {
    const lo = leave.startDate > from ? leave.startDate : from;
    const hi = leave.endDate < to ? leave.endDate : to;
    if (lo > hi) continue;
    const perDay = leave.isHalfDay ? 0.5 : 1;
    const pct = leave.leaveType.isPaid
      ? (leave.leaveType.salaryImpactPercent ?? 100) / 100
      : 0;
    for (const d of datesBetween(lo, hi)) {
      paid.set(d, Math.min(1, (paid.get(d) ?? 0) + perDay * pct));
      unpaid.set(d, Math.min(1, (unpaid.get(d) ?? 0) + perDay * (1 - pct)));
    }
  }
  const out = new Map<string, number>();
  for (const d of new Set([...rowByDate.keys(), ...paid.keys()])) {
    const u = Math.min(1, unpaid.get(d) ?? 0);
    const pay = Math.min(1 - u, (rowByDate.get(d) ?? 0) + (paid.get(d) ?? 0));
    out.set(d, Math.max(0, pay));
  }
  return out;
}

function sumDayPay(
  attendanceRows: DatedAttendanceRowLike[],
  leaveRows: LeaveRowWithType[],
  from: string,
  to: string,
): number {
  let total = 0;
  for (const v of resolveDayPay(attendanceRows, leaveRows, from, to).values())
    total += v;
  return total;
}

/**
 * Payable days within [from, to] — one YYYY-MM-DD range inside a single payroll month, using the same per-day
 * resolution as the month summary. Used to prorate each segment of a month split at a mid-month salary revision;
 * summed over a partition of the month it equals the month's payableDays.
 */
export function payableDaysInRange(
  attendanceRows: DatedAttendanceRowLike[],
  leaveRows: LeaveRowWithType[],
  from: string,
  to: string,
): number {
  return sumDayPay(attendanceRows, leaveRows, from, to);
}
