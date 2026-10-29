import { isLoanEligible } from './loan-eligibility';

describe('loan eligibility', () => {
  it('a confirmed, permanent employee is eligible', () => {
    expect(isLoanEligible({ employmentStatus: 'CONFIRMED', employeeType: 'permanent' })).toBe(true);
  });
  it.each(['PROBATION', 'EXTENDED_PROBATION', 'ONBOARDING', 'NOTICE_PERIOD', 'ON_HOLD'])(
    '%s is not eligible',
    (employmentStatus) => {
      expect(isLoanEligible({ employmentStatus, employeeType: 'permanent' })).toBe(false);
    },
  );
  it.each(['intern', 'trainee', 'contract', 'probation'])('a confirmed %s is not eligible', (employeeType) => {
    expect(isLoanEligible({ employmentStatus: 'CONFIRMED', employeeType })).toBe(false);
  });
});
