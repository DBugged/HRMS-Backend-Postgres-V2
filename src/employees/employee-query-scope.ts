import { Role } from '@prisma/client';

export interface Actor {
  id?: string;
  role: Role;
  departmentId: string | null;
}

/**
 * Data-scoping, not access-control — @Roles(ADMIN, HR, MANAGER) on the
 * list/get routes already answers "can this caller call the endpoint at
 * all." This answers a different question the guard can't express: which
 * rows should come back. Mirrors the old backend's getEmployees, which
 * forced `filter.department = req.user.department` for department_head
 * callers regardless of any `department` query param they passed.
 *
 * Extracted as a pure function (same reasoning as evaluateTenantScope) so
 * it's unit-testable without spinning up a controller/service/Prisma call.
 */
export function resolveDepartmentFilter(
  actor: Actor,
  requestedDepartmentId?: string,
): string | undefined {
  if (actor.role === Role.MANAGER) {
    // Forced, ignoring whatever the query param says — a Manager can't
    // widen their own view by passing a different department id.
    return actor.departmentId ?? undefined;
  }
  return requestedDepartmentId;
}

/**
 * Used by GET /employees/:id — a MANAGER may only read employees in their
 * own department; ADMIN/HR/self are handled by the guard already.
 */
export function canManagerAccessEmployee(
  actor: Actor,
  targetDepartmentId: string | null,
): boolean {
  if (actor.role !== Role.MANAGER) return true; // not this function's concern for other roles
  return (
    actor.departmentId !== null && actor.departmentId === targetDepartmentId
  );
}

/**
 * A MANAGER with no department must NOT fall through to "unfiltered" (which
 * would list every employee) — they are limited to their own record plus
 * anyone who reports to them directly.
 */
export function noDepartmentManagerScope(
  actor: Actor & { id?: string },
): { OR: Array<{ id: string } | { reportingManagerId: string }> } | undefined {
  if (actor.role !== Role.MANAGER || actor.departmentId) return undefined;
  const id = actor.id ?? '';
  return { OR: [{ id }, { reportingManagerId: id }] };
}
