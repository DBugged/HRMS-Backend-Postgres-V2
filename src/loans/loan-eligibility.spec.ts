import { canRequestDespiteEligibility, isLoanEligible } from './loan-eligibility';

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

describe('who may apply despite the rule', () => {
  it('Admin, HR and Manager may; an employee may not', () => {
    expect(canRequestDespiteEligibility('ADMIN')).toBe(true);
    expect(canRequestDespiteEligibility('HR')).toBe(true);
    expect(canRequestDespiteEligibility('MANAGER')).toBe(true);
    expect(canRequestDespiteEligibility('EMPLOYEE')).toBe(false);
  });
});
