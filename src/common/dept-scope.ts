import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

interface DeptScopeActor {
  id: string;
  role: Role;
  departmentId: string | null;
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
