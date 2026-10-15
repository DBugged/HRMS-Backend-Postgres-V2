import {
  monthsBeforeInFY,
  validateOpeningBalance,
  withOpeningBalance,
} from './opening-balances';
import { TaxRegime } from '@prisma/client';
import { calculateTax } from './tax-engine';
import { getDefaultTaxSlabConfig } from '../tax-slabs/default-tax-slabs';

const ok = {
  monthsCovered: 5,
  taxableEarnings: 687500,
  tdsDeducted: 20000,
  pfPaid: 0,
  ptPaid: 1000,
};

describe('withOpeningBalance', () => {
  const ytd = { ytdGross: 0, ytdTDS: 0, ytdMonths: 0, ytdProfessionalTax: 0 };
  it('adds the balance to the year so far', () => {
    expect(withOpeningBalance(ytd, ok)).toEqual({
      ytdGross: 687500,
      ytdTDS: 20000,
      ytdMonths: 5,
      ytdProfessionalTax: 1000,
    });
  });
  it('leaves figures alone with no balance and caps months at 12', () => {
    expect(withOpeningBalance(ytd, null)).toBe(ytd);
    expect(withOpeningBalance({ ...ytd, ytdMonths: 10 }, ok).ytdMonths).toBe(
      12,
    );
  });
});

describe('monthsBeforeInFY', () => {
  it('counts months since the FY start', () => {
    expect(monthsBeforeInFY(9, 4)).toBe(5);
    expect(monthsBeforeInFY(4, 4)).toBe(0);
    expect(monthsBeforeInFY(1, 4)).toBe(9);
  });
});

describe('validateOpeningBalance', () => {
  it('accepts a sensible balance', () => {
    expect(validateOpeningBalance(ok, 5)).toBeNull();
  });
  it('rejects too many months, negatives, amounts without months, TDS above earnings', () => {
    expect(validateOpeningBalance({ ...ok, monthsCovered: 6 }, 5)).toMatch(
      /more than 5/,
    );
    expect(validateOpeningBalance({ ...ok, ptPaid: -1 }, 5)).toMatch(
      /negative/,
    );
    expect(validateOpeningBalance({ ...ok, monthsCovered: 0 }, 5)).toMatch(
      /months/,
    );
    expect(validateOpeningBalance({ ...ok, tdsDeducted: 900000 }, 5)).toMatch(
      /more than/,
    );
    expect(validateOpeningBalance({ ...ok, taxableEarnings: NaN }, 5)).toMatch(
      /numbers/,
    );
  });
});

describe('tax engine with opening balances (first run in September)', () => {
  const taxSlabConfig = {
    regime: TaxRegime.NEW,
    ...getDefaultTaxSlabConfig(TaxRegime.NEW),
  };
  const run = (ytdGross: number, ytdTDS: number) =>
    calculateTax({
      month: 9,
      year: 2026,
      currentMonthGross: 137500,
      recurringMonthlyGross: 137500,
      ytdGross,
      ytdTDS,
      declaration: null,
      taxSlabConfig,
      financialYearStartMonth: 4,
    });

  it('without them only Sep-Mar is annualised and TDS wrongly falls under the rebate', () => {
    const r = run(0, 0);
    expect(r.grossAnnualIncome).toBe(962500);
    expect(r.monthlyTDS).toBe(0);
  });

  it('with Apr-Aug opening balances the whole year is taxed', () => {
    const ytd = withOpeningBalance(
      { ytdGross: 0, ytdTDS: 0, ytdMonths: 0, ytdProfessionalTax: 0 },
      { ...ok, tdsDeducted: 0, ptPaid: 0 },
    );
    const r = run(ytd.ytdGross, ytd.ytdTDS);
    expect(r.grossAnnualIncome).toBe(1650000);
    expect(r.monthlyTDS).toBeGreaterThan(0);
  });

  it('tax already deducted before go-live is credited against the annual tax', () => {
    const none = run(687500, 0);
    const paid = run(687500, 20000);
    expect(paid.monthlyTDS).toBeLessThan(none.monthlyTDS);
  });
});
