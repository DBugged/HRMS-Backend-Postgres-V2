import { addMonthsYmd, probationMonthsOf } from './org-probation-policy';

describe('org probation policy', () => {
  it('defaults to 6 months and accepts 1-24', () => {
    expect(probationMonthsOf(undefined)).toBe(6);
    expect(probationMonthsOf('abc')).toBe(6);
    expect(probationMonthsOf(0)).toBe(6);
    expect(probationMonthsOf(3)).toBe(3);
    expect(probationMonthsOf(24)).toBe(24);
  });

  it('adds months and clamps to a shorter month', () => {
    expect(addMonthsYmd('2026-10-02', 6)).toBe('2027-04-02');
    expect(addMonthsYmd('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonthsYmd('2026-11-15', 3)).toBe('2027-02-15');
  });
});
