// Purpose: Manages the policy-document library (versioned, visibility-scoped) and the org's document
// requirement checklist.
// Responsibilities: Owns policy CRUD/versioning (a linked list via previousVersionId) and requirement CRUD;
// signs stored file URLs on every read via signFileToken rather than persisting signed URLs.
// Important: canView() implements role/department/employee visibility scoping ported from the old system's
// canViewPolicy; HR/Admin bypass visibility entirely since they manage the library, not just consume it.
// deletePolicy() only deletes the underlying file when fileUrl is an internal storage key, never an
// external URL a user pasted in.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PolicyDocument,
  PolicyDocType,
  PolicyVisibility,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { deleteStoredFile } from '../files/delete-stored-file';
import { signFileToken } from '../files/file-token';
import { CreatePolicyDocumentDto } from './dto/create-policy-document.dto';
import { UpdatePolicyDocumentDto } from './dto/update-policy-document.dto';
import { CreateDocumentRequirementDto } from './dto/create-document-requirement.dto';
import { UpdateDocumentRequirementDto } from './dto/update-document-requirement.dto';
import { BulkDeleteDocumentRequirementsDto } from './dto/bulk-delete-document-requirements.dto';
import { BulkImportDocumentRequirementsDto } from './dto/bulk-import-document-requirements.dto';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';

type Actor = Omit<User, 'password'>;

