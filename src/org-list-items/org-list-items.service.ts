// Purpose: Org-scoped named lists behind Organization Structure's Designations, Grades / Levels, and
//   Employee Categories screens — each is just OrgListItem rows filtered by `type`.
// Responsibilities: list/create/delete one item, plus a client-parsed Excel/CSV bulk import — same
//   Promise.allSettled per-row-isolation pattern as DocumentRequirement's bulk import.
// Important: `name` is stored as a plain string on the Employee record wherever it's selected (no FK) —
//   deleting or renaming an OrgListItem never orphans an employee who already has that value set.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, OrgListType } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateOrgListItemDto } from './dto/create-org-list-item.dto';
import { BulkImportOrgListItemsDto } from './dto/bulk-import-org-list-items.dto';
import { wrapAll } from '../common/pagination';

type Actor = { id: string };

@Injectable()
export class OrgListItemsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(type: OrgListType, organizationId: string) {
    const data = await this.scopedPrisma.orgListItem.findMany({
      where: { organizationId, type },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  async create(dto: CreateOrgListItemDto, organizationId: string, actor: Actor) {
    const name = dto.name.trim();
    const item = await this.scopedPrisma.orgListItem.create({
      data: { organizationId, type: dto.type, name },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ORG_LIST_ITEM_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: item.id,
      details: { type: dto.type, name },
    });

    return item;
  }

  async delete(id: string, organizationId: string, actor: Actor) {
    const item = await this.scopedPrisma.orgListItem.findFirst({
      where: { id, organizationId },
    });
    if (!item) throw new NotFoundException('List item not found.');

    await this.scopedPrisma.orgListItem.deleteMany({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ORG_LIST_ITEM_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { type: item.type, name: item.name },
    });

    return { success: true, message: 'List item deleted' };
  }

  async bulkImport(
    dto: BulkImportOrgListItemsDto,
    organizationId: string,
    actor: Actor,
  ) {
    const results = await Promise.allSettled(
      dto.rows.map((row) => {
        const name = row.name?.trim();
        if (!name) return Promise.reject(new Error('Row has no name.'));
        return this.scopedPrisma.orgListItem.create({
          data: { organizationId, type: dto.type, name },
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
            ? 'An item with this name already exists.'
            : result.reason instanceof Error
              ? result.reason.message
              : 'Failed to import row.';
        skipped.push({ name: dto.rows[idx]?.name ?? '(unknown)', reason });
      }
    });

    if (created.length > 0) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'ORG_LIST_ITEM_BULK_IMPORTED',
        module: AuditModule.ORGANIZATION,
        organizationId,
        details: { type: dto.type, created: created.length, skipped: skipped.length },
      });
    }

    return { created, skipped };
  }
}
