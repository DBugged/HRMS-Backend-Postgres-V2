// Purpose: Opening balances - what an employee earned and had deducted in the months of the financial year BEFORE this
//   company started running payroll here - and how they fold into the year-to-date the tax engine annualises from.
// Responsibilities: validate a balance (rows from the form or an import) and add it to the year-to-date figures.
// Important: pure. Without these, a first run in September annualises only Sep-Mar and the TDS comes out too low.

export interface YtdFigures {
  ytdGross: number;
  ytdTDS: number;
  ytdMonths: number;
  ytdProfessionalTax: number;
}

export interface OpeningBalanceValues {
  monthsCovered: number;
  taxableEarnings: number;
  tdsDeducted: number;
  pfPaid: number;
  ptPaid: number;
}

/** Year-to-date from this system's runs plus the opening balance (if any). Months are capped at a full year. */
export function withOpeningBalance(
  ytd: YtdFigures,
  opening: OpeningBalanceValues | null | undefined,
): YtdFigures {
  if (!opening) return ytd;
  return {
    ytdGross: ytd.ytdGross + opening.taxableEarnings,
    ytdTDS: ytd.ytdTDS + opening.tdsDeducted,
    ytdMonths: Math.min(12, ytd.ytdMonths + opening.monthsCovered),
    ytdProfessionalTax: ytd.ytdProfessionalTax + opening.ptPaid,
  };
}

/** Months from the FY start up to (not including) the given month: 5 for September in an April year. */
export function monthsBeforeInFY(month: number, fyStartMonth: number): number {
  return (month - fyStartMonth + 12) % 12;
}

/** The first problem with a balance, in plain words, or null when it is fine. `maxMonths` = months before go-live. */
export function validateOpeningBalance(
  v: OpeningBalanceValues,
  maxMonths: number,
): string | null {
  const nums = [
    v.monthsCovered,
    v.taxableEarnings,
    v.tdsDeducted,
    v.pfPaid,
    v.ptPaid,
  ];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return 'Enter numbers only.';
  }
  if (nums.some((n) => n < 0)) return 'Amounts cannot be negative.';
  if (!Number.isInteger(v.monthsCovered))
    return 'Months must be a whole number.';
  if (v.monthsCovered > maxMonths) {
    return `Months cannot be more than ${maxMonths} (the months before this company's first payroll).`;
  }
  if (v.monthsCovered === 0 && nums.some((n) => n > 0)) {
    return 'Enter the number of months these amounts cover.';
  }
  if (v.tdsDeducted > v.taxableEarnings) {
    return 'Tax deducted is more than the earnings.';
  }
  return null;
}
