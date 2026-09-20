// Purpose: Owns the org-level privacy configuration: settings (purposes, categories, retention, officer/grievance
// contact), versioned privacy notices, the data-processor register, data-sharing records, breach incidents and the
// report-only retention review.
// Responsibilities: Lazily get-or-creates default settings + a DRAFT notice v1 + system-detected processors on first
// read; validates the JSON config shapes; audit-logs every change via PrivacyAuditService.
// Important: Published notice versions are immutable (a change = a new version row). Retention rules default to
// periodMonths=null ("Not configured"); no legal period is ever invented. retentionReview() only REPORTS candidates
// — nothing here deletes data. All queries are org-scoped through scopedPrisma (tenant guard).
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrivacySettings } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { paginate, wrapAll } from '../common/pagination';
import { PrivacyAuditService } from './privacy-audit.service';
import {
  LEGAL_BASES,
  ProcessingPurpose,
  RETENTION_ACTIONS,
  RetentionRule,
  defaultCategories,
  defaultDeletionRules,
  defaultExportSettings,
  defaultNoticeBody,
  defaultPurposes,
  defaultRetention,
  detectedProcessors,
} from './privacy-defaults';
import type { Caller, ReqCtx } from './privacy.types';
import { UpdatePrivacySettingsDto } from './dto/update-privacy-settings.dto';
import {
  CreatePrivacyNoticeDto,
  PublishPrivacyNoticeDto,
  UpdatePrivacyNoticeDraftDto,
} from './dto/privacy-notice.dto';
import {
  CreateDataProcessorDto,
  UpdateDataProcessorDto,
} from './dto/data-processor.dto';
import {
  CreateDataSharingDto,
  UpdateDataSharingDto,
} from './dto/data-sharing.dto';
import {
  CloseBreachDto,
  CreateBreachDto,
  ListBreachesQueryDto,
  UpdateBreachDto,
} from './dto/breach-incident.dto';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

