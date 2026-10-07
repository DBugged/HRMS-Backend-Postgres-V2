import { AttendanceStatus } from '@prisma/client';
import {
  employmentWindow,
  missingOffDayRows,
  monthBounds,
  offDayCalendar,
  splitLeavesAroundOffDays,
} from './off-days';
import { computeAttendanceSummary } from './attendance-summary';

// September 2026: the 1st is a Tuesday; Saturdays are 5, 12, 19, 26 and Sundays 6, 13, 20, 27.
const SAT_SUN = [6, 0];

describe('monthBounds / employmentWindow', () => {
  it('gives the first and last day of the month', () => {
    expect(monthBounds(9, 2026)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthBounds(2, 2028)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('counts the whole month for someone who joined earlier', () => {
    expect(employmentWindow('2024-04-04', 9, 2026)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      daysBeforeJoining: 0,
    });
  });

  it('starts at the joining date inside the joining month', () => {
    expect(employmentWindow(new Date('2026-10-05T00:00:00.000Z'), 10, 2026)).toEqual({
      from: '2026-10-05',
      to: '2026-10-31',
      daysBeforeJoining: 4,
    });
  });

  it('treats a month before the joining date as entirely before joining', () => {
    expect(employmentWindow('2026-10-01', 9, 2026).daysBeforeJoining).toBe(30);
  });
});

describe('offDayCalendar / missingOffDayRows', () => {
  it('finds weekly offs and holidays and skips dates that already have a row', () => {
    const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, ['2026-09-14', '2026-09-12']);
    expect(cal.weeklyOffDates.size).toBe(8);
    // 12 Sep is a Saturday: counted once, as a weekly off, not also as a holiday.
    expect([...cal.holidayDates]).toEqual(['2026-09-14']);
    const rows = missingOffDayRows(cal, new Set(['2026-09-05', '2026-09-14']));
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === AttendanceStatus.WEEKLY_OFF)).toBe(true);
  });

  it('pays unmarked weekends: 22 worked weekdays + 8 weekend days = 30 payable, no LOP', () => {
    const worked: { status: AttendanceStatus; isLate: boolean; date: string }[] = [];
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        worked.push({ status: AttendanceStatus.PRESENT, isLate: false, date });
      }
    }
    const cal = offDayCalendar('2026-09-01', '2026-09-30', SAT_SUN, []);
    const rows = [...worked, ...missingOffDayRows(cal, new Set(worked.map((r) => r.date)))];
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
    expect([out[0].startDate, out[0].endDate]).toEqual(['2026-09-04', '2026-09-07']);
  });

  it('leaves half-day leaves alone', () => {
    const half = { ...leave(false), startDate: '2026-09-04', endDate: '2026-09-04', isHalfDay: true };
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
