import { TaxRegime } from '@prisma/client';
import { getDefaultTaxSlabConfig } from '../tax-slabs/default-tax-slabs';
import {
  applySlabs,
  applySurcharge,
  calculateTax,
  computeHraExemption,
  monthsRemainingInFY,
} from './tax-engine';

describe('monthsRemainingInFY', () => {
  it('the FY start month has all 12 months remaining', () => {
    expect(monthsRemainingInFY(4, 2026, 4)).toBe(12);
  });

  it('the FY end month has 1 month remaining', () => {
    expect(monthsRemainingInFY(3, 2027, 4)).toBe(1);
  });
});

describe('applySlabs', () => {
  it('taxes each band only on the amount within it', () => {
    const slabs = [
      { from: 0, to: 400000, rate: 0 },
      { from: 400000, to: 800000, rate: 5 },
      { from: 800000, to: null, rate: 10 },
    ];
    expect(applySlabs(925000, slabs)).toBe(20000 + 12500);
  });
});

describe('applySurcharge', () => {
  it('returns 0 when no slab matches', () => {
    const slabs = [{ from: 5000000, to: 10000000, rate: 10 }];
    expect(applySurcharge(1000, 900000, slabs)).toBe(0);
  });

  it('applies the matching bracket rate to the tax amount', () => {
    const slabs = [{ from: 5000000, to: 10000000, rate: 10 }];
    expect(applySurcharge(100000, 6000000, slabs)).toBe(10000);
  });
});

describe('computeHraExemption', () => {
  it('returns 0 when no rent is paid', () => {
    expect(
      computeHraExemption({
        hraReceivedAnnual: 100000,
        basicAnnual: 600000,
        rentPaidAnnual: 0,
        isMetroCity: true,
      }),
    ).toBe(0);
  });

  it('takes the least of received/rent-minus-10pct/city-limit', () => {
    expect(
      computeHraExemption({
        hraReceivedAnnual: 240000,
        basicAnnual: 600000,
        rentPaidAnnual: 300000,
        isMetroCity: true,
      }),
    ).toBe(240000); // min(240000, 300000-60000=240000, 300000)
  });
});

