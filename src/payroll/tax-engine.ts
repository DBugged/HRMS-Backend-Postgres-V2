import { TaxRegime } from '@prisma/client';
import { getFinancialYear } from '../payroll-settings/financial-year';

/**
 * Indian Income Tax (TDS) engine — pure port of the old backend's
 * taxEngine.js. All rates/slabs are configurable per financial year via
 * TaxSlabConfig; nothing here is hardcoded to a specific year's rules.
 * `getFinancialYear` itself is reused from Batch 7b, not duplicated.
 */

// Months (inclusive of the current one) remaining until the FY closes.
export function monthsRemainingInFY(
  month: number,
  year: number,
  startMonth: number,
): number {
  const monthIndexInFY =
    month >= startMonth ? month - startMonth : month + (12 - startMonth);
  return 12 - monthIndexInFY;
}

export interface TaxSlab {
  from?: number;
  to?: number | null;
  rate: number;
}

export function applySlabs(taxableIncome: number, slabs: TaxSlab[]): number {
  let tax = 0;
  for (const slab of slabs) {
    const from = slab.from || 0;
    const to = slab.to === null || slab.to === undefined ? Infinity : slab.to;
    if (taxableIncome > from) {
      const taxableInSlab = Math.min(taxableIncome, to) - from;
      if (taxableInSlab > 0) tax += (taxableInSlab * slab.rate) / 100;
    }
  }
  return tax;
}

export function applySurcharge(
  tax: number,
  taxableIncome: number,
  surchargeSlabs: TaxSlab[] = [],
): number {
  for (const s of surchargeSlabs) {
    const from = s.from || 0;
    const to = s.to === null || s.to === undefined ? Infinity : s.to;
    if (taxableIncome > from && taxableIncome <= to) {
      return (tax * s.rate) / 100;
    }
  }
  return 0;
}

// Surcharge with marginal relief: the total of tax + surcharge on income just above a surcharge threshold may not
// exceed the tax (with the lower band's surcharge) at that threshold plus the income earned above it — otherwise
// crossing a threshold by ₹1 would cost lakhs. `incomeSlabs` are the regime's slabs, needed to price the tax at the
// threshold. Falls back to the plain surcharge when nothing in the band is capped.
export function applySurchargeWithMarginalRelief(
  tax: number,
  taxableIncome: number,
  surchargeSlabs: TaxSlab[],
  incomeSlabs: TaxSlab[],
  // Prices the tax at the threshold. Defaults to the slabs as they stand; the caller passes its own where the
  // taxpayer's tax is not the plain slab tax (the old regime's higher exemption for a senior / super-senior
  // citizen), so the relief cap is measured on the same basis as the tax being capped.
  taxAt: (income: number) => number = (income) =>
    applySlabs(income, incomeSlabs),
): number {
  const plain = applySurcharge(tax, taxableIncome, surchargeSlabs);
  if (plain <= 0) return plain;
  const band = surchargeSlabs.find((s) => {
    const from = s.from || 0;
    const to = s.to === null || s.to === undefined ? Infinity : s.to;
    return taxableIncome > from && taxableIncome <= to;
  });
  if (!band) return plain;
  const threshold = band.from || 0;
  // The surcharge rate in force just below the threshold (0 for the first band).
  const lower = surchargeSlabs.find((s) => (s.to ?? Infinity) === threshold);
  const lowerRate = lower ? lower.rate : 0;
  const taxAtThreshold = taxAt(threshold);
  const maxTotal =
    taxAtThreshold * (1 + lowerRate / 100) + (taxableIncome - threshold);
  return Math.max(0, Math.min(plain, maxTotal - tax));
}

export interface HraExemptionInput {
  hraReceivedAnnual: number;
  basicAnnual: number;
  rentPaidAnnual: number;
  isMetroCity: boolean;
}

// HRA exemption (old regime only): least of (1) HRA actually received
// annually, (2) rent paid - 10% of Basic, (3) 50%/40% of Basic (metro/non).
export function computeHraExemption({
  hraReceivedAnnual,
  basicAnnual,
  rentPaidAnnual,
  isMetroCity,
}: HraExemptionInput): number {
  if (!rentPaidAnnual) return 0;
  const rentMinusTenPct = Math.max(0, rentPaidAnnual - 0.1 * basicAnnual);
  const cityLimit = (isMetroCity ? 0.5 : 0.4) * basicAnnual;
  return Math.max(0, Math.min(hraReceivedAnnual, rentMinusTenPct, cityLimit));
}

