import { AttendanceStatus, OvertimeType } from '@prisma/client';
import { computeAttendanceSummary } from './attendance-summary';

function attendanceRow(status: AttendanceStatus, isLate = false) {
  return { status, isLate };
}

describe('computeAttendanceSummary', () => {
  it('tallies attendance status counts and late marks', () => {
    const rows = [
      attendanceRow(AttendanceStatus.PRESENT),
      attendanceRow(AttendanceStatus.PRESENT, true),
      attendanceRow(AttendanceStatus.HALF_DAY),
      attendanceRow(AttendanceStatus.HOLIDAY),
      attendanceRow(AttendanceStatus.WEEKLY_OFF),
      attendanceRow(AttendanceStatus.ABSENT),
    ];
    const result = computeAttendanceSummary(rows, [], [], 4, 2026);
    expect(result.presentDays).toBe(2);
    expect(result.halfDays).toBe(1);
    expect(result.holidays).toBe(1);
    expect(result.weeklyOffs).toBe(1);
    expect(result.lateMarks).toBe(1);
    expect(result.totalDaysInMonth).toBe(30);
  });

  it('splits leave days into paid/unpaid via salaryImpactPercent', () => {
    const leaveRows = [
      {
        startDate: '2026-04-10',
        endDate: '2026-04-12',
        isHalfDay: false,
        leaveType: { isPaid: true, salaryImpactPercent: 50 },
      },
    ];
    const result = computeAttendanceSummary([], leaveRows, [], 4, 2026);
    // 3 days total, 50% salary impact -> half paid, half unpaid.
    expect(result.paidLeaveDays).toBe(1.5);
    expect(result.unpaidLeaveDays).toBe(1.5);
  });

  it('an unpaid leave type contributes entirely to unpaidLeaveDays', () => {
    const leaveRows = [
      {
        startDate: '2026-04-10',
        endDate: '2026-04-11',
        isHalfDay: false,
        leaveType: { isPaid: false, salaryImpactPercent: 100 },
      },
    ];
    const result = computeAttendanceSummary([], leaveRows, [], 4, 2026);
    expect(result.paidLeaveDays).toBe(0);
    expect(result.unpaidLeaveDays).toBe(2);
  });

  it('sums overtime hours and counts holiday/weekend work days by type', () => {
    const overtimeRows = [
      { hours: 2, type: OvertimeType.REGULAR },
      { hours: 3, type: OvertimeType.HOLIDAY },
      { hours: 4, type: OvertimeType.WEEKEND },
    ];
    const result = computeAttendanceSummary([], [], overtimeRows, 4, 2026);
    expect(result.overtimeHours).toBe(9);
    expect(result.holidayWorkDays).toBe(1);
    expect(result.weekendWorkDays).toBe(1);
  });

  it('derives payableDays, lopDays, and workingDays correctly', () => {
    const rows = Array.from({ length: 20 }, () =>
      attendanceRow(AttendanceStatus.PRESENT),
    );
    // 30-day April: 20 present, 4 weekly offs, 1 holiday, 5 absent (no
    // leave) -> payableDays = 20 + 0 + 1 + 4 = 25, lopDays = max(0, 30-25-0) = 5.
    rows.push(
      attendanceRow(AttendanceStatus.WEEKLY_OFF),
      attendanceRow(AttendanceStatus.WEEKLY_OFF),
      attendanceRow(AttendanceStatus.WEEKLY_OFF),
      attendanceRow(AttendanceStatus.WEEKLY_OFF),
      attendanceRow(AttendanceStatus.HOLIDAY),
    );
    const result = computeAttendanceSummary(rows, [], [], 4, 2026);
    expect(result.payableDays).toBe(25);
    expect(result.lopDays).toBe(5);
    expect(result.workingDays).toBe(30 - 1 - 4);
  });
});
