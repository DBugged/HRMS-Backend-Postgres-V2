import type { AttendanceSummary } from './attendance-summary';
import type { OverlaidSettings, PtSlab } from './statutory-overlay';

// Who the statutory rules are being resolved for — drives state-wise LWF and Professional Tax. `state` is the
// state of the employee's department's work location; `gender` picks a state's women-specific PT ladder.
export interface EmployeeStatutoryProfile {
  state?: string | null;
  gender?: string | null;
}

/**
 * Pure port of the old backend's payrollEngine.js buildBaseContext +
 * buildPtSlabContext — the flat formula-engine context every salary
 * component formula is evaluated against, before earnings/deductions/
 * employer-contribution lines add their own running values on top.
 */

const DEFAULT_PT_SLABS: PtSlab[] = [
  { upTo: 7500, amount: 0 },
  { upTo: 10000, amount: 175 },
  { upTo: null, amount: 200 },
];

// The number of slabs the pre-PT_SLAB_AMOUNT default formula spelled out by
// hand. Orgs seeded before that formula changed still reference
// PT_SLAB1_UPTO, PT_SLAB2_UPTO and PT_SLAB3_AMOUNT literally.
const LEGACY_PT_SLAB_COUNT = 3;

// An open-ended slab still needs a numeric ceiling for those legacy formulas
// to compare against — "everything above the previous slab" in practice.
const NO_CEILING = Number.MAX_SAFE_INTEGER;

function buildPtSlabContext(ptSlabs: PtSlab[]): Record<string, number> {
  const slabs =
    Array.isArray(ptSlabs) && ptSlabs.length > 0 ? ptSlabs : DEFAULT_PT_SLABS;
  const context: Record<string, number> = {};
  slabs.forEach((slab, idx) => {
    const n = idx + 1;
    context[`PT_SLAB${n}_UPTO`] =
      slab.upTo === null || slab.upTo === undefined ? NO_CEILING : slab.upTo;
    context[`PT_SLAB${n}_AMOUNT`] = slab.amount;
  });

  // Pad up to the legacy slab count by repeating the top slab. An org with
  // fewer slabs than that used to throw 'Unknown reference
  // "PT_SLAB3_AMOUNT"' out of the seeded formula, which dropped every
  // affected employee into the payroll run's failures[]. Repeating the top
  // slab makes the legacy formula fall through to the right answer instead.
  //
  // Padding only ever ADDS keys beyond the configured slabs, so
  // PT_SLAB_AMOUNT() (which stops at the first slab with no ceiling) is
  // unaffected by it.
  const top = slabs[slabs.length - 1];
  for (let n = slabs.length + 1; n <= LEGACY_PT_SLAB_COUNT; n += 1) {
    context[`PT_SLAB${n}_UPTO`] = NO_CEILING;
    context[`PT_SLAB${n}_AMOUNT`] = top.amount;
  }
  return context;
}

// The LWF amounts and deduction months that apply to one employee: their work location's state rate when the
// org has configured one for that state, otherwise the org-wide default. An employee with no known state
// (no department, no work location, or a location with no state set) always gets the default.
export function resolveLwfRate(
  settings: OverlaidSettings,
  month: number,
  lwfState?: string | null,
): { employeeAmount: number; employerAmount: number } {
  const stateRate = lwfState
    ? settings.lwfStateRates.find((r) => r.state === lwfState)
    : undefined;
  const rate = stateRate ?? {
    employeeAmount: settings.lwfEmployeeAmount,
    employerAmount: settings.lwfEmployerAmount,
    months: settings.lwfMonths,
  };
  const isLwfMonth = rate.months.includes(month);
  return {
    employeeAmount: isLwfMonth ? rate.employeeAmount : 0,
    employerAmount: isLwfMonth ? rate.employerAmount : 0,
  };
}

// The Professional Tax ladder for one employee in one month: their state's ladder when the org has one for it
// (the women's ladder for a woman where that state defines one), otherwise the org-wide default (its women's
// ladder for a woman, where one is set); then February's
// own amount is swapped in where a slab defines it.
export function resolvePtSlabs(
  settings: OverlaidSettings,
  month: number,
  profile?: EmployeeStatutoryProfile,
): PtSlab[] {
  const stateRate = profile?.state
    ? settings.ptStateRates.find((r) => r.state === profile.state)
    : undefined;
  const isWoman = profile?.gender === 'FEMALE';
  // A state's own ladders win; without one, the org-wide default (and its women's ladder, if it has one).
  const base = stateRate
    ? isWoman && stateRate.womenSlabs
      ? stateRate.womenSlabs
      : stateRate.slabs
    : isWoman && settings.ptWomenSlabs
      ? settings.ptWomenSlabs
      : settings.ptSlabs;
  return month === 2
    ? base.map((s) =>
        s.februaryAmount === undefined ? s : { ...s, amount: s.februaryAmount },
      )
    : base;
}

