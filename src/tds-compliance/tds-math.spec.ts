import {
  challanDueDate,
  isValidTaxYear,
  monthsOfQuarter,
  quarterOf,
  splitMonthlyTds,
  statementDueDate,
  taxYearOf,
} from './tds-math';

describe('tds-math', () => {
  it('maps months to tax years and quarters', () => {
    expect(taxYearOf(4, 2026)).toBe('2026-27');
    expect(taxYearOf(3, 2027)).toBe('2026-27');
    expect([4, 6, 7, 9, 10, 12, 1, 3].map(quarterOf)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it('lists the months of a quarter, Q4 falling in the next calendar year', () => {
    expect(monthsOfQuarter('2026-27', 3)).toEqual([
      { month: 10, year: 2026 },
      { month: 11, year: 2026 },
      { month: 12, year: 2026 },
    ]);
    expect(monthsOfQuarter('2026-27', 4)).toEqual([
      { month: 1, year: 2027 },
      { month: 2, year: 2027 },
      { month: 3, year: 2027 },
    ]);
  });

  it('challan is due on the 7th of the next month, March on 30 April', () => {
    expect(challanDueDate(10, 2026)).toBe('2026-11-07');
    expect(challanDueDate(12, 2026)).toBe('2027-01-07');
    expect(challanDueDate(3, 2027)).toBe('2027-04-30');
  });

  it('statement due dates are 31 Jul / Oct / Jan / May', () => {
    expect(
      [1, 2, 3, 4].map((q) => statementDueDate('2026-27', q as 1 | 2 | 3 | 4)),
    ).toEqual(['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31']);
  });

  it('validates tax year labels', () => {
    expect(isValidTaxYear('2026-27')).toBe(true);
    expect(isValidTaxYear('2026-28')).toBe(false);
    expect(isValidTaxYear('26-27')).toBe(false);
  });

  it('splits TDS into tax/surcharge/cess that add back exactly', () => {
    const s = splitMonthlyTds(10000, {
      taxAfterRebate: 100000,
      surcharge: 10000,
      cess: 4400,
    });
    expect(s.tax + s.surcharge + s.cess).toBe(10000);
    expect(s.surcharge).toBe(874);
    expect(splitMonthlyTds(5000, null)).toEqual({
      tax: 5000,
      surcharge: 0,
      cess: 0,
    });
  });
});
