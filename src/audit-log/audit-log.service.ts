// Purpose: Writes and lists AuditLog entries, the org's tamper trail of who did what.
// Responsibilities: Owns log() (fire-and-forget writer) and findAll() (paginated, role-filtered reader);
// callers throughout the app invoke log() but never read AuditLog directly.
// Important: log() swallows and logs its own errors — a broken audit write must never fail the action it's
// documenting. findAll() hides ADMIN/MANAGER activity from HR viewers (HR_HIDDEN_ACTOR_ROLES), mirroring
// the original release's HR_HIDDEN_ACTOR_ROLES exactly. deleteRange() lets an Admin purge a bounded date range
// (retention); it re-links the hash chain over what remains and writes an AUDIT_LOGS_DELETED entry recording who
// purged what, so a purge is itself traceable rather than a silent gap.
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditModule, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { currentRequest } from '../common/request-context';
import { paginate } from '../common/pagination';
import { randomUUID } from 'crypto';
import { computeHash, verifyChain, type ChainRow } from '../privacy/audit-chain';

type Actor = Omit<User, 'password'>;

export interface LogAuditInput {
  actorId: string;
  action: string;
  module: AuditModule;
  organizationId: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string;
  // Defaults to the role of the signed-in user when they are the actor (else looked up).
  actorRole?: string;
  // 'FAILURE' for a refused or denied attempt; defaults to 'SUCCESS'.
  outcome?: 'SUCCESS' | 'FAILURE';
}

