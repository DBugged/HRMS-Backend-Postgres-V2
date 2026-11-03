import { Role } from '@prisma/client';

export interface Actor {
  id?: string;
  role: Role;
  departmentId: string | null;
}

/**
 * "My Team" scope — everyone in a MANAGER's reporting chain (direct
 * reports, and their reports, transitively), as opposed to the default
 * department-head scope (common/dept-scope.ts reviewerScope) applied everywhere else.
 * Walked in-memory over one pair-only fetch rather than a recursive SQL
 * query — org sizes here don't warrant the extra complexity, and every
 * other in-memory graph walk in this codebase (e.g. department-tree
 * lookups) follows the same pattern.
 */
export function collectReportingChain(
  managerId: string,
  allPairs: Array<{ id: string; reportingManagerId: string | null; additionalReportingManagerIds?: string[] | null }>,
): string[] {
  const reportsOf = new Map<string, string[]>();
  for (const { id, reportingManagerId, additionalReportingManagerIds } of allPairs) {
    // A person reports to their primary manager and to every additional one.
    for (const managerId of [reportingManagerId, ...(additionalReportingManagerIds ?? [])]) {
      if (!managerId) continue;
      const list = reportsOf.get(managerId);
      if (list) list.push(id);
      else reportsOf.set(managerId, [id]);
    }
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

/**
 * What an EMPLOYEE may see of a colleague in the directory list (it feeds the Reporting Structure org view): who they are and where
 * they sit in the reporting line - never email, phone, gender, probation or anything else from their record. The caller's own row
 * is not trimmed.
 */
const EMPLOYEE_VISIBLE_FIELDS = [
  'id', 'organizationId', 'name', 'employeeId', 'role', 'departmentId', 'designation', 'profileImage',
  'reportingManagerId', 'additionalReportingManagerIds', 'isActive', 'employmentStatus',
] as const;

export function slimForEmployeeViewer<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of EMPLOYEE_VISIBLE_FIELDS) if (key in row) out[key] = row[key];
  return out as Partial<T>;
}

/** An EMPLOYEE sees only people who still work here (plus their own record, whatever its state). */
export function employeeDirectoryScope(actor: Actor & { id?: string }): { OR: Array<{ isActive: true } | { id: string }> } | undefined {
  if (actor.role !== Role.EMPLOYEE) return undefined;
  return { OR: [{ isActive: true }, { id: actor.id ?? '' }] };
}
