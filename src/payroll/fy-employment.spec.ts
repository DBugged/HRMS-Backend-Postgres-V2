import { employeeDob, missingPastMonths } from './fy-employment';

describe('employeeDob', () => {
  it('reads dateOfBirth, as the profile stores it, and falls back to the older dob key', () => {
    expect(employeeDob({ dateOfBirth: '1960-05-04' })).toBe('1960-05-04');
    expect(employeeDob({ dob: '1950-01-01' })).toBe('1950-01-01');
    expect(employeeDob(null)).toBeUndefined();
  });
});

describe('missingPastMonths', () => {
  const base = { fyStartYear: 2026, fyStartMonth: 4, currentMonth: 10, currentYear: 2026 };
  it('counts April to September when someone joined at the start of the year and nothing is on record', () => {
    expect(missingPastMonths({ ...base, joiningDate: '2026-04-01', monthsAlreadyCounted: 0 })).toBe(6);
  });
  it('counts only from the joining month for a later joiner, and nothing for one joining this month', () => {
    expect(missingPastMonths({ ...base, joiningDate: '2026-08-15', monthsAlreadyCounted: 0 })).toBe(2);
    expect(missingPastMonths({ ...base, joiningDate: '2026-10-01', monthsAlreadyCounted: 0 })).toBe(0);
  });
  it('counts from the start of the year for someone who joined in an earlier year', () => {
    expect(missingPastMonths({ ...base, joiningDate: '2021-01-10', monthsAlreadyCounted: 0 })).toBe(6);
  });
  it('subtracts months the system already holds, never below zero', () => {
    expect(missingPastMonths({ ...base, joiningDate: '2026-04-01', monthsAlreadyCounted: 4 })).toBe(2);
    expect(missingPastMonths({ ...base, joiningDate: '2026-04-01', monthsAlreadyCounted: 9 })).toBe(0);
  });
  it('handles a year that starts in January', () => {
    expect(missingPastMonths({ fyStartYear: 2026, fyStartMonth: 1, currentMonth: 3, currentYear: 2026, joiningDate: '2025-06-01', monthsAlreadyCounted: 1 })).toBe(1);
  });
});
