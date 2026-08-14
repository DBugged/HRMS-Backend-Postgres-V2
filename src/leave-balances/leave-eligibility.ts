/**
 * Pure port of the old backend's `getEligibleLeaveTypes` filter logic
 * (`leavePolicyEngine.js`) — generic, data-driven off `LeaveType`'s
 * applicability fields, no per-leave-type branching. Extracted from the
 * DB-touching orchestration in leave-balance.service.ts so it's directly
 * unit-testable, same reasoning as employee-query-scope.ts.
 *
 * `applicableGenders` is deliberately NOT checked here — backend-v2's User
 * model has no `gender` field (the old system's did). The JSON field is
 * kept on LeaveType for schema fidelity only; see schema.prisma's comment.
 */

export interface EligibilityLeaveType {
  applicableDepartments: unknown;
  applicableEmployeeTypes: unknown;
  minServiceMonths: number;
  maxServiceMonths: number | null;
}

export interface EligibilityEmployee {
  departmentId: string | null;
  employeeType: string;
  joiningDate: Date;
}

// Inclusive of the joining month itself, matching the old system's
// `monthsBetween` (whole calendar months elapsed, not calendar-day-precise).
export function monthsOfService(joiningDate: Date, asOf: Date): number {
  const years = asOf.getUTCFullYear() - joiningDate.getUTCFullYear();
  const months = asOf.getUTCMonth() - joiningDate.getUTCMonth();
  let total = years * 12 + months;
  if (asOf.getUTCDate() < joiningDate.getUTCDate()) total -= 1;
  return Math.max(total, 0);
}

function matchesListFilter(list: unknown, value: string | null): boolean {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (value === null) return false;
  return list.includes(value);
}

export function isEligible(
  leaveType: EligibilityLeaveType,
  employee: EligibilityEmployee,
  asOf: Date = new Date(),
): boolean {
  if (
    !matchesListFilter(leaveType.applicableDepartments, employee.departmentId)
  ) {
    return false;
  }
  if (
    !matchesListFilter(leaveType.applicableEmployeeTypes, employee.employeeType)
  ) {
    return false;
  }

  const service = monthsOfService(employee.joiningDate, asOf);
  if (service < leaveType.minServiceMonths) return false;
  if (
    leaveType.maxServiceMonths !== null &&
    service > leaveType.maxServiceMonths
  ) {
    return false;
  }

  return true;
}
