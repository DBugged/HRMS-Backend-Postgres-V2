// Purpose: Who holds which role - the data behind the People view on the Access Control page.
// Responsibilities: head count per role, the active Admin and HR accounts (the powerful ones), and the latest role changes read
//   from the audit log (who changed whose role, from what to what, when). Read-only.
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

@Injectable()
export class AccessControlService {
  constructor(@Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient) {}

  // Who holds which role: counts for every role, the people who hold Admin or HR (the powerful accounts), and the latest role
  // changes (who changed whose role, from what to what, when) from the audit log.
  async people(organizationId: string) {
    const [grouped, privileged, audits] = await Promise.all([
      this.scopedPrisma.user.groupBy({ by: ['role'], where: { organizationId, isActive: true }, _count: { _all: true } }),
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, role: { in: ['ADMIN', 'HR'] } },
        select: { id: true, name: true, employeeId: true, role: true, email: true },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      }),
      this.scopedPrisma.auditLog.findMany({
        where: { organizationId, action: 'EMPLOYEE_UPDATED' },
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: { actorId: true, targetId: true, details: true, createdAt: true },
      }),
    ]);
    const counts = { ADMIN: 0, HR: 0, MANAGER: 0, EMPLOYEE: 0 } as Record<string, number>;
    for (const g of grouped) counts[g.role] = g._count._all;
    const changes = audits
      .map((a) => {
        const d = (a.details ?? {}) as { changes?: { role?: { before?: string; after?: string } } };
        return d.changes?.role ? { actorId: a.actorId, targetId: a.targetId, from: d.changes.role.before ?? '', to: d.changes.role.after ?? '', at: a.createdAt } : null;
      })
      .filter((c): c is NonNullable<typeof c> => !!c)
      .slice(0, 15);
    const ids = [...new Set(changes.flatMap((c) => [c.actorId, c.targetId ?? '']).filter(Boolean))];
    const users = await this.scopedPrisma.user.findMany({ where: { organizationId, id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return {
      counts,
      privileged,
      roleChanges: changes.map((c) => ({ by: nameOf.get(c.actorId) ?? 'Unknown', employee: nameOf.get(c.targetId ?? '') ?? 'Unknown', from: c.from, to: c.to, at: c.at })),
    };
  }
}
