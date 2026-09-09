import type { AttendanceSummary } from './attendance-summary';
import type { OverlaidSettings, PtSlab } from './statutory-overlay';

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

export function buildBaseContext(
  attendance: AttendanceSummary,
  settings: OverlaidSettings,
  month: number,
): Record<string, number> {
  const isLwfMonth = settings.lwfMonths.includes(month);
  return {
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
    LWF_EMPLOYEE_AMOUNT: isLwfMonth ? settings.lwfEmployeeAmount : 0,
    LWF_EMPLOYER_AMOUNT: isLwfMonth ? settings.lwfEmployerAmount : 0,
    NPS_EMPLOYER_RATE: settings.npsEmployerRate,
    GRATUITY_RATE: settings.gratuityRate,
    ...buildPtSlabContext(settings.ptSlabs),
  };
}
