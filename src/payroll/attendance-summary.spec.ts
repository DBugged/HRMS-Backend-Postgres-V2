import { AttendanceStatus, OvertimeType } from '@prisma/client';
import {
  computeAttendanceSummary,
  payableDaysInRange,
} from './attendance-summary';

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

describe('computeAttendanceSummary — weighted overtime', () => {
  it('weights each approved OT record by its rateMultiplier', () => {
    const result = computeAttendanceSummary(
      [],
      [],
      [
        { hours: 2, type: OvertimeType.REGULAR, rateMultiplier: 1.5 },
        { hours: 3, type: OvertimeType.HOLIDAY, rateMultiplier: 2 },
        { hours: 4, type: OvertimeType.NIGHT, rateMultiplier: 1.75 },
      ],
      4,
      2026,
    );
    expect(result.overtimeHours).toBe(9); // raw hours unchanged
    expect(result.overtimeWeightedHours).toBe(2 * 1.5 + 3 * 2 + 4 * 1.75);
  });

  it('a record without a multiplier counts at 1x', () => {
    const result = computeAttendanceSummary(
      [],
      [],
      [{ hours: 3, type: OvertimeType.REGULAR }],
      4,
      2026,
    );
    expect(result.overtimeWeightedHours).toBe(3);
  });
});

describe('payableDaysInRange', () => {
  const dated = (date: string, status: AttendanceStatus) => ({
    date,
    status,
    isLate: false,
  });
  const rows = [
    dated('2026-04-01', AttendanceStatus.PRESENT),
    dated('2026-04-02', AttendanceStatus.HALF_DAY),
    dated('2026-04-05', AttendanceStatus.WEEKLY_OFF),
    dated('2026-04-14', AttendanceStatus.HOLIDAY),
    dated('2026-04-15', AttendanceStatus.ABSENT),
    dated('2026-04-16', AttendanceStatus.PRESENT),
    dated('2026-04-20', AttendanceStatus.ON_LEAVE),
  ];
  const leaves = [
    {
      startDate: '2026-04-14',
      endDate: '2026-04-17',
      isHalfDay: false,
      leaveType: { isPaid: true, salaryImpactPercent: 50 },
    },
    {
      startDate: '2026-04-20',
      endDate: '2026-04-20',
      isHalfDay: true,
      leaveType: { isPaid: true, salaryImpactPercent: 100 },
    },
    {
      startDate: '2026-04-25',
      endDate: '2026-04-26',
      isHalfDay: false,
      leaveType: { isPaid: false, salaryImpactPercent: 100 },
    },
  ];

  it('counts only the days inside the range', () => {
    // 1 present + 0.5 half + 1 weekly off; no leave overlaps 1-10.
    expect(payableDaysInRange(rows, leaves, '2026-04-01', '2026-04-10')).toBe(
      2.5,
    );
  });

  it('summed over a partition of the month equals the whole-month payableDays', () => {
    const month = computeAttendanceSummary(rows, leaves, [], 4, 2026);
    const first = payableDaysInRange(rows, leaves, '2026-04-01', '2026-04-15');
    const second = payableDaysInRange(rows, leaves, '2026-04-16', '2026-04-30');
    expect(first + second).toBeCloseTo(month.payableDays, 10);
  });
});
