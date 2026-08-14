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
  ytdGross?: number;
  ytdTDS?: number;
  basicAnnual?: number;
  hraReceivedAnnual?: number;
  declaration: DeclarationLike | null;
  taxSlabConfig: TaxSlabConfigLike;
  financialYearStartMonth?: number;
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
    other: number;
  };
  taxableIncome: number;
  taxBeforeCess: number;
  rebate: number;
  surcharge: number;
  cess: number;
  totalAnnualTax: number;
  ytdTDS: number;
  remainingMonths: number;
  monthlyTDS: number;
}

export function calculateTax({
  month,
  year,
  currentMonthGross,
  ytdGross = 0,
  ytdTDS = 0,
  basicAnnual = 0,
  hraReceivedAnnual = 0,
  declaration,
  taxSlabConfig,
  financialYearStartMonth = 4,
}: CalculateTaxInput): TaxDetails {
  if (!taxSlabConfig) {
    throw new Error(
      'No tax slab configuration found for this financial year/regime',
    );
  }

  const regime = taxSlabConfig.regime;
  const remainingMonths = monthsRemainingInFY(
    month,
    year,
    financialYearStartMonth,
  );
  const projectedRemainingGross = currentMonthGross * remainingMonths;
  const previousEmployerIncome = declaration?.previousEmployerIncome || 0;
  const otherIncome = declaration?.otherIncome || 0;

  const grossAnnualIncome =
    ytdGross + projectedRemainingGross + previousEmployerIncome + otherIncome;

  const exemptions = { hra: 0, lta: 0 };
  const deductions = {
    standard: taxSlabConfig.standardDeduction || 0,
    section80C: 0,
    section80CCD1B: 0,
    section80CCD2: 0,
    section80D: 0,
    section80E: 0,
    section80G: 0,
    other: 0,
  };

  if (regime === TaxRegime.OLD && declaration) {
    exemptions.hra = computeHraExemption({
      hraReceivedAnnual,
      basicAnnual,
      rentPaidAnnual: declaration.hraRentPaidAnnual || 0,
      isMetroCity: !!declaration.isMetroCity,
    });
    exemptions.lta = declaration.ltaClaimed || 0;
    deductions.section80C = Math.min(declaration.section80C || 0, 150000);
    deductions.section80CCD1B = Math.min(
      declaration.section80CCD1B || 0,
      50000,
    );
    deductions.section80D = Math.min(declaration.section80D || 0, 100000);
    deductions.section80E = declaration.section80E || 0;
    deductions.section80G = declaration.section80G || 0;
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
  const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);

  const taxableIncome = Math.max(
    0,
    grossAnnualIncome - totalExemptions - totalDeductions,
  );

  const taxBeforeCess = applySlabs(taxableIncome, taxSlabConfig.slabs);

  let rebate = 0;
  if (taxableIncome <= (taxSlabConfig.rebate87ALimit || 0)) {
    rebate = Math.min(taxBeforeCess, taxSlabConfig.rebate87AAmount || 0);
  }
  const taxAfterRebate = Math.max(0, taxBeforeCess - rebate);

  const surcharge = applySurcharge(
    taxAfterRebate,
    taxableIncome,
    taxSlabConfig.surchargeSlabs,
  );
  const cess =
    ((taxAfterRebate + surcharge) * (taxSlabConfig.cessRate || 0)) / 100;

  const totalAnnualTax = Math.round(taxAfterRebate + surcharge + cess);
  const remainingTax = Math.max(0, totalAnnualTax - ytdTDS);
  const monthlyTDS = Math.round(remainingTax / remainingMonths);

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
    totalAnnualTax,
    ytdTDS,
    remainingMonths,
    monthlyTDS,
  };
}
