import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditModule, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

type Actor = Omit<User, 'password'>;

export interface LogAuditInput {
  actorId: string;
  action: string;
  module: AuditModule;
  organizationId: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

// Roles whose activity an HR viewer must not see — ADMIN and MANAGER
// activity is hidden from HR's audit view; ADMIN itself sees everything.
// Mirrors the old system's HR_HIDDEN_ACTOR_ROLES exactly (administrator ->
// ADMIN, department_head -> MANAGER).
const HR_HIDDEN_ACTOR_ROLES: Role[] = [Role.ADMIN, Role.MANAGER];

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // Fire-and-forget — a broken audit write must never fail the action it's
  // documenting, same as the old system's logAudit util.
  async log(input: LogAuditInput): Promise<void> {
    try {
      await this.scopedPrisma.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorId: input.actorId,
          action: input.action,
          module: input.module,
          targetId: input.targetId ?? null,
          details: (input.details ?? {}) as Prisma.InputJsonValue,
          ipAddress: input.ipAddress ?? '',
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findAll(query: QueryAuditLogDto, actor: Actor, organizationId: string) {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    if (query.module) where.module = query.module;
    if (query.actor) where.actorId = query.actor;
    if (query.action) {
      where.action = { contains: query.action, mode: 'insensitive' };
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }
    if (actor.role === Role.HR) {
      where.actor = { role: { notIn: HR_HIDDEN_ACTOR_ROLES } };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      this.scopedPrisma.auditLog.findMany({
        where,
        include: {
          actor: {
            select: { id: true, name: true, employeeId: true, role: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.scopedPrisma.auditLog.count({ where }),
    ]);

    return { total, page, logs };
  }
}
