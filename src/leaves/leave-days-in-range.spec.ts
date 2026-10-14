import { leaveDaysInRange } from './leave-days-in-range';

describe('leaveDaysInRange', () => {
  const leave = (startDate: string, endDate: string, totalDays: number) => ({
    startDate,
    endDate,
    isHalfDay: false,
    totalDays,
  });

  it('counts a leave that sits inside the window in full', () => {
    expect(
      leaveDaysInRange(
        leave('2026-10-05', '2026-10-07', 3),
        '2026-10-01',
        '2026-10-31',
      ),
    ).toBe(3);
  });

  it('shares a leave that spans two months between them (10 calendar days: 3 in September, 7 in October)', () => {
    const l = leave('2026-09-28', '2026-10-07', 10);
    const sep = leaveDaysInRange(l, '2026-09-01', '2026-09-30');
    const oct = leaveDaysInRange(l, '2026-10-01', '2026-10-31');
    expect(sep).toBe(3);
    expect(oct).toBe(7);
    expect(sep + oct).toBe(10);
  });

  it('shares a leave whose working days differ from its calendar days in proportion', () => {
    // 14 calendar days, 10 working days: 4 calendar days fall in the first window.
    const l = leave('2026-10-28', '2026-11-10', 10);
    expect(leaveDaysInRange(l, '2026-10-01', '2026-10-31')).toBe(2.86);
  });

  it('counts nothing outside the window', () => {
    expect(
      leaveDaysInRange(
        leave('2026-09-01', '2026-09-03', 3),
        '2026-10-01',
        '2026-10-31',
      ),
    ).toBe(0);
  });

  it('puts a half day in the month of its date only', () => {
    const half = {
      startDate: '2026-10-31',
      endDate: '2026-10-31',
      isHalfDay: true,
      totalDays: 0.5,
    };
    expect(leaveDaysInRange(half, '2026-10-01', '2026-10-31')).toBe(0.5);
    expect(leaveDaysInRange(half, '2026-11-01', '2026-11-30')).toBe(0);
  });
});
