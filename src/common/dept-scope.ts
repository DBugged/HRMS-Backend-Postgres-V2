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
  const deptEmployees = await prisma.user.findMany({
    where: { organizationId, departmentId: actor.departmentId },
    select: { id: true },
  });
  return deptEmployees.map((e) => e.id);
}

// Guards a single-record action (review/approve/view) so a MANAGER can only
// act on an employee within their own department. No-op for ADMIN/HR.
// EMPLOYEE never reaches this — those actions are self-scoped upstream.
export async function assertManagerDeptScope(
  prisma: ExtendedPrismaClient,
  actor: DeptScopeActor,
  organizationId: string,
  targetEmployeeId: string,
): Promise<void> {
  if (actor.role !== Role.MANAGER) return;
  const target = await prisma.user.findFirst({
    where: { id: targetEmployeeId, organizationId },
    select: { departmentId: true },
  });
  if (!target || target.departmentId !== actor.departmentId) {
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
  if (actor.role !== Role.MANAGER) return;
  const target = await prisma.user.findFirst({
    where: { id: targetEmployeeId, organizationId },
    select: { departmentId: true, reportingManagerId: true },
  });
  if (target && target.departmentId === actor.departmentId) return;

  if (
    target?.reportingManagerId &&
    target.reportingManagerId !== actor.id &&
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
