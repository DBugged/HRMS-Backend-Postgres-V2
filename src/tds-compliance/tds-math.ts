// Purpose: Pure rules for salary TDS compliance — TDS quarters, the challan due date, and how a month's TDS splits
//   into tax / surcharge / cess for the deductee-wise return.
// Important: TDS quarters follow the government's April-March tax year regardless of an organisation's own
//   payroll financial-year start month; "financialYear" here is the "YYYY-YY" label of that tax year.

export type TdsQuarter = 1 | 2 | 3 | 4;

// Tax year label ("2026-27") a deduction month falls in.
export function taxYearOf(month: number, year: number): string {
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Apr-Jun = 1, Jul-Sep = 2, Oct-Dec = 3, Jan-Mar = 4.
export function quarterOf(month: number): TdsQuarter {
  if (month >= 4 && month <= 6) return 1;
  if (month >= 7 && month <= 9) return 2;
  if (month >= 10) return 3;
  return 4;
}

// The calendar (month, year) pairs of one quarter of a tax year ("2026-27", 3 -> Oct, Nov, Dec 2026).
export function monthsOfQuarter(
  taxYear: string,
  quarter: TdsQuarter,
): { month: number; year: number }[] {
  const startYear = Number(taxYear.slice(0, 4));
  const first = [4, 7, 10, 1][quarter - 1];
  return [0, 1, 2].map((i) => {
    const month = first + i;
    return { month, year: month >= 4 ? startYear : startYear + 1 };
  });
}

export function isValidTaxYear(taxYear: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(taxYear);
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
}

// TDS deducted in a month is due on the 7th of the next month; March's is due on 30 April (non-government
// deductor). Returned as YYYY-MM-DD.
export function challanDueDate(month: number, year: number): string {
  if (month === 3) return `${year}-04-30`;
  const dueMonth = month === 12 ? 1 : month + 1;
  const dueYear = month === 12 ? year + 1 : year;
  return `${dueYear}-${String(dueMonth).padStart(2, '0')}-07`;
}

// Form 138's last-date for a quarter's statement: 31 Jul, 31 Oct, 31 Jan, 31 May.
export function statementDueDate(taxYear: string, quarter: TdsQuarter): string {
  const startYear = Number(taxYear.slice(0, 4));
  return [
    `${startYear}-07-31`,
    `${startYear}-10-31`,
    `${startYear + 1}-01-31`,
    `${startYear + 1}-05-31`,
  ][quarter - 1];
}

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

// Splits one month's TDS into base tax / surcharge / cess in the proportions of the employee's annual
// computation, so the three always add back to the amount actually deducted.
export function splitMonthlyTds(
  tdsDeducted: number,
  annual: { taxAfterRebate: number; surcharge: number; cess: number } | null,
): { tax: number; surcharge: number; cess: number } {
  // A negative amount is excess tax given back on exit — it stays a plain negative tax adjustment.
  if (!annual || tdsDeducted <= 0) {
    return { tax: tdsDeducted, surcharge: 0, cess: 0 };
  }
  const total = annual.taxAfterRebate + annual.surcharge + annual.cess;
  if (total <= 0) return { tax: tdsDeducted, surcharge: 0, cess: 0 };
  const surcharge = Math.round((tdsDeducted * annual.surcharge) / total);
  const cess = Math.round((tdsDeducted * annual.cess) / total);
  return { tax: tdsDeducted - surcharge - cess, surcharge, cess };
}

// What stands in the way of issuing Form 130 / Form 16 (blockers: the certificate would be unusable) and what only
// deserves a look (warnings: it can still be issued). The employer's TAN and PAN identify the deductor on the
// certificate; without them it cannot be matched to the return. The employee's PAN missing is a warning - the
// certificate is still the employee's record of tax deducted - and it is worth fixing because tax is deducted at the
// higher rate for someone without a PAN.
export function form130Issues(
  employer: { tan?: string | null; pan?: string | null } | null,
  employeePan: string | null | undefined,
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const tan = (employer?.tan ?? '').trim().toUpperCase();
  const pan = (employer?.pan ?? '').trim().toUpperCase();
  if (!tan) {
    blockers.push(
      "The company's TAN is not set. Add it in Organization Settings > Registration Details before issuing the certificate.",
    );
  } else if (!TAN_PATTERN.test(tan)) {
    warnings.push(`The company's TAN (${tan}) does not look like a valid TAN.`);
  }
  if (!pan) {
    blockers.push(
      "The company's PAN is not set. Add it in Organization Settings > Registration Details before issuing the certificate.",
    );
  } else if (!PAN_PATTERN.test(pan)) {
    warnings.push(`The company's PAN (${pan}) does not look like a valid PAN.`);
  }
  const empPan = (employeePan ?? '').trim().toUpperCase();
  if (!empPan) {
    warnings.push(
      "The employee's PAN is not on their profile, so the certificate shows '-' for it. Add it to their profile and issue the certificate again.",
    );
  } else if (!PAN_PATTERN.test(empPan)) {
    warnings.push(
      `The employee's PAN (${empPan}) does not look like a valid PAN.`,
    );
  }
  return { blockers, warnings };
}
