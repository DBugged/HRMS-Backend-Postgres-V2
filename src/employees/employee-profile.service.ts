// Purpose: Manages the employee-profile "extras" — personal data, probation decisions, documents, and
// assets — kept separate from EmployeesService's core CRUD.
// Responsibilities: Owns updatePersonalData (deep-merge, not overwrite), probationDecision (status +
// history + timeline event), and document/asset lifecycle; delegates timeline logging and
// notification/email delivery to their respective services.
// Important: assertSelfOrHr() gates personal-data/document/asset self-service so a non-HR actor can only
// touch their own profile; getFullProfile() is the HR/Admin-only variant that returns everything, unlike
// the password-stripped-only view elsewhere.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmployeeDocument,
  EmployeeDocumentStatus,
  EmploymentStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken, SESSION_ASSET_TTL_SECONDS } from '../files/file-token';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UpdatePersonalDataDto } from './dto/update-personal-data.dto';
import { ProbationDecisionDto } from './dto/probation-decision.dto';
import { CreateEmployeeDocumentDto } from './dto/create-employee-document.dto';
import { ReviewEmployeeDocumentDto } from './dto/review-employee-document.dto';
import { CreateEmployeeAssetDto } from './dto/create-employee-asset.dto';
import { UpdateEmployeeAssetDto } from './dto/update-employee-asset.dto';
import { mergePersonalData, signPersonalDataFileUrls } from './personal-data';

type Actor = Omit<User, 'password'>;

const HR_ROLES: Role[] = [Role.ADMIN, Role.HR];

