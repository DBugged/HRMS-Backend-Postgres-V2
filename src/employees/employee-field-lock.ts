import { Role } from '@prisma/client';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

/**
 * Ports the original release's LOCKED_FIELDS_FOR_EMPLOYEE (defined locally in
 * employeeController.js, not centralized in roles.js there either — kept
 * here for the same reason: it's specific to this one endpoint's
 * self-vs-HR field split, not a generic role concept).
 */
const LOCKED_FIELDS_FOR_EMPLOYEE: (keyof UpdateEmployeeDto)[] = [
  'role',
  'departmentId',
  'workLocationId',
  'brandId',
  'alwaysPresent',
  'alwaysPresentFrom',
  'requireWorkLocationForPunch',
  'selfieRequirement',
  'locationRequirement',
  'designation',
  // gradeLevel/employeeCategory added alongside designation/departmentId —
  // same class of structural classification, not something an employee
  // sets on themselves.
  'gradeLevel',
  'employeeCategory',
  'isActive',
  'excludeFromPayroll',
  'lwfExempt',
  'epsExcluded',
  'epsExcludedUntil',
  'joiningDate',
  'reportingManagerId',
  'additionalReportingManagerIds',
  'email',
  'employmentStatus',
  'confirmationDate',
  'probationEndDate',
  'employeeType',
];

/**
 * `@SelfOrRoles('id', ADMIN, HR)` (the route guard) only answers "can this
 * caller hit PATCH /employees/:id at all" — self, or HR/Admin. This answers
 * the finer-grained second question the guard can't express: which fields
 * may they actually change. Kept as one small, unit-testable function
 * rather than scattered inline `if` checks, so the same self-vs-HR split
 * is reusable when other modules need it later.
 */
export function stripLockedFields(
  dto: UpdateEmployeeDto,
  actorRole: Role,
): UpdateEmployeeDto {
  const isHR = actorRole === Role.ADMIN || actorRole === Role.HR;
  const clean: UpdateEmployeeDto = { ...dto };

  if (!isHR) {
    for (const field of LOCKED_FIELDS_FOR_EMPLOYEE) {
      delete clean[field];
    }
  }

  // Even HR (not just plain employees) cannot change designation through
  // this endpoint — only ADMIN can. Mirrors the original release exactly.
  if (actorRole !== Role.ADMIN) {
    delete clean.designation;
  }

  return clean;
}

const asComparable = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return v.slice(0, 10);
  }
  return String(v);
};

/**
 * The fields the caller sent that stripLockedFields() would throw away AND that really differ from what is stored. A
 * client that re-sends a locked field with its current value (a form posting everything back) is not trying to change
 * it, so that is not an attempt. Used to answer with a clear 403 instead of a "200 OK" for a change that never happened.
 */
export function lockedFieldAttempts(
  dto: UpdateEmployeeDto,
  current: Record<string, unknown>,
  actorRole: Role,
): string[] {
  const stripped = stripLockedFields(dto, actorRole);
  const attempts: string[] = [];
  for (const key of Object.keys(dto) as (keyof UpdateEmployeeDto)[]) {
    if (dto[key] === undefined) continue;
    if (key in stripped) continue;
    if (asComparable(dto[key]) !== asComparable(current[key])) {
      attempts.push(key);
    }
  }
  return attempts;
}
