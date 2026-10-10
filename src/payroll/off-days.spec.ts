import { AttendanceStatus } from '@prisma/client';
import {
  dropLeaveRowsOnOffDays,
  employmentWindow,
  missingOffDayRows,
  monthBounds,
  offDayCalendar,
  splitLeavesAroundOffDays,
  lastCountedDay,
} from './off-days';
import { computeAttendanceSummary } from './attendance-summary';

// September 2026: the 1st is a Tuesday; Saturdays are 5, 12, 19, 26 and Sundays 6, 13, 20, 27.
const SAT_SUN = [6, 0];

describe('monthBounds / employmentWindow', () => {
  it('gives the first and last day of the month', () => {
    expect(monthBounds(9, 2026)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(monthBounds(2, 2028)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('counts the whole month for someone who joined earlier', () => {
    expect(employmentWindow('2024-04-04', 9, 2026)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      daysBeforeJoining: 0,
      daysNotElapsed: 0,
    });
  });

  it('starts at the joining date inside the joining month', () => {
    expect(
      employmentWindow(new Date('2026-10-05T00:00:00.000Z'), 10, 2026),
    ).toEqual({
      from: '2026-10-05',
      to: '2026-10-31',
      daysBeforeJoining: 4,
      daysNotElapsed: 0,
    });
  });

  it('treats a month before the joining date as entirely before joining', () => {
    expect(employmentWindow('2026-10-01', 9, 2026).daysBeforeJoining).toBe(30);
  });

  it('stops at today while the month is still running', () => {
    expect(employmentWindow('2024-04-04', 10, 2026, '2026-10-08')).toEqual({
      from: '2026-10-01',
      to: '2026-10-08',
      daysBeforeJoining: 0,
      daysNotElapsed: 23,
    });
  });

  it('counts both the days before joining and the days not yet elapsed', () => {
    const w = employmentWindow('2026-10-05', 10, 2026, '2026-10-08');
    expect(w).toMatchObject({
      from: '2026-10-05',
      to: '2026-10-08',
      daysBeforeJoining: 4,
      daysNotElapsed: 23,
    });
  });

  it('ignores a through date that is on or after the end of the month', () => {
    expect(
      employmentWindow('2024-04-04', 9, 2026, '2026-10-08').daysNotElapsed,
    ).toBe(0);
    expect(employmentWindow('2024-04-04', 9, 2026, '2026-09-30').to).toBe(
      '2026-09-30',
    );
  });
});

describe('offDayCalendar / missingOffDayRows', () => {
  it('finds weekly offs and holidays and skips dates that already have a row', () => {
    const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, [
      '2026-09-14',
      '2026-09-12',
    ]);
    expect(cal.weeklyOffDates.size).toBe(8);
    // 12 Sep is a Saturday: counted once, as a weekly off, not also as a holiday.
    expect([...cal.holidayDates]).toEqual(['2026-09-14']);
    const rows = missingOffDayRows(cal, new Set(['2026-09-05', '2026-09-14']));
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === AttendanceStatus.WEEKLY_OFF)).toBe(
      true,
    );
  });

  it('pays unmarked weekends: 22 worked weekdays + 8 weekend days = 30 payable, no LOP', () => {
    const worked: {
      status: AttendanceStatus;
      isLate: boolean;
      date: string;
    }[] = [];
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        worked.push({ status: AttendanceStatus.PRESENT, isLate: false, date });
      }
    }
    const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, []);
    const rows = [
      ...worked,
      ...missingOffDayRows(cal, new Set(worked.map((r) => r.date))),
    ];
    const summary = computeAttendanceSummary(rows, [], [], 9, 2026);
    expect(summary.payableDays).toBe(30);
    expect(summary.lopDays).toBe(0);
    expect(summary.weeklyOffs).toBe(8);
  });

  it('keeps days before joining out of LOP', () => {
    const summary = computeAttendanceSummary([], [], [], 10, 2026, 4);
    expect(summary.payableDays).toBe(0);
    expect(summary.lopDays).toBe(27);
  });
});

