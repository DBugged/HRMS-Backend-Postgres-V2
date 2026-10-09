import { isReasonableJoiningDate } from './is-reasonable-joining-date.validator';

describe('isReasonableJoiningDate', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  it('accepts a past hire, today and an upcoming joiner', () => {
    expect(isReasonableJoiningDate('2005-04-01', now)).toBe(true);
    expect(isReasonableJoiningDate('2026-10-09', now)).toBe(true);
    expect(isReasonableJoiningDate('2027-01-15', now)).toBe(true);
  });
  it('rejects a date far ahead, before 1990 or impossible', () => {
    expect(isReasonableJoiningDate('2099-01-01', now)).toBe(false);
    expect(isReasonableJoiningDate('2027-12-31', now)).toBe(false);
    expect(isReasonableJoiningDate('1985-01-01', now)).toBe(false);
    expect(isReasonableJoiningDate('2026-02-30', now)).toBe(false);
    expect(isReasonableJoiningDate(undefined, now)).toBe(false);
  });
});
