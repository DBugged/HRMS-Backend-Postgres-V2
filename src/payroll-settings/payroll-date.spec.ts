import { resolveDayOfMonth } from './payroll-date';

describe('resolveDayOfMonth', () => {
  it('day=0 resolves to the last calendar day when it is a weekday', () => {
    // Aug 2026: Aug 31 2026 is a Monday.
    expect(resolveDayOfMonth(0, 2026, 8)).toBe('2026-08-31');
  });

  it('day=0 steps back over a trailing weekend', () => {
    // May 2026: May 31 2026 is a Sunday -> steps back to Fri May 29.
    expect(resolveDayOfMonth(0, 2026, 5)).toBe('2026-05-29');
  });

  it('a fixed day is used as-is when it fits in the month', () => {
    expect(resolveDayOfMonth(15, 2026, 8)).toBe('2026-08-15');
  });

  it('a fixed day beyond month length clamps to the last day', () => {
    // Feb 2026 has 28 days.
    expect(resolveDayOfMonth(31, 2026, 2)).toBe('2026-02-28');
  });

  it('clamps day=31 correctly in a leap-year February', () => {
    expect(resolveDayOfMonth(31, 2028, 2)).toBe('2028-02-29');
  });
});
