// Pure port of the old backend's loanController.js EMI calculation —
// standard reducing-balance EMI formula, falling back to a flat
// principal/tenure split when interestRate is 0 (the formula is undefined
// at r=0).
export function calculateEmi(
  principal: number,
  interestRate: number,
  tenureMonths: number,
): number {
  const monthlyRate = interestRate / 12 / 100;
  if (monthlyRate > 0) {
    const factor = Math.pow(1 + monthlyRate, tenureMonths);
    return Math.round((principal * monthlyRate * factor) / (factor - 1));
  }
  return Math.round(principal / tenureMonths);
}

// Money helper — loan amounts are Floats, so every derived figure is
// snapped back to paise to keep repeated arithmetic from drifting.
const round2 = (value: number): number => Math.round(value * 100) / 100;

// Interest accrued on the current balance for one month, at the loan's
// annual rate. Zero-rate loans (every ADVANCE, and any interest-free
// LOAN) return 0, which is what keeps their behaviour unchanged.
export function monthlyInterestDue(
  outstandingBalance: number,
  interestRate: number,
): number {
  return round2(Math.max(0, outstandingBalance) * (interestRate / 12 / 100));
}

// Splits one repayment into its interest and principal parts, the way a
// reducing-balance loan actually amortizes: this month's interest is
// taken first, and only what's left reduces the balance.
//
// This used to be `principal = min(amount, balance)` with
// `interest = amount - principal`, which made interestComponent
// identically 0 and decremented the balance by the WHOLE EMI. The EMI
// returned by calculateEmi() already contains the interest, so charging
// all of it against principal repaid the loan faster than the schedule
// and wrote off the lender's entire interest: a 100,000 loan at 12% over
// 12 months silently forgave ~6,620 and closed about a month early.
//
// Anything paid beyond this month's interest plus the whole remaining
// balance is a genuine overpayment; it is deliberately left out of both
// components rather than being folded into interest, so it can't inflate
// reported interest income. See getDueLoanEmis in PayrollService for why
// the payroll engine never produces one.
export function splitRepayment(
  amount: number,
  outstandingBalance: number,
  interestRate: number,
): { interestComponent: number; principalComponent: number } {
  const interestComponent = round2(
    Math.min(amount, monthlyInterestDue(outstandingBalance, interestRate)),
  );
  const principalComponent = round2(
    Math.min(
      Math.max(0, amount - interestComponent),
      Math.max(0, outstandingBalance),
    ),
  );
  return { interestComponent, principalComponent };
}

// What it costs to clear the loan outright this month: the remaining
// balance plus the interest that accrues on it. The cap for a final
// installment — capping at the bare balance (as this used to) leaves the
// interest portion unpaid, so the balance can never reach zero and the
// loan never closes.
export function payoffAmount(
  outstandingBalance: number,
  interestRate: number,
): number {
  return round2(
    Math.max(0, outstandingBalance) +
      monthlyInterestDue(outstandingBalance, interestRate),
  );
}
