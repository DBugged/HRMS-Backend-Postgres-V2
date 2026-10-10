import { TaxRegime } from '@prisma/client';
import { getDefaultTaxSlabConfig } from '../tax-slabs/default-tax-slabs';
import {
  applySlabs,
  applySurcharge,
  applySurchargeWithMarginalRelief,
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
    expect(result.totalAnnualTax).toBe(21940); // 21,944 rounded to the nearest 10 (s.288B)
    expect(result.monthlyTDS).toBe(1828);
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

describe('marginal relief', () => {
  const newRegime = {
    regime: TaxRegime.NEW,
    ...getDefaultTaxSlabConfig(TaxRegime.NEW),
  };
  const taxFor = (regimeConfig: typeof newRegime, taxable: number) =>
    calculateTax({
      month: 4,
      year: 2026,
      // Annualised gross = taxable + standard deduction, so taxable income lands exactly where asked.
      currentMonthGross: (taxable + regimeConfig.standardDeduction) / 12,
      declaration: null,
      taxSlabConfig: regimeConfig,
      financialYearStartMonth: 4,
    });

  it('NEW regime 87A: income just above ₹12L pays only the excess over ₹12L, not the full slab tax', () => {
    const r = taxFor(newRegime, 1210000);
    expect(r.taxableIncome).toBe(1210000);
    expect(r.taxBeforeCess).toBe(61500); // slab tax before relief
    // relief caps tax at the ₹10,000 earned above ₹12,00,000 (+4% cess)
    expect(r.rebate).toBe(51500);
    expect(r.totalAnnualTax).toBe(10400);
  });

  it('NEW regime 87A: no relief once the slab tax is already below the excess', () => {
    const r = taxFor(newRegime, 1275000); // tax 71,250 vs excess 75,000
    expect(r.rebate).toBe(0);
    expect(r.taxBeforeCess).toBe(71250);
  });

  it('OLD regime keeps the hard 87A cliff (no marginal relief)', () => {
    const oldRegime = {
      regime: TaxRegime.OLD,
      ...getDefaultTaxSlabConfig(TaxRegime.OLD),
    };
    const r = taxFor(oldRegime as never, 510000);
    expect(r.rebate).toBe(0);
    expect(r.taxBeforeCess).toBeGreaterThan(0);
  });

  it('surcharge marginal relief: crossing ₹50L costs no more than the income earned above it', () => {
    const slabs = newRegime.slabs;
    const surcharge = newRegime.surchargeSlabs;
    const tax = applySlabs(5010000, slabs); // 10,83,000
    expect(tax).toBe(1083000);
    // plain surcharge would be 10% = 1,08,300; relief caps total at tax(50L) + ₹10,000 excess
    expect(applySurcharge(tax, 5010000, surcharge)).toBe(108300);
    expect(
      applySurchargeWithMarginalRelief(tax, 5010000, surcharge, slabs),
    ).toBe(7000);
  });

  it('surcharge marginal relief leaves the plain surcharge alone well above the threshold', () => {
    const slabs = newRegime.slabs;
    const tax = applySlabs(6000000, slabs);
    expect(
      applySurchargeWithMarginalRelief(
        tax,
        6000000,
        newRegime.surchargeSlabs,
        slabs,
      ),
    ).toBe(applySurcharge(tax, 6000000, newRegime.surchargeSlabs));
  });
});

// Regression: the remaining months were projected as `currentMonthGross ×
// remainingMonths`, so a one-off (overtime/bonus/encashment) in this month was
// taxed as if it recurred every month, and a prorated joining month as if the
// whole year were prorated. With the recurring figure, this month counts once
// and only the regular structure is projected forward.
describe('calculateTax — projection from the recurring structure', () => {
  const taxSlabConfig = {
    regime: TaxRegime.NEW,
    ...getDefaultTaxSlabConfig(TaxRegime.NEW),
  };
  const base = {
    month: 4,
    year: 2026,
    ytdGross: 0,
    ytdTDS: 0,
    declaration: null,
    taxSlabConfig,
    financialYearStartMonth: 4,
  };

  it('a one-off bonus month is counted once, not ×12', () => {
    // Regular 100,000/month plus a 200,000 bonus in April.
    const result = calculateTax({
      ...base,
      currentMonthGross: 300000,
      recurringMonthlyGross: 100000,
    });
    expect(result.grossAnnualIncome).toBe(300000 + 100000 * 11);
    const oldProjection = calculateTax({ ...base, currentMonthGross: 300000 });
    expect(oldProjection.grossAnnualIncome).toBe(300000 * 12);
    expect(result.totalAnnualTax).toBeLessThan(oldProjection.totalAnnualTax);
  });

  it('a prorated joining month does not shrink the whole-year projection', () => {
    const result = calculateTax({
      ...base,
      month: 10,
      currentMonthGross: 50000, // joined mid-October
      recurringMonthlyGross: 150000,
    });
    // October + November..March (5 more months) at the full rate.
    expect(result.remainingMonths).toBe(6);
    expect(result.grossAnnualIncome).toBe(50000 + 150000 * 5);
  });

  it('is identical to the old projection when this month IS the regular month', () => {
    const withRecurring = calculateTax({
      ...base,
      currentMonthGross: 125000,
      recurringMonthlyGross: 125000,
    });
    const without = calculateTax({ ...base, currentMonthGross: 125000 });
    expect(withRecurring).toEqual(without);
  });

  it('in the last FY month only the actual month counts', () => {
    const result = calculateTax({
      ...base,
      month: 3,
      year: 2027,
      currentMonthGross: 80000,
      recurringMonthlyGross: 999999,
    });
    expect(result.remainingMonths).toBe(1);
    expect(result.grossAnnualIncome).toBe(80000);
  });
});

describe('exit-aware and part-year tax (audit B3/B8)', () => {
  const cfg: any = getDefaultTaxSlabConfig(TaxRegime.NEW);
  const slabConfig = {
    regime: TaxRegime.NEW,
    standardDeduction: cfg.standardDeduction,
    slabs: cfg.slabs,
    surchargeSlabs: cfg.surchargeSlabs,
    cessRate: cfg.cessRate,
    rebate87ALimit: cfg.rebate87ALimit,
    rebate87AAmount: cfg.rebate87AAmount,
  };

  it('a leaver is taxed on income actually earned, not a projected full year', () => {
    // 6 months paid at 300,000 (ytd 1.8M, TDS 150,800 withheld so far on a full-year projection), leaving in Oct.
    const projected = calculateTax({
      month: 10,
      year: 2026,
      currentMonthGross: 300000,
      recurringMonthlyGross: 300000,
      ytdGross: 1800000,
      ytdTDS: 150000,
      declaration: null,
      taxSlabConfig: slabConfig,
    });
    const exit = calculateTax({
      month: 10,
      year: 2026,
      currentMonthGross: 300000,
      ytdGross: 1800000,
      ytdTDS: 150000,
      declaration: null,
      taxSlabConfig: slabConfig,
      finalMonth: true,
    });
    expect(exit.remainingMonths).toBe(1);
    // Income 2.1M, not 3.6M.
    expect(exit.grossAnnualIncome).toBe(2100000);
    expect(exit.totalAnnualTax).toBeLessThan(projected.totalAnnualTax);
    expect(exit.monthlyTDS).toBe(exit.totalAnnualTax - 150000);
  });

  it('declared annual rent is scaled to the months employed', () => {
    const base = {
      month: 10,
      year: 2026,
      currentMonthGross: 150000,
      recurringMonthlyGross: 150000,
      basicAnnual: 900000,
      hraReceivedAnnual: 360000,
      declaration: { hraRentPaidAnnual: 360000, isMetroCity: true },
      taxSlabConfig: { ...getOld() },
    };
    function getOld() {
      const o: any = getDefaultTaxSlabConfig(TaxRegime.OLD);
      return {
        regime: TaxRegime.OLD,
        standardDeduction: o.standardDeduction,
        slabs: o.slabs,
        surchargeSlabs: o.surchargeSlabs,
        cessRate: o.cessRate,
        rebate87ALimit: o.rebate87ALimit,
        rebate87AAmount: o.rebate87AAmount,
      };
    }
    const full = calculateTax({ ...base, employmentMonthsInFY: 12 });
    const half = calculateTax({ ...base, employmentMonthsInFY: 6 });
    // rent 360,000 - 10% of 900,000 = 270,000 for 12 months; 6 months: 180,000 - 90,000 = 90,000.
    expect(full.exemptions.hra).toBe(270000);
    expect(half.exemptions.hra).toBe(90000);
  });
});

describe('home-loan interest, 80TTA and section 89 relief (audit gaps)', () => {
  const mk = (regime: TaxRegime) => {
    const c: any = getDefaultTaxSlabConfig(regime);
    return {
      regime,
      standardDeduction: c.standardDeduction,
      slabs: c.slabs,
      surchargeSlabs: c.surchargeSlabs,
      cessRate: c.cessRate,
      rebate87ALimit: c.rebate87ALimit,
      rebate87AAmount: c.rebate87AAmount,
    };
  };
  const base = {
    month: 4,
    year: 2026,
    currentMonthGross: 2400000,
    recurringMonthlyGross: 0,
  };

  it('24(b) is capped at 2,00,000 and 80TTA at 10,000 — old regime only', () => {
    const decl = { homeLoanInterest: 350000, section80TTA: 25000 };
    const old = calculateTax({
      ...base,
      declaration: decl,
      taxSlabConfig: mk(TaxRegime.OLD),
    });
    expect(old.deductions.homeLoanInterest).toBe(200000);
    expect(old.deductions.section80TTA).toBe(10000);
    const plain = calculateTax({
      ...base,
      declaration: null,
      taxSlabConfig: mk(TaxRegime.OLD),
    });
    expect(plain.taxableIncome - old.taxableIncome).toBe(210000);
    const neu = calculateTax({
      ...base,
      declaration: decl,
      taxSlabConfig: mk(TaxRegime.NEW),
    });
    expect(neu.deductions.homeLoanInterest).toBe(0);
    expect(neu.deductions.section80TTA).toBe(0);
  });

  it('section 89 relief reduces the tax after cess in either regime, never below zero', () => {
    for (const regime of [TaxRegime.OLD, TaxRegime.NEW]) {
      const without = calculateTax({
        ...base,
        declaration: null,
        taxSlabConfig: mk(regime),
      });
      const withRelief = calculateTax({
        ...base,
        declaration: { section89Relief: 12000 },
        taxSlabConfig: mk(regime),
      });
      expect(withRelief.relief89).toBe(12000);
      expect(withRelief.totalAnnualTax).toBe(without.totalAnnualTax - 12000);
    }
    const huge = calculateTax({
      ...base,
      declaration: { section89Relief: 99999999 },
      taxSlabConfig: mk(TaxRegime.NEW),
    });
    expect(huge.totalAnnualTax).toBe(0);
  });
});

describe('refund of excess TDS on exit (audit)', () => {
  const cfg: any = getDefaultTaxSlabConfig(TaxRegime.NEW);
  const slab = {
    regime: TaxRegime.NEW,
    standardDeduction: cfg.standardDeduction,
    slabs: cfg.slabs,
    surchargeSlabs: cfg.surchargeSlabs,
    cessRate: cfg.cessRate,
    rebate87ALimit: cfg.rebate87ALimit,
    rebate87AAmount: cfg.rebate87AAmount,
  };
  const base = {
    month: 10,
    year: 2026,
    currentMonthGross: 200000,
    ytdGross: 1860000,
    ytdTDS: 350220,
    declaration: null,
    taxSlabConfig: slab,
    finalMonth: true,
  };

  it('returns the excess as a negative amount when asked to', () => {
    const r = calculateTax({ ...base, refundExcess: true });
    expect(r.totalAnnualTax).toBeLessThan(350220);
    expect(r.monthlyTDS).toBe(r.totalAnnualTax - 350220);
    expect(r.monthlyTDS).toBeLessThan(0);
  });

  it('stops at zero without the option (previous behaviour)', () => {
    expect(calculateTax({ ...base, refundExcess: false }).monthlyTDS).toBe(0);
  });

  it('never refunds more than this employer withheld', () => {
    const r = calculateTax({
      ...base,
      ytdTDS: 1000,
      declaration: { previousEmployerTDS: 500000 },
      refundExcess: true,
    });
    expect(r.monthlyTDS).toBe(-1000);
  });

  it('is ignored outside a final month', () => {
    expect(
      calculateTax({ ...base, finalMonth: false, refundExcess: true })
        .monthlyTDS,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('old regime senior citizen exemption', () => {
  const run = (ageAtFYEnd: number | null) =>
    calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 100000, // 12L annual
      declaration: null,
      taxSlabConfig: {
        regime: TaxRegime.OLD,
        ...getDefaultTaxSlabConfig(TaxRegime.OLD),
      },
      financialYearStartMonth: 4,
      ageAtFYEnd,
    }).taxBeforeCess;
  it('60+ pays 2,500 less and 80+ pays 12,500 less than a non-senior', () => {
    const base = run(40);
    expect(run(null)).toBe(base);
    expect(base - run(65)).toBe(2500);
    expect(base - run(82)).toBe(12500);
  });

  it('rounds the tax payable to the nearest 10 rupees and and withholds exactly that over the year (NEW regime)', () => {
    const taxSlabConfig = {
      regime: TaxRegime.NEW,
      ...getDefaultTaxSlabConfig(TaxRegime.NEW),
    };
    // 1,83,190 a month: tax 2,30,820 + cess 9,233 = 2,40,053 -> 2,40,050
    let ytdGross = 0;
    let ytdTDS = 0;
    const months: number[][] = [
      [4, 2026],
      [5, 2026],
      [6, 2026],
      [7, 2026],
      [8, 2026],
      [9, 2026],
      [10, 2026],
      [11, 2026],
      [12, 2026],
      [1, 2027],
      [2, 2027],
      [3, 2027],
    ];
    const deducted: number[] = [];
    for (const [month, year] of months) {
      const r = calculateTax({
        month,
        year,
        currentMonthGross: 183190,
        recurringMonthlyGross: 183190,
        ytdGross,
        ytdTDS,
        basicAnnual: 1200000,
        declaration: null,
        taxSlabConfig,
        financialYearStartMonth: 4,
      });
      expect(r.totalAnnualTax).toBe(240050);
      deducted.push(r.monthlyTDS);
      ytdGross += 183190;
      ytdTDS += r.monthlyTDS;
    }
    // The balance is re-spread over the months left each time, so a month may differ by Rs. 1 from a flat 20,004.
    expect(deducted.every((v) => v === 20004 || v === 20005)).toBe(true);
    expect(ytdTDS).toBe(240050);
  });
});

describe('deduction caps (audit T-2/T-3/T-5)', () => {
  const oldCfg = {
    regime: TaxRegime.OLD,
    ...getDefaultTaxSlabConfig(TaxRegime.OLD),
  };
  const run = (over: Record<string, unknown>, declaration: object | null) =>
    calculateTax({
      month: 4,
      year: 2026,
      currentMonthGross: 100000,
      basicAnnual: 600000,
      hraReceivedAnnual: 0,
      declaration: declaration as never,
      taxSlabConfig: oldCfg,
      ...over,
    });

  it('caps the standard deduction at the salary actually earned', () => {
    const r = run(
      { currentMonthGross: 20000, employmentMonthsInFY: 1, finalMonth: true },
      { otherIncome: 1500000 },
    );
    expect(r.deductions.standard).toBe(20000);
  });

  it('allows 80D up to 1,00,000 for a senior citizen, 75,000 otherwise', () => {
    const decl = { section80D: 100000 };
    expect(run({ ageAtFYEnd: 40 }, decl).deductions.section80D).toBe(75000);
    expect(run({ ageAtFYEnd: 65 }, decl).deductions.section80D).toBe(100000);
  });

  it('allows 50,000 of savings/deposit interest for a senior (80TTB), 10,000 otherwise', () => {
    const decl = { section80TTA: 50000 };
    expect(run({ ageAtFYEnd: 40 }, decl).deductions.section80TTA).toBe(10000);
    expect(run({ ageAtFYEnd: 70 }, decl).deductions.section80TTA).toBe(50000);
  });

  it('limits the LTA exemption to LTA actually paid', () => {
    const decl = { ltaClaimed: 90000 };
    expect(run({ ltaReceivedAnnual: 30000 }, decl).exemptions.lta).toBe(30000);
    expect(run({ ltaReceivedAnnual: 0 }, decl).exemptions.lta).toBe(0);
  });

  it('limits 80G to 10% of adjusted total income', () => {
    const r = run({}, { section80G: 5000000 });
    expect(r.deductions.section80G).toBeLessThanOrEqual(
      Math.floor((r.grossAnnualIncome - r.deductions.standard) * 0.1),
    );
    expect(r.taxableIncome).toBeGreaterThan(0);
  });
});
