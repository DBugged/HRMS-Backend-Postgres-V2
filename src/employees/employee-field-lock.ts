import { Role } from '@prisma/client';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

/**
 * Ports the old backend's LOCKED_FIELDS_FOR_EMPLOYEE (defined locally in
 * employeeController.js, not centralized in roles.js there either — kept
 * here for the same reason: it's specific to this one endpoint's
 * self-vs-HR field split, not a generic role concept).
 */
const LOCKED_FIELDS_FOR_EMPLOYEE: (keyof UpdateEmployeeDto)[] = [
  'role',
  'departmentId',
  'designation',
  'isActive',
  'joiningDate',
  'reportingManagerId',
  'email',
  'employmentStatus',
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
  // this endpoint — only ADMIN can. Mirrors the old system exactly.
  if (actorRole !== Role.ADMIN) {
    delete clean.designation;
  }

  return clean;
}