export interface DeclarationLike {
  previousEmployerIncome?: number | null;
  previousEmployerTDS?: number | null;
  otherIncome?: number | null;
  hraRentPaidAnnual?: number | null;
  isMetroCity?: boolean | null;
  ltaClaimed?: number | null;
  section80C?: number | null;
  section80CCD1B?: number | null;
  section80CCD2?: number | null;
  section80D?: number | null;
  section80E?: number | null;
  section80G?: number | null;
  otherDeductions?: number | null;
  homeLoanInterest?: number | null;
  section80TTA?: number | null;
  section89Relief?: number | null;
}

export interface TaxSlabConfigLike {
  regime: TaxRegime;
  standardDeduction: number;
  slabs: TaxSlab[];
  surchargeSlabs: TaxSlab[];
  cessRate: number;
  rebate87ALimit: number;
  rebate87AAmount: number;
}

export interface CalculateTaxInput {
  month: number;
  year: number;
  currentMonthGross: number;
  // The employee's regular full-month taxable pay (recurring monthly components only — no proration, overtime,
  // arrears, bonus, encashment or other one-offs). When given, the months after this one are projected at this
  // figure and this month's actual gross is counted once; when omitted, every remaining month is projected at
  // currentMonthGross (the original behaviour).
  recurringMonthlyGross?: number;
  ytdGross?: number;
  ytdTDS?: number;
  basicAnnual?: number;
  hraReceivedAnnual?: number;
  // Leave Travel Allowance actually paid in the year (from the salary structure). The LTA exemption can never
  // exceed what was paid; when omitted, the declared figure is used as before.
  ltaReceivedAnnual?: number;
  declaration: DeclarationLike | null;
  taxSlabConfig: TaxSlabConfigLike;
  financialYearStartMonth?: number;
  // Last pay of an employee who is leaving (final settlement): nothing more will be earned this year, so the
  // year is NOT projected forward — the tax is trued up on the income actually earned and the whole balance is
  // withheld now. Projecting the remaining months over-deducted every leaver.
  finalMonth?: boolean;
  // With finalMonth: when the tax already withheld exceeds the tax due, return the excess (a negative monthlyTDS,
  // limited to what this employer actually withheld) instead of stopping at zero.
  refundExcess?: boolean;
  // Months of this FY the income base covers (months already paid by this employer + this month and the months
  // still to come). basicAnnual / hraReceivedAnnual are expected to span the same months, and the declared annual
  // rent is scaled to them — a part-year employee must not get a 12-month HRA exemption against 6 months of pay.
  employmentMonthsInFY?: number;
  // Employee's age on the last day of the financial year. Old regime only: 60+ is exempt up to 3,00,000 and 80+
  // up to 5,00,000 (instead of 2,50,000). Unknown age = treated as under 60.
  ageAtFYEnd?: number | null;
}

// Basic-exemption limit of the old regime for an age (senior / super-senior citizen).
export function oldRegimeExemptionLimit(age?: number | null): number {
  if (age == null) return 250000;
  return age >= 80 ? 500000 : age >= 60 ? 300000 : 250000;
}

export interface TaxDetails {
  regime: TaxRegime;
  financialYear: string;
  grossAnnualIncome: number;
  exemptions: { hra: number; lta: number };
  deductions: {
    standard: number;
    section80C: number;
    section80CCD1B: number;
    section80CCD2: number;
    section80D: number;
    section80E: number;
    section80G: number;
    section80TTA: number;
    homeLoanInterest: number;
    other: number;
  };
  taxableIncome: number;
  taxBeforeCess: number;
  rebate: number;
  surcharge: number;
  cess: number;
  // Section 89 relief applied (already deducted from totalAnnualTax).
  relief89: number;
  totalAnnualTax: number;
  ytdTDS: number;
  // TDS the previous employer already deducted this financial year, credited
  // against the annual liability alongside ytdTDS.
  previousEmployerTDS: number;
  remainingMonths: number;
  monthlyTDS: number;
}

