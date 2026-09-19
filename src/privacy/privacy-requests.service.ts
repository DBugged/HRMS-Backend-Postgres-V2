// Purpose: Runs the data-principal request workflow (ACCESS / CORRECTION / UPDATE / EXPORT / ERASURE): submission,
// HR assignment/review/completion, SLA due dates, an append-only per-request event trail, export generation and
// restricted erasure.
// Responsibilities: Enforces the DPDP-aligned rules of this module — correction/update auto-applies ONLY to a
// whitelist of low-risk contact fields (controlled fields such as name, DOB, bank, PAN, salary, designation are never
// auto-changed and stay in the existing HR process); exports contain only the requester's own data with ID numbers
// masked and are stored under a signed-token URL (no public URL); erasure is refused ("Deletion Restricted") while
// payroll/loan/statutory records or configured retention rules apply, and otherwise only anonymizes optional
// personalData and removes non-required documents.
// Important: NEVER deletes the User row or payroll/audit data. Every state change is written to PrivacyAuditLog with
// field NAMES only, never values.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataRequest, DataRequestStatus, Prisma, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { paginate } from '../common/pagination';
import { signFileToken } from '../files/file-token';
import { deleteStoredFile } from '../files/delete-stored-file';
import { PrivacyAuditService } from './privacy-audit.service';
import { PrivacyService } from './privacy.service';
import { storeGeneratedFile } from './privacy-storage';
import type { RetentionRule } from './privacy-defaults';
import type { Caller, ReqCtx } from './privacy.types';
import {
  AssignDataRequestDto,
  CompleteDataRequestDto,
  CreateDataRequestDto,
  ListDataRequestsQueryDto,
  ReviewDataRequestDto,
} from './dto/data-request.dto';

const HR_ROLES: Role[] = [Role.ADMIN, Role.HR];

// Low-risk fields that an approved CORRECTION/UPDATE may change automatically.
export const AUTO_APPLY_USER_COLUMNS: Record<string, 'contactNumber'> = {
  phone: 'contactNumber',
  contactNumber: 'contactNumber',
};
export const AUTO_APPLY_PERSONAL_DATA = [
  'currentAddress',
  'emergencyContact1Name',
  'emergencyContact1Number',
  'emergencyContact2Name',
  'emergencyContact2Number',
] as const;
// Fields that may be REQUESTED but are never auto-changed — HR's existing verification process applies.
export const CONTROLLED_FIELDS = [
  'name',
  'fullNameAsPerGovtId',
  'dateOfBirth',
  'gender',
  'designation',
  'salary',
  'panNumber',
  'aadharNumber',
  'uanNumber',
  'esicNumber',
  'bankAccountNo',
  'bankIFSC',
  'bankName',
  'bankAccountHolderName',
  'email',
  'officialEmail',
] as const;

const OPTIONAL_PERSONAL_DATA_KEYS = [
  'fatherName',
  'fatherContact',
  'fatherOccupation',
  'motherName',
  'motherContact',
  'motherOccupation',
  'bloodGroup',
  'maritalStatus',
  'personalEmail',
  'currentAddress',
  'emergencyContact1Name',
  'emergencyContact1Number',
  'emergencyContact2Name',
  'emergencyContact2Number',
  'references',
  'previousEmployment',
];

const MASKED_KEYS = [
  'panNumber',
  'aadharNumber',
  'uanNumber',
  'esicNumber',
  'bankAccountNo',
  'bankMobile',
  'passportNumber',
];
const OMITTED_KEYS = ['cancelledChequeUrl'];

const OPEN_STATUSES: DataRequestStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
];

export function maskTail(value: unknown, keep = 4): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= keep) return '*'.repeat(s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}

interface RequestEvent {
  at: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  note?: string;
}