function pad(n: number): string {
  return String(n).padStart(5, '0');
}

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly audit: PrivacyAuditService,
  ) {}

  // -- helpers --

  private async log(
    actor: Caller,
    ctx: ReqCtx,
    action: string,
    category: string,
    extra: {
      entity?: string;
      entityId?: string;
      meta?: Record<string, unknown>;
    } = {},
  ) {
    await this.audit.log({
      organizationId: actor.organizationId,
      actorId: actor.id,
      actorRole: actor.role,
      action,
      category,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      ...extra,
    });
  }

  // -- settings --

  // Get-or-create with defaults. Safe under races: a lost unique-violation just re-reads the winner's row.
  async ensureSettings(organizationId: string): Promise<PrivacySettings> {
    const existing = await this.scopedPrisma.privacySettings.findFirst({
      where: { organizationId },
    });
    if (existing) return existing;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    let created: PrivacySettings;
    try {
      created = await this.scopedPrisma.privacySettings.create({
        data: {
          organizationId,
          processingPurposes:
            defaultPurposes() as unknown as Prisma.InputJsonValue,
          dataCategories:
            defaultCategories() as unknown as Prisma.InputJsonValue,
          retentionRules:
            defaultRetention() as unknown as Prisma.InputJsonValue,
          exportSettings: defaultExportSettings(),
          deletionRules: defaultDeletionRules(),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.scopedPrisma.privacySettings.findFirstOrThrow({
        where: { organizationId },
      });
    }
    const noticeCount = await this.scopedPrisma.privacyNoticeVersion.count({
      where: { organizationId },
    });
    if (noticeCount === 0) {
      try {
        await this.scopedPrisma.privacyNoticeVersion.create({
          data: {
            organizationId,
            version: 1,
            title: 'Employee Privacy Notice (template - requires legal review)',
            body: defaultNoticeBody(org?.name ?? 'the organization'),
            status: 'DRAFT',
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return created;
  }

  async getSettings(organizationId: string) {
    return this.ensureSettings(organizationId);
  }

  private validateSettingsJson(dto: UpdatePrivacySettingsDto) {
    const bad = (m: string) => new BadRequestException(m);
    if (dto.processingPurposes) {
      const seen = new Set<string>();
      for (const p of dto.processingPurposes as Partial<ProcessingPurpose>[]) {
        if (!p || typeof p !== 'object')
          throw bad('Each purpose must be an object.');
        if (
          !p.key ||
          typeof p.key !== 'string' ||
          !/^[a-z0-9_]{2,60}$/.test(p.key)
        ) {
          throw bad(
            'Each purpose needs a key (lowercase letters, digits, underscore).',
          );
        }
        if (seen.has(p.key)) throw bad(`Duplicate purpose key "${p.key}".`);
        seen.add(p.key);
        if (!p.label || typeof p.label !== 'string')
          throw bad(`Purpose "${p.key}" needs a label.`);
        if (!p.legalBasis || !LEGAL_BASES.includes(p.legalBasis)) {
          throw bad(
            `Purpose "${p.key}" needs a legalBasis of ${LEGAL_BASES.join(', ')}.`,
          );
        }
        if (p.modules !== undefined && !Array.isArray(p.modules)) {
          throw bad(`Purpose "${p.key}" modules must be an array.`);
        }
      }
    }
    if (dto.dataCategories) {
      const seen = new Set<string>();
      for (const c of dto.dataCategories as {
        key?: string;
        label?: string;
        fields?: { key?: string; label?: string; source?: string }[];
      }[]) {
        if (
          !c ||
          typeof c.key !== 'string' ||
          !c.key ||
          typeof c.label !== 'string'
        ) {
          throw bad('Each data category needs a key and label.');
        }
        if (seen.has(c.key)) throw bad(`Duplicate category key "${c.key}".`);
        seen.add(c.key);
        if (!Array.isArray(c.fields))
          throw bad(`Category "${c.key}" needs a fields array.`);
        for (const fld of c.fields) {
          if (
            !fld ||
            typeof fld.key !== 'string' ||
            typeof fld.label !== 'string' ||
            typeof fld.source !== 'string'
          ) {
            throw bad(`Category "${c.key}" fields need key, label and source.`);
          }
        }
      }
    }
    if (dto.retentionRules) {
      for (const r of dto.retentionRules as Partial<RetentionRule>[]) {
        if (!r || typeof r.dataType !== 'string' || !r.dataType) {
          throw bad('Each retention rule needs a dataType.');
        }
        if (r.periodMonths !== null && r.periodMonths !== undefined) {
          if (
            !Number.isInteger(r.periodMonths) ||
            r.periodMonths < 1 ||
            r.periodMonths > 1200
          ) {
            throw bad(
              `Retention rule "${r.dataType}": periodMonths must be null or a whole number of months.`,
            );
          }
        }
        if (
          !r.action ||
          !(RETENTION_ACTIONS as readonly string[]).includes(r.action)
        ) {
          throw bad(
            `Retention rule "${r.dataType}": action must be one of ${RETENTION_ACTIONS.join(', ')}.`,
          );
        }
      }
    }
  }

  async updateSettings(
    dto: UpdatePrivacySettingsDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const organizationId = actor.organizationId;
    await this.ensureSettings(organizationId);
    this.validateSettingsJson(dto);
    const data: Prisma.PrivacySettingsUpdateManyMutationInput = {};
    const changed: string[] = [];
    const scalar = [
      'privacyOfficerName',
      'privacyOfficerEmail',
      'privacyOfficerPhone',
      'grievanceInfo',
      'requestSlaDays',
    ] as const;
    for (const k of scalar) {
      if (dto[k] !== undefined) {
        (data as Record<string, unknown>)[k] = dto[k];
        changed.push(k);
      }
    }
    const json = [
      'processingPurposes',
      'dataCategories',
      'retentionRules',
      'exportSettings',
      'deletionRules',
    ] as const;
    for (const k of json) {
      if (dto[k] !== undefined) {
        // retention rules with no period are forced back to "needs legal review" semantics client-side only;
        // stored exactly as provided.
        (data as Record<string, unknown>)[k] = dto[k];
        changed.push(k);
      }
    }
    if (changed.length) {
      await this.scopedPrisma.privacySettings.updateMany({
        where: { organizationId },
        data,
      });
    }
    await this.log(actor, ctx, 'PRIVACY_SETTINGS_UPDATED', 'SETTINGS', {
      entity: 'PrivacySettings',
      meta: { changedKeys: changed },
    });
    return this.ensureSettings(organizationId);
  }

  // -- notices --

  async listNotices(organizationId: string) {
    await this.ensureSettings(organizationId);
    const rows = await this.scopedPrisma.privacyNoticeVersion.findMany({
      where: { organizationId },
      orderBy: { version: 'desc' },
    });
    return wrapAll(rows);
  }

  async getCurrentNotice(organizationId: string) {
    await this.ensureSettings(organizationId);
    return this.scopedPrisma.privacyNoticeVersion.findFirst({
      where: {
        organizationId,
        status: 'PUBLISHED',
        effectiveFrom: { lte: new Date() },
      },
      orderBy: { version: 'desc' },
    });
  }

  private async nextNoticeVersion(organizationId: string): Promise<number> {
    const last = await this.scopedPrisma.privacyNoticeVersion.findFirst({
      where: { organizationId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (last?.version ?? 0) + 1;
  }

  async createNotice(dto: CreatePrivacyNoticeDto, actor: Caller, ctx: ReqCtx) {
    const organizationId = actor.organizationId;
    await this.ensureSettings(organizationId);
    const publish = dto.publish !== false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await this.nextNoticeVersion(organizationId);
      try {
        const now = new Date();
        const row = await this.scopedPrisma.privacyNoticeVersion.create({
          data: {
            organizationId,
            version,
            title: dto.title,
            body: dto.body,
            createdById: actor.id,
            ...(publish
              ? {
                  status: 'PUBLISHED' as const,
                  publishedAt: now,
                  publishedById: actor.id,
                  effectiveFrom: dto.effectiveFrom
                    ? new Date(dto.effectiveFrom)
                    : now,
                }
              : {
                  effectiveFrom: dto.effectiveFrom
                    ? new Date(dto.effectiveFrom)
                    : null,
                }),
          },
        });
        await this.log(
          actor,
          ctx,
          publish ? 'PRIVACY_NOTICE_PUBLISHED' : 'PRIVACY_NOTICE_DRAFT_CREATED',
          'NOTICE',
          {
            entity: 'PrivacyNoticeVersion',
            entityId: row.id,
            meta: { version },
          },
        );
        return row;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new ConflictException(
      'Could not allocate a notice version; please retry.',
    );
  }

  async updateNoticeDraft(
    id: string,
    dto: UpdatePrivacyNoticeDraftDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const notice = await this.findNoticeOrThrow(id, actor.organizationId);
    if (notice.status !== 'DRAFT') {
      throw new ConflictException(
        'A published notice is immutable. Create a new version instead.',
      );
    }
    await this.scopedPrisma.privacyNoticeVersion.updateMany({
      where: { id, organizationId: actor.organizationId, status: 'DRAFT' },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.effectiveFrom !== undefined && {
          effectiveFrom: new Date(dto.effectiveFrom),
        }),
      },
    });
    await this.log(actor, ctx, 'PRIVACY_NOTICE_DRAFT_UPDATED', 'NOTICE', {
      entity: 'PrivacyNoticeVersion',
      entityId: id,
      meta: { version: notice.version },
    });
    return this.findNoticeOrThrow(id, actor.organizationId);
  }

  async publishNotice(
    id: string,
    dto: PublishPrivacyNoticeDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const notice = await this.findNoticeOrThrow(id, actor.organizationId);
    if (notice.status === 'PUBLISHED') {
      throw new ConflictException('This notice version is already published.');
    }
    const now = new Date();
    await this.scopedPrisma.privacyNoticeVersion.updateMany({
      where: { id, organizationId: actor.organizationId, status: 'DRAFT' },
      data: {
        status: 'PUBLISHED',
        publishedAt: now,
        publishedById: actor.id,
        effectiveFrom: dto.effectiveFrom
          ? new Date(dto.effectiveFrom)
          : (notice.effectiveFrom ?? now),
      },
    });
    await this.log(actor, ctx, 'PRIVACY_NOTICE_PUBLISHED', 'NOTICE', {
      entity: 'PrivacyNoticeVersion',
      entityId: id,
      meta: { version: notice.version },
    });
    return this.findNoticeOrThrow(id, actor.organizationId);
  }

  private async findNoticeOrThrow(id: string, organizationId: string) {
    const n = await this.scopedPrisma.privacyNoticeVersion.findFirst({
      where: { id, organizationId },
    });
    if (!n) throw new NotFoundException('Notice version not found.');
    return n;
  }

  // -- processors --

  private async ensureProcessorsSeeded(organizationId: string) {
    const settings = await this.ensureSettings(organizationId);
    if (settings.processorsSeededAt) return;
    // Claim the seed first (compare-and-set) so two concurrent first reads cannot both insert.
    const claimed = await this.scopedPrisma.privacySettings.updateMany({
      where: { organizationId, processorsSeededAt: null },
      data: { processorsSeededAt: new Date() },
    });
    if (claimed.count === 0) return;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { faceApiKey: true },
    });
    const seeds = detectedProcessors(process.env, {
      faceDeviceEnabled: !!org?.faceApiKey,
    });
    await this.scopedPrisma.dataProcessor.createMany({
      data: seeds.map((s) => ({
        ...s,
        organizationId,
        isSystemDetected: true,
      })),
    });
  }

  async listProcessors(organizationId: string) {
    await this.ensureProcessorsSeeded(organizationId);
    const rows = await this.scopedPrisma.dataProcessor.findMany({
      where: { organizationId },
      orderBy: [{ isSystemDetected: 'desc' }, { name: 'asc' }],
    });
    return wrapAll(rows);
  }

  async createProcessor(
    dto: CreateDataProcessorDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    await this.ensureProcessorsSeeded(actor.organizationId);
    const row = await this.scopedPrisma.dataProcessor.create({
      data: { ...dto, organizationId: actor.organizationId },
    });
    await this.log(actor, ctx, 'DATA_PROCESSOR_CREATED', 'PROCESSOR', {
      entity: 'DataProcessor',
      entityId: row.id,
    });
    return row;
  }

  async updateProcessor(
    id: string,
    dto: UpdateDataProcessorDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const res = await this.scopedPrisma.dataProcessor.updateMany({
      where: { id, organizationId: actor.organizationId },
      data: dto,
    });
    if (res.count === 0)
      throw new NotFoundException('Data processor not found.');
    await this.log(actor, ctx, 'DATA_PROCESSOR_UPDATED', 'PROCESSOR', {
      entity: 'DataProcessor',
      entityId: id,
      meta: { changedKeys: Object.keys(dto) },
    });
    return this.scopedPrisma.dataProcessor.findFirstOrThrow({
      where: { id, organizationId: actor.organizationId },
    });
  }

  async removeProcessor(id: string, actor: Caller, ctx: ReqCtx) {
    const res = await this.scopedPrisma.dataProcessor.deleteMany({
      where: { id, organizationId: actor.organizationId },
    });
    if (res.count === 0)
      throw new NotFoundException('Data processor not found.');
    await this.log(actor, ctx, 'DATA_PROCESSOR_DELETED', 'PROCESSOR', {
      entity: 'DataProcessor',
      entityId: id,
    });
    return { success: true };
  }

  // -- data sharing --

  async listSharing(organizationId: string) {
    const rows = await this.scopedPrisma.dataSharingRecord.findMany({
      where: { organizationId },
      orderBy: { sharedAt: 'desc' },
    });
    return wrapAll(rows);
  }

  async createSharing(dto: CreateDataSharingDto, actor: Caller, ctx: ReqCtx) {
    const row = await this.scopedPrisma.dataSharingRecord.create({
      data: {
        organizationId: actor.organizationId,
        recipient: dto.recipient,
        dataCategory: dto.dataCategory,
        purpose: dto.purpose ?? '',
        integration: dto.integration ?? '',
        ...(dto.status && { status: dto.status }),
        sharedAt: dto.sharedAt ? new Date(dto.sharedAt) : new Date(),
        recordedById: actor.id,
      },
    });
    await this.log(actor, ctx, 'DATA_SHARING_RECORDED', 'SHARING', {
      entity: 'DataSharingRecord',
      entityId: row.id,
    });
    return row;
  }

  // For reuse by export paths (statutory/bank files) in a follow-up; not wired into other modules yet.
  async recordSystemSharing(
    organizationId: string,
    input: {
      recipient: string;
      dataCategory: string;
      purpose?: string;
      integration?: string;
    },
    actorId?: string,
  ) {
    const key = {
      organizationId,
      recipient: input.recipient,
      dataCategory: input.dataCategory,
      purpose: input.purpose ?? '',
      integration: input.integration ?? '',
      isAutoRecorded: true,
    };
    // Refresh the existing auto-recorded row instead of adding one per export.
    const existing = await this.scopedPrisma.dataSharingRecord.findFirst({
      where: key,
    });
    if (existing) {
      const sharedAt = new Date();
      await this.scopedPrisma.dataSharingRecord.updateMany({
        where: { id: existing.id, organizationId },
        data: { sharedAt, recordedById: actorId ?? null },
      });
      return { ...existing, sharedAt };
    }
    return this.scopedPrisma.dataSharingRecord.create({
      data: { ...key, recordedById: actorId ?? null },
    });
  }

  async updateSharing(
    id: string,
    dto: UpdateDataSharingDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const { sharedAt, ...rest } = dto;
    const res = await this.scopedPrisma.dataSharingRecord.updateMany({
      where: { id, organizationId: actor.organizationId },
      data: { ...rest, ...(sharedAt && { sharedAt: new Date(sharedAt) }) },
    });
    if (res.count === 0)
      throw new NotFoundException('Sharing record not found.');
    await this.log(actor, ctx, 'DATA_SHARING_UPDATED', 'SHARING', {
      entity: 'DataSharingRecord',
      entityId: id,
      meta: { changedKeys: Object.keys(dto) },
    });
    return this.scopedPrisma.dataSharingRecord.findFirstOrThrow({
      where: { id, organizationId: actor.organizationId },
    });
  }

  async removeSharing(id: string, actor: Caller, ctx: ReqCtx) {
    const res = await this.scopedPrisma.dataSharingRecord.deleteMany({
      where: { id, organizationId: actor.organizationId },
    });
    if (res.count === 0)
      throw new NotFoundException('Sharing record not found.');
    await this.log(actor, ctx, 'DATA_SHARING_DELETED', 'SHARING', {
      entity: 'DataSharingRecord',
      entityId: id,
    });
    return { success: true };
  }

  // -- breaches --

  async listBreaches(query: ListBreachesQueryDto, organizationId: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: Prisma.BreachIncidentWhereInput = {
      organizationId,
      ...(query.status && { status: query.status }),
    };
    return paginate(
      () =>
        this.scopedPrisma.breachIncident.findMany({
          where,
          orderBy: { seqNo: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      () => this.scopedPrisma.breachIncident.count({ where }),
      page,
      limit,
    );
  }

  async getBreach(id: string, organizationId: string) {
    const b = await this.scopedPrisma.breachIncident.findFirst({
      where: { id, organizationId },
    });
    if (!b) throw new NotFoundException('Incident not found.');
    return b;
  }

  async createBreach(dto: CreateBreachDto, actor: Caller, ctx: ReqCtx) {
    const organizationId = actor.organizationId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await this.scopedPrisma.breachIncident.findFirst({
        where: { organizationId },
        orderBy: { seqNo: 'desc' },
        select: { seqNo: true },
      });
      const seqNo = (last?.seqNo ?? 0) + 1;
      try {
        const row = await this.scopedPrisma.breachIncident.create({
          data: {
            organizationId,
            seqNo,
            incidentNo: `INC-${pad(seqNo)}`,
            createdById: actor.id,
            ...dto,
            detectedAt: new Date(dto.detectedAt),
            reportedBy: dto.reportedBy ?? actor.name,
          },
        });
        await this.log(actor, ctx, 'BREACH_INCIDENT_CREATED', 'BREACH', {
          entity: 'BreachIncident',
          entityId: row.id,
          meta: { incidentNo: row.incidentNo, severity: row.severity },
        });
        return row;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new ConflictException(
      'Could not allocate an incident number; please retry.',
    );
  }

  async updateBreach(
    id: string,
    dto: UpdateBreachDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const existing = await this.getBreach(id, actor.organizationId);
    if (existing.status === 'CLOSED') {
      throw new ConflictException('A closed incident cannot be edited.');
    }
    const { detectedAt, ...rest } = dto;
    await this.scopedPrisma.breachIncident.updateMany({
      where: { id, organizationId: actor.organizationId },
      data: {
        ...rest,
        ...(detectedAt && { detectedAt: new Date(detectedAt) }),
      },
    });
    await this.log(actor, ctx, 'BREACH_INCIDENT_UPDATED', 'BREACH', {
      entity: 'BreachIncident',
      entityId: id,
      meta: { incidentNo: existing.incidentNo, changedKeys: Object.keys(dto) },
    });
    return this.getBreach(id, actor.organizationId);
  }

  async closeBreach(
    id: string,
    dto: CloseBreachDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const existing = await this.getBreach(id, actor.organizationId);
    if (existing.status === 'CLOSED') {
      throw new ConflictException('This incident is already closed.');
    }
    await this.scopedPrisma.breachIncident.updateMany({
      where: { id, organizationId: actor.organizationId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        resolution: dto.resolution,
      },
    });
    await this.log(actor, ctx, 'BREACH_INCIDENT_CLOSED', 'BREACH', {
      entity: 'BreachIncident',
      entityId: id,
      meta: { incidentNo: existing.incidentNo },
    });
    return this.getBreach(id, actor.organizationId);
  }

  async removeBreach(id: string, actor: Caller, ctx: ReqCtx) {
    const existing = await this.getBreach(id, actor.organizationId);
    if (existing.status === 'CLOSED') {
      throw new ConflictException(
        'A closed incident is part of the record and cannot be deleted.',
      );
    }
    await this.scopedPrisma.breachIncident.deleteMany({
      where: { id, organizationId: actor.organizationId },
    });
    await this.log(actor, ctx, 'BREACH_INCIDENT_DELETED', 'BREACH', {
      entity: 'BreachIncident',
      entityId: id,
      meta: { incidentNo: existing.incidentNo },
    });
    return { success: true };
  }

  // -- retention review (REPORT ONLY) --

  async retentionReview(actor: Caller, ctx: ReqCtx) {
    const organizationId = actor.organizationId;
    const settings = await this.ensureSettings(organizationId);
    const rules = (settings.retentionRules as unknown as RetentionRule[]) ?? [];
    const report: Record<string, unknown>[] = [];
    for (const rule of rules) {
      if (rule.periodMonths === null || rule.periodMonths === undefined) {
        report.push({
          dataType: rule.dataType,
          label: rule.label ?? rule.dataType,
          status: 'NOT_CONFIGURED',
          periodMonths: null,
          action: rule.action,
          candidateCount: null,
          note: 'Not configured. A retention period needs legal review before it can be applied.',
        });
        continue;
      }
      const cutoff = monthsAgo(rule.periodMonths);
      const count = await this.countCandidates(
        rule.dataType,
        organizationId,
        cutoff,
      );
      report.push({
        dataType: rule.dataType,
        label: rule.label ?? rule.dataType,
        status: count === null ? 'MANUAL_REVIEW' : 'EVALUATED',
        periodMonths: rule.periodMonths,
        action: rule.action,
        cutoff: cutoff.toISOString(),
        candidateCount: count,
        note:
          count === null
            ? 'No automated candidate query exists for this data type; review manually.'
            : 'Report only. Nothing is deleted automatically.',
      });
    }
    await this.log(actor, ctx, 'RETENTION_REVIEW_RUN', 'RETENTION', {
      entity: 'PrivacySettings',
      meta: { rules: report.length },
    });
    return {
      generatedAt: new Date().toISOString(),
      reportOnly: true,
      rules: report,
    };
  }

  private async countCandidates(
    dataType: string,
    organizationId: string,
    cutoff: Date,
  ): Promise<number | null> {
    const p = this.scopedPrisma;
    switch (dataType) {
      case 'employee_profile':
        return p.user.count({
          where: { organizationId, isActive: false, updatedAt: { lt: cutoff } },
        });
      case 'documents':
        return p.employeeDocument.count({
          where: {
            organizationId,
            uploadedAt: { lt: cutoff },
            employee: { isActive: false },
          },
        });
      case 'notifications':
        return p.notification.count({
          where: { organizationId, createdAt: { lt: cutoff } },
        });
      case 'sessions_tokens':
        return p.refreshToken.count({
          where: {
            organizationId,
            OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
          },
        });
      case 'attendance_records':
        return p.punch.count({
          where: { organizationId, punchTime: { lt: cutoff } },
        });
      case 'audit_logs':
        return p.auditLog.count({
          where: { organizationId, createdAt: { lt: cutoff } },
        });
      default:
        return null;
    }
  }
}
