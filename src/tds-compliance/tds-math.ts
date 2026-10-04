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
