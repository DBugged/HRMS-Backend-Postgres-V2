import { currentFinancialYear, previousMonthPeriod } from './report-period';

describe('report period defaults', () => {
  it('a monthly return defaults to the month that just ended', () => {
    expect(previousMonthPeriod(new Date('2026-10-12T05:00:00Z'))).toEqual({
      month: 9,
      year: 2026,
    });
    expect(previousMonthPeriod(new Date('2027-01-03T05:00:00Z'))).toEqual({
      month: 12,
      year: 2026,
    });
  });
  it('a yearly report defaults to the current financial year', () => {
    expect(currentFinancialYear(new Date('2026-10-12T00:00:00Z'))).toBe(
      '2026-27',
    );
    expect(currentFinancialYear(new Date('2027-02-01T00:00:00Z'))).toBe(
      '2026-27',
    );
    expect(currentFinancialYear(new Date('2026-03-31T00:00:00Z'))).toBe(
      '2025-26',
    );
    expect(currentFinancialYear(new Date('2099-04-01T00:00:00Z'))).toBe(
      '2099-00',
    );
  });
});
