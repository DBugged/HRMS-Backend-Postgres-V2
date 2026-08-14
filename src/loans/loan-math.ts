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