// profileImage is stored as a durable relativeKey (never a signed URL —
// see file-token.ts), so every response that surfaces one signs it fresh.
// This toSafe (separate copy from employees.service.ts's) was missing
// this — updatePersonalData's response carried the raw relativeKey
// straight through, which 404s when used as an <img src>, making the
// profile photo appear to vanish right after Save Profile.
function toSafe(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
  const { password, ...safe } = user;
  if (safe.profileImage) {
    // Held in AuthContext for the whole session — see
    // SESSION_ASSET_TTL_SECONDS' comment.
    safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage, SESSION_ASSET_TTL_SECONDS)}`;
  }
  if (safe.personalData && typeof safe.personalData === 'object') {
    safe.personalData = signPersonalDataFileUrls(
      safe.personalData as Record<string, unknown>,
      safe.organizationId,
    ) as unknown as User['personalData'];
  }
  return safe;
}

// EmployeeDocument.fileUrl stores a durable relativeKey (never a signed
// URL — see file-token.ts), so every response that surfaces one signs it
// fresh, same pattern as PolicyDocument's withSignedUrl.
function withSignedFileUrl<T extends EmployeeDocument>(doc: T): T {
  if (!doc.fileUrl) return doc;
  return {
    ...doc,
    fileUrl: `/files/${signFileToken(doc.organizationId, doc.fileUrl)}`,
  };
}

@Injectable()
export class EmployeeProfileService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly timelineService: EmployeeTimelineService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  private async findEmployeeOrThrow(id: string, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    return employee;
  }

  private assertSelfOrHr(actor: Actor, employeeId: string) {
    if (actor.id !== employeeId && !HR_ROLES.includes(actor.role)) {
      throw new ForbiddenException('You can only manage your own profile.');
    }
  }

  // An HR/Admin employee's personal data is editable only by an Admin (or
  // by that employee themselves) — same gap, same fix, as
  // employees.service.ts's update(): assertSelfOrHr only ever checked the
  // caller's own role, never the target's, so HR could edit another HR's
  // (or an Admin's) personal data freely.
  private assertMaySetPersonalDataFor(actor: Actor, employee: User) {
    if (
      actor.id !== employee.id &&
      actor.role !== Role.ADMIN &&
      (employee.role === Role.ADMIN || employee.role === Role.HR)
    ) {
      throw new ForbiddenException(
        'Only an Admin can edit an HR or Admin employee record.',
      );
    }
  }

  async updatePersonalData(
    id: string,
    dto: UpdatePersonalDataDto,
    actor: Actor,
    organizationId: string,
  ) {
    this.assertSelfOrHr(actor, id);
    const employee = await this.findEmployeeOrThrow(id, organizationId);
    this.assertMaySetPersonalDataFor(actor, employee);
    const merged = mergePersonalData(
      employee.personalData as Record<string, unknown>,
      dto.personalData,
    );

    await this.scopedPrisma.user.updateMany({
      where: { id, organizationId },
      data: { personalData: merged as Prisma.InputJsonValue },
    });

    return toSafe(await this.findEmployeeOrThrow(id, organizationId));
  }

  // HR/Admin-only — everything, including personalData/bank details/
  // documents/assets, unlike findOne() which strips the password only.
  async getFullProfile(id: string, organizationId: string) {
    const employee = await this.findEmployeeOrThrow(id, organizationId);
    const [documents, assets] = await Promise.all([
      this.scopedPrisma.employeeDocument.findMany({
        where: { organizationId, employeeId: id },
        orderBy: { uploadedAt: 'desc' },
      }),
      this.scopedPrisma.employeeAsset.findMany({
        where: { organizationId, employeeId: id, isActive: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      ...toSafe(employee),
      documents: documents.map(withSignedFileUrl),
      assets,
    };
  }

  async getRoleHistory(id: string, organizationId: string) {
    await this.findEmployeeOrThrow(id, organizationId);
    return this.scopedPrisma.employeeRoleHistory.findMany({
      where: { organizationId, employeeId: id },
      orderBy: { changedAt: 'desc' },
    });
  }

  async getEmploymentStatusHistory(id: string, organizationId: string) {
    await this.findEmployeeOrThrow(id, organizationId);
    return this.scopedPrisma.employmentStatusHistory.findMany({
      where: { organizationId, employeeId: id },
      orderBy: { changedAt: 'desc' },
    });
  }

  // Org-wide variant of getRoleHistory — backs the standalone Employee
  // History screen (Employees > Employee History), which browses every
  // employee's role/designation/department changes in one place rather
  // than one profile at a time.
  async listAllRoleHistory(organizationId: string) {
    return this.scopedPrisma.employeeRoleHistory.findMany({
      where: { organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        changedBy: { select: { id: true, name: true } },
      },
      orderBy: { changedAt: 'desc' },
      take: 500,
    });
  }

  async probationDecision(
    id: string,
    dto: ProbationDecisionDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.findEmployeeOrThrow(id, organizationId);
    if (dto.decision === 'extended' && !dto.newProbationEndDate) {
      throw new BadRequestException(
        'newProbationEndDate is required when extending probation.',
      );
    }

    const newStatus: EmploymentStatus =
      dto.decision === 'confirmed' ? 'CONFIRMED' : 'EXTENDED_PROBATION';

    await this.scopedPrisma.$transaction([
      this.scopedPrisma.user.updateMany({
        where: { id, organizationId },
        data: {
          employmentStatus: newStatus,
          probationStatus:
            dto.decision === 'confirmed' ? 'CONFIRMED' : 'EXTENDED',
          probationEndDate:
            dto.decision === 'extended'
              ? dto.newProbationEndDate
              : employee.probationEndDate,
        },
      }),
      this.scopedPrisma.employmentStatusHistory.create({
        data: {
          organizationId,
          employeeId: id,
          previousStatus: employee.employmentStatus,
          newStatus,
          note: dto.note ?? '',
          changedById: actor.id,
        },
      }),
    ]);

    await this.timelineService.logEvent({
      organizationId,
      employeeId: id,
      eventKey:
        dto.decision === 'confirmed'
          ? 'EMPLOYMENT_CONFIRMED'
          : 'PROBATION_EXTENDED',
      performedById: actor.id,
      description: dto.note ?? '',
    });

    return toSafe(await this.findEmployeeOrThrow(id, organizationId));
  }

  // -- Documents --

  async listDocuments(id: string, actor: Actor, organizationId: string) {
    this.assertSelfOrHr(actor, id);
    await this.findEmployeeOrThrow(id, organizationId);
    const docs = await this.scopedPrisma.employeeDocument.findMany({
      where: { organizationId, employeeId: id },
      orderBy: { uploadedAt: 'desc' },
    });
    return docs.map(withSignedFileUrl);
  }

  async addDocument(
    id: string,
    dto: CreateEmployeeDocumentDto,
    actor: Actor,
    organizationId: string,
  ) {
    this.assertSelfOrHr(actor, id);
    const employee = await this.findEmployeeOrThrow(id, organizationId);
    // Approval tier follows the document owner's role, not who physically
    // clicked upload (an HR/Admin can upload on an employee's behalf):
    // Founder/Admin documents need no review at all — there's no one above
    // an Admin in this hierarchy to approve them — so they're stamped
    // approved immediately instead of sitting PENDING forever. HR and
    // Employee documents still go through the normal review flow (see
    // assertMayReviewDocumentFor).
    const isFounderDoc = employee.role === Role.ADMIN;
    const doc = await this.scopedPrisma.employeeDocument.create({
      data: {
        organizationId,
        employeeId: id,
        docType: dto.docType,
        fileName: dto.fileName,
        fileUrl: dto.fileUrl,
        ...(isFounderDoc && {
          status: EmployeeDocumentStatus.APPROVED,
          reviewedById: actor.id,
          reviewedAt: new Date(),
        }),
      },
    });
    return withSignedFileUrl(doc);
  }

  async removeDocument(
    id: string,
    docId: string,
    actor: Actor,
    organizationId: string,
  ) {
    this.assertSelfOrHr(actor, id);
    const doc = await this.scopedPrisma.employeeDocument.findFirst({
      where: { id: docId, employeeId: id, organizationId },
    });
    if (!doc) throw new NotFoundException('Document not found.');
    await this.scopedPrisma.employeeDocument.deleteMany({
      where: { id: docId, organizationId },
    });
    return { success: true };
  }

  // One tier up the hierarchy reviews the one below — a Founder/Admin's own
  // documents are auto-approved on upload (see addDocument) and never reach
  // here in practice; an HR document needs an Admin specifically (another
  // HR can't approve a peer's document); an Employee/Manager document keeps
  // the existing ADMIN-or-HR review the controller's @Roles already gates.
  private assertMayReviewDocumentFor(actor: Actor, employee: User) {
    if (
      (employee.role === Role.ADMIN || employee.role === Role.HR) &&
      actor.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Only an Admin can review an HR or Admin employee’s document.',
      );
    }
  }

  async reviewDocument(
    id: string,
    docId: string,
    dto: ReviewEmployeeDocumentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.findEmployeeOrThrow(id, organizationId);
    this.assertMayReviewDocumentFor(actor, employee);
    const doc = await this.scopedPrisma.employeeDocument.findFirst({
      where: { id: docId, employeeId: id, organizationId },
    });
    if (!doc) throw new NotFoundException('Document not found.');

    await this.scopedPrisma.employeeDocument.updateMany({
      where: { id: docId, organizationId },
      data: {
        status: dto.status,
        reviewReason: dto.reason ?? '',
        reviewedById: actor.id,
        reviewedAt: new Date(),
      },
    });

    const updated = await this.scopedPrisma.employeeDocument.findFirstOrThrow({
      where: { id: docId, organizationId },
    });

    {
      const title = `Document ${dto.status === 'APPROVED' ? 'Approved' : 'Rejected'}`;
      const message = `Your document "${doc.fileName}" has been ${dto.status.toLowerCase()}.${dto.reason ? ` Reason: ${dto.reason}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'DOCUMENT_STATUS',
        { employeeName: employee.name, fileName: doc.fileName, status: dto.status, reason: dto.reason ?? '' },
        { subject: title, html: message },
      );
      await this.emailService.send({ to: employee.email, subject: rendered.subject, html: rendered.html });
    }

    return withSignedFileUrl(updated);
  }

  // -- Assets --

  async listAssets(id: string, actor: Actor, organizationId: string) {
    this.assertSelfOrHr(actor, id);
    await this.findEmployeeOrThrow(id, organizationId);
    return this.scopedPrisma.employeeAsset.findMany({
      where: { organizationId, employeeId: id, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Org-wide variant of listAssets — backs the standalone Employee Assets
  // screen (Employees > Employee Assets), which browses every employee's
  // allocated assets in one place rather than one profile at a time.
  async listAllAssets(organizationId: string) {
    return this.scopedPrisma.employeeAsset.findMany({
      where: { organizationId, isActive: true },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async allocateAsset(
    id: string,
    dto: CreateEmployeeAssetDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.findEmployeeOrThrow(id, organizationId);
    // assetTag is @@unique([organizationId, assetTag]) at the DB level (NULLs
    // exempt, same as officialEmail elsewhere), so a duplicate tag within
    // this org throws Prisma P2002 here — the global AllExceptionsFilter
    // turns that into a clean 409 automatically, same mechanism used for
    // every other unique-constraint conflict in this app, so no manual
    // pre-check or hand-rolled error is needed.
    const asset = await this.scopedPrisma.employeeAsset.create({
      data: {
        organizationId,
        employeeId: id,
        assetType: dto.assetType,
        assetName: dto.assetName,
        assetTag: dto.assetTag,
        allocatedDate: dto.allocatedDate,
        notes: dto.notes ?? '',
        allocatedById: actor.id,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_ALLOCATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: asset.id,
      details: {
        employeeId: id,
        assetType: asset.assetType,
        assetName: asset.assetName,
        assetTag: asset.assetTag,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: id,
      eventKey: 'ASSET_ALLOCATED',
      performedById: actor.id,
      description: `${asset.assetType}: ${asset.assetName}${asset.assetTag ? ` (${asset.assetTag})` : ''}`,
    });

    return asset;
  }

  async updateAssetStatus(
    id: string,
    assetId: string,
    dto: UpdateEmployeeAssetDto,
    actor: Actor,
    organizationId: string,
  ) {
    const asset = await this.scopedPrisma.employeeAsset.findFirst({
      where: { id: assetId, employeeId: id, organizationId, isActive: true },
    });
    if (!asset) throw new NotFoundException('Asset not found.');
    if (dto.status === 'RETURNED' && !dto.returnedDate) {
      throw new BadRequestException(
        'returnedDate is required when marking an asset returned.',
      );
    }

    await this.scopedPrisma.employeeAsset.updateMany({
      where: { id: assetId, organizationId },
      data: {
        status: dto.status,
        returnedDate:
          dto.status === 'RETURNED' ? dto.returnedDate : asset.returnedDate,
        // Only ever set (never cleared) on an actual RETURNED transition —
        // records who processed the return, mirroring allocatedById, which
        // is always set at creation time by contrast.
        returnedById: dto.status === 'RETURNED' ? actor.id : asset.returnedById,
      },
    });

    const updated = await this.scopedPrisma.employeeAsset.findFirstOrThrow({
      where: { id: assetId, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action:
        dto.status === 'RETURNED' ? 'ASSET_RETURNED' : 'ASSET_STATUS_CHANGED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: assetId,
      details: {
        employeeId: id,
        previousStatus: asset.status,
        newStatus: dto.status,
        returnedDate: updated.returnedDate,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: id,
      eventKey:
        dto.status === 'RETURNED' ? 'ASSET_RETURNED' : 'ASSET_STATUS_CHANGED',
      performedById: actor.id,
      description: `${asset.assetType}: ${asset.assetName} — ${asset.status} -> ${dto.status}`,
    });

    return updated;
  }

  // Soft delete only — the underlying row is kept for audit-trail
  // integrity (matching removeDocument's hard-delete being fine there
  // since documents carry no allocation/return audit history worth
  // preserving, unlike assets). Deliberately not implemented as "just set
  // status to RETURNED": RETURNED represents a real-world event (the
  // physical asset came back, and requires a returnedDate), whereas delete
  // is a record-management action — e.g. removing a mistaken entry for an
  // asset that was never actually returned, or an ALLOCATED asset that
  // should never have been logged. Reusing RETURNED for that would corrupt
  // the return-workflow's own meaning, so isActive is a separate flag.
  async removeAsset(
    id: string,
    assetId: string,
    actor: Actor,
    organizationId: string,
  ) {
    const asset = await this.scopedPrisma.employeeAsset.findFirst({
      where: { id: assetId, employeeId: id, organizationId, isActive: true },
    });
    if (!asset) throw new NotFoundException('Asset not found.');

    await this.scopedPrisma.employeeAsset.updateMany({
      where: { id: assetId, organizationId },
      data: { isActive: false },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_REMOVED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: assetId,
      details: {
        employeeId: id,
        assetType: asset.assetType,
        assetName: asset.assetName,
        assetTag: asset.assetTag,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: id,
      eventKey: 'ASSET_REMOVED',
      performedById: actor.id,
      description: `${asset.assetType}: ${asset.assetName}${asset.assetTag ? ` (${asset.assetTag})` : ''}`,
    });

    return { success: true };
  }
}
