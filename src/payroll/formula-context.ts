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

function buildPtSlabContext(ptSlabs: PtSlab[]): Record<string, number> {
  const slabs =
    Array.isArray(ptSlabs) && ptSlabs.length > 0 ? ptSlabs : DEFAULT_PT_SLABS;
  const context: Record<string, number> = {};
  slabs.forEach((slab, idx) => {
    const n = idx + 1;
    if (slab.upTo !== null && slab.upTo !== undefined) {
      context[`PT_SLAB${n}_UPTO`] = slab.upTo;
    }
    context[`PT_SLAB${n}_AMOUNT`] = slab.amount;
  });
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
