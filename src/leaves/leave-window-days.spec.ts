import { chargedDaysInWindow, crossesWindow } from './leave-window-days';

const holidays = new Set(['2026-11-10', '2026-11-11']);
const ruleSet =
  (sandwichHolidays: boolean, sandwichWeeklyOffs = false) =>
  () => ({
    holidayDates: holidays,
    weeklyOffs: [0],
    kinds: { holidays: sandwichHolidays, weeklyOffs: sandwichWeeklyOffs },
  });
const boom = () => {
  throw new Error('rules must not be read for a leave inside the window');
};

describe('leave days inside a window', () => {
  it('a leave inside the month is the days it was charged: 9-12 Nov with 10 and 11 holidays and the sandwich rule off is 2, not 4', () => {
    const leave = {
      startDate: '2026-11-09',
      endDate: '2026-11-12',
      isHalfDay: false,
      totalDays: 2,
    };
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', boom)).toBe(
      2,
    );
    expect(crossesWindow(leave, '2026-11-01', '2026-11-30')).toBe(false);
  });

  it('with the sandwich rule on, the stored charge is used as it is (4)', () => {
    const leave = {
      startDate: '2026-11-09',
      endDate: '2026-11-12',
      isHalfDay: false,
      totalDays: 4,
    };
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', boom)).toBe(
      4,
    );
  });

  it('a leave crossing the month end is re-counted for the month only, skipping uncharged holidays', () => {
    // 27 Nov to 3 Dec: 28 Nov is a holiday and 29 Nov a Sunday, neither charged with the sandwich rule off.
    const nov = new Set(['2026-11-28']);
    const rules = () => ({
      holidayDates: nov,
      weeklyOffs: [0],
      kinds: { holidays: false, weeklyOffs: false },
    });
    const leave = {
      startDate: '2026-11-27',
      endDate: '2026-12-03',
      isHalfDay: false,
      totalDays: 5,
    };
    expect(crossesWindow(leave, '2026-11-01', '2026-11-30')).toBe(true);
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', rules)).toBe(
      2,
    ); // 27 and 30 Nov
  });

  it('with the holiday sandwich on, the same crossing leave charges the holiday as well', () => {
    const nov = new Set(['2026-11-28']);
    const rules = () => ({
      holidayDates: nov,
      weeklyOffs: [0],
      kinds: { holidays: true, weeklyOffs: false },
    });
    const leave = {
      startDate: '2026-11-27',
      endDate: '2026-12-03',
      isHalfDay: false,
      totalDays: 6,
    };
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', rules)).toBe(
      3,
    ); // 27, 28 (holiday), 30
  });

  it('a half day counts 0.5 in its own window and nothing elsewhere', () => {
    const leave = {
      startDate: '2026-11-09',
      endDate: '2026-11-09',
      isHalfDay: true,
      totalDays: 0.5,
    };
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', boom)).toBe(
      0.5,
    );
    expect(chargedDaysInWindow(leave, '2026-12-01', '2026-12-31', boom)).toBe(
      0,
    );
  });

  it('a leave outside the window is 0', () => {
    const leave = {
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      isHalfDay: false,
      totalDays: 2,
    };
    expect(chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', boom)).toBe(
      0,
    );
  });

  it('a leave with no stored charge is counted from the rules', () => {
    const leave = {
      startDate: '2026-11-09',
      endDate: '2026-11-12',
      isHalfDay: false,
      totalDays: null,
    };
    expect(
      chargedDaysInWindow(leave, '2026-11-01', '2026-11-30', ruleSet(false)),
    ).toBe(2);
  });
});
