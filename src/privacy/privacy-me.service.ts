// Purpose: Employee-facing (self-service) privacy operations under /privacy/me: current notice + acknowledgement,
// "my data" summary, consent grant/withdraw and the privacy contact.
// Responsibilities: Reads only the caller's own data; ConsentRecord is append-only (a withdrawal is a new row);
// consent operations are accepted only for purposes whose legal basis is CONSENT.
// Important: Withdrawal never affects processing that rests on another legal basis (contract, legal obligation,
// legitimate use) — for those purposes the API refuses with an explanation instead of pretending to stop the
// processing. The my-data summary exposes no sensitive values beyond masked last-4 of ID/bank numbers.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrivacyAuditService } from './privacy-audit.service';
import { PrivacyService } from './privacy.service';
import { maskTail } from './privacy-requests.service';
import type { DataCategory, ProcessingPurpose } from './privacy-defaults';
import type { Caller, ReqCtx } from './privacy.types';

export const NOTICE_ACK_KEY = 'notice_acknowledgement';

@Injectable()
export class PrivacyMeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly audit: PrivacyAuditService,
    private readonly privacy: PrivacyService,
  ) {}

  private log(
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
    return this.audit.log({
      organizationId: actor.organizationId,
      actorId: actor.id,
      actorRole: actor.role,
      action,
      category,
      targetUserId: actor.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      ...extra,
    });
  }

  // -- notice --

  async getNotice(actor: Caller) {
    const notice = await this.privacy.getCurrentNotice(actor.organizationId);
    if (!notice) {
      return {
        notice: null,
        acknowledged: false,
        message: 'No privacy notice has been published yet.',
      };
    }
    const ack = await this.scopedPrisma.consentRecord.findFirst({
      where: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey: NOTICE_ACK_KEY,
        noticeVersionId: notice.id,
        status: 'GRANTED',
      },
      orderBy: { at: 'desc' },
    });
    return {
      notice: {
        id: notice.id,
        version: notice.version,
        title: notice.title,
        body: notice.body,
        effectiveFrom: notice.effectiveFrom,
      },
      acknowledged: !!ack,
      acknowledgedAt: ack?.at ?? null,
    };
  }

  async acknowledgeNotice(
    noticeVersionId: string | undefined,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const notice = await this.privacy.getCurrentNotice(actor.organizationId);
    if (!notice)
      throw new NotFoundException('No privacy notice has been published yet.');
    if (noticeVersionId && noticeVersionId !== notice.id) {
      throw new BadRequestException(
        'That notice version is not the current one. Reload the notice.',
      );
    }
    const row = await this.scopedPrisma.consentRecord.create({
      data: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey: NOTICE_ACK_KEY,
        status: 'GRANTED',
        noticeVersionId: notice.id,
        source: 'NOTICE_ACKNOWLEDGEMENT',
      },
    });
    await this.log(actor, ctx, 'PRIVACY_NOTICE_ACKNOWLEDGED', 'NOTICE', {
      entity: 'PrivacyNoticeVersion',
      entityId: notice.id,
      meta: { version: notice.version },
    });
    return {
      acknowledged: true,
      noticeVersionId: notice.id,
      version: notice.version,
      at: row.at,
    };
  }

  // -- my data --

  async getSummary(actor: Caller, ctx: ReqCtx) {
    const settings = await this.privacy.ensureSettings(actor.organizationId);
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId: actor.organizationId },
      select: { personalData: true, profileImage: true },
    });
    const pd = (user?.personalData as Record<string, unknown>) ?? {};
    const documents = await this.scopedPrisma.employeeDocument.findMany({
      where: { organizationId: actor.organizationId, employeeId: actor.id },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        docType: true,
        fileName: true,
        category: true,
        status: true,
        uploadedAt: true,
      },
    });
    const categories =
      (settings.dataCategories as unknown as DataCategory[]) ?? [];
    const purposes =
      (settings.processingPurposes as unknown as ProcessingPurpose[]) ?? [];
    await this.log(actor, ctx, 'MY_DATA_SUMMARY_VIEWED', 'ACCESS');
    return {
      categoriesHeld: categories.map((c) => ({
        key: c.key,
        label: c.label,
        fields: c.fields.map((f) => f.label),
      })),
      purposes: purposes.map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description,
        legalBasis: p.legalBasis,
      })),
      documents,
      identifiers: {
        pan: maskTail(pd.panNumber),
        aadhaar: maskTail(pd.aadharNumber),
        uan: maskTail(pd.uanNumber),
        bankAccount: maskTail(pd.bankAccountNo),
      },
      hasProfilePhoto: !!user?.profileImage,
    };
  }

  // -- consents --

  private async consentPurposes(organizationId: string) {
    const settings = await this.privacy.ensureSettings(organizationId);
    return (
      (settings.processingPurposes as unknown as ProcessingPurpose[]) ?? []
    );
  }

  private async latestStatus(actor: Caller, purposeKey: string) {
    return this.scopedPrisma.consentRecord.findFirst({
      where: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey,
      },
      orderBy: { at: 'desc' },
    });
  }

  async listConsents(actor: Caller) {
    const purposes = await this.consentPurposes(actor.organizationId);
    const records = await this.scopedPrisma.consentRecord.findMany({
      where: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey: { not: NOTICE_ACK_KEY },
      },
      orderBy: { at: 'desc' },
    });
    const latest = new Map<string, (typeof records)[number]>();
    for (const r of records)
      if (!latest.has(r.purposeKey)) latest.set(r.purposeKey, r);
    const data = purposes.map((p) => {
      const l = latest.get(p.key);
      return {
        purposeKey: p.key,
        label: p.label,
        description: p.description,
        legalBasis: p.legalBasis,
        consentBased: p.legalBasis === 'CONSENT',
        status:
          p.legalBasis === 'CONSENT'
            ? (l?.status ?? 'NOT_GIVEN')
            : 'NOT_APPLICABLE',
        lastChangedAt: l?.at ?? null,
        note:
          p.legalBasis === 'CONSENT'
            ? null
            : `Processed under ${p.legalBasis.replace('_', ' ').toLowerCase()}; it does not depend on your consent.`,
      };
    });
    return { data, total: data.length, page: 1, limit: data.length || 1 };
  }

  private async consentPurposeOrThrow(actor: Caller, purposeKey: string) {
    const purpose = (await this.consentPurposes(actor.organizationId)).find(
      (p) => p.key === purposeKey,
    );
    if (!purpose) throw new NotFoundException('Unknown purpose.');
    if (purpose.legalBasis !== 'CONSENT') {
      throw new BadRequestException(
        `"${purpose.label}" is processed under ${purpose.legalBasis.replace('_', ' ').toLowerCase()}, not consent, so it cannot be granted or withdrawn here. To object or ask about it, raise a privacy request.`,
      );
    }
    return purpose;
  }

  async grant(
    purposeKey: string,
    source: string | undefined,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const purpose = await this.consentPurposeOrThrow(actor, purposeKey);
    const notice = await this.privacy.getCurrentNotice(actor.organizationId);
    const row = await this.scopedPrisma.consentRecord.create({
      data: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey,
        status: 'GRANTED',
        noticeVersionId: notice?.id ?? null,
        source: source ?? 'SELF_SERVICE',
      },
    });
    await this.log(actor, ctx, 'CONSENT_GRANTED', 'CONSENT', {
      entity: 'ConsentRecord',
      entityId: row.id,
      meta: { purposeKey },
    });
    return { purposeKey, label: purpose.label, status: 'GRANTED', at: row.at };
  }

  async withdraw(
    purposeKey: string,
    source: string | undefined,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const purpose = await this.consentPurposeOrThrow(actor, purposeKey);
    const notice = await this.privacy.getCurrentNotice(actor.organizationId);
    const row = await this.scopedPrisma.consentRecord.create({
      data: {
        organizationId: actor.organizationId,
        userId: actor.id,
        purposeKey,
        status: 'WITHDRAWN',
        noticeVersionId: notice?.id ?? null,
        source: source ?? 'SELF_SERVICE',
      },
    });
    await this.log(actor, ctx, 'CONSENT_WITHDRAWN', 'CONSENT', {
      entity: 'ConsentRecord',
      entityId: row.id,
      meta: { purposeKey },
    });
    return {
      purposeKey,
      label: purpose.label,
      status: 'WITHDRAWN',
      at: row.at,
      consequence:
        purpose.withdrawalConsequence ??
        'Processing that depends only on your consent for this purpose will stop. Processing required by law or your employment contract is not affected.',
    };
  }

  // -- contact --

  async getContact(organizationId: string) {
    const s = await this.privacy.ensureSettings(organizationId);
    return {
      privacyOfficerName: s.privacyOfficerName,
      privacyOfficerEmail: s.privacyOfficerEmail,
      privacyOfficerPhone: s.privacyOfficerPhone,
      grievanceInfo: s.grievanceInfo,
      requestSlaDays: s.requestSlaDays,
    };
  }
}
