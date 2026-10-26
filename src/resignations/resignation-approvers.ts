// Purpose: who is told about a resignation, and who decides it.
// Responsibilities: one lookup used when a resignation is submitted (email) and by the pending-resignation reminder, so both reach
//   the same people: the employee's reporting manager(s) (primary and additional) and the HR / Admin who decide it.
// Important: only an Admin decides an HR or Admin employee's resignation, so for them the decision-makers are Admins only. Never
//   the employee themself, and only people who still work here.
import { Role } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { managerIdsOf } from '../common/managers';

export interface ResignationApprover {
  id: string;
  name: string;
  email: string;
  role: Role;
  notificationPreferences: unknown;
}

export async function findResignationApprovers(
  prisma: ExtendedPrismaClient,
  organizationId: string,
  employee: { id: string; role: Role; reportingManagerId: string | null; additionalReportingManagerIds?: string[] | null },
  excludeIds: string[] = [],
): Promise<ResignationApprover[]> {
  const deciders: Role[] = employee.role === Role.HR || employee.role === Role.ADMIN ? [Role.ADMIN] : [Role.HR, Role.ADMIN];
  const managers = managerIdsOf(employee);
  return prisma.user.findMany({
    where: {
      organizationId,
      isActive: true,
      id: { notIn: [employee.id, ...excludeIds] },
      OR: [{ role: { in: deciders } }, ...(managers.length ? [{ id: { in: managers } }] : [])],
    },
    select: { id: true, name: true, email: true, role: true, notificationPreferences: true },
  });
}
