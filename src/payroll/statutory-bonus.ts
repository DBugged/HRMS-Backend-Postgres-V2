// Purpose: The annual statutory bonus (Code on Wages, Chapter on Bonus; earlier the Payment of Bonus Act, 1965) for one
//   employee and one accounting year, from the monthly Basic + DA the payroll actually paid.
// Important: pure arithmetic only. The rate is the one the organisation has set (8.33%-20%): the allocable-surplus test
//   that decides it, and set-on / set-off, are the company's own accounts and are not computed here. Per-month
//   eligibility and counting payable days as days worked are the conservative reading - confirm with the CA.

// Minimum bonus: 8.33% of wages or ₹100, whichever is higher (employee with at least 30 days' work in the year).
export const BONUS_MIN_AMOUNT = 100;
export const BONUS_MIN_DAYS = 30;
// The calculation base is never below this, whatever the minimum wage.
export const BONUS_BASE_FLOOR = 7000;

export interface BonusMonthInput {
  month: number;
  year: number;
  // Basic + DA earned in the month (already reduced for LOP / joining).
  basicDaEarned: number;
  payableDays: number;
  totalDays: number;
}

export interface BonusConfig {
  rate: number;
  eligibilityCeiling: number;
  calculationCeiling: number;
  // The applicable minimum wage for the employee's scheduled employment / zone / skill, per month. The calculation
  // base is the higher of ₹7,000 and this.
  minimumWage?: number;
}

export interface BonusResult {
  eligible: boolean;
  reason: string | null;
  daysWorked: number;
  eligibleMonths: number;
  baseWages: number;
  bonus: number;
  // The monthly ceiling the base was capped at.
  calculationCeiling: number;
}

// The monthly wage the calculation is capped at: the configured ceiling, but never below ₹7,000 or the applicable
// minimum wage.
export function effectiveBonusCeiling(
  calculationCeiling: number,
  minimumWage = 0,
): number {
  return Math.max(BONUS_BASE_FLOOR, calculationCeiling, minimumWage);
}

export function computeStatutoryBonus(
  months: BonusMonthInput[],
  config: BonusConfig,
): BonusResult {
  const ceiling = effectiveBonusCeiling(
    config.calculationCeiling,
    config.minimumWage,
  );
  const daysWorked = months.reduce(
    (s, m) => s + Math.max(0, m.payableDays),
    0,
  );
  let base = 0;
  let eligibleMonths = 0;
  for (const m of months) {
    if (m.totalDays <= 0 || m.payableDays <= 0 || m.basicDaEarned <= 0) continue;
    const ratio = Math.min(1, m.payableDays / m.totalDays);
    // The wage the employee is paid for a full month - eligibility is judged on this, not on a part month's earnings.
    const monthlyRate = m.basicDaEarned / ratio;
    if (monthlyRate > config.eligibilityCeiling) continue;
    eligibleMonths += 1;
    base += Math.min(m.basicDaEarned, ceiling * ratio);
  }
  if (eligibleMonths === 0) {
    return {
      eligible: false,
      reason: 'Basic + DA is above the eligibility ceiling in every month',
      daysWorked,
      eligibleMonths,
      baseWages: 0,
      bonus: 0,
      calculationCeiling: ceiling,
    };
  }
  if (daysWorked < BONUS_MIN_DAYS) {
    return {
      eligible: false,
      reason: `Worked fewer than ${BONUS_MIN_DAYS} days in the year`,
      daysWorked,
      eligibleMonths,
      baseWages: Math.round(base),
      bonus: 0,
      calculationCeiling: ceiling,
    };
  }
  const raw = Math.round((base * config.rate) / 100);
  return {
    eligible: true,
    reason: null,
    daysWorked,
    eligibleMonths,
    baseWages: Math.round(base),
    bonus: Math.max(raw, BONUS_MIN_AMOUNT),
    calculationCeiling: ceiling,
  };
}