const HR_ROLES: Role[] = [Role.ADMIN, Role.HR];
const MANAGER_ROLES: Role[] = [Role.MANAGER, Role.ADMIN, Role.HR];
const EXTERNAL_URL_RE = /^https?:\/\//i;

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  // HR/Admin bypass visibility entirely (they manage the library, not just
  // consume it) — see findPolicies. Ported from the old system's
  // canViewPolicy exactly, with department_head collapsed to MANAGER.
  private canView(policy: PolicyDocument, actor: Actor): boolean {
    switch (policy.visibility) {
      case PolicyVisibility.HR_ONLY:
        return HR_ROLES.includes(actor.role);
      case PolicyVisibility.MANAGERS:
        return MANAGER_ROLES.includes(actor.role);
      case PolicyVisibility.DEPARTMENTS:
        return (
          !!actor.departmentId &&
          policy.visibleDepartments.includes(actor.departmentId)
        );
      case PolicyVisibility.EMPLOYEES:
        return policy.visibleEmployees.includes(actor.id);
      default:
        return true;
    }
  }

  private withSignedUrl<T extends { fileUrl: string; organizationId: string }>(
    doc: T,
  ): T {
    if (EXTERNAL_URL_RE.test(doc.fileUrl)) return doc;
    return {
      ...doc,
      fileUrl: `/files/${signFileToken(doc.organizationId, doc.fileUrl)}`,
    };
  }

  async findPolicies(actor: Actor, organizationId: string) {
    const isHr = HR_ROLES.includes(actor.role);
    const policies = await this.scopedPrisma.policyDocument.findMany({
      where: {
        organizationId,
        ...(isHr ? {} : { isPublished: true }),
      },
      orderBy: { createdAt: 'desc' },
    });
    const visible = isHr
      ? policies
      : policies.filter((p) => this.canView(p, actor));
    return wrapAll(visible.map((p) => this.withSignedUrl(p)));
  }

  async createPolicy(
    dto: CreatePolicyDocumentDto,
    actor: Actor,
    organizationId: string,
  ) {
    let previousVersion: PolicyDocument | null = null;
    if (dto.replacesId) {
      previousVersion = await this.scopedPrisma.policyDocument.findFirst({
        where: { id: dto.replacesId, organizationId },
      });
      if (!previousVersion) {
        throw new NotFoundException('Document being replaced was not found.');
      }
    }

    const title = dto.title ?? previousVersion?.title;
    if (!title) {
      throw new BadRequestException(
        'title is required unless replacesId is set.',
      );
    }

    const docType = dto.docType ?? PolicyDocType.PDF;
    if (docType === PolicyDocType.URL && !EXTERNAL_URL_RE.test(dto.fileUrl)) {
      throw new BadRequestException(
        'fileUrl must be an http(s) URL when docType is URL.',
      );
    }

    const policy = await this.scopedPrisma.policyDocument.create({
      data: {
        organizationId,
        title,
        category: dto.category ?? previousVersion?.category ?? 'General',
        docType,
        fileUrl: dto.fileUrl,
        fileName: dto.fileName,
        isPublished: dto.isPublished ?? true,
        uploadedById: actor.id,
        visibility:
          dto.visibility ??
          previousVersion?.visibility ??
          PolicyVisibility.EVERYONE,
        visibleDepartments:
          dto.visibleDepartments ?? previousVersion?.visibleDepartments ?? [],
        visibleEmployees:
          dto.visibleEmployees ?? previousVersion?.visibleEmployees ?? [],
        version: previousVersion ? previousVersion.version + 1 : 1,
        previousVersionId: previousVersion?.id ?? null,
      },
    });

    if (previousVersion) {
      await this.scopedPrisma.policyDocument.updateMany({
        where: { id: previousVersion.id, organizationId },
        data: { isPublished: false },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'DOCUMENT_POLICY_CREATED',
      module: 'DOCUMENT',
      organizationId,
      targetId: policy.id,
      details: { title: policy.title, version: policy.version },
    });

    return this.withSignedUrl(policy);
  }

  // Walks the previousVersionId chain in both directions to return every
  // version, newest first — mirrors the old system's getPolicyVersions.
  async findPolicyVersions(id: string, organizationId: string) {
    const start = await this.scopedPrisma.policyDocument.findFirst({
      where: { id, organizationId },
    });
    if (!start) throw new NotFoundException('Policy not found.');

    const all = await this.scopedPrisma.policyDocument.findMany({
      where: { organizationId },
    });
    const byId = new Map(all.map((p) => [p.id, p]));
    const newerOf = (versionId: string) =>
      all.find((p) => p.previousVersionId === versionId);

    let head = start;
    let next = newerOf(head.id);
    while (next) {
      head = next;
      next = newerOf(head.id);
    }

    const chain: PolicyDocument[] = [];
    let cur: PolicyDocument | undefined = head;
    while (cur) {
      chain.push(cur);
      cur = cur.previousVersionId ? byId.get(cur.previousVersionId) : undefined;
    }

    return wrapAll(chain.map((p) => this.withSignedUrl(p)));
  }

  async updatePolicy(
    id: string,
    dto: UpdatePolicyDocumentDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.policyDocument.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Policy not found.');

    await this.scopedPrisma.policyDocument.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
        ...(dto.visibleDepartments !== undefined && {
          visibleDepartments: dto.visibleDepartments,
        }),
        ...(dto.visibleEmployees !== undefined && {
          visibleEmployees: dto.visibleEmployees,
        }),
        ...(dto.isPublished !== undefined && { isPublished: dto.isPublished }),
      },
    });

    const updated = await this.scopedPrisma.policyDocument.findFirstOrThrow({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DOCUMENT_POLICY_UPDATED',
        module: 'DOCUMENT',
        organizationId,
        targetId: id,
      });
    }

    return this.withSignedUrl(updated);
  }

  async deletePolicy(id: string, organizationId: string, actorId?: string) {
    const policy = await this.scopedPrisma.policyDocument.findFirst({
      where: { id, organizationId },
    });
    if (!policy) throw new NotFoundException('Policy not found.');

    // Only remove the file if it's one we actually stored (a relative
    // storage key), never an external URL someone pasted in.
    if (!EXTERNAL_URL_RE.test(policy.fileUrl)) {
      deleteStoredFile(policy.fileUrl);
    }

    await this.scopedPrisma.policyDocument.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DOCUMENT_POLICY_DELETED',
        module: 'DOCUMENT',
        organizationId,
        targetId: id,
        details: { title: policy.title },
      });
    }

    return { success: true, message: 'Policy deleted' };
  }

  async findRequirements(organizationId: string) {
    const data = await this.scopedPrisma.documentRequirement.findMany({
      where: { organizationId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return wrapAll(data);
  }

  async createRequirement(
    dto: CreateDocumentRequirementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Document name is required.');

    const count = await this.scopedPrisma.documentRequirement.count({
      where: { organizationId },
    });

    const requirement = await this.scopedPrisma.documentRequirement.create({
      data: {
        organizationId,
        name,
        isMandatory: dto.isMandatory ?? false,
        displayOrder: dto.displayOrder ?? count,
        createdById: actor.id,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'DOCUMENT_REQUIREMENT_CREATED',
      module: 'DOCUMENT',
      organizationId,
      targetId: requirement.id,
      details: { name: requirement.name },
    });

    return requirement;
  }

  async updateRequirement(
    id: string,
    dto: UpdateDocumentRequirementDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.documentRequirement.findFirst({
      where: { id, organizationId },
    });
    if (!existing)
      throw new NotFoundException('Document requirement not found.');

    await this.scopedPrisma.documentRequirement.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.isMandatory !== undefined && { isMandatory: dto.isMandatory }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.displayOrder !== undefined && {
          displayOrder: dto.displayOrder,
        }),
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DOCUMENT_REQUIREMENT_UPDATED',
        module: 'DOCUMENT',
        organizationId,
        targetId: id,
      });
    }

    return this.scopedPrisma.documentRequirement.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // A hard delete, not the isActive soft-disable updateRequirement already
  // supports — deliberately, since the user asked for real delete alongside
  // the existing Disable toggle. Doesn't touch any EmployeeDocument rows:
  // those are matched by name string, not a foreign key, so removing the
  // requirement definition never deletes or orphans an employee's actual
  // uploaded file — it just stops being tracked as "required" going
  // forward, same non-destructive characteristic the Disable toggle has.
  async deleteRequirement(
    id: string,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.documentRequirement.findFirst({
      where: { id, organizationId },
    });
    if (!existing)
      throw new NotFoundException('Document requirement not found.');

    await this.scopedPrisma.documentRequirement.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DOCUMENT_REQUIREMENT_DELETED',
        module: 'DOCUMENT',
        organizationId,
        targetId: id,
        details: { name: existing.name },
      });
    }

    return { success: true, message: 'Document requirement deleted' };
  }

  async bulkDeleteRequirements(
    dto: BulkDeleteDocumentRequirementsDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.scopedPrisma.documentRequirement.findMany({
      where: { id: { in: dto.ids }, organizationId },
    });
    if (existing.length === 0) {
      return { deleted: 0 };
    }

    await this.scopedPrisma.documentRequirement.deleteMany({
      where: { id: { in: existing.map((r) => r.id) }, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DOCUMENT_REQUIREMENT_BULK_DELETED',
        module: 'DOCUMENT',
        organizationId,
        details: { names: existing.map((r) => r.name) },
      });
    }

    return { deleted: existing.length };
  }

  // Rows are parsed client-side from the uploaded Excel/CSV (same xlsx
  // library the export path already uses) — this only ever receives plain
  // {name, isMandatory} JSON. Each row is created independently
  // (Promise.allSettled, same per-item isolation idiom used by
  // PayrollService.calculate() and ReimbursementsService.bulkReview()) so
  // one bad/duplicate row doesn't abort the whole import; a name that
  // collides with an existing requirement (the @@unique constraint) is
  // reported back as skipped rather than as a hard failure.
  async bulkImportRequirements(
    dto: BulkImportDocumentRequirementsDto,
    actor: Actor,
    organizationId: string,
  ) {
    const count = await this.scopedPrisma.documentRequirement.count({
      where: { organizationId },
    });

    const results = await Promise.allSettled(
      dto.rows.map((row, idx) => {
        const name = row.name?.trim();
        if (!name) {
          return Promise.reject(new Error('Row has no document name.'));
        }
        return this.scopedPrisma.documentRequirement.create({
          data: {
            organizationId,
            name,
            isMandatory: row.isMandatory ?? false,
            displayOrder: count + idx,
            createdById: actor.id,
          },
        });
      }),
    );

    const created: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        created.push(result.value.name);
      } else {
        const reason =
          result.reason instanceof Error &&
          result.reason.message.includes('Unique constraint')
            ? 'A requirement with this name already exists.'
            : result.reason instanceof Error
              ? result.reason.message
              : 'Failed to create.';
        skipped.push({ name: dto.rows[idx].name || '(blank)', reason });
      }
    });

    if (created.length > 0) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'DOCUMENT_REQUIREMENT_BULK_IMPORTED',
        module: 'DOCUMENT',
        organizationId,
        details: { names: created },
      });
    }

    return { created, skipped };
  }
}
