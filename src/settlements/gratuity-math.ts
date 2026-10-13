// Payment of Gratuity Act, 1972 — the arithmetic of s.4, kept pure so the
// rules are testable without a settlement fixture.

// s.2A: five years of continuous service before gratuity is payable at all.
export const YEARS_FOR_GRATUITY_ELIGIBILITY = 5;

// Code on Social Security, 2020 (in force 21-Nov-2025): a fixed-term employee is gratuity-eligible after ONE year of
// continuous service (pro-rata to the contract), not five.
export const YEARS_FOR_FIXED_TERM_GRATUITY = 1;

// Built-in employee types that are fixed-term engagements — a contract or temporary employee. Interns, apprentices,
// trainees, freelancers and third-party payroll aren't the employer's employees for gratuity purposes. A custom
// type whose name says fixed-term / contract / temporary counts too.
export function isFixedTermEmployeeType(
  employeeType: string | null | undefined,
): boolean {
  return /(^|[_\s-])(contract|temporary|fixed[_\s-]?term)$/i.test(
    (employeeType ?? '').trim(),
  );
}

// The Code requires gratuity within 30 days of it becoming payable (the last working day); later payment attracts
// interest and a 10% penalty. Returns the due date (YYYY-MM-DD) and whether a payment on `paidOn` (or today, if
// not yet paid) is late.
export const GRATUITY_PAYOUT_DAYS = 30;
export function gratuityPayoutStatus(
  lastWorkingDay: string,
  paidOn: Date | null,
  today: Date = new Date(),
): { dueBy: string; overdue: boolean } {
  const due = new Date(`${lastWorkingDay}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + GRATUITY_PAYOUT_DAYS);
  const dueBy = due.toISOString().slice(0, 10);
  const compare = (paidOn ?? today).toISOString().slice(0, 10);
  return { dueBy, overdue: compare > dueBy };
}

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
  opts: { fixedTerm?: boolean; exemptFromMinimumService?: boolean } = {},
): number {
  const required = opts.fixedTerm
    ? YEARS_FOR_FIXED_TERM_GRATUITY
    : YEARS_FOR_GRATUITY_ELIGIBILITY;
  // Death or disablement: the minimum-service condition does not apply (Payment of Gratuity Act s.4(1) proviso).
  if (!opts.exemptFromMinimumService && yearsOfService < required) return 0;
  const raw =
    basicMonthly * (15 / 26) * completedYearsOfService(yearsOfService);
  return Math.min(Math.round(raw), GRATUITY_STATUTORY_CAP);
}

// Whole calendar years plus the fraction of the next, from the joining date through the last working day inclusive.
export function calendarYearsOfService(
  joinedOn: string,
  lastWorkingDay: string,
): number {
  const end = new Date(`${lastWorkingDay}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const [jy, jm, jd] = joinedOn.split('-').map(Number);
  let years = end.getUTCFullYear() - jy;
  let months = end.getUTCMonth() + 1 - jm;
  let days = end.getUTCDate() - jd;
  if (days < 0) {
    months -= 1;
    days += 30;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return years + (months + days / 30) / 12;
}

// Code on Wages, 2019 s.17(2): wages are paid within two working days of the employee's removal, dismissal,
// retrenchment or resignation. Which weekdays are working days is the establishment's own, so only Sundays are
// skipped here - the earliest (most conservative) due date; the establishment's weekly off may only push it later.
export const FINAL_WAGES_WORKING_DAYS = 2;
export function finalWagesDueBy(lastWorkingDay: string): string {
  const d = new Date(`${lastWorkingDay}T00:00:00.000Z`);
  let left = FINAL_WAGES_WORKING_DAYS;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

// Whether the final wages are (or were) paid after that due date; `paidOn` null means still unpaid, judged by today.
export function finalWagesStatus(
  lastWorkingDay: string,
  paidOn: Date | null,
  today: Date = new Date(),
): { dueBy: string; overdue: boolean } {
  const dueBy = finalWagesDueBy(lastWorkingDay);
  const compare = (paidOn ?? today).toISOString().slice(0, 10);
  return { dueBy, overdue: compare > dueBy };
}

// ── Coverage: who is under the Payment of Gratuity Act ──────────────────────────────────────────────────────────
// COVERED:     the establishment is under the Act (traditionally 10 or more employees on any day of the previous 12
//              months). The Act's formula (15/26, a part-year over six months rounds up, 5-year minimum, ₹20 lakh cap)
//              is the floor and a statutory right.
// NOT_COVERED: no statutory right: any gratuity is contractual / voluntary, so the company's own formula and
//              minimum service apply. The tax exemption is lower (s.10(10)(iii)).
export type GratuityCoverage = 'COVERED' | 'NOT_COVERED';
// How the amount is worked out: the Act's formula, or half a month's wages per completed year (15/30).
export type GratuityPayoutFormula = 'ACT' | 'HALF_MONTH';

// Headcount at which an establishment is, as a rule, covered by the Act.
export const GRATUITY_COVERAGE_HEADCOUNT = 10;

// Half a month's (15/30) average wages for every COMPLETED year - a part-year is not rounded up - for a
// non-covered employer's own policy. Zero below `minYears`. No ceiling is applied here (a contract may pay more); the
// tax exemption below is what is capped.
export function calculateHalfMonthGratuity(
  averageMonthlyWages: number,
  yearsOfService: number,
  opts: { minYears?: number; exemptFromMinimumService?: boolean } = {},
): number {
  const minYears = opts.minYears ?? YEARS_FOR_GRATUITY_ELIGIBILITY;
  if (!opts.exemptFromMinimumService && yearsOfService < minYears) return 0;
  return Math.round(
    averageMonthlyWages * (15 / 30) * Math.floor(Math.max(0, yearsOfService)),
  );
}

// The part of the gratuity paid that is exempt from tax on leaving (s.10(10)); the rest is taxed with the final pay.
// This is decided by the law and the employer's coverage - NOT by which formula the company chose to pay:
//   covered     (s.10(10)(ii)): least of the amount paid, ₹20 lakh, and 15/26 x last drawn wages x completed years
//                (a part-year over six months counted as a year);
//   not covered (s.10(10)(iii)): least of the amount paid, ₹20 lakh, and half a month's average salary of the last
//                ten months x completed years of service only.
export function gratuityTaxExemption(opts: {
  coverage: GratuityCoverage;
  paid: number;
  lastDrawnWages: number;
  averageWages: number;
  yearsOfService: number;
}): number {
  const { coverage, paid, lastDrawnWages, averageWages, yearsOfService } = opts;
  if (paid <= 0) return 0;
  const statutoryLimit =
    coverage === 'COVERED'
      ? lastDrawnWages *
        (15 / 26) *
        completedYearsOfService(Math.max(0, yearsOfService))
      : averageWages * (15 / 30) * Math.floor(Math.max(0, yearsOfService));
  return Math.max(
    0,
    Math.round(Math.min(paid, GRATUITY_STATUTORY_CAP, statutoryLimit)),
  );
}
