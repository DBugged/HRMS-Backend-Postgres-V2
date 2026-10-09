import { isFinancialYear } from './is-financial-year.validator';

describe('isFinancialYear', () => {
  it('accepts a real financial year', () => {
    expect(isFinancialYear('2026-27')).toBe(true);
    expect(isFinancialYear('2099-00')).toBe(true);
  });
  it('rejects labels that are not one', () => {
    for (const bad of [
      'abc',
      '2026',
      '2026-28',
      '26-27',
      '2026-2027',
      '1999-00',
      '',
      undefined,
      2026,
    ]) {
      expect(isFinancialYear(bad)).toBe(false);
    }
  });
});
