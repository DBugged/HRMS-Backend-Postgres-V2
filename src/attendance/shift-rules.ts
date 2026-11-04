// Purpose: Gender-wise shift timings (Organization Structure > Work Schedules > Shift rules) and how they combine with
//   the department's shift.
// Responsibilities: pickShiftRule finds the rule that applies to a person; shiftDepartmentFor returns the department's
//   shift fields with that rule's timing laid over them, so resolveShiftConfig and every caller after it needs no change.
// Important: precedence is a rule for the person's own department, then a company-wide rule, then the department's shift
//   unchanged. Only the start/end time and (optionally) the break are replaced; weekly offs and thresholds stay the
//   department's.
import type { Gender } from '@prisma/client';
import type { DepartmentShiftFields } from './attendance-shift-config';

export interface ShiftRuleLite {
  gender: Gender;
  startTime: string;
  endTime: string;
  breakMinutes: number | null;
  departmentIds: string[];
  isActive: boolean;
}

export function pickShiftRule<T extends ShiftRuleLite>(
  rules: T[] | null | undefined,
  gender: Gender | null | undefined,
  departmentId: string | null | undefined,
): T | null {
  if (!rules?.length || !gender) return null;
  const mine = rules.filter((r) => r.isActive && r.gender === gender);
  return (
    mine.find((r) => departmentId && r.departmentIds.includes(departmentId)) ??
    mine.find((r) => r.departmentIds.length === 0) ??
    null
  );
}

// A shift that starts after it ends (22:00-06:00) runs past midnight.
const crosses = (start: string, end: string) => end <= start;

export function shiftDepartmentFor<D extends DepartmentShiftFields>(
  department: D | null | undefined,
  person: { gender?: Gender | null; departmentId?: string | null },
  rules: ShiftRuleLite[] | null | undefined,
): D | null | undefined {
  const rule = pickShiftRule(
    rules,
    person.gender,
    (department as { id?: string } | null)?.id ?? person.departmentId,
  );
  // Without a department there is nothing to lay a rule over (the company default shift applies).
  if (!rule || !department) return department;
  return {
    ...department,
    shiftStartTime: rule.startTime,
    shiftEndTime: rule.endTime,
    breakMinutes: rule.breakMinutes ?? department.breakMinutes,
    crossesMidnight: crosses(rule.startTime, rule.endTime),
  };
}
