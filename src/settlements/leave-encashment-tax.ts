// Income-tax s.10(10AA): leave encashment received on leaving a (non-government) job is exempt up to the least of
//   (a) the amount actually received,
//   (b) Rs 25 lakh (CBDT notification 31/2023, from 1-Apr-2023),
//   (c) ten months' average salary (basic + dearness allowance), and
//   (d) the cash equivalent of leave entitlement - 30 days for every completed year of service.
// Kept pure so the arithmetic is testable. Limits already used with an earlier employer are not known here; the
// employee claims any difference in their own return.
export const LEAVE_ENCASHMENT_EXEMPTION_CAP = 2500000;
export const LEAVE_EXEMPTION_AVERAGE_MONTHS = 10;
export const LEAVE_DAYS_PER_YEAR_OF_SERVICE = 30;

export function leaveEncashmentExemption(opts: {
  amount: number;
  // Monthly basic + dearness allowance (the "salary" for this exemption).
  basicPlusDaMonthly: number;
  yearsOfService: number;
}): number {
  const { amount, basicPlusDaMonthly, yearsOfService } = opts;
  if (amount <= 0 || basicPlusDaMonthly <= 0) return 0;
  const dailyWage = basicPlusDaMonthly / 30;
  const entitlementCap =
    LEAVE_DAYS_PER_YEAR_OF_SERVICE *
    Math.floor(Math.max(0, yearsOfService)) *
    dailyWage;
  const exempt = Math.min(
    amount,
    LEAVE_ENCASHMENT_EXEMPTION_CAP,
    LEAVE_EXEMPTION_AVERAGE_MONTHS * basicPlusDaMonthly,
    entitlementCap,
  );
  return Math.max(0, Math.round(exempt));
}
