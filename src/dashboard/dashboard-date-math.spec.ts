import {
  buildFyMonths,
  daysUntilNextOccurrence,
  monthsForRange,
} from './dashboard-date-math';

describe('buildFyMonths', () => {
  it('builds the current FY (Apr -> Mar) when "today" is mid-FY', () => {
    const months = buildFyMonths(0, new Date(2026, 5, 15)); // June 2026
    expect(months[0]).toEqual({ month: 4, year: 2026 });
    expect(months[11]).toEqual({ month: 3, year: 2027 });
    expect(months).toHaveLength(12);
  });

  it('resolves the FY correctly when "today" is before April (still last FY)', () => {
    const months = buildFyMonths(0, new Date(2026, 1, 10)); // Feb 2026
    expect(months[0]).toEqual({ month: 4, year: 2025 });
    expect(months[11]).toEqual({ month: 3, year: 2026 });
  });

  it('goes back further FYs with fysBack', () => {
    const months = buildFyMonths(1, new Date(2026, 5, 15));
    expect(months[0]).toEqual({ month: 4, year: 2025 });
  });
});

describe('monthsForRange', () => {
  const now = new Date(2026, 7, 1); // August 2026 -> FY2026-27, month index 4 (Aug is the 5th FY month)

  it('this_year returns the current FY', () => {
    const months = monthsForRange('this_year', now);
    expect(months[0]).toEqual({ month: 4, year: 2026 });
  });

  it('previous_year returns the FY before', () => {
    const months = monthsForRange('previous_year', now);
    expect(months[0]).toEqual({ month: 4, year: 2025 });
  });

  it('this_quarter returns exactly 3 months including the current one', () => {
    const months = monthsForRange('this_quarter', now);
    expect(months).toHaveLength(3);
    expect(months.some((m) => m.month === 8 && m.year === 2026)).toBe(true);
  });

  it('previous_quarter returns the 3 months before this_quarter', () => {
    const thisQ = monthsForRange('this_quarter', now);
    const prevQ = monthsForRange('previous_quarter', now);
    expect(prevQ).toHaveLength(3);
    expect(prevQ[2].month).not.toBe(thisQ[0].month);
  });
});

describe('daysUntilNextOccurrence', () => {
  it('returns 0 for today', () => {
    const today = new Date(2026, 5, 15);
    expect(daysUntilNextOccurrence(6, 15, today)).toBe(0);
  });

  it('returns days remaining within this year', () => {
    const today = new Date(2026, 5, 15);
    expect(daysUntilNextOccurrence(6, 20, today)).toBe(5);
  });

  it('wraps to next year when the date already passed this year', () => {
    const today = new Date(2026, 5, 15);
    const days = daysUntilNextOccurrence(1, 1, today);
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(220);
  });
});