// Roles whose activity an HR viewer must not see — ADMIN and MANAGER
// activity is hidden from HR's audit view; ADMIN itself sees everything.
// Mirrors the original release's HR_HIDDEN_ACTOR_ROLES exactly (administrator ->
// ADMIN, department_head -> MANAGER).
const HR_HIDDEN_ACTOR_ROLES: Role[] = [Role.ADMIN, Role.MANAGER];

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // An Admin is the one role allowed to review their own request (HR/Manager are blocked by assertNotSelfApproval);
  // that is only safe if it is visible, so every such review is written to the trail as SELF_APPROVAL. A no-op for
  // anyone else and for requests that belong to someone else. Never fails the review it documents.
  async logSelfApproval(
    actor: Actor,
    input: {
      module: AuditModule;
      targetId: string;
      employeeId: string;
      request: string;
    },
  ): Promise<void> {
    if (actor.role !== Role.ADMIN || actor.id !== input.employeeId) return;
    await this.log({
      actorId: actor.id,
      action: 'SELF_APPROVAL',
      module: input.module,
      organizationId: actor.organizationId,
      targetId: input.targetId,
      details: {
        request: input.request,
        employeeId: input.employeeId,
        note: 'Admin reviewed their own request',
      },
    });
  }

  // Fire-and-forget — a broken audit write must never fail the action it's
  // documenting, same as the original release's logAudit util.
  async log(input: LogAuditInput): Promise<void> {
    try {
      // Where it came from: the request's id and client address, and the actor's role at this moment. A scheduled job
      // has no request, so it records no request id and the role is looked up.
      const request = currentRequest();
      const actorRole =
        input.actorRole ??
        (request?.user?.id === input.actorId
          ? request.user.role
          : ((
              await this.scopedPrisma.user.findFirst({
                where: {
                  id: input.actorId,
                  organizationId: input.organizationId,
                },
                select: { role: true },
              })
            )?.role ?? null));
      const id = randomUUID();
      const createdAt = new Date();
      const details = (input.details ?? {}) as Prisma.InputJsonValue;
      const ipAddress = input.ipAddress ?? request?.ip ?? '';
      const outcome = input.outcome ?? 'SUCCESS';
      // Chained: each row carries the hash of the previous one for this organization, written under a lock per organization so
      // two writers cannot fork the chain.
      await this.scopedPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'audit-log:' + input.organizationId}))`;
        const last = await tx.auditLog.findFirst({
          where: { organizationId: input.organizationId, hash: { not: '' } },
          orderBy: { seq: 'desc' },
          select: { hash: true },
        });
        const prevHash = last?.hash ?? '';
        await tx.auditLog.create({
          data: {
            id,
            createdAt,
            organizationId: input.organizationId,
            actorId: input.actorId,
            action: input.action,
            module: input.module,
            targetId: input.targetId ?? null,
            details,
            ipAddress,
            actorRole,
            outcome,
            requestId: request?.requestId ?? null,
            prevHash,
            hash: computeHash(prevHash, this.chainRow({ id, organizationId: input.organizationId, actorId: input.actorId, actorRole, action: input.action, module: input.module, targetId: input.targetId ?? null, outcome, ipAddress, details, createdAt })),
          },
        });
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // The fields that are hashed. Request id is left out on purpose: it is a trace aid, not part of what happened.
  private chainRow(r: { id: string; organizationId: string; actorId: string | null; actorRole: string | null; action: string; module: string; targetId: string | null; outcome: string; ipAddress: string; details: unknown; createdAt: Date }): ChainRow {
    return {
      id: r.id,
      organizationId: r.organizationId,
      actorId: r.actorId,
      actorRole: r.actorRole ?? '',
      action: r.action,
      category: r.module,
      targetUserId: r.targetId,
      entity: null,
      entityId: null,
      result: r.outcome,
      ip: r.ipAddress,
      userAgent: '',
      meta: r.details ?? {},
      createdAt: r.createdAt,
    };
  }

  // Recomputes the chain for the organization (oldest first) and reports the first row that does not match. Rows written before
  // the chain existed have no hash and are counted separately, not as a break.
  async verifyChain(organizationId: string) {
    const BATCH = 1000;
    let lastSeq: number | undefined;
    let prev = '';
    let processed = 0;
    for (;;) {
      const rows = await this.scopedPrisma.auditLog.findMany({
        where: { organizationId, hash: { not: '' }, ...(lastSeq !== undefined ? { seq: { gt: lastSeq } } : {}) },
        orderBy: { seq: 'asc' },
        take: BATCH,
      });
      if (rows.length === 0) break;
      const res = verifyChain(rows.map((r) => ({ ...this.chainRow(r), prevHash: r.prevHash, hash: r.hash })), prev, processed);
      if (!res.intact) {
        return { intact: false, checked: processed + res.checked, unchained: await this.countUnchained(organizationId), brokenRowId: res.brokenRowId, reason: res.reason };
      }
      prev = res.lastHash;
      lastSeq = rows[rows.length - 1].seq;
      processed += rows.length;
      if (rows.length < BATCH) break;
    }
    return { intact: true, checked: processed, unchained: await this.countUnchained(organizationId), brokenRowId: null, reason: null };
  }

  private countUnchained(organizationId: string) {
    return this.scopedPrisma.auditLog.count({ where: { organizationId, hash: '' } });
  }

  // Deletes the org's entries inside a date range (inclusive, whole days), re-links the hash chain over the rows
  // that remain so verifyChain() stays intact, then records the purge itself (who, range, how many) as a new entry.
  async deleteRange(actor: Actor, fromDate: string, toDate: string) {
    const from = new Date(`${fromDate.slice(0, 10)}T00:00:00.000Z`);
    const to = new Date(`${toDate.slice(0, 10)}T23:59:59.999Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('Choose a valid date range (from must not be after to)');
    }
    const organizationId = actor.organizationId;
    const deleted = await this.scopedPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'audit-log:' + organizationId}))`;
        const range = { organizationId, createdAt: { gte: from, lte: to } };
        const first = await tx.auditLog.findFirst({ where: { ...range, hash: { not: '' } }, orderBy: { seq: 'asc' }, select: { seq: true } });
        const count = await tx.auditLog.deleteMany({ where: range });
        if (first && count.count > 0) {
          // Re-link every chained row from the first removed position onward.
          const before = await tx.auditLog.findFirst({
            where: { organizationId, hash: { not: '' }, seq: { lt: first.seq } },
            orderBy: { seq: 'desc' },
            select: { hash: true },
          });
          let prev = before?.hash ?? '';
          let lastSeq = first.seq - 1;
          for (;;) {
            const rows = await tx.auditLog.findMany({
              where: { organizationId, hash: { not: '' }, seq: { gt: lastSeq } },
              orderBy: { seq: 'asc' },
              take: 500,
            });
            if (rows.length === 0) break;
            for (const r of rows) {
              const hash = computeHash(prev, this.chainRow(r));
              if (r.prevHash !== prev || r.hash !== hash) {
                await tx.auditLog.updateMany({ where: { id: r.id, organizationId }, data: { prevHash: prev, hash } });
              }
              prev = hash;
            }
            lastSeq = rows[rows.length - 1].seq;
          }
        }
        return count.count;
      },
      { timeout: 120000, maxWait: 10000 },
    );
    await this.log({
      actorId: actor.id,
      action: 'AUDIT_LOGS_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { from: fromDate.slice(0, 10), to: toDate.slice(0, 10), deleted },
    });
    return { deleted };
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
    if (query.outcome) where.outcome = query.outcome;
    // Sign-ins are the bulk of the trail and bury the changes people look for.
    if (query.hideSignIns) where.NOT = { module: AuditModule.AUTH, action: 'LOGIN' };
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
