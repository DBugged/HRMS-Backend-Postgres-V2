// Purpose: Writes and lists AuditLog entries, the org's tamper trail of who did what.
// Responsibilities: Owns log() (fire-and-forget writer) and findAll() (paginated, role-filtered reader);
// callers throughout the app invoke log() but never read AuditLog directly.
// Important: log() swallows and logs its own errors — a broken audit write must never fail the action it's
// documenting. findAll() hides ADMIN/MANAGER activity from HR viewers (HR_HIDDEN_ACTOR_ROLES), mirroring
// the old system's HR_HIDDEN_ACTOR_ROLES exactly.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditModule, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { paginate } from '../common/pagination';

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

  // Deletes every AuditLog row for the org, then writes a fresh one
  // recording who cleared it — the one entry that survives its own clear,
  // so "the trail was wiped" is itself traceable rather than a silent gap.
  async clearAll(actor: Actor, organizationId: string): Promise<{ deleted: number }> {
    const { count } = await this.scopedPrisma.auditLog.deleteMany({
      where: { organizationId },
    });
    await this.log({
      actorId: actor.id,
      action: 'AUDIT_LOG_CLEARED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { deletedCount: count },
    });
    return { deleted: count };
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

    return paginate(
      () =>
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
      () => this.scopedPrisma.auditLog.count({ where }),
      page,
      limit,
    );
  }
}
