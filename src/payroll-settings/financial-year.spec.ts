import { getFinancialYear } from './financial-year';

describe('getFinancialYear', () => {
  it('returns "year-year+1" when month is on/after the start month', () => {
    expect(getFinancialYear(4, 2026, 4)).toBe('2026-27');
    expect(getFinancialYear(12, 2026, 4)).toBe('2026-27');
  });

  it('returns "year-1-year" when month is before the start month', () => {
    expect(getFinancialYear(1, 2026, 4)).toBe('2025-26');
    expect(getFinancialYear(3, 2026, 4)).toBe('2025-26');
  });

  it('pads the trailing two-digit year with a leading zero when needed', () => {
    expect(getFinancialYear(4, 2099, 4)).toBe('2099-00');
  });

  it('respects a non-default start month', () => {
    expect(getFinancialYear(1, 2026, 1)).toBe('2026-27');
    expect(getFinancialYear(12, 2026, 1)).toBe('2026-27');
  });
});
