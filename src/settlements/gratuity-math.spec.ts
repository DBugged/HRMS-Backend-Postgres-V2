import {
  calendarYearsOfService,
  GRATUITY_STATUTORY_CAP,
  calculateGratuity,
  calculateHalfMonthGratuity,
  gratuityTaxExemption,
  completedYearsOfService,
  finalWagesDueBy,
  finalWagesStatus,
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

describe('calendarYearsOfService', () => {
  it('counts exactly five years as five (not 4.9993 of a 365.25-day year)', () => {
    expect(calendarYearsOfService('2020-10-07', '2025-10-06')).toBe(5);
    expect(calendarYearsOfService('2020-10-01', '2025-09-30')).toBe(5);
  });

  it('is under five the day before the anniversary minus one', () => {
    expect(calendarYearsOfService('2020-10-07', '2025-10-05')).toBeLessThan(5);
  });

  it('adds months as a fraction of a year', () => {
    expect(calendarYearsOfService('2020-01-01', '2020-06-30')).toBeCloseTo(
      0.5,
      5,
    );
  });
});

describe('calculateGratuity - death or disablement', () => {
  it('pays below five years only when the exit is death/disablement', () => {
    expect(calculateGratuity(26000, 2.4)).toBe(0);
    expect(
      calculateGratuity(26000, 2.4, { exemptFromMinimumService: true }),
    ).toBe(Math.round(26000 * (15 / 26) * 2));
  });
});

describe('final wages deadline (Code on Wages s.17(2))', () => {
  it('is two working days after the last working day, skipping Sundays', () => {
    // Tuesday 2026-10-06 -> Thursday 08th.
    expect(finalWagesDueBy('2026-10-06')).toBe('2026-10-08');
    // Friday 2026-10-09 -> Saturday 10th, then Sunday is skipped -> Monday 12th.
    expect(finalWagesDueBy('2026-10-09')).toBe('2026-10-12');
  });

  it('flags a payment made after it (or still unpaid past it) as overdue', () => {
    expect(
      finalWagesStatus('2026-10-06', new Date('2026-10-08T10:00:00Z')),
    ).toEqual({ dueBy: '2026-10-08', overdue: false });
    expect(
      finalWagesStatus('2026-10-06', new Date('2026-10-09T10:00:00Z')).overdue,
    ).toBe(true);
    expect(
      finalWagesStatus('2026-10-06', null, new Date('2026-10-10T00:00:00Z'))
        .overdue,
    ).toBe(true);
  });
});

describe('gratuity: covered / not covered', () => {
  it('half a month per COMPLETED year, no round-up, and a minimum service', () => {
    // 30,000 x 15/30 x 7 (7.8 years -> 7)
    expect(calculateHalfMonthGratuity(30000, 7.8)).toBe(105000);
    // below the default 5-year minimum, or a custom one
    expect(calculateHalfMonthGratuity(30000, 4.9)).toBe(0);
    expect(calculateHalfMonthGratuity(30000, 3.2, { minYears: 3 })).toBe(45000);
    expect(
      calculateHalfMonthGratuity(30000, 1, { exemptFromMinimumService: true }),
    ).toBe(15000);
  });

  it('a covered employer is exempt up to the Act figure (part-year rounds up)', () => {
    // 40,000 x 15/26 x 8 (7.6 -> 8) = 184,615
    expect(
      gratuityTaxExemption({
        coverage: 'COVERED',
        paid: 184615,
        lastDrawnWages: 40000,
        averageWages: 38000,
        yearsOfService: 7.6,
      }),
    ).toBe(184615);
  });

  it('a non-covered employer is exempt only up to 15/30 on the 10-month average x completed years', () => {
    // paying the Act figure (184,615) voluntarily: exempt = 38,000 x 0.5 x 7 = 133,000; the rest is taxable
    const exempt = gratuityTaxExemption({
      coverage: 'NOT_COVERED',
      paid: 184615,
      lastDrawnWages: 40000,
      averageWages: 38000,
      yearsOfService: 7.6,
    });
    expect(exempt).toBe(133000);
    expect(184615 - exempt).toBe(51615);
  });

  it('is never more than the amount paid or 20 lakh', () => {
    expect(
      gratuityTaxExemption({
        coverage: 'NOT_COVERED',
        paid: 50000,
        lastDrawnWages: 40000,
        averageWages: 38000,
        yearsOfService: 10,
      }),
    ).toBe(50000);
    expect(
      gratuityTaxExemption({
        coverage: 'COVERED',
        paid: 5000000,
        lastDrawnWages: 900000,
        averageWages: 900000,
        yearsOfService: 30,
      }),
    ).toBe(GRATUITY_STATUTORY_CAP);
  });
});