describe('splitLeavesAroundOffDays', () => {
  const unpaid = { isPaid: false, salaryImpactPercent: 100 };
  const leave = (sandwichApplies: boolean) => ({
    startDate: '2026-09-04', // Friday
    endDate: '2026-09-07', // Monday
    isHalfDay: false,
    leaveType: unpaid,
    sandwichApplies,
  });
  const off = new Set(['2026-09-05', '2026-09-06']);

  it('cuts the weekend out of a leave without the sandwich rule', () => {
    const out = splitLeavesAroundOffDays([leave(false)], off);
    expect(out.map((l) => [l.startDate, l.endDate])).toEqual([
      ['2026-09-04', '2026-09-04'],
      ['2026-09-07', '2026-09-07'],
    ]);
  });

  it('leaves a leave alone when its type applies the sandwich rule', () => {
    const out = splitLeavesAroundOffDays([leave(true)], off);
    expect(out).toHaveLength(1);
    expect([out[0].startDate, out[0].endDate]).toEqual([
      '2026-09-04',
      '2026-09-07',
    ]);
  });

  it('leaves half-day leaves alone', () => {
    const half = {
      ...leave(false),
      startDate: '2026-09-04',
      endDate: '2026-09-04',
      isHalfDay: true,
    };
    expect(splitLeavesAroundOffDays([half], off)).toEqual([half]);
  });

  it('unpaid Friday-Monday leave without sandwich costs 2 days, with sandwich 4', () => {
    const rows = (sandwich: boolean) => {
      const leaves = splitLeavesAroundOffDays([leave(sandwich)], off);
      const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, []);
      const att = missingOffDayRows(cal, new Set());
      return computeAttendanceSummary(att, leaves, [], 9, 2026);
    };
    expect(rows(false).unpaidLeaveDays).toBe(2);
    expect(rows(true).unpaidLeaveDays).toBe(4);
  });
});

describe('dropLeaveRowsOnOffDays', () => {
  const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, []);
  const rows = ['2026-09-10', '2026-09-12', '2026-09-13', '2026-09-14'].map(
    (date) => ({ status: AttendanceStatus.ON_LEAVE, date }),
  );
  const leave = { startDate: '2026-09-10', endDate: '2026-09-14' };

  it('drops the ON_LEAVE rows on a weekend inside a leave without the sandwich rule', () => {
    const kept = dropLeaveRowsOnOffDays(rows, cal, [leave]);
    expect(kept.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-14']);
  });

  it('keeps them when the leave applies the sandwich rule', () => {
    const kept = dropLeaveRowsOnOffDays(rows, cal, [
      { ...leave, sandwichApplies: true },
    ]);
    expect(kept).toHaveLength(4);
  });

  it('only touches ON_LEAVE rows', () => {
    const present = [{ status: AttendanceStatus.PRESENT, date: '2026-09-12' }];
    expect(dropLeaveRowsOnOffDays(present, cal, [leave])).toHaveLength(1);
  });
});

describe('a month still running (month to date)', () => {
  it('pays and counts only the days that have happened', () => {
    // 8 Oct 2026 (Thursday): worked every weekday so far, Saturday 3rd and Sunday 4th are weekly offs.
    const w = employmentWindow('2024-04-04', 10, 2026, '2026-10-08');
    const cal = offDayCalendar(w.from, w.to, SAT_SUN, []);
    const worked = [
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ].map((date) => ({
      status: AttendanceStatus.PRESENT,
      isLate: false as const,
      date,
    }));
    const rows = [
      ...worked,
      ...missingOffDayRows(cal, new Set(worked.map((r) => r.date))),
    ];
    const summary = computeAttendanceSummary(
      rows,
      [],
      [],
      10,
      2026,
      w.daysBeforeJoining + w.daysNotElapsed,
    );
    expect(summary.payableDays).toBe(8);
    expect(summary.lopDays).toBe(0);
    expect(summary.totalDaysInMonth).toBe(31);
  });

  it('counts a missed day so far as LOP but never the days to come', () => {
    const w = employmentWindow('2024-04-04', 10, 2026, '2026-10-08');
    const cal = offDayCalendar(w.from, w.to, SAT_SUN, []);
    const worked = [
      '2026-10-01',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ].map((date) => ({
      status: AttendanceStatus.PRESENT,
      isLate: false as const,
      date,
    }));
    const rows = [
      ...worked,
      ...missingOffDayRows(cal, new Set(worked.map((r) => r.date))),
    ];
    const summary = computeAttendanceSummary(
      rows,
      [],
      [],
      10,
      2026,
      w.daysBeforeJoining + w.daysNotElapsed,
    );
    expect(summary.payableDays).toBe(7);
    expect(summary.lopDays).toBe(1); // 2 Oct, a Friday nobody marked
  });
});

describe('lastCountedDay', () => {
  it('a running month is counted up to yesterday, not today', () => {
    expect(lastCountedDay('2026-10-10', 10, 2026)).toBe('2026-10-09');
  });
  it('on the 1st it stays the 1st, so the month is never empty', () => {
    expect(lastCountedDay('2026-10-01', 10, 2026)).toBe('2026-10-01');
  });
  it('a finished month is not cut short', () => {
    const through = lastCountedDay('2026-10-10', 9, 2026);
    expect(employmentWindow('2024-04-04', 9, 2026, through).to).toBe(
      '2026-09-30',
    );
  });
  it('an employee who joined today has no finished day yet', () => {
    const w = employmentWindow(
      '2026-10-10',
      10,
      2026,
      lastCountedDay('2026-10-10', 10, 2026),
    );
    expect(w.from > w.to).toBe(true);
  });
});
