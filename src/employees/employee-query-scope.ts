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

/**
 * "My Team" scope — everyone in a MANAGER's reporting chain (direct
 * reports, and their reports, transitively), as opposed to the default
 * department-wide scope resolveDepartmentFilter applies everywhere else.
 * Walked in-memory over one pair-only fetch rather than a recursive SQL
 * query — org sizes here don't warrant the extra complexity, and every
 * other in-memory graph walk in this codebase (e.g. department-tree
 * lookups) follows the same pattern.
 */
export function collectReportingChain(
  managerId: string,
  allPairs: Array<{ id: string; reportingManagerId: string | null }>,
): string[] {
  const reportsOf = new Map<string, string[]>();
  for (const { id, reportingManagerId } of allPairs) {
    if (!reportingManagerId) continue;
    const list = reportsOf.get(reportingManagerId);
    if (list) list.push(id);
    else reportsOf.set(reportingManagerId, [id]);
  }
  const chain: string[] = [];
  const queue = [...(reportsOf.get(managerId) ?? [])];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const next = queue.shift()!;
    chain.push(next);
    for (const child of reportsOf.get(next) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return chain;
}
