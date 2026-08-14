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
}

export interface AttendanceSummary {
  totalDaysInMonth: number;
  workingDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  halfDays: number;
  overtimeHours: number;
  lateMarks: number;
  holidayWorkDays: number;
  weekendWorkDays: number;
  holidays: number;
  weeklyOffs: number;
  lopDays: number;
  payableDays: number;
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
  const payableDays =
    presentDays + halfDays * 0.5 + holidays + weeklyOffs + paidLeaveDays;
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
    lateMarks,
    holidayWorkDays,
    weekendWorkDays,
    holidays,
    weeklyOffs,
    lopDays,
    payableDays,
  };
}