@Injectable()
export class PrivacyRequestsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly audit: PrivacyAuditService,
    private readonly privacy: PrivacyService,
  ) {}

  // -- shared helpers --

  private event(
    actor: Caller | null,
    action: string,
    note?: string,
  ): RequestEvent {
    return {
      at: new Date().toISOString(),
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'SYSTEM',
      action,
      ...(note && { note }),
    };
  }

  private async log(
    actor: Caller,
    ctx: ReqCtx,
    action: string,
    req: Pick<DataRequest, 'id' | 'userId' | 'requestNo' | 'type'>,
    meta: Record<string, unknown> = {},
    result: 'SUCCESS' | 'FAILURE' | 'DENIED' = 'SUCCESS',
  ) {
    await this.audit.log({
      organizationId: actor.organizationId,
      actorId: actor.id,
      actorRole: actor.role,
      action,
      category: 'REQUEST',
      targetUserId: req.userId,
      entity: 'DataRequest',
      entityId: req.id,
      result,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      meta: { requestNo: req.requestNo, type: req.type, ...meta },
    });
  }

  private async findOrThrow(id: string, organizationId: string) {
    const r = await this.scopedPrisma.dataRequest.findFirst({
      where: { id, organizationId },
    });
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  // Guarded write: only applies while the row is still in one of `fromStatuses`, so two reviewers cannot both act.
  private async transition(
    r: DataRequest,
    fromStatuses: DataRequestStatus[],
    data: Prisma.DataRequestUpdateManyMutationInput,
    ev: RequestEvent,
  ) {
    const events = [...((r.events as unknown as RequestEvent[]) ?? []), ev];
    const res = await this.scopedPrisma.dataRequest.updateMany({
      where: {
        id: r.id,
        organizationId: r.organizationId,
        status: { in: fromStatuses },
      },
      data: { ...data, events: events as unknown as Prisma.InputJsonValue },
    });
    if (res.count === 0) {
      throw new ConflictException(
        'This request was changed by someone else; reload and retry.',
      );
    }
    return this.findOrThrow(r.id, r.organizationId);
  }

  // Erasure verdict is exposed on the request so the employee sees "Deletion Restricted" and why.
  private async present(r: DataRequest) {
    let extra: Record<string, unknown> = {};
    if (r.type === 'ERASURE' && OPEN_STATUSES.includes(r.status)) {
      const restriction = await this.evaluateErasure(
        r.userId,
        r.organizationId,
      );
      extra = {
        deletionRestricted: restriction.restricted,
        restrictionReasons: restriction.reasons,
      };
    } else if (r.type === 'ERASURE') {
      const res = (r.result ?? {}) as Record<string, unknown>;
      extra = {
        deletionRestricted: !!res.deletionRestricted,
        restrictionReasons: res.restrictionReasons ?? [],
      };
    }
    const { exportFileKey, ...rest } = r;
    return { ...rest, exportReady: !!exportFileKey, ...extra };
  }

  // -- employee side --

  async create(dto: CreateDataRequestDto, actor: Caller, ctx: ReqCtx) {
    const organizationId = actor.organizationId;
    const settings = await this.privacy.ensureSettings(organizationId);

    const payload: Record<string, unknown> = {};
    if (dto.description) payload.description = dto.description;
    if (dto.type === 'CORRECTION' || dto.type === 'UPDATE') {
      const fields = dto.fields;
      if (!fields || Object.keys(fields).length === 0) {
        throw new BadRequestException(
          'Specify at least one field to correct or update.',
        );
      }
      const allowed = new Set<string>([
        ...Object.keys(AUTO_APPLY_USER_COLUMNS),
        ...AUTO_APPLY_PERSONAL_DATA,
        ...CONTROLLED_FIELDS,
      ]);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.has(k)) {
          throw new BadRequestException(
            `"${k}" is not a field that can be changed through a privacy request.`,
          );
        }
        if (typeof v !== 'string' || v.length > 500) {
          throw new BadRequestException(
            `Value for "${k}" must be text of at most 500 characters.`,
          );
        }
        clean[k] = v;
      }
      payload.fields = clean;
    } else if (dto.fields) {
      throw new BadRequestException(
        'Fields can only be provided for CORRECTION or UPDATE requests.',
      );
    }

    if (dto.type !== 'CORRECTION' && dto.type !== 'UPDATE') {
      const open = await this.scopedPrisma.dataRequest.count({
        where: {
          organizationId,
          userId: actor.id,
          type: dto.type,
          status: { in: OPEN_STATUSES },
        },
      });
      if (open > 0) {
        throw new ConflictException(
          `You already have an open ${dto.type} request.`,
        );
      }
    }

    const dueDate = new Date(Date.now() + settings.requestSlaDays * 86_400_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await this.scopedPrisma.dataRequest.findFirst({
        where: { organizationId },
        orderBy: { seqNo: 'desc' },
        select: { seqNo: true },
      });
      const seqNo = (last?.seqNo ?? 0) + 1;
      try {
        const created = await this.scopedPrisma.dataRequest.create({
          data: {
            organizationId,
            seqNo,
            requestNo: `PRV-${String(seqNo).padStart(5, '0')}`,
            userId: actor.id,
            type: dto.type,
            payload: payload as Prisma.InputJsonValue,
            dueDate,
            events: [
              this.event(actor, 'SUBMITTED'),
            ] as unknown as Prisma.InputJsonValue,
          },
        });
        await this.log(actor, ctx, 'DATA_REQUEST_SUBMITTED', created, {
          fieldNames: Object.keys((payload.fields as object) ?? {}),
        });
        return this.present(created);
      } catch (err) {
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== 'P2002'
        ) {
          throw err;
        }
      }
    }
    throw new ConflictException(
      'Could not allocate a request number; please retry.',
    );
  }

  async listMine(actor: Caller) {
    const page = 1;
    const rows = await this.scopedPrisma.dataRequest.findMany({
      where: { organizationId: actor.organizationId, userId: actor.id },
      orderBy: { seqNo: 'desc' },
    });
    const data = await Promise.all(rows.map((r) => this.present(r)));
    return { data, total: data.length, page, limit: data.length || 1 };
  }

  private async findOwn(id: string, actor: Caller) {
    const r = await this.scopedPrisma.dataRequest.findFirst({
      where: { id, organizationId: actor.organizationId, userId: actor.id },
    });
    if (!r) throw new NotFoundException('Request not found.');
    return r;
  }

  async getMine(id: string, actor: Caller) {
    return this.present(await this.findOwn(id, actor));
  }

  async cancelMine(id: string, actor: Caller, ctx: ReqCtx) {
    const r = await this.findOwn(id, actor);
    if (r.status !== 'SUBMITTED') {
      throw new ConflictException(
        'Only a request that has not been picked up yet can be cancelled.',
      );
    }
    const updated = await this.transition(
      r,
      ['SUBMITTED'],
      { status: 'CANCELLED', completedAt: new Date() },
      this.event(actor, 'CANCELLED_BY_REQUESTER'),
    );
    await this.log(actor, ctx, 'DATA_REQUEST_CANCELLED', updated);
    return this.present(updated);
  }

  async downloadMine(id: string, actor: Caller, ctx: ReqCtx) {
    const r = await this.findOwn(id, actor);
    if (
      (r.type !== 'ACCESS' && r.type !== 'EXPORT') ||
      !r.exportFileKey ||
      (r.status !== 'APPROVED' && r.status !== 'COMPLETED')
    ) {
      throw new NotFoundException('No export is available for this request.');
    }
    const settings = await this.privacy.ensureSettings(actor.organizationId);
    const cfg = (settings.exportSettings ?? {}) as {
      downloadLinkTtlSeconds?: number;
    };
    const ttl = Math.min(
      3600,
      Math.max(60, Number(cfg.downloadLinkTtlSeconds) || 600),
    );
    const events = [
      ...((r.events as unknown as RequestEvent[]) ?? []),
      this.event(actor, 'EXPORT_DOWNLOADED'),
    ];
    await this.scopedPrisma.dataRequest.updateMany({
      where: { id: r.id, organizationId: r.organizationId },
      data: { events: events as unknown as Prisma.InputJsonValue },
    });
    await this.log(actor, ctx, 'DATA_EXPORT_DOWNLOADED', r);
    return {
      url: `/files/${signFileToken(actor.organizationId, r.exportFileKey, ttl)}`,
      expiresInSeconds: ttl,
      fileName: `${r.requestNo}.json`,
    };
  }

  // -- HR / admin side --

  async listAll(query: ListDataRequestsQueryDto, organizationId: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: Prisma.DataRequestWhereInput = {
      organizationId,
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
      ...(query.userId && { userId: query.userId }),
      ...(query.assignedToId && { assignedToId: query.assignedToId }),
    };
    const res = await paginate(
      () =>
        this.scopedPrisma.dataRequest.findMany({
          where,
          orderBy: { seqNo: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      () => this.scopedPrisma.dataRequest.count({ where }),
      page,
      limit,
    );
    const users = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        id: { in: [...new Set(res.data.map((r) => r.userId))] },
      },
      select: { id: true, name: true, employeeId: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const now = Date.now();
    return {
      ...res,
      data: res.data.map(({ exportFileKey, ...r }) => ({
        ...r,
        exportReady: !!exportFileKey,
        requester: byId.get(r.userId) ?? null,
        overdue: OPEN_STATUSES.includes(r.status) && r.dueDate.getTime() < now,
      })),
    };
  }

  async getOne(id: string, actor: Caller, ctx: ReqCtx) {
    const r = await this.findOrThrow(id, actor.organizationId);
    await this.assertHrMayHandle(actor, r.userId);
    await this.log(actor, ctx, 'DATA_REQUEST_VIEWED', r);
    return this.present(r);
  }

  // Same tiering as documents: only an ADMIN handles an HR/ADMIN user's request; nobody reviews their own.
  private async assertHrMayHandle(actor: Caller, requesterId: string) {
    if (actor.id === requesterId) {
      throw new ForbiddenException(
        'You cannot handle your own privacy request; ask another administrator.',
      );
    }
    const requester = await this.scopedPrisma.user.findFirst({
      where: { id: requesterId, organizationId: actor.organizationId },
      select: { role: true },
    });
    if (
      requester &&
      HR_ROLES.includes(requester.role) &&
      actor.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Only an Admin can handle an HR or Admin employee’s request.',
      );
    }
  }

  async assign(
    id: string,
    dto: AssignDataRequestDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const r = await this.findOrThrow(id, actor.organizationId);
    await this.assertHrMayHandle(actor, r.userId);
    const assignee = await this.scopedPrisma.user.findFirst({
      where: {
        id: dto.assignedToId,
        organizationId: actor.organizationId,
        isActive: true,
        role: { in: HR_ROLES },
      },
      select: { id: true },
    });
    if (!assignee)
      throw new BadRequestException(
        'Assignee must be an active HR or Admin user.',
      );
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(r.status)) {
      throw new ConflictException('This request is closed.');
    }
    const updated = await this.transition(
      r,
      ['SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED'],
      {
        assignedToId: dto.assignedToId,
        ...(r.status === 'SUBMITTED' && { status: 'UNDER_REVIEW' as const }),
      },
      this.event(actor, 'ASSIGNED', dto.assignedToId),
    );
    await this.log(actor, ctx, 'DATA_REQUEST_ASSIGNED', updated, {
      assignedToId: dto.assignedToId,
    });
    return this.present(updated);
  }

  async review(
    id: string,
    dto: ReviewDataRequestDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const r = await this.findOrThrow(id, actor.organizationId);
    await this.assertHrMayHandle(actor, r.userId);
    if (!OPEN_STATUSES.includes(r.status)) {
      throw new ConflictException(
        `A ${r.status} request can no longer be reviewed.`,
      );
    }
    if (
      (dto.decision === 'REJECTED' || dto.decision === 'ACTION_REQUIRED') &&
      !dto.resolution?.trim()
    ) {
      throw new BadRequestException(
        'A resolution note is required for this decision.',
      );
    }
    const open = OPEN_STATUSES;

    if (dto.decision === 'UNDER_REVIEW') {
      const u = await this.transition(
        r,
        open,
        { status: 'UNDER_REVIEW' },
        this.event(actor, 'UNDER_REVIEW'),
      );
      await this.log(actor, ctx, 'DATA_REQUEST_UNDER_REVIEW', u);
      return this.present(u);
    }
    if (dto.decision === 'ACTION_REQUIRED') {
      const u = await this.transition(
        r,
        open,
        { status: 'ACTION_REQUIRED', resolution: dto.resolution },
        this.event(actor, 'ACTION_REQUIRED', dto.resolution),
      );
      await this.log(actor, ctx, 'DATA_REQUEST_ACTION_REQUIRED', u);
      return this.present(u);
    }
    if (dto.decision === 'REJECTED') {
      const u = await this.transition(
        r,
        open,
        {
          status: 'REJECTED',
          resolution: dto.resolution,
          completedAt: new Date(),
        },
        this.event(actor, 'REJECTED', dto.resolution),
      );
      await this.log(actor, ctx, 'DATA_REQUEST_REJECTED', u);
      return this.present(u);
    }
    return this.approve(r, dto, actor, ctx);
  }

  private async approve(
    r: DataRequest,
    dto: ReviewDataRequestDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const open = OPEN_STATUSES;
    switch (r.type) {
      case 'ACCESS':
      case 'EXPORT': {
        const key = await this.generateExport(r);
        const u = await this.transition(
          r,
          open,
          {
            status: 'APPROVED',
            exportFileKey: key,
            resolution:
              dto.resolution ?? 'Your data export is ready to download.',
            result: { export: 'GENERATED' },
          },
          this.event(actor, 'APPROVED_EXPORT_GENERATED'),
        );
        await this.log(actor, ctx, 'DATA_EXPORT_GENERATED', u);
        return this.present(u);
      }
      case 'CORRECTION':
      case 'UPDATE': {
        const { applied, controlled } = await this.applyCorrection(r);
        const hasControlled = controlled.length > 0;
        const resolution = hasControlled
          ? `${dto.resolution ? dto.resolution + ' ' : ''}Some requested fields (${controlled.join(', ')}) are controlled fields and were NOT changed automatically. They need HR verification and must be updated through the normal HR profile-update process.`
          : (dto.resolution ??
            'The requested changes were applied to your profile.');
        const u = await this.transition(
          r,
          open,
          {
            status: hasControlled ? 'ACTION_REQUIRED' : 'APPROVED',
            resolution,
            result: { appliedFields: applied, controlledFields: controlled },
          },
          this.event(
            actor,
            hasControlled
              ? 'APPROVED_PARTIAL_CONTROLLED_PENDING'
              : 'APPROVED_APPLIED',
          ),
        );
        await this.log(actor, ctx, 'DATA_CORRECTION_APPROVED', u, {
          appliedFields: applied,
          controlledFields: controlled,
        });
        return this.present(u);
      }
      case 'ERASURE': {
        const verdict = await this.evaluateErasure(r.userId, r.organizationId);
        if (verdict.restricted) {
          const u = await this.transition(
            r,
            open,
            {
              status: 'ACTION_REQUIRED',
              resolution: `Deletion Restricted: ${verdict.reasons.join(' ')}`,
              result: {
                deletionRestricted: true,
                restrictionReasons: verdict.reasons,
              },
            },
            this.event(actor, 'DELETION_RESTRICTED'),
          );
          await this.log(
            actor,
            ctx,
            'DATA_ERASURE_RESTRICTED',
            u,
            {
              reasonCount: verdict.reasons.length,
            },
            'DENIED',
          );
          return this.present(u);
        }
        const outcome = await this.anonymize(r.userId, r.organizationId);
        const u = await this.transition(
          r,
          open,
          {
            status: 'APPROVED',
            resolution:
              dto.resolution ??
              'Optional personal data was anonymized and non-required documents were removed. Your account, payroll and audit records are retained as required.',
            result: { deletionRestricted: false, ...outcome },
          },
          this.event(actor, 'ERASURE_APPLIED'),
        );
        await this.log(actor, ctx, 'DATA_ERASURE_APPLIED', u, { ...outcome });
        return this.present(u);
      }
      default:
        throw new BadRequestException('Unsupported request type.');
    }
  }

  async complete(
    id: string,
    dto: CompleteDataRequestDto,
    actor: Caller,
    ctx: ReqCtx,
  ) {
    const r = await this.findOrThrow(id, actor.organizationId);
    await this.assertHrMayHandle(actor, r.userId);
    const manualOk =
      r.status === 'ACTION_REQUIRED' &&
      (r.type === 'CORRECTION' || r.type === 'UPDATE');
    if (r.status !== 'APPROVED' && !manualOk) {
      throw new ConflictException('Only an approved request can be completed.');
    }
    if (manualOk && !dto.resolution?.trim()) {
      throw new BadRequestException(
        'Describe how the controlled fields were handled to complete this request.',
      );
    }
    const u = await this.transition(
      r,
      ['APPROVED', 'ACTION_REQUIRED'],
      {
        status: 'COMPLETED',
        completedAt: new Date(),
        ...(dto.resolution && { resolution: dto.resolution }),
      },
      this.event(actor, 'COMPLETED', dto.resolution),
    );
    await this.log(actor, ctx, 'DATA_REQUEST_COMPLETED', u);
    return this.present(u);
  }

  // -- correction --

  private async applyCorrection(r: DataRequest) {
    const fields =
      (r.payload as { fields?: Record<string, string> })?.fields ?? {};
    const applied: string[] = [];
    const controlled: string[] = [];
    const columnUpdates: Record<string, string> = {};
    const pdUpdates: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k in AUTO_APPLY_USER_COLUMNS) {
        columnUpdates[AUTO_APPLY_USER_COLUMNS[k]] = v;
        applied.push(k);
      } else if ((AUTO_APPLY_PERSONAL_DATA as readonly string[]).includes(k)) {
        pdUpdates[k] = v;
        applied.push(k);
      } else {
        controlled.push(k);
      }
    }
    if (applied.length) {
      const user = await this.scopedPrisma.user.findFirst({
        where: { id: r.userId, organizationId: r.organizationId },
        select: { personalData: true },
      });
      if (!user) throw new NotFoundException('Requester no longer exists.');
      const pd = {
        ...((user.personalData as Record<string, unknown>) ?? {}),
        ...pdUpdates,
      };
      await this.scopedPrisma.user.updateMany({
        where: { id: r.userId, organizationId: r.organizationId },
        data: {
          ...columnUpdates,
          ...(Object.keys(pdUpdates).length && {
            personalData: pd as Prisma.InputJsonValue,
          }),
        },
      });
    }
    return { applied, controlled };
  }

  // -- erasure --

  async evaluateErasure(userId: string, organizationId: string) {
    const p = this.scopedPrisma;
    const reasons: string[] = [];
    const [payroll, loans, settlements, offboarding, tax] = await Promise.all([
      p.payrollRun.count({ where: { organizationId, employeeId: userId } }),
      p.loan.count({ where: { organizationId, employeeId: userId } }),
      p.settlement.count({ where: { organizationId, employeeId: userId } }),
      p.offboardingCase.count({
        where: { organizationId, employeeId: userId },
      }),
      p.employeeTaxDeclaration.count({
        where: { organizationId, employeeId: userId },
      }),
    ]);
    if (payroll > 0) {
      reasons.push(
        'Payroll and statutory records (payslips, PF/ESI/tax data) must be retained.',
      );
    }
    if (loans > 0) reasons.push('Loan records must be retained.');
    if (settlements > 0 || offboarding > 0) {
      reasons.push(
        'Final settlement and offboarding records must be retained.',
      );
    }
    if (tax > 0) reasons.push('Tax declaration records must be retained.');

    // Configured retention period for the employee profile: still running while the employee is active or was
    // separated more recently than the period.
    const settings = await this.privacy.ensureSettings(organizationId);
    const rule = (
      (settings.retentionRules as unknown as RetentionRule[]) ?? []
    ).find((x) => x.dataType === 'employee_profile');
    if (rule && rule.periodMonths) {
      const user = await p.user.findFirst({
        where: { id: userId, organizationId },
        select: { isActive: true, updatedAt: true },
      });
      if (user) {
        const until = new Date(user.updatedAt);
        until.setMonth(until.getMonth() + rule.periodMonths);
        if (user.isActive || until > new Date()) {
          reasons.push(
            `The configured retention period (${rule.periodMonths} months after separation) for employee profile data has not elapsed.`,
          );
        }
      }
    }
    return { restricted: reasons.length > 0, reasons };
  }

  private async anonymize(userId: string, organizationId: string) {
    const settings = await this.privacy.ensureSettings(organizationId);
    const rules = (settings.deletionRules ?? {}) as {
      anonymizeOptionalPersonalData?: boolean;
      removeNonRequiredDocuments?: boolean;
    };
    const p = this.scopedPrisma;
    const outcome = {
      personalDataKeysCleared: 0,
      documentsRemoved: 0,
      profileImageRemoved: false,
    };
    const user = await p.user.findFirst({
      where: { id: userId, organizationId },
      select: { personalData: true, profileImage: true },
    });
    if (!user) return outcome;

    if (rules.anonymizeOptionalPersonalData !== false) {
      const pd = { ...((user.personalData as Record<string, unknown>) ?? {}) };
      for (const k of OPTIONAL_PERSONAL_DATA_KEYS) {
        if (k in pd) {
          delete pd[k];
          outcome.personalDataKeysCleared++;
        }
      }
      pd.privacyAnonymizedAt = new Date().toISOString();
      await p.user.updateMany({
        where: { id: userId, organizationId },
        data: {
          personalData: pd as Prisma.InputJsonValue,
          ...(user.profileImage && { profileImage: null }),
        },
      });
      if (user.profileImage) {
        if (!/^https?:\/\//i.test(user.profileImage))
          deleteStoredFile(user.profileImage);
        outcome.profileImageRemoved = true;
      }
    }

    if (rules.removeNonRequiredDocuments !== false) {
      const required = await p.documentRequirement.findMany({
        where: { organizationId, isMandatory: true, isActive: true },
        select: { name: true },
      });
      const requiredNames = new Set(
        required.map((x) => x.name.trim().toLowerCase()),
      );
      const docs = await p.employeeDocument.findMany({
        where: { organizationId, employeeId: userId },
      });
      const removable = docs.filter(
        (d) => !requiredNames.has(d.docType.trim().toLowerCase()),
      );
      for (const d of removable) {
        if (!/^https?:\/\//i.test(d.fileUrl)) deleteStoredFile(d.fileUrl);
      }
      if (removable.length) {
        await p.employeeDocument.deleteMany({
          where: {
            organizationId,
            employeeId: userId,
            id: { in: removable.map((d) => d.id) },
          },
        });
      }
      outcome.documentsRemoved = removable.length;
    }
    return outcome;
  }

  // -- export --

  // Builds the requester's OWN data only. ID numbers are masked to last-4; file URLs are omitted.
  async buildExport(userId: string, organizationId: string) {
    const p = this.scopedPrisma;
    const user = await p.user.findFirst({
      where: { id: userId, organizationId },
    });
    if (!user) throw new NotFoundException('User not found.');
    const dept = user.departmentId
      ? await p.department.findFirst({
          where: { id: user.departmentId, organizationId },
          select: { name: true },
        })
      : null;

    const pd = { ...((user.personalData as Record<string, unknown>) ?? {}) };
    for (const k of MASKED_KEYS) if (k in pd) pd[k] = maskTail(pd[k]);
    for (const k of OMITTED_KEYS) delete pd[k];
    if (Array.isArray(pd.previousEmployment)) {
      pd.previousEmployment = (
        pd.previousEmployment as Record<string, unknown>[]
      ).map((e) => {
        const { documentUrl, ...rest } = e ?? {};
        void documentUrl;
        return rest;
      });
    }

    const [docs, leaveGroups, attGroups, payslips, consents, requests] =
      await Promise.all([
        p.employeeDocument.findMany({
          where: { organizationId, employeeId: userId },
          orderBy: { uploadedAt: 'desc' },
          select: {
            docType: true,
            fileName: true,
            category: true,
            status: true,
            uploadedAt: true,
          },
        }),
        p.leave.groupBy({
          by: ['status'],
          where: { organizationId, employeeId: userId },
          _count: { _all: true },
        }),
        p.attendance.groupBy({
          by: ['status'],
          where: { organizationId, employeeId: userId },
          _count: { _all: true },
        }),
        p.payrollRun.findMany({
          where: { organizationId, employeeId: userId },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
          select: {
            month: true,
            year: true,
            status: true,
            payslipNumber: true,
          },
        }),
        p.consentRecord.findMany({
          where: { organizationId, userId },
          orderBy: { at: 'asc' },
          select: { purposeKey: true, status: true, at: true, source: true },
        }),
        p.dataRequest.findMany({
          where: { organizationId, userId },
          orderBy: { seqNo: 'asc' },
          select: {
            requestNo: true,
            type: true,
            status: true,
            createdAt: true,
          },
        }),
      ]);

    return {
      generatedAt: new Date().toISOString(),
      note: 'Contains only your own data. Identification numbers are masked to the last 4 characters.',
      profile: {
        name: user.name,
        email: user.email,
        officialEmail: user.officialEmail,
        contactNumber: user.contactNumber,
        gender: user.gender,
        employeeId: user.employeeId,
        designation: user.designation,
        department: dept?.name ?? null,
        joiningDate: user.joiningDate,
        employmentStatus: user.employmentStatus,
      },
      personalData: pd,
      documents: docs,
      leaveSummary: Object.fromEntries(
        leaveGroups.map((g) => [g.status, g._count._all]),
      ),
      attendanceSummary: Object.fromEntries(
        attGroups.map((g) => [g.status, g._count._all]),
      ),
      payslips,
      consents,
      privacyRequests: requests,
    };
  }

  private async generateExport(r: DataRequest): Promise<string> {
    const data = await this.buildExport(r.userId, r.organizationId);
    return storeGeneratedFile(
      r.organizationId,
      'privacy-exports',
      '.json',
      Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      'application/json',
    );
  }
}
