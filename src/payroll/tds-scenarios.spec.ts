// Purpose: Acceptance scenarios for monthly TDS = (annual tax - TDS already deducted) / remaining payroll months.
// Important: salary of 25,50,000 a year (2,12,500 a month), FY 2026-27, New regime: taxable 24,75,000, tax with cess 3,35,400.
import { TaxRegime } from '@prisma/client';
import { getDefaultTaxSlabConfig } from '../tax-slabs/default-tax-slabs';
import { calculateTax } from './tax-engine';

const MONTHLY = 212500;
const cfg = (regime: TaxRegime) => ({
  regime,
  ...getDefaultTaxSlabConfig(regime),
});

// Pay run for `month` (1-12, FY starting April 2026), with `paidMonths` already paid before it.
function run(opts: {
  month: number;
  paidMonths: number;
  ytdTDS: number;
  regime?: TaxRegime;
  previousEmployerTDS?: number;
  employmentMonths?: number;
}) {
  const year = opts.month >= 4 ? 2026 : 2027;
  return calculateTax({
    month: opts.month,
    year,
    currentMonthGross: MONTHLY,
    recurringMonthlyGross: MONTHLY,
    ytdGross: opts.paidMonths * MONTHLY,
    ytdTDS: opts.ytdTDS,
    employmentMonthsInFY: opts.employmentMonths,
    declaration: opts.previousEmployerTDS
      ? ({ previousEmployerTDS: opts.previousEmployerTDS } as never)
      : null,
    taxSlabConfig: cfg(opts.regime ?? TaxRegime.NEW),
    financialYearStartMonth: 4,
  });
}

describe('monthly TDS from actual deductions and remaining months', () => {
  it('annual tax is 3,35,400 for 25,50,000 under the New regime', () => {
    const t = run({ month: 4, paidMonths: 0, ytdTDS: 0 });
    expect(t.taxableIncome).toBe(2475000);
    expect(t.totalAnnualTax).toBe(335400);
    expect(t.monthlyTDS).toBe(27950); // nothing deducted yet: 12 months
  });

  it('A: 1,67,700 deducted Apr-Sep, 6 months left (Oct-Mar) -> 27,950', () => {
    const t = run({ month: 10, paidMonths: 6, ytdTDS: 167700 });
    expect(t.remainingMonths).toBe(6);
    expect(t.monthlyTDS).toBe(27950);
  });

  it('B: 1,95,650 deducted Apr-Oct, 5 months left -> 27,950', () => {
    const t = run({ month: 11, paidMonths: 7, ytdTDS: 195650 });
    expect(t.remainingMonths).toBe(5);
    expect(t.monthlyTDS).toBe(27950);
  });

  it('C: only 1,67,700 deducted by November, 5 months left -> 33,540', () => {
    const t = run({ month: 11, paidMonths: 7, ytdTDS: 167700 });
    expect(t.monthlyTDS).toBe(33540);
  });

  it('reconciles: tax deducted + monthly x remaining = annual tax', () => {
    const t = run({ month: 11, paidMonths: 7, ytdTDS: 167700 });
    expect(167700 + t.monthlyTDS * t.remainingMonths).toBe(t.totalAnnualTax);
  });

  it('opening balance / previous employer TDS is credited once', () => {
    const t = run({
      month: 11,
      paidMonths: 7,
      ytdTDS: 100000,
      previousEmployerTDS: 67700,
    });
    expect(t.monthlyTDS).toBe(33540);
  });

  it('zero remaining liability deducts nothing more', () => {
    const t = run({ month: 12, paidMonths: 8, ytdTDS: 335400 });
    expect(t.monthlyTDS).toBe(0);
  });

  it('TDS already above the annual liability never goes negative', () => {
    const t = run({ month: 12, paidMonths: 8, ytdTDS: 400000 });
    expect(t.monthlyTDS).toBe(0);
  });

  it('Old regime uses the 50,000 standard deduction and a different liability', () => {
    const t = run({ month: 4, paidMonths: 0, ytdTDS: 0, regime: TaxRegime.OLD });
    expect(t.deductions.standard).toBe(50000);
    expect(t.taxableIncome).toBe(2500000);
    expect(t.totalAnnualTax).toBeGreaterThan(335400);
  });

  it('a mid-year joiner is taxed on the months employed and the standard deduction still applies', () => {
    // Joined in October: Oct-Mar is 6 months of pay.
    const t = run({ month: 10, paidMonths: 0, ytdTDS: 0, employmentMonths: 6 });
    expect(t.remainingMonths).toBe(6);
    expect(t.grossAnnualIncome).toBe(6 * MONTHLY);
    expect(t.taxableIncome).toBe(6 * MONTHLY - 75000);
    expect(t.monthlyTDS * 6).toBeGreaterThanOrEqual(t.totalAnnualTax - 30);
  });

  it('a salary revision moves the projection, not the TDS already withheld', () => {
    const before = run({ month: 10, paidMonths: 6, ytdTDS: 167700 });
    const revised = calculateTax({
      month: 10,
      year: 2026,
      currentMonthGross: 250000,
      recurringMonthlyGross: 250000,
      ytdGross: 6 * MONTHLY,
      ytdTDS: 167700,
      declaration: null,
      taxSlabConfig: cfg(TaxRegime.NEW),
      financialYearStartMonth: 4,
    });
    expect(revised.ytdTDS).toBe(167700);
    expect(revised.monthlyTDS).toBeGreaterThan(before.monthlyTDS);
  });
});
