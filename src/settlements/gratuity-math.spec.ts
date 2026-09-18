import {
  GRATUITY_STATUTORY_CAP,
  calculateGratuity,
  completedYearsOfService,
  gratuityPayoutStatus,
  isFixedTermEmployeeType,
} from './gratuity-math';

describe('completedYearsOfService', () => {
  it('drops a part-year of six months or less', () => {
    expect(completedYearsOfService(7.4)).toBe(7);
    expect(completedYearsOfService(7.5)).toBe(7); // "in excess of six months"
    expect(completedYearsOfService(7)).toBe(7);
  });

  it('rounds a part-year of more than six months up', () => {
    expect(completedYearsOfService(7.51)).toBe(8);
    expect(completedYearsOfService(7.9)).toBe(8);
  });
});

describe('calculateGratuity', () => {
  it('pays nothing below the five-year eligibility threshold', () => {
    expect(calculateGratuity(40000, 4.9)).toBe(0);
  });

  // Regression: the settlement multiplied by the raw fractional years, so
  // 7.4 years of service paid for 7.4 years.
  it('pays for completed years, not the fraction actually served', () => {
    expect(calculateGratuity(40000, 7.4)).toBe(161538); // 40000 * 15/26 * 7
    expect(calculateGratuity(40000, 7.4)).not.toBe(170769);
  });

  it('rounds a part-year over six months up to a full year', () => {
    expect(calculateGratuity(40000, 7.8)).toBe(184615); // ...* 8
  });

  // Regression: there was no cap at all.
  it('never exceeds the 20 lakh statutory ceiling', () => {
    expect(calculateGratuity(500000, 30)).toBe(GRATUITY_STATUTORY_CAP);
  });

  it('leaves an uncapped amount alone', () => {
    expect(calculateGratuity(50000, 10)).toBe(288462);
  });
});

describe('fixed-term gratuity (Code on Social Security)', () => {
  it('a fixed-term employee is eligible after 1 year; a permanent one still needs 5', () => {
    expect(calculateGratuity(26000, 1.2, { fixedTerm: true })).toBeGreaterThan(
      0,
    );
    expect(calculateGratuity(26000, 0.9, { fixedTerm: true })).toBe(0);
    expect(calculateGratuity(26000, 3)).toBe(0);
    expect(calculateGratuity(26000, 5)).toBeGreaterThan(0);
  });

  it('treats contract / temporary / fixed-term types as fixed-term, not interns or permanent staff', () => {
    for (const t of [
      'contract',
      'temporary',
      'fixed_term',
      'Fixed-Term',
      'fixed term',
    ]) {
      expect(isFixedTermEmployeeType(t)).toBe(true);
    }
    for (const t of [
      'permanent',
      'probation',
      'intern',
      'apprentice',
      'consultant',
      '',
      null,
      undefined,
    ]) {
      expect(isFixedTermEmployeeType(t)).toBe(false);
    }
  });
});

describe('gratuity payout deadline', () => {
  it('is 30 days after the last working day', () => {
    expect(
      gratuityPayoutStatus('2026-09-30', null, new Date('2026-10-15')).dueBy,
    ).toBe('2026-10-30');
  });
  it('is overdue only once the deadline has passed (paid or still unpaid)', () => {
    expect(
      gratuityPayoutStatus('2026-09-30', null, new Date('2026-10-30')).overdue,
    ).toBe(false);
    expect(
      gratuityPayoutStatus('2026-09-30', null, new Date('2026-10-31')).overdue,
    ).toBe(true);
    expect(
      gratuityPayoutStatus(
        '2026-09-30',
        new Date('2026-10-20'),
        new Date('2027-01-01'),
      ).overdue,
    ).toBe(false);
    expect(
      gratuityPayoutStatus(
        '2026-09-30',
        new Date('2026-11-05'),
        new Date('2027-01-01'),
      ).overdue,
    ).toBe(true);
  });
});
