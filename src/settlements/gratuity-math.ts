// Payment of Gratuity Act, 1972 — the arithmetic of s.4, kept pure so the
// rules are testable without a settlement fixture.

// s.2A: five years of continuous service before gratuity is payable at all.
export const YEARS_FOR_GRATUITY_ELIGIBILITY = 5;

// s.4(3): the statutory ceiling on gratuity payable, raised to 20 lakh in
// 2018. There was no cap here at all, so a long-serving senior employee's
// settlement could pay out well above it.
export const GRATUITY_STATUTORY_CAP = 2000000;

// s.4(2): service is counted in COMPLETED years, with a part-year of more
// than six months rounded up to a full year. The settlement used the raw
// fractional figure instead, so 7.4 years paid for 7.4 years — 170,769
// against the statutory 161,538 on a 40,000 basic.
export function completedYearsOfService(yearsOfService: number): number {
  const wholeYears = Math.floor(yearsOfService);
  return yearsOfService - wholeYears > 0.5 ? wholeYears + 1 : wholeYears;
}

// 15 days' wages (a month taken as 26 working days) for every completed
// year, capped at the statutory ceiling. Returns 0 below the eligibility
// threshold.
export function calculateGratuity(
  basicMonthly: number,
  yearsOfService: number,
): number {
  if (yearsOfService < YEARS_FOR_GRATUITY_ELIGIBILITY) return 0;
  const raw =
    basicMonthly * (15 / 26) * completedYearsOfService(yearsOfService);
  return Math.min(Math.round(raw), GRATUITY_STATUTORY_CAP);
}
