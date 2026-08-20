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
  EmploymentStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { signFileToken } from '../files/file-token';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { UpdatePersonalDataDto } from './dto/update-personal-data.dto';
import { ProbationDecisionDto } from './dto/probation-decision.dto';
import { CreateEmployeeDocumentDto } from './dto/create-employee-document.dto';
import { ReviewEmployeeDocumentDto } from './dto/review-employee-document.dto';
import { CreateEmployeeAssetDto } from './dto/create-employee-asset.dto';
import { UpdateEmployeeAssetDto } from './dto/update-employee-asset.dto';
import { mergePersonalData, signPersonalDataFileUrls } from './personal-data';

type Actor = Omit<User, 'password'>;

const HR_ROLES: Role[] = [Role.ADMIN, Role.HR];

function toSafe(user: User) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash deliberately
  const { password, ...safe } = user;
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

  async updatePersonalData(
    id: string,
    dto: UpdatePersonalDataDto,
    actor: Actor,
    organizationId: string,
  ) {
    this.assertSelfOrHr(actor, id);
    const employee = await this.findEmployeeOrThrow(id, organizationId);
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
        where: { organizationId, employeeId: id },
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
    await this.findEmployeeOrThrow(id, organizationId);
    const doc = await this.scopedPrisma.employeeDocument.create({
      data: {
        organizationId,
        employeeId: id,
        docType: dto.docType,
        fileName: dto.fileName,
        fileUrl: dto.fileUrl,
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

  async reviewDocument(
    id: string,
    docId: string,
    dto: ReviewEmployeeDocumentDto,
    actor: Actor,
    organizationId: string,
  ) {
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

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id, organizationId },
    });
    if (employee) {
      const title = `Document ${dto.status === 'APPROVED' ? 'Approved' : 'Rejected'}`;
      const message = `Your document "${doc.fileName}" has been ${dto.status.toLowerCase()}.${dto.reason ? ` Reason: ${dto.reason}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return withSignedFileUrl(updated);
  }

  // -- Assets --

  async listAssets(id: string, actor: Actor, organizationId: string) {
    this.assertSelfOrHr(actor, id);
    await this.findEmployeeOrThrow(id, organizationId);
    return this.scopedPrisma.employeeAsset.findMany({
      where: { organizationId, employeeId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async allocateAsset(
    id: string,
    dto: CreateEmployeeAssetDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.findEmployeeOrThrow(id, organizationId);
    return this.scopedPrisma.employeeAsset.create({
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
  }

  async updateAssetStatus(
    id: string,
    assetId: string,
    dto: UpdateEmployeeAssetDto,
    organizationId: string,
  ) {
    const asset = await this.scopedPrisma.employeeAsset.findFirst({
      where: { id: assetId, employeeId: id, organizationId },
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
      },
    });

    return this.scopedPrisma.employeeAsset.findFirstOrThrow({
      where: { id: assetId, organizationId },
    });
  }
}