export function calculateTax({
  month,
  year,
  currentMonthGross,
  recurringMonthlyGross,
  ytdGross = 0,
  ytdTDS = 0,
  basicAnnual = 0,
  hraReceivedAnnual = 0,
  ltaReceivedAnnual,
  declaration,
  taxSlabConfig,
  financialYearStartMonth = 4,
  finalMonth = false,
  refundExcess = false,
  employmentMonthsInFY = 12,
  ageAtFYEnd = null,
}: CalculateTaxInput): TaxDetails {
  if (!taxSlabConfig) {
    throw new Error(
      'No tax slab configuration found for this financial year/regime.',
    );
  }

  const regime = taxSlabConfig.regime;
  const remainingMonths = finalMonth
    ? 1
    : monthsRemainingInFY(month, year, financialYearStartMonth);
  // Multiplying this month's actual gross by every remaining month projected a one-off (an overtime/bonus/
  // encashment month) as if it recurred all year, and a prorated joining/LOP month as if the whole year were
  // prorated. With the recurring figure, this month counts once at its actual amount and only the regular
  // structure is projected forward.
  const projectedRemainingGross = finalMonth
    ? currentMonthGross
    : recurringMonthlyGross === undefined
      ? currentMonthGross * remainingMonths
      : currentMonthGross + recurringMonthlyGross * (remainingMonths - 1);
  const previousEmployerIncome = declaration?.previousEmployerIncome || 0;
  // Tax the previous employer already deducted on that income. Collected on
  // the declaration form since day one but never read, so previous-employer
  // income was added to the annual gross while the tax already paid on it was
  // ignored — a systematic over-deduction for every mid-year joiner.
  const previousEmployerTDS = declaration?.previousEmployerTDS || 0;
  const otherIncome = declaration?.otherIncome || 0;

  const grossAnnualIncome =
    ytdGross + projectedRemainingGross + previousEmployerIncome + otherIncome;

  // The standard deduction is a deduction from salary: it can't exceed the salary actually earned this year (this
  // employer's salary plus the previous employer's), so a part-year joiner or a near-zero salary doesn't shelter
  // other income with a full standard deduction.
  const salaryIncome = Math.max(
    0,
    ytdGross + projectedRemainingGross + previousEmployerIncome,
  );
  const exemptions = { hra: 0, lta: 0 };
  const deductions = {
    standard: Math.min(taxSlabConfig.standardDeduction || 0, salaryIncome),
    section80C: 0,
    section80CCD1B: 0,
    section80CCD2: 0,
    section80D: 0,
    section80E: 0,
    section80G: 0,
    section80TTA: 0,
    homeLoanInterest: 0,
    other: 0,
  };

  if (regime === TaxRegime.OLD && declaration) {
    exemptions.hra = computeHraExemption({
      hraReceivedAnnual,
      basicAnnual,
      rentPaidAnnual:
        ((declaration.hraRentPaidAnnual || 0) *
          Math.min(12, Math.max(0, employmentMonthsInFY))) /
        12,
      isMetroCity: !!declaration.isMetroCity,
    });
    // LTA is exempt only up to what the employer actually paid.
    exemptions.lta =
      ltaReceivedAnnual === undefined
        ? declaration.ltaClaimed || 0
        : Math.min(declaration.ltaClaimed || 0, Math.max(0, ltaReceivedAnnual));
    deductions.section80C = Math.min(declaration.section80C || 0, 150000);
    deductions.section80CCD1B = Math.min(
      declaration.section80CCD1B || 0,
      50000,
    );
    // Section 80D ceiling: 25,000 self/family + 25,000 parents, each 50,000 where the person covered is a senior
    // citizen. For a non-senior employee the most they can claim is 25,000 + 50,000 (senior parents) = 75,000; a
    // senior employee can reach 50,000 + 50,000 = 1,00,000.
    const isSenior = (ageAtFYEnd ?? 0) >= 60;
    deductions.section80D = Math.min(
      declaration.section80D || 0,
      isSenior ? 100000 : 75000,
    );
    deductions.section80E = declaration.section80E || 0;
    deductions.section80G = declaration.section80G || 0; // capped below, against adjusted total income
    // 24(b): interest on a self-occupied home loan — set off against income, at most 2,00,000 a year (old regime
    // only; the new regime allows no such deduction).
    deductions.homeLoanInterest = Math.min(
      declaration.homeLoanInterest || 0,
      200000,
    );
    // 80TTA: savings-account interest, at most 10,000. A senior citizen claims 80TTB instead (interest on deposits
    // of any kind, at most 50,000) and cannot claim 80TTA.
    deductions.section80TTA = Math.min(
      declaration.section80TTA || 0,
      (ageAtFYEnd ?? 0) >= 60 ? 50000 : 10000,
    );
    deductions.other = declaration.otherDeductions || 0;
  }

  // 80CCD(2) — employer NPS contribution — is allowed under both regimes,
  // capped at 10%/14% of Basic (Old/New). DA isn't modeled as a separate
  // figure, so the cap applies against Basic alone (documented
  // simplification, ported as-is).
  const section80CCD2Cap =
    (regime === TaxRegime.NEW ? 0.14 : 0.1) * basicAnnual;
  deductions.section80CCD2 = Math.min(
    declaration?.section80CCD2 || 0,
    section80CCD2Cap,
  );

  const totalExemptions = exemptions.hra + exemptions.lta;
  // Section 80G donations are limited to 10% of adjusted total income (income after every other deduction): an
  // uncapped figure could take taxable income to zero.
  if (deductions.section80G > 0) {
    const withoutDonations = Object.entries(deductions)
      .filter(([key]) => key !== 'section80G')
      .reduce((sum, [, v]) => sum + v, 0);
    const adjustedIncome = Math.max(
      0,
      grossAnnualIncome - totalExemptions - withoutDonations,
    );
    deductions.section80G = Math.min(
      deductions.section80G,
      Math.floor(adjustedIncome * 0.1),
    );
  }
  const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);

  const taxableIncome = Math.max(
    0,
    grossAnnualIncome - totalExemptions - totalDeductions,
  );

  let taxBeforeCess = applySlabs(taxableIncome, taxSlabConfig.slabs);
  if (regime === TaxRegime.OLD) {
    // Senior / super-senior: the higher exemption removes the tax on the extra band the standard slabs charge.
    const limit = oldRegimeExemptionLimit(ageAtFYEnd);
    if (limit > 250000) {
      taxBeforeCess = Math.max(
        0,
        taxBeforeCess -
          applySlabs(Math.min(taxableIncome, limit), taxSlabConfig.slabs),
      );
    }
  }

  let rebate = 0;
  const rebateLimit = taxSlabConfig.rebate87ALimit || 0;
  if (taxableIncome <= rebateLimit) {
    rebate = Math.min(taxBeforeCess, taxSlabConfig.rebate87AAmount || 0);
  } else if (
    regime === TaxRegime.NEW &&
    rebateLimit > 0 &&
    (taxSlabConfig.rebate87AAmount || 0) > 0
  ) {
    // 87A marginal relief (new regime only — the old regime's rebate is a hard cliff): for income just above
    // the rebate limit, tax before cess may not exceed the income earned over that limit. Without this, ₹1
    // above ₹12 lakh would cost the full ~₹60,000 the rebate was waiving.
    const cap = taxableIncome - rebateLimit;
    if (taxBeforeCess > cap) rebate = taxBeforeCess - cap;
  }
  const taxAfterRebate = Math.max(0, taxBeforeCess - rebate);

  const surcharge = applySurchargeWithMarginalRelief(
    taxAfterRebate,
    taxableIncome,
    taxSlabConfig.surchargeSlabs,
    taxSlabConfig.slabs,
    (income) => {
      let t = applySlabs(income, taxSlabConfig.slabs);
      if (regime === TaxRegime.OLD) {
        // Same senior / super-senior adjustment as the tax itself (the higher basic exemption).
        const limit = oldRegimeExemptionLimit(ageAtFYEnd);
        if (limit > 250000) {
          t = Math.max(
            0,
            t - applySlabs(Math.min(income, limit), taxSlabConfig.slabs),
          );
        }
      }
      return t;
    },
  );
  const cess =
    ((taxAfterRebate + surcharge) * (taxSlabConfig.cessRate || 0)) / 100;

  // Section 89 relief (HR-entered from Form 10E) comes off the tax after cess, in either regime.
  const taxBeforeRelief = Math.round(taxAfterRebate + surcharge + cess);
  const relief89 = Math.min(
    taxBeforeRelief,
    Math.max(0, Math.round(declaration?.section89Relief || 0)),
  );
  // Section 288B: the tax payable is rounded off to the nearest ten rupees.
  const totalAnnualTax = Math.round((taxBeforeRelief - relief89) / 10) * 10;
  // Credit everything already withheld this year — this employer's YTD TDS
  // and whatever the previous employer deducted.
  const owed = totalAnnualTax - ytdTDS - previousEmployerTDS;
  const remainingTax = Math.max(0, owed);
  // A leaver's excess comes back (only this employer's own withholding can be returned by this employer).
  const refund =
    finalMonth && refundExcess && owed < 0 ? -Math.min(-owed, ytdTDS) : 0;
  const monthlyTDS =
    refund < 0
      ? Math.round(refund)
      : Math.round(remainingTax / remainingMonths);

  return {
    regime,
    financialYear: getFinancialYear(month, year, financialYearStartMonth),
    grossAnnualIncome: Math.round(grossAnnualIncome),
    exemptions,
    deductions,
    taxableIncome: Math.round(taxableIncome),
    taxBeforeCess: Math.round(taxBeforeCess),
    rebate: Math.round(rebate),
    surcharge: Math.round(surcharge),
    cess: Math.round(cess),
    relief89,
    totalAnnualTax,
    ytdTDS,
    previousEmployerTDS,
    remainingMonths,
    monthlyTDS,
  };
}