// Wage bases that depend on this month's earnings, so they can only be computed once GROSS_EARNINGS is known.
// PF_WAGES / GRATUITY_WAGES are Basic + DA, lifted to 50% of gross where the org has switched the Labour Codes
// "50% wages" rule on for that module. ESI_APPLICABLE keeps an employee covered for the rest of an ESI
// contribution period (Apr-Sep / Oct-Mar) once they were covered, even if wages cross the ceiling mid-period.
export function deriveStatutoryContext(
  context: Record<string, number>,
  settings: OverlaidSettings,
  hadEsiThisPeriod: boolean,
): Record<string, number> {
  const basicDa = (context.BASIC ?? 0) + (context.DA ?? 0);
  const floor = (context.GROSS_EARNINGS ?? 0) * 0.5;
  const wages = (useRule: boolean) =>
    useRule ? Math.max(basicDa, floor) : basicDa;
  return {
    BASIC_DA: basicDa,
    PF_WAGES: wages(settings.pfUseWagesRule),
    GRATUITY_WAGES: wages(settings.gratuityUseWagesRule),
    NPS_WAGES: basicDa,
    ESI_APPLICABLE:
      (context.GROSS_EARNINGS ?? 0) <= settings.esiWageCeiling ||
      hadEsiThisPeriod
        ? 1
        : 0,
  };
}

// The EPS (pension) / EPF split of the employer's PF for the ECR: EPS is its rate on PF wages up to the ceiling,
// EPF is the remainder of whatever the employer PF line came to, so the two always add back to the line.
export function splitEmployerPf(
  employerPfAmount: number,
  context: Record<string, number>,
  settings: OverlaidSettings,
): { eps: number; epf: number } {
  const wages = Math.min(context.PF_WAGES ?? 0, settings.pfWageCeiling);
  const eps = Math.min(
    employerPfAmount,
    Math.round((wages * settings.pfEpsRate) / 100),
  );
  return { eps, epf: employerPfAmount - eps };
}

export function buildBaseContext(
  attendance: AttendanceSummary,
  settings: OverlaidSettings,
  month: number,
  profile?: EmployeeStatutoryProfile,
): Record<string, number> {
  const lwf = resolveLwfRate(settings, month, profile?.state);
  return {
    // Dearness Allowance is optional (seeded inactive) — 0 unless the org's DA component is applicable, in
    // which case the earnings pass overwrites this with the real amount.
    DA: 0,
    PF_EDLI_RATE: settings.pfEdliRate,
    PF_ADMIN_RATE: settings.pfAdminRate,
    PF_EDLI_MAX: settings.pfEdliMax,
    BONUS_RATE: settings.bonusRate,
    BONUS_ELIGIBILITY_CEILING: settings.bonusEligibilityCeiling,
    BONUS_CALC_CEILING: settings.bonusCalcCeiling,
    WORKING_DAYS: attendance.workingDays,
    TOTAL_DAYS_IN_MONTH: attendance.totalDaysInMonth,
    PRESENT_DAYS: attendance.presentDays,
    PAID_LEAVE_DAYS: attendance.paidLeaveDays,
    UNPAID_LEAVE_DAYS: attendance.unpaidLeaveDays,
    HALF_DAYS: attendance.halfDays,
    OT_HOURS: attendance.overtimeHours,
    LATE_MARKS: attendance.lateMarks,
    HOLIDAY_WORK_DAYS: attendance.holidayWorkDays,
    WEEKEND_WORK_DAYS: attendance.weekendWorkDays,
    LOP_DAYS: attendance.lopDays,
    PAYABLE_DAYS: attendance.payableDays,
    HOLIDAYS: attendance.holidays,
    WEEKLY_OFFS: attendance.weeklyOffs,
    PF_EMPLOYEE_RATE: settings.pfEmployeeRate,
    PF_EMPLOYER_RATE: settings.pfEmployerRate,
    PF_WAGE_CEILING: settings.pfWageCeiling,
    ESI_EMPLOYEE_RATE: settings.esiEmployeeRate,
    ESI_EMPLOYER_RATE: settings.esiEmployerRate,
    ESI_WAGE_CEILING: settings.esiWageCeiling,
    LWF_EMPLOYEE_AMOUNT: lwf.employeeAmount,
    LWF_EMPLOYER_AMOUNT: lwf.employerAmount,
    NPS_EMPLOYER_RATE: settings.npsEmployerRate,
    GRATUITY_RATE: settings.gratuityRate,
    ...buildPtSlabContext(resolvePtSlabs(settings, month, profile)),
  };
}
