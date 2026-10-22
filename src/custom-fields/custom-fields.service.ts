// Purpose: A company's own extra fields on the employee profile - defining them (Admin/HR) and saving each employee's
//   values (HR/Admin for anyone, the employee for the fields marked editable).
// Responsibilities: CRUD on CustomFieldDefinition; PATCH of one employee's values through custom-field-values.ts, which
//   does the checking. Everything is audit-logged by key (never by value - the values may be personal).
// Important: a field is switched off, not deleted, so values already entered are kept. The type and key never change.
//   Values are returned to HR/Admin and the employee themself only (employee lists mask them for everyone else).
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  UpdateCustomFieldValuesDto,
} from './dto/custom-field.dto';
import {
  MAX_CUSTOM_FIELDS,
  cleanOptions,
  mergeValues,
  uniqueKey,
  type FieldDef,
} from './custom-field-values';

type Actor = Omit<User, 'password'>;
const HR_ROLES: Role[] = [Role.ADMIN, Role.HR];
const DEFAULT_SECTION = 'Additional information';

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  // Active fields for everyone (the forms need them); HR/Admin can also ask for the switched-off ones.
  list(organizationId: string, actor: Actor, includeInactive: boolean) {
    const all = includeInactive && HR_ROLES.includes(actor.role);
    return this.scopedPrisma.customFieldDefinition.findMany({
      where: { organizationId, ...(all ? {} : { isActive: true }) },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(dto: CreateCustomFieldDto, actor: Actor, organizationId: string) {
    const existing = await this.scopedPrisma.customFieldDefinition.findMany({
      where: { organizationId },
      select: { key: true, label: true, displayOrder: true, isActive: true },
    });
    if (existing.length >= MAX_CUSTOM_FIELDS) {
      throw new BadRequestException(`A company can have at most ${MAX_CUSTOM_FIELDS} custom fields. Switch one off or reuse it.`);
    }
    const label = dto.label.trim();
    if (existing.some((f) => f.isActive && f.label.toLowerCase() === label.toLowerCase())) {
      throw new BadRequestException(`There is already a field called "${label}".`);
    }
    let options: string[] | undefined;
    if (dto.type === 'DROPDOWN') {
      const cleaned = cleanOptions(dto.options);
      if ('error' in cleaned) throw new BadRequestException(cleaned.error);
      options = cleaned.options;
    }
    const created = await this.scopedPrisma.customFieldDefinition.create({
      data: {
        organizationId,
        key: uniqueKey(label, existing.map((f) => f.key)),
        label,
        type: dto.type,
        options: options ?? Prisma.JsonNull,
        required: dto.required ?? false,
        helpText: dto.helpText?.trim() ?? '',
        section: dto.section?.trim() || DEFAULT_SECTION,
        employeeEditable: dto.employeeEditable ?? false,
        displayOrder: existing.reduce((m, f) => Math.max(m, f.displayOrder), 0) + 1,
      },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'CUSTOM_FIELD_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: created.id,
      details: { key: created.key, label: created.label, type: created.type },
    });
    return created;
  }

  async update(id: string, dto: UpdateCustomFieldDto, actor: Actor, organizationId: string) {
    const field = await this.scopedPrisma.customFieldDefinition.findFirst({ where: { id, organizationId } });
    if (!field) throw new NotFoundException('Custom field not found.');
    const data: Prisma.CustomFieldDefinitionUpdateInput = {};
    if (dto.label !== undefined) {
      const label = dto.label.trim();
      if (!label) throw new BadRequestException('Give the field a name.');
      const clash = await this.scopedPrisma.customFieldDefinition.findFirst({
        where: { organizationId, isActive: true, id: { not: id }, label: { equals: label, mode: 'insensitive' } },
        select: { id: true },
      });
      if (clash) throw new BadRequestException(`There is already a field called "${label}".`);
      data.label = label;
    }
    if (dto.options !== undefined) {
      if (field.type !== 'DROPDOWN') throw new BadRequestException('Only a dropdown has choices.');
      const cleaned = cleanOptions(dto.options);
      if ('error' in cleaned) throw new BadRequestException(cleaned.error);
      data.options = cleaned.options;
    }
    if (dto.required !== undefined) data.required = dto.required;
    if (dto.helpText !== undefined) data.helpText = dto.helpText.trim();
    if (dto.section !== undefined) data.section = dto.section.trim() || DEFAULT_SECTION;
    if (dto.employeeEditable !== undefined) data.employeeEditable = dto.employeeEditable;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    const updated = await this.scopedPrisma.customFieldDefinition.update({ where: { id }, data });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'CUSTOM_FIELD_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { key: field.key, changed: Object.keys(data) },
    });
    return updated;
  }

  // One employee's values. HR/Admin may set any active field; the employee only the ones marked editable.
  async updateValues(employeeId: string, dto: UpdateCustomFieldValuesDto, actor: Actor, organizationId: string) {
    const target = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true, role: true, customFields: true },
    });
    if (!target) throw new NotFoundException('Employee not found.');
    const isSelf = actor.id === employeeId;
    const canEditAll = HR_ROLES.includes(actor.role);
    if (!isSelf && !canEditAll) throw new ForbiddenException('You cannot edit another employee\'s details.');
    // The same rule as the rest of an employee's record: only an Admin edits an HR or Admin record (apart from their own).
    if (!isSelf && actor.role !== Role.ADMIN && (target.role === Role.ADMIN || target.role === Role.HR)) {
      throw new ForbiddenException('Only an Admin can edit an HR or Admin employee record.');
    }
    const defs = await this.scopedPrisma.customFieldDefinition.findMany({ where: { organizationId } });
    const current = (target.customFields ?? {}) as Record<string, unknown>;
    const result = mergeValues(defs as unknown as FieldDef[], current, dto.values, { canEditAll });
    if (result.errors.length > 0) throw new BadRequestException(result.errors.join(' '));
    if (result.changedKeys.length === 0) return { customFields: result.values };
    await this.scopedPrisma.user.updateMany({
      where: { id: employeeId, organizationId },
      data: { customFields: result.values as Prisma.InputJsonValue },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_CUSTOM_FIELDS_UPDATED',
      module: AuditModule.EMPLOYEE,
      organizationId,
      targetId: employeeId,
      details: { changedKeys: result.changedKeys },
    });
    return { customFields: result.values };
  }
}
