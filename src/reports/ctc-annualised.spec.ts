import { annualisedCtc } from './payroll-reports.service';

describe('annualisedCtc', () => {
  it('uses the monthly figure x 12 for a full month', () => {
    expect(
      annualisedCtc(
        75000,
        { payableDays: 30, totalDaysInMonth: 30 },
        'Regular',
      ),
    ).toBe(900000);
  });

  it('scales a part-month (joiner) back up to the full-month rate', () => {
    // 15 of 30 days paid: 39,687 earned in the month stands for 79,374 a month.
    expect(
      annualisedCtc(
        39687,
        { payableDays: 15, totalDaysInMonth: 30 },
        'Regular',
      ),
    ).toBe(Math.round(39687 * 2 * 12));
  });

  it('leaves a final settlement and a supplementary run as they are', () => {
    const s = { payableDays: 10, totalDaysInMonth: 31 };
    expect(annualisedCtc(1000, s, 'Final Settlement')).toBe(12000);
    expect(annualisedCtc(1000, s, 'Supplementary - Arrears')).toBe(12000);
  });

  it('copes with a missing or empty attendance summary', () => {
    expect(annualisedCtc(1000, {}, 'Regular')).toBe(12000);
    expect(annualisedCtc(1000, null, 'Regular')).toBe(12000);
  });

  it('does not divide by zero payable days', () => {
    expect(
      annualisedCtc(0, { payableDays: 0, totalDaysInMonth: 30 }, 'Regular'),
    ).toBe(0);
  });
});
