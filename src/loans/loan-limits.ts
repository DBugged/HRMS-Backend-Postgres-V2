// Limits on what can be sanctioned. The EMI cap is the company's rule: the total of an employee's loan/advance EMIs
// may not exceed 30% of their net payable (monthly take-home) salary.
export const MAX_EMI_SHARE_OF_NET_SALARY = 0.3;
export const MAX_LOAN_PRINCIPAL = 10_000_000;
export const MAX_LOAN_TENURE_MONTHS = 60;
export const MAX_LOAN_INTEREST_RATE = 30; // annual %

// A loan may start a little in the past (sanctioned late) or up to a year ahead, not decades away.
export const START_MONTHS_BACK = 3;
export const START_MONTHS_AHEAD = 12;

export function loanStartError(
  startMonth: number,
  startYear: number,
  now: Date = new Date(),
): string | null {
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const startIndex = startYear * 12 + (startMonth - 1);
  if (startIndex < nowIndex - START_MONTHS_BACK) {
    return `The first EMI month cannot be more than ${START_MONTHS_BACK} months in the past.`;
  }
  if (startIndex > nowIndex + START_MONTHS_AHEAD) {
    return `The first EMI month cannot be more than ${START_MONTHS_AHEAD} months from now.`;
  }
  return null;
}

// Whether the employee's total EMI (existing active loans plus this one) stays inside the cap.
export function emiCapError(
  totalEmi: number,
  netMonthlySalary: number,
): string | null {
  const limit = Math.floor(netMonthlySalary * MAX_EMI_SHARE_OF_NET_SALARY);
  if (totalEmi <= limit) return null;
  return `Total loan EMI would be ${totalEmi} a month, above the ${MAX_EMI_SHARE_OF_NET_SALARY * 100}% limit of the employee's net monthly salary (${netMonthlySalary} -> limit ${limit}).`;
}
