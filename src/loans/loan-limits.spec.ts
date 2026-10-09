import { emiCapError, loanStartError } from './loan-limits';

describe('loanStartError', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  it('accepts this month, a late sanction and a start up to a year ahead', () => {
    expect(loanStartError(10, 2026, now)).toBeNull();
    expect(loanStartError(7, 2026, now)).toBeNull();
    expect(loanStartError(10, 2027, now)).toBeNull();
  });
  it('rejects a start decades away or long past', () => {
    expect(loanStartError(1, 1999, now)).toMatch(/past/);
    expect(loanStartError(1, 3000, now)).toMatch(/from now/);
    expect(loanStartError(6, 2026, now)).toMatch(/past/);
  });
});

describe('emiCapError', () => {
  it('allows EMIs up to 30% of net salary and rejects above', () => {
    expect(emiCapError(3000, 10000)).toBeNull();
    expect(emiCapError(3001, 10000)).toMatch(/30%/);
  });
});
