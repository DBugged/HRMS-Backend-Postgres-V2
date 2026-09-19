// Purpose: Writes, lists and verifies the privacy audit trail — an append-only, hash-chained log per organization.
// Responsibilities: log() appends a row whose hash covers the previous row's hash (see audit-chain.ts), serialized
// per organization with a Postgres advisory lock so concurrent writers cannot fork the chain; findAll() lists with
// filters; verifyChain() re-computes the whole chain and reports the first broken index.
// Important: Exported from PrivacyModule for reuse by other modules. There is deliberately NO update/delete method
// or route. log() swallows its own errors like AuditLogService (an audit failure must not fail the documented
// action). meta must only ever carry action descriptors (field names, counts, ids) — sanitizeMeta() redacts
// obviously sensitive keys and truncates long strings as a safety net, but callers must not pass raw values.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { paginate } from '../common/pagination';
import { computeHash, verifyChain } from './audit-chain';
import { QueryPrivacyAuditDto } from './dto/query-privacy-audit.dto';

export interface PrivacyAuditInput {
  organizationId: string;
  actorId?: string | null;
  actorRole?: string;
  action: string;
  category: string;
  targetUserId?: string | null;
  entity?: string;
  entityId?: string;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

const SENSITIVE_KEY =
  /pass|token|secret|aadh|pan(number)?$|bank|account|ifsc|salary|dob|birth|address|phone|email|value/i;
const MAX_META_STRING = 200;

export function sanitizeMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const clean = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.slice(0, MAX_META_STRING);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth > 3) return '[truncated]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : clean(val, depth + 1);
      }
      return out;
    }
    return '[unsupported]';
  };
  return (clean(meta ?? {}, 0) ?? {}) as Record<string, unknown>;
}

@Injectable()
export class PrivacyAuditService {
  private readonly logger = new Logger(PrivacyAuditService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async log(input: PrivacyAuditInput): Promise<void> {
    try {
      const id = randomUUID();
      const createdAt = new Date();
      const meta = sanitizeMeta(input.meta);
      await this.scopedPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'privacy-audit:' + input.organizationId}))`;
        const last = await tx.privacyAuditLog.findFirst({
          where: { organizationId: input.organizationId },
          orderBy: { seq: 'desc' },
          select: { hash: true },
        });
        const prevHash = last?.hash ?? '';
        const row = {
          id,
          organizationId: input.organizationId,
          actorId: input.actorId ?? null,
          actorRole: input.actorRole ?? '',
          action: input.action,
          category: input.category,
          targetUserId: input.targetUserId ?? null,
          entity: input.entity ?? null,
          entityId: input.entityId ?? null,
          result: input.result ?? 'SUCCESS',
          ip: input.ip ?? '',
          userAgent: (input.userAgent ?? '').slice(0, 300),
          meta,
          createdAt,
        };
        await tx.privacyAuditLog.create({
          data: {
            ...row,
            meta: meta as Prisma.InputJsonValue,
            prevHash,
            hash: computeHash(prevHash, row),
          },
        });
      });
    } catch (err) {
      this.logger.error(
        `Failed to write privacy audit log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findAll(query: QueryPrivacyAuditDto, organizationId: string) {
    const where: Prisma.PrivacyAuditLogWhereInput = { organizationId };
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetUserId) where.targetUserId = query.targetUserId;
    if (query.category) where.category = query.category;
    if (query.result) where.result = query.result;
    if (query.action) {
      where.action = { contains: query.action, mode: 'insensitive' };
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    return paginate(
      () =>
        this.scopedPrisma.privacyAuditLog.findMany({
          where,
          orderBy: { seq: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      () => this.scopedPrisma.privacyAuditLog.count({ where }),
      page,
      limit,
    );
  }

  // Re-computes the org's entire chain in batches. Read-only.
  async verifyChain(organizationId: string) {
    const BATCH = 1000;
    let offset = 0;
    let prev = '';
    let total = 0;
    for (;;) {
      const rows = await this.scopedPrisma.privacyAuditLog.findMany({
        where: { organizationId },
        orderBy: { seq: 'asc' },
        skip: offset,
        take: BATCH,
      });
      if (rows.length === 0) break;
      const res = verifyChain(rows, prev, offset);
      if (!res.intact) {
        return {
          intact: false,
          total: await this.scopedPrisma.privacyAuditLog.count({
            where: { organizationId },
          }),
          brokenAtIndex: res.brokenAtIndex,
          brokenRowId: res.brokenRowId,
          reason: res.reason,
        };
      }
      prev = res.lastHash;
      offset += rows.length;
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    return {
      intact: true,
      total,
      brokenAtIndex: null,
      brokenRowId: null,
      reason: null,
    };
  }
}
