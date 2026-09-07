import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import type { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';

interface DeptScopeActor {
  id: string;
  role: Role;
  departmentId: string | null;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Employee ids a MANAGER's list/query endpoints must be constrained to —
// their own department. Callers combine this with the actor's own id for
// EMPLOYEE and leave ADMIN/HR unrestricted.
export async function deptScopedEmployeeIds(
  prisma: ExtendedPrismaClient,
  actor: DeptScopeActor,
  organizationId: string,
): Promise<string[]> {
  // A departmentless actor must be scoped to nobody, not to every other
  // departmentless employee — `departmentId: null` in a Prisma where-clause
  // matches every row with a null department, which would otherwise let any
  // two unassigned managers see (and, via the checks below, act on) each
  // other's unassigned direct reports.
  if (actor.departmentId === null) return [];
  const deptEmployees = await prisma.user.findMany({
    where: { organizationId, departmentId: actor.departmentId },
    select: { id: true },
  });
  return deptEmployees.map((e) => e.id);
}

// No one below ADMIN may approve their own request — an HR (or MANAGER)
// reviewing their own leave/comp-off/overtime/reimbursement/document is
// self-approval regardless of department scope, so this runs first, ahead
// of (and independent from) the MANAGER-only department check below. ADMIN
// is exempt: there's no one above an Admin in this hierarchy to review
// their requests instead.
export function assertNotSelfApproval(
  actor: DeptScopeActor,
  targetEmployeeId: string,
): void {
  if (actor.role !== Role.ADMIN && actor.id === targetEmployeeId) {
    throw new ForbiddenException(
      'You cannot approve or review your own request.',
    );
  }
}

// Guards a single-record action (review/approve/view) so a MANAGER can only
// act on an employee within their own department, and no one but ADMIN can
// act on their own request. No further scope check for ADMIN/HR beyond
// self-approval. EMPLOYEE never reaches this — those actions are
// self-scoped upstream.
export async function assertManagerDeptScope(
  prisma: ExtendedPrismaClient,
  actor: DeptScopeActor,
  organizationId: string,
  targetEmployeeId: string,
): Promise<void> {
  assertNotSelfApproval(actor, targetEmployeeId);
  if (actor.role !== Role.MANAGER) return;
  const target = await prisma.user.findFirst({
    where: { id: targetEmployeeId, organizationId },
    select: { departmentId: true },
  });
  // actor.departmentId === null is deliberately excluded from matching —
  // otherwise two departmentless managers would satisfy `null === null`
  // and be treated as sharing a department.
  if (
    !target ||
    actor.departmentId === null ||
    target.departmentId !== actor.departmentId
  ) {
    throw new ForbiddenException(
      'You can only act on employees in your own department.',
    );
  }
}

// Same guard as assertManagerDeptScope, but also lets a stand-in reviewer
// act when the target employee's actual reporting manager has an active
// ApprovalDelegation naming the actor — same isActiveDelegate pattern as
// LeavesService.review(), applied to attendance regularization/WFH,
// overtime, and comp-off review paths so delegation works consistently
// across all review actions, not just leaves.
export async function assertManagerScopeOrDelegate(
  prisma: ExtendedPrismaClient,
  delegationService: ApprovalDelegationService,
  actor: DeptScopeActor,
  organizationId: string,
  targetEmployeeId: string,
): Promise<void> {
  assertNotSelfApproval(actor, targetEmployeeId);
  if (actor.role !== Role.MANAGER) return;
  const target = await prisma.user.findFirst({
    where: { id: targetEmployeeId, organizationId },
    select: { departmentId: true, reportingManagerId: true },
  });
  if (!target) {
    throw new ForbiddenException(
      'You can only act on employees in your own department (or whose manager has delegated to you).',
    );
  }
  // The actual reporting relationship always grants access, independent of
  // department — this covers a manager/employee pair that predates (or
  // simply never got) a department assignment.
  if (target.reportingManagerId === actor.id) return;
  // actor.departmentId === null is deliberately excluded — see
  // assertManagerDeptScope's identical guard against null-department
  // managers matching every other null-department employee.
  if (
    actor.departmentId !== null &&
    target.departmentId === actor.departmentId
  ) {
    return;
  }

  if (
    target.reportingManagerId &&
    (await delegationService.isActiveDelegate(
      target.reportingManagerId,
      actor.id,
      organizationId,
      todayStr(),
    ))
  ) {
    return;
  }

  throw new ForbiddenException(
    'You can only act on employees in your own department (or whose manager has delegated to you).',
  );
}
