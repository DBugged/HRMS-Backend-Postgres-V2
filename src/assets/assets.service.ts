// Purpose: The org's Asset Inventory master — the physical assets it owns, their warranty, service
//   history, and paperwork.
// Responsibilities: CRUD + status/warranty/maintenance/document sub-resources, all org-scoped through
//   PRISMA_CLIENT and all audited through the shared AuditLogService (module: ASSET).
// Important: This module never assigns an asset to anyone. Assignment stays entirely in the Employees
//   module's existing /employees/:id/assets endpoints; the inventory record only *reacts* to those
//   (EmployeeAsset.assetId -> Asset.status), and exposes the live allocation read-only as
//   `currentAssignment`. History is not a table of its own either — it's AuditLog filtered by
//   module=ASSET + targetId, so there's exactly one audit trail in this app, not two.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Asset,
  AssetDocument,
  AssetInventoryStatus,
  AuditModule,
  OrgListType,
  Prisma,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { signFileToken } from '../files/file-token';
import { paginate, skip, wrapAll } from '../common/pagination';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { UpdateAssetStatusDto } from './dto/update-asset-status.dto';
import { UpdateAssetWarrantyDto } from './dto/update-asset-warranty.dto';
import { CreateAssetMaintenanceDto } from './dto/create-asset-maintenance.dto';
import { UpdateAssetMaintenanceDto } from './dto/update-asset-maintenance.dto';
import { CreateAssetDocumentDto } from './dto/create-asset-document.dto';
import { ListAssetsQueryDto } from './dto/list-assets-query.dto';

type Actor = { id: string; role?: Role };

// Retiring or disposing of an asset writes off company property — Admin
// only. Mirrors the controller's updateStatus() gate so create() can't be
// used to land an asset directly in one of these states.
export const ADMIN_ONLY_STATUSES: AssetInventoryStatus[] = [
  AssetInventoryStatus.RETIRED,
  AssetInventoryStatus.DISPOSED,
];

const ASSIGNED_BY_HAND_MESSAGE =
  'An asset becomes Assigned by allocating it to an employee, not from the inventory screen.';

// Prisma's `contains` becomes a parameterized ILIKE '%value%' but does not
// escape LIKE metacharacters inside the value, so a search for "50%" or
// "a_b" would act as a wildcard. Postgres LIKE's default escape char is
// backslash, so prefixing each metachar makes it literal.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// The category name that turns on the "Specify Asset" free-text field —
// same convention the Assets tab on EmployeeFullProfile already uses
// (assetType === 'Other' relabels Asset Name to "Specify Asset *").
const OTHER_CATEGORY = 'Other';

// A blank/whitespace-only tag or serial must land in the DB as a real SQL
// NULL, not '': Postgres exempts NULLs from unique indexes but not empty
// strings, so without this the *second* asset saved with no tag would 409
// against the first. Exactly the normalization EmployeeAsset.assetTag
// already documents.
function nullIfBlank(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// YYYY-MM-DD -> DateTime at UTC midnight. Parsing the bare string through
// `new Date()` already does this, but going through an explicit helper
// keeps every date field in this service converting identically.
function toDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`"${value}" is not a valid date.`);
  }
  return parsed;
}