describe('calculateTax', () => {
  it('throws when no tax slab config is provided', () => {
    expect(() =>
      calculateTax({
        month: 4,
        year: 2026,
        currentMonthGross: 100000,
        declaration: null,
        taxSlabConfig: undefined as never,
      }),
    ).toThrow(/No tax slab configuration/);
  });

  it('NEW regime worked example: 15L annualized, no declaration extras', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    const result = calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 125000, // -> 1,500,000 annualized
      ytdGross: 0,
      ytdTDS: 0,
      declaration: null,
      taxSlabConfig,
      financialYearStartMonth: 4,
    });
    expect(result.grossAnnualIncome).toBe(1500000);
    expect(result.taxableIncome).toBe(1425000); // 1,500,000 - 75,000 standard deduction
    expect(result.taxBeforeCess).toBe(93750);
    expect(result.rebate).toBe(0); // taxable income exceeds the 87A limit
    expect(result.cess).toBe(3750);
    expect(result.totalAnnualTax).toBe(97500);
    expect(result.remainingMonths).toBe(12);
    expect(result.monthlyTDS).toBe(8125);
  });

  it('NEW regime: taxable income under the 87A rebate limit zeroes the tax', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    const result = calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 1000000 / 12,
      declaration: null,
      taxSlabConfig,
    });
    expect(result.rebate).toBe(result.taxBeforeCess);
    expect(result.totalAnnualTax).toBe(0);
    expect(result.monthlyTDS).toBe(0);
  });

  it('OLD regime worked example: HRA exemption + capped 80C/80CCD1B/80D/80CCD2', () => {
    const taxSlabConfig = {
      regime: TaxRegime.OLD,
      ...getDefaultTaxSlabConfig(TaxRegime.OLD),
    };
    const declaration = {
      hraRentPaidAnnual: 300000,
      isMetroCity: true,
      ltaClaimed: 15000,
      section80C: 150000,
      section80CCD1B: 60000, // capped to 50,000
      section80CCD2: 80000, // capped to 10% of basicAnnual (60,000)
      section80D: 100000, // capped to the 75,000 statutory ceiling
      section80E: 10000,
      section80G: 5000,
      otherDeductions: 2000,
      previousEmployerIncome: 0,
      otherIncome: 0,
    };
    const result = calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 100000, // -> 1,200,000 annualized
      ytdGross: 0,
      ytdTDS: 0,
      basicAnnual: 600000,
      hraReceivedAnnual: 240000,
      declaration,
      taxSlabConfig,
      financialYearStartMonth: 4,
    });
    expect(result.grossAnnualIncome).toBe(1200000);
    expect(result.exemptions.hra).toBe(240000);
    expect(result.exemptions.lta).toBe(15000);
    expect(result.deductions.section80C).toBe(150000);
    expect(result.deductions.section80CCD1B).toBe(50000);
    expect(result.deductions.section80CCD2).toBe(60000);
    expect(result.deductions.section80D).toBe(75000);
    expect(result.taxableIncome).toBe(543000);
    expect(result.taxBeforeCess).toBe(21100);
    expect(result.rebate).toBe(0); // taxable income exceeds the old-regime 87A limit (5L)
    expect(result.cess).toBe(844);
    expect(result.totalAnnualTax).toBe(21944);
    expect(result.monthlyTDS).toBe(1829);
  });

  it('OLD regime with no declaration: no old-regime-only exemptions/deductions apply', () => {
    const taxSlabConfig = {
      regime: TaxRegime.OLD,
      ...getDefaultTaxSlabConfig(TaxRegime.OLD),
    };
    const result = calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 100000,
      basicAnnual: 600000,
      hraReceivedAnnual: 240000,
      declaration: null,
      taxSlabConfig,
    });
    expect(result.exemptions.hra).toBe(0);
    expect(result.exemptions.lta).toBe(0);
    expect(result.deductions.section80C).toBe(0);
    expect(result.deductions.section80CCD2).toBe(0); // declaration null -> 0, even though capped-by-basic logic runs
    expect(result.deductions.standard).toBe(taxSlabConfig.standardDeduction);
  });

  // Regression: previousEmployerIncome was added to the annual gross while
  // previousEmployerTDS — collected on the same declaration form — was never
  // read, so every mid-year joiner was taxed on the old salary as if no tax
  // had been withheld on it.
  it('credits TDS the previous employer already deducted', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    const base = {
      month: 10,
      year: 2026,
      currentMonthGross: 150000,
      ytdGross: 900000,
      ytdTDS: 0,
      taxSlabConfig,
      financialYearStartMonth: 4,
    };
    const withoutCredit = calculateTax({
      ...base,
      declaration: { previousEmployerIncome: 600000, previousEmployerTDS: 0 },
    });
    const withCredit = calculateTax({
      ...base,
      declaration: {
        previousEmployerIncome: 600000,
        previousEmployerTDS: 45000,
      },
    });

    // Same liability — the credit is tax already paid, not a deduction.
    expect(withCredit.totalAnnualTax).toBe(withoutCredit.totalAnnualTax);
    expect(withCredit.taxableIncome).toBe(withoutCredit.taxableIncome);
    expect(withCredit.previousEmployerTDS).toBe(45000);

    // ...spread over the months left in the year.
    expect(withCredit.monthlyTDS).toBe(
      withoutCredit.monthlyTDS - Math.round(45000 / withCredit.remainingMonths),
    );
  });

  it('never turns an over-credit into a refund through monthlyTDS', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    const result = calculateTax({
      month: 10,
      year: 2026,
      currentMonthGross: 150000,
      ytdGross: 900000,
      ytdTDS: 0,
      declaration: {
        previousEmployerIncome: 600000,
        previousEmployerTDS: 9999999,
      },
      taxSlabConfig,
      financialYearStartMonth: 4,
    });
    expect(result.monthlyTDS).toBe(0);
  });

  it('reduces monthlyTDS by TDS already paid YTD', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    const withoutYtd = calculateTax({
      month: 6,
      year: 2026,
      currentMonthGross: 125000,
      ytdGross: 250000,
      ytdTDS: 0,
      declaration: null,
      taxSlabConfig,
      financialYearStartMonth: 4,
    });
    const withYtd = calculateTax({
      month: 6,
      year: 2026,
      currentMonthGross: 125000,
      ytdGross: 250000,
      ytdTDS: 20000,
      declaration: null,
      taxSlabConfig,
      financialYearStartMonth: 4,
    });
    expect(withYtd.totalAnnualTax).toBe(withoutYtd.totalAnnualTax);
    expect(withYtd.monthlyTDS).toBeLessThan(withoutYtd.monthlyTDS);
  });
});