// AssetDocument.fileUrl holds a durable relativeKey, never a signed URL —
// so every response surfacing one signs it fresh, same as
// EmployeeDocument's withSignedFileUrl.
function withSignedFileUrl<T extends AssetDocument>(doc: T): T {
  if (!doc.fileUrl) return doc;
  return {
    ...doc,
    fileUrl: `/files/${signFileToken(doc.organizationId, doc.fileUrl)}`,
  };
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  // activeOnly (default) 404s a soft-deleted asset, so no mutation can
  // touch one; read-only views (findOne/history) pass false.
  private async findAssetOrThrow(
    id: string,
    organizationId: string,
    activeOnly = true,
  ) {
    const asset = await this.scopedPrisma.asset.findFirst({
      where: { id, organizationId, ...(activeOnly && { isActive: true }) },
    });
    if (!asset) throw new NotFoundException('Asset not found.');
    return asset;
  }

  // Whether a live EmployeeAsset allocation actually backs this asset — the
  // source of truth for "is it assigned". Asset.status can drift to a stale
  // ASSIGNED when an allocation row is removed without a return.
  private async hasLiveAllocation(
    assetId: string,
    organizationId: string,
  ): Promise<boolean> {
    const row = await this.scopedPrisma.employeeAsset.findFirst({
      where: { organizationId, assetId, status: 'ALLOCATED', isActive: true },
      select: { id: true },
    });
    return row != null;
  }

  // Resolves the category FK and enforces the "Other" -> categorySpecify
  // rule. Returns the resolved name so callers can put it in audit details.
  private async resolveCategory(
    categoryId: string,
    categorySpecify: string | undefined,
    organizationId: string,
  ): Promise<{ categoryId: string; categorySpecify: string | null }> {
    const category = await this.scopedPrisma.orgListItem.findFirst({
      where: {
        id: categoryId,
        organizationId,
        type: OrgListType.ASSET_CATEGORY,
      },
    });
    if (!category) throw new BadRequestException('Asset category not found.');
    const specify = nullIfBlank(categorySpecify);
    if (category.name === OTHER_CATEGORY && !specify) {
      throw new BadRequestException(
        'Specify Asset is required when the category is "Other".',
      );
    }
    return { categoryId: category.id, categorySpecify: specify };
  }

  // assetCode is human-readable and unique per org. Derived from the org's
  // current row count rather than a stored counter — an inventory is small
  // enough that a count() is free, and there's no second writer racing it
  // in practice (a collision would surface as the 409 below, not silent
  // corruption).
  private async nextAssetCode(organizationId: string): Promise<string> {
    const count = await this.scopedPrisma.asset.count({
      where: { organizationId },
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = `AST-${String(count + 1 + attempt).padStart(4, '0')}`;
      const existing = await this.scopedPrisma.asset.findFirst({
        where: { organizationId, assetCode: candidate },
      });
      if (!existing) return candidate;
    }
    throw new ConflictException(
      'Could not generate a unique asset code — enter one manually.',
    );
  }

  // Pre-checks the two per-org unique fields so the caller gets a message
  // naming the actual field, rather than the generic P2002 envelope.
  private async assertUniqueIdentifiers(
    organizationId: string,
    fields: {
      assetCode?: string | null;
      assetTag?: string | null;
      serialNumber?: string | null;
    },
    excludeId?: string,
  ): Promise<void> {
    const checks: { field: string; value: string; label: string }[] = [];
    if (fields.assetCode)
      checks.push({
        field: 'assetCode',
        value: fields.assetCode,
        label: 'asset code',
      });
    if (fields.assetTag)
      checks.push({
        field: 'assetTag',
        value: fields.assetTag,
        label: 'asset tag',
      });
    if (fields.serialNumber)
      checks.push({
        field: 'serialNumber',
        value: fields.serialNumber,
        label: 'serial number',
      });

    for (const check of checks) {
      const clash = await this.scopedPrisma.asset.findFirst({
        where: {
          organizationId,
          [check.field]: check.value,
          ...(excludeId && { id: { not: excludeId } }),
        },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          `Another asset in this organization already uses this ${check.label}.`,
        );
      }
    }
  }

  // end >= start, checked against the merged result so a partial warranty
  // edit can't leave the pair inverted.
  private assertWarrantyDates(
    start: Date | null | undefined,
    end: Date | null | undefined,
  ): void {
    if (start && end && end.getTime() < start.getTime()) {
      throw new BadRequestException(
        'Warranty end date cannot be before the warranty start date.',
      );
    }
  }

  async findAll(query: ListAssetsQueryDto, organizationId: string) {
    const search = query.search ? escapeLike(query.search) : undefined;
    const where: Prisma.AssetWhereInput = {
      organizationId,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.status && { status: query.status }),
      ...(query.condition && { condition: query.condition }),
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.location && {
        location: { contains: query.location, mode: 'insensitive' },
      }),
      ...(search && {
        OR: [
          { assetCode: { contains: search, mode: 'insensitive' } },
          { assetName: { contains: search, mode: 'insensitive' } },
          { assetTag: { contains: search, mode: 'insensitive' } },
          { serialNumber: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
          { model: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return paginate(
      () =>
        this.scopedPrisma.asset.findMany({
          where,
          include: { category: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: skip(page, limit),
          take: limit,
        }),
      () => this.scopedPrisma.asset.count({ where }),
      page,
      limit,
    );
  }

  async findOne(id: string, organizationId: string) {
    const asset = await this.scopedPrisma.asset.findFirst({
      where: { id, organizationId },
      include: {
        category: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        maintenances: { orderBy: { serviceDate: 'desc' } },
        documents: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found.');

    // Read-only view of whoever currently holds this asset. Sourced from
    // the Employees module's own EmployeeAsset rows — this module never
    // writes one, and exposes no assign/return/transfer action at all.
    const currentAssignment = await this.scopedPrisma.employeeAsset.findFirst({
      where: {
        organizationId,
        assetId: id,
        status: 'ALLOCATED',
        isActive: true,
      },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { allocatedDate: 'desc' },
    });

    return {
      ...asset,
      documents: asset.documents.map(withSignedFileUrl),
      currentAssignment,
    };
  }

  async create(dto: CreateAssetDto, organizationId: string, actor: Actor) {
    // Same rules updateStatus() enforces: ASSIGNED only ever comes from an
    // allocation, and RETIRED/DISPOSED are Admin-only write-offs.
    if (dto.status === AssetInventoryStatus.ASSIGNED) {
      throw new BadRequestException(ASSIGNED_BY_HAND_MESSAGE);
    }
    if (ADMIN_ONLY_STATUSES.includes(dto.status) && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only an administrator can retire or dispose of an asset.',
      );
    }

    const category = await this.resolveCategory(
      dto.categoryId,
      dto.categorySpecify,
      organizationId,
    );
    const assetCode =
      nullIfBlank(dto.assetCode) ?? (await this.nextAssetCode(organizationId));
    const assetTag = nullIfBlank(dto.assetTag);
    const serialNumber = nullIfBlank(dto.serialNumber);

    await this.assertUniqueIdentifiers(organizationId, {
      assetCode,
      assetTag,
      serialNumber,
    });

    const warrantyStartDate = toDate(dto.warrantyStartDate);
    const warrantyEndDate = toDate(dto.warrantyEndDate);
    this.assertWarrantyDates(warrantyStartDate, warrantyEndDate);

    const asset = await this.scopedPrisma.asset.create({
      data: {
        organizationId,
        assetCode,
        assetName: dto.assetName.trim(),
        categoryId: category.categoryId,
        categorySpecify: category.categorySpecify,
        brand: nullIfBlank(dto.brand),
        model: nullIfBlank(dto.model),
        assetTag,
        serialNumber,
        purchasedFrom: dto.purchasedFrom.trim(),
        purchaseDate: toDate(dto.purchaseDate),
        purchaseCost: dto.purchaseCost ?? null,
        vendorContact: nullIfBlank(dto.vendorContact),
        invoiceNumber: nullIfBlank(dto.invoiceNumber),
        poNumber: nullIfBlank(dto.poNumber),
        location: nullIfBlank(dto.location),
        condition: dto.condition,
        status: dto.status,
        usefulLifeMonths: dto.usefulLifeMonths ?? null,
        remarks: nullIfBlank(dto.remarks),
        warrantyProvider: nullIfBlank(dto.warrantyProvider),
        warrantyNumber: nullIfBlank(dto.warrantyNumber),
        warrantyStartDate,
        warrantyEndDate,
        warrantyPeriodMonths: dto.warrantyPeriodMonths ?? null,
        supportContact: nullIfBlank(dto.supportContact),
        supportEmail: nullIfBlank(dto.supportEmail),
        supportPhone: nullIfBlank(dto.supportPhone),
        warrantyTerms: nullIfBlank(dto.warrantyTerms),
        createdById: actor.id,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_CREATED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: asset.id,
      details: {
        assetCode: asset.assetCode,
        assetName: asset.assetName,
        assetTag: asset.assetTag,
        serialNumber: asset.serialNumber,
        status: asset.status,
      },
    });

    return asset;
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    organizationId: string,
    actor: Actor,
  ) {
    const existing = await this.findAssetOrThrow(id, organizationId);

    const data: Prisma.AssetUpdateManyMutationInput & { categoryId?: string } =
      {};
    if (dto.categoryId !== undefined) {
      const category = await this.resolveCategory(
        dto.categoryId,
        dto.categorySpecify ?? existing.categorySpecify ?? undefined,
        organizationId,
      );
      data.categoryId = category.categoryId;
      data.categorySpecify = category.categorySpecify;
    } else if (dto.categorySpecify !== undefined) {
      data.categorySpecify = nullIfBlank(dto.categorySpecify);
    }

    if (dto.assetCode !== undefined)
      data.assetCode = nullIfBlank(dto.assetCode) ?? existing.assetCode;
    if (dto.assetName !== undefined) data.assetName = dto.assetName.trim();
    if (dto.brand !== undefined) data.brand = nullIfBlank(dto.brand);
    if (dto.model !== undefined) data.model = nullIfBlank(dto.model);
    if (dto.assetTag !== undefined) data.assetTag = nullIfBlank(dto.assetTag);
    if (dto.serialNumber !== undefined)
      data.serialNumber = nullIfBlank(dto.serialNumber);
    if (dto.purchasedFrom !== undefined)
      data.purchasedFrom = dto.purchasedFrom.trim();
    if (dto.purchaseDate !== undefined)
      data.purchaseDate = toDate(dto.purchaseDate);
    if (dto.purchaseCost !== undefined) data.purchaseCost = dto.purchaseCost;
    if (dto.vendorContact !== undefined)
      data.vendorContact = nullIfBlank(dto.vendorContact);
    if (dto.invoiceNumber !== undefined)
      data.invoiceNumber = nullIfBlank(dto.invoiceNumber);
    if (dto.poNumber !== undefined) data.poNumber = nullIfBlank(dto.poNumber);
    if (dto.location !== undefined) data.location = nullIfBlank(dto.location);
    if (dto.condition !== undefined) data.condition = dto.condition;
    if (dto.usefulLifeMonths !== undefined)
      data.usefulLifeMonths = dto.usefulLifeMonths;
    if (dto.remarks !== undefined) data.remarks = nullIfBlank(dto.remarks);

    // Status deliberately isn't editable here — it has its own endpoint
    // with its own (Admin-only for RETIRED/DISPOSED) role rules, which a
    // general edit must not be able to route around.

    if (dto.warrantyProvider !== undefined)
      data.warrantyProvider = nullIfBlank(dto.warrantyProvider);
    if (dto.warrantyNumber !== undefined)
      data.warrantyNumber = nullIfBlank(dto.warrantyNumber);
    if (dto.warrantyStartDate !== undefined)
      data.warrantyStartDate = toDate(dto.warrantyStartDate);
    if (dto.warrantyEndDate !== undefined)
      data.warrantyEndDate = toDate(dto.warrantyEndDate);
    if (dto.warrantyPeriodMonths !== undefined)
      data.warrantyPeriodMonths = dto.warrantyPeriodMonths;
    if (dto.supportContact !== undefined)
      data.supportContact = nullIfBlank(dto.supportContact);
    if (dto.supportEmail !== undefined)
      data.supportEmail = nullIfBlank(dto.supportEmail);
    if (dto.supportPhone !== undefined)
      data.supportPhone = nullIfBlank(dto.supportPhone);
    if (dto.warrantyTerms !== undefined)
      data.warrantyTerms = nullIfBlank(dto.warrantyTerms);

    await this.assertUniqueIdentifiers(
      organizationId,
      {
        assetCode: (data.assetCode as string | undefined) ?? undefined,
        assetTag: (data.assetTag as string | null | undefined) ?? undefined,
        serialNumber:
          (data.serialNumber as string | null | undefined) ?? undefined,
      },
      id,
    );
    this.assertWarrantyDates(
      (data.warrantyStartDate as Date | null | undefined) !== undefined
        ? (data.warrantyStartDate as Date | null)
        : existing.warrantyStartDate,
      (data.warrantyEndDate as Date | null | undefined) !== undefined
        ? (data.warrantyEndDate as Date | null)
        : existing.warrantyEndDate,
    );

    // updateMany (not update) — its `where` takes arbitrary filters, so it
    // can carry organizationId, which the tenant-scope guard requires.
    await this.scopedPrisma.asset.updateMany({
      where: { id, organizationId },
      data,
    });
    const updated = await this.findAssetOrThrow(id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_UPDATED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: { changes: diffAsset(existing, updated) },
    });

    return updated;
  }

  async updateStatus(
    id: string,
    dto: UpdateAssetStatusDto,
    organizationId: string,
    actor: Actor,
  ) {
    const existing = await this.findAssetOrThrow(id, organizationId);

    // ASSIGNED is owned exclusively by the Employees module's allocation
    // flow — it can never be set (or cleared) by hand from here, or the
    // inventory would claim an asset is held by someone with no matching
    // EmployeeAsset row behind it.
    if (dto.status === AssetInventoryStatus.ASSIGNED) {
      throw new BadRequestException(ASSIGNED_BY_HAND_MESSAGE);
    }
    // Keyed off a live EmployeeAsset row, not Asset.status: a stale
    // ASSIGNED with nothing behind it (allocation row removed without a
    // return) must not lock the asset forever. The update below overwrites
    // the stale status with the requested one.
    if (await this.hasLiveAllocation(id, organizationId)) {
      throw new BadRequestException(
        'This asset is currently assigned — return it from the employee’s profile first.',
      );
    }

    await this.scopedPrisma.asset.updateMany({
      where: { id, organizationId },
      data: {
        status: dto.status,
        ...(dto.remarks !== undefined && { remarks: nullIfBlank(dto.remarks) }),
      },
    });
    const updated = await this.findAssetOrThrow(id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_STATUS_CHANGED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        previousStatus: existing.status,
        newStatus: dto.status,
        remarks: dto.remarks ?? null,
      },
    });

    return updated;
  }

  async updateWarranty(
    id: string,
    dto: UpdateAssetWarrantyDto,
    organizationId: string,
    actor: Actor,
  ) {
    const existing = await this.findAssetOrThrow(id, organizationId);

    const warrantyStartDate =
      dto.warrantyStartDate !== undefined
        ? toDate(dto.warrantyStartDate)
        : existing.warrantyStartDate;
    const warrantyEndDate =
      dto.warrantyEndDate !== undefined
        ? toDate(dto.warrantyEndDate)
        : existing.warrantyEndDate;
    this.assertWarrantyDates(warrantyStartDate, warrantyEndDate);

    await this.scopedPrisma.asset.updateMany({
      where: { id, organizationId },
      data: {
        warrantyProvider:
          dto.warrantyProvider !== undefined
            ? nullIfBlank(dto.warrantyProvider)
            : existing.warrantyProvider,
        warrantyNumber:
          dto.warrantyNumber !== undefined
            ? nullIfBlank(dto.warrantyNumber)
            : existing.warrantyNumber,
        warrantyStartDate,
        warrantyEndDate,
        warrantyPeriodMonths:
          dto.warrantyPeriodMonths !== undefined
            ? dto.warrantyPeriodMonths
            : existing.warrantyPeriodMonths,
        supportContact:
          dto.supportContact !== undefined
            ? nullIfBlank(dto.supportContact)
            : existing.supportContact,
        supportEmail:
          dto.supportEmail !== undefined
            ? nullIfBlank(dto.supportEmail)
            : existing.supportEmail,
        supportPhone:
          dto.supportPhone !== undefined
            ? nullIfBlank(dto.supportPhone)
            : existing.supportPhone,
        warrantyTerms:
          dto.warrantyTerms !== undefined
            ? nullIfBlank(dto.warrantyTerms)
            : existing.warrantyTerms,
      },
    });
    const updated = await this.findAssetOrThrow(id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_WARRANTY_UPDATED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        warrantyProvider: updated.warrantyProvider,
        warrantyNumber: updated.warrantyNumber,
        warrantyStartDate: updated.warrantyStartDate,
        warrantyEndDate: updated.warrantyEndDate,
      },
    });

    return updated;
  }

  // Soft delete — the row stays for audit-trail integrity and drops out of
  // findAll(), same isActive convention as EmployeeAsset.removeAsset.
  async remove(id: string, organizationId: string, actor: Actor) {
    // activeOnly=false so a repeat delete gets the specific 400 below
    // rather than a generic 404.
    const asset = await this.findAssetOrThrow(id, organizationId, false);
    if (!asset.isActive) {
      throw new BadRequestException('This asset has already been removed.');
    }
    // A live allocation row is the real signal — Asset.status alone can be
    // a stale ASSIGNED left behind when the allocation row was removed.
    if (await this.hasLiveAllocation(id, organizationId)) {
      throw new BadRequestException(
        'This asset is currently assigned to an employee — it must be returned before it can be removed.',
      );
    }
    const staleAssigned = asset.status === AssetInventoryStatus.ASSIGNED;

    await this.scopedPrisma.asset.updateMany({
      where: { id, organizationId },
      data: {
        isActive: false,
        ...(staleAssigned && { status: AssetInventoryStatus.AVAILABLE }),
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_RETIRED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        assetCode: asset.assetCode,
        assetName: asset.assetName,
        statusAtRemoval: asset.status,
        ...(staleAssigned && {
          statusCorrectedTo: AssetInventoryStatus.AVAILABLE,
        }),
      },
    });

    return { success: true, message: 'Asset removed' };
  }

  // -- Maintenance --

  async addMaintenance(
    id: string,
    dto: CreateAssetMaintenanceDto,
    organizationId: string,
    actor: Actor,
  ) {
    await this.findAssetOrThrow(id, organizationId);

    const record = await this.scopedPrisma.assetMaintenance.create({
      data: {
        organizationId,
        assetId: id,
        serviceDate: toDate(dto.serviceDate)!,
        issue: dto.issue.trim(),
        serviceProvider: nullIfBlank(dto.serviceProvider),
        serviceCost: dto.serviceCost ?? null,
        ...(dto.serviceStatus && { serviceStatus: dto.serviceStatus }),
        serviceStartDate: toDate(dto.serviceStartDate),
        serviceCompletionDate: toDate(dto.serviceCompletionDate),
        nextServiceDate: toDate(dto.nextServiceDate),
        warrantyClaim: dto.warrantyClaim ?? false,
        remarks: nullIfBlank(dto.remarks),
        createdById: actor.id,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_MAINTENANCE_ADDED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        maintenanceId: record.id,
        issue: record.issue,
        serviceStatus: record.serviceStatus,
        serviceDate: record.serviceDate,
      },
    });

    return record;
  }

  async updateMaintenance(
    id: string,
    maintenanceId: string,
    dto: UpdateAssetMaintenanceDto,
    organizationId: string,
    actor: Actor,
  ) {
    await this.findAssetOrThrow(id, organizationId);
    const existing = await this.scopedPrisma.assetMaintenance.findFirst({
      where: { id: maintenanceId, assetId: id, organizationId },
    });
    if (!existing) throw new NotFoundException('Maintenance record not found.');

    await this.scopedPrisma.assetMaintenance.updateMany({
      where: { id: maintenanceId, organizationId },
      data: {
        ...(dto.serviceDate !== undefined && {
          serviceDate: toDate(dto.serviceDate)!,
        }),
        ...(dto.issue !== undefined && { issue: dto.issue.trim() }),
        ...(dto.serviceProvider !== undefined && {
          serviceProvider: nullIfBlank(dto.serviceProvider),
        }),
        ...(dto.serviceCost !== undefined && { serviceCost: dto.serviceCost }),
        ...(dto.serviceStatus !== undefined && {
          serviceStatus: dto.serviceStatus,
        }),
        ...(dto.serviceStartDate !== undefined && {
          serviceStartDate: toDate(dto.serviceStartDate),
        }),
        ...(dto.serviceCompletionDate !== undefined && {
          serviceCompletionDate: toDate(dto.serviceCompletionDate),
        }),
        ...(dto.nextServiceDate !== undefined && {
          nextServiceDate: toDate(dto.nextServiceDate),
        }),
        ...(dto.warrantyClaim !== undefined && {
          warrantyClaim: dto.warrantyClaim,
        }),
        ...(dto.remarks !== undefined && { remarks: nullIfBlank(dto.remarks) }),
      },
    });

    const updated = await this.scopedPrisma.assetMaintenance.findFirstOrThrow({
      where: { id: maintenanceId, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_MAINTENANCE_UPDATED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        maintenanceId,
        previousStatus: existing.serviceStatus,
        newStatus: updated.serviceStatus,
      },
    });

    return updated;
  }

  // -- Documents --

  async addDocument(
    id: string,
    dto: CreateAssetDocumentDto,
    organizationId: string,
    actor: Actor,
  ) {
    await this.findAssetOrThrow(id, organizationId);

    if (dto.maintenanceId) {
      const maintenance = await this.scopedPrisma.assetMaintenance.findFirst({
        where: { id: dto.maintenanceId, assetId: id, organizationId },
        select: { id: true },
      });
      if (!maintenance) {
        throw new BadRequestException(
          'Maintenance record not found for this asset.',
        );
      }
    }

    const doc = await this.scopedPrisma.assetDocument.create({
      data: {
        organizationId,
        assetId: id,
        maintenanceId: dto.maintenanceId ?? null,
        docType: dto.docType,
        fileName: dto.fileName.trim(),
        fileUrl: dto.relativeKey,
        uploadedById: actor.id,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_DOCUMENT_ADDED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        documentId: doc.id,
        docType: doc.docType,
        fileName: doc.fileName,
      },
    });

    return withSignedFileUrl(doc);
  }

  async removeDocument(
    id: string,
    docId: string,
    organizationId: string,
    actor: Actor,
  ) {
    await this.findAssetOrThrow(id, organizationId);
    const doc = await this.scopedPrisma.assetDocument.findFirst({
      where: { id: docId, assetId: id, organizationId },
    });
    if (!doc) throw new NotFoundException('Document not found.');

    await this.scopedPrisma.assetDocument.deleteMany({
      where: { id: docId, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ASSET_DOCUMENT_REMOVED',
      module: AuditModule.ASSET,
      organizationId,
      targetId: id,
      details: {
        documentId: docId,
        docType: doc.docType,
        fileName: doc.fileName,
      },
    });

    return { success: true, message: 'Document removed' };
  }

  // -- History --
  //
  // Just this asset's slice of the org-wide AuditLog — there is deliberately
  // no separate asset-history table to drift out of sync with it.
  async history(id: string, organizationId: string) {
    await this.findAssetOrThrow(id, organizationId, false);
    // Allocation/return events are logged by the Employees module under
    // module=EMPLOYEE with targetId = the EmployeeAsset row's id, so pull
    // those in alongside this asset's own ASSET-module entries.
    const allocationIds = (
      await this.scopedPrisma.employeeAsset.findMany({
        where: { assetId: id, organizationId },
        select: { id: true },
      })
    ).map((row) => row.id);
    const entries = await this.scopedPrisma.auditLog.findMany({
      where: {
        organizationId,
        OR: [
          { module: AuditModule.ASSET, targetId: id },
          ...(allocationIds.length
            ? [
                {
                  module: AuditModule.EMPLOYEE,
                  targetId: { in: allocationIds },
                },
              ]
            : []),
        ],
      },
      include: {
        actor: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return wrapAll(entries);
  }
}

// Field-level before/after for the ASSET_UPDATED audit entry — only the
// fields that actually moved, so the trail reads as a change list rather
// than a full record dump on every save.
const DIFFED_FIELDS: (keyof Asset)[] = [
  'assetCode',
  'assetName',
  'categoryId',
  'categorySpecify',
  'brand',
  'model',
  'assetTag',
  'serialNumber',
  'purchasedFrom',
  'purchaseDate',
  'purchaseCost',
  'vendorContact',
  'invoiceNumber',
  'poNumber',
  'location',
  'condition',
  'usefulLifeMonths',
  'remarks',
  'warrantyProvider',
  'warrantyNumber',
  'warrantyStartDate',
  'warrantyEndDate',
  'warrantyPeriodMonths',
  'supportContact',
  'supportEmail',
  'supportPhone',
  'warrantyTerms',
];

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

export function diffAsset(
  before: Asset,
  after: Asset,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of DIFFED_FIELDS) {
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
