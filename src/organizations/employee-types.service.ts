// Purpose: Manage the org's Employee Type list — the 12 built-in defaults (undeletable/unrenameable,
//   business logic keys off their exact values, but deactivatable) plus whatever custom ones this org has
//   added.
// Responsibilities: Owns Organization.customEmployeeTypes (the same field the Setup Wizard's
//   settings/employeeTypes section and Employees.tsx's inline "add new type" flow already write) and
//   Organization.inactiveBuiltinEmployeeTypes (a built-in's only writable state, since the built-in entry
//   itself is hardcoded in employee-types.ts) behind ADMIN/HR-scoped endpoints, instead of the broad
//   ADMIN-only settings/:section route — this is the management-screen equivalent of Departments/
//   OrgListItems, kept consistent with their role split.
// Important: doesn't introduce a second source of truth — reads/writes the exact same JSON array
//   useEmployeeTypes() and the old inline flow already use, so all three surfaces stay in sync.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  DEFAULT_EMPLOYEE_TYPES,
  slugifyEmployeeType,
  type EmployeeTypeEntry,
} from './employee-types';

type Actor = { id: string };

@Injectable()
export class EmployeeTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private async getCustomTypes(
    organizationId: string,
  ): Promise<EmployeeTypeEntry[]> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { customEmployeeTypes: true },
    });
    return (org?.customEmployeeTypes as EmployeeTypeEntry[] | null) ?? [];
  }

  private async getInactiveBuiltins(
    organizationId: string,
  ): Promise<string[]> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { inactiveBuiltinEmployeeTypes: true },
    });
    return org?.inactiveBuiltinEmployeeTypes ?? [];
  }

  async findAll(organizationId: string) {
    const [custom, inactiveBuiltins] = await Promise.all([
      this.getCustomTypes(organizationId),
      this.getInactiveBuiltins(organizationId),
    ]);
    return [
      ...DEFAULT_EMPLOYEE_TYPES.map((t) => ({
        ...t,
        isActive: !inactiveBuiltins.includes(t.value),
        isCustom: false,
      })),
      ...custom.map((t) => ({
        ...t,
        isActive: t.isActive ?? true,
        isCustom: true,
      })),
    ];
  }

  async create(label: string, organizationId: string, actor: Actor) {
    const trimmed = label.trim();
    if (!trimmed) throw new BadRequestException('Label is required.');
    const value = slugifyEmployeeType(trimmed);
    if (!value) throw new BadRequestException('Label is required.');

    const custom = await this.getCustomTypes(organizationId);
    if (
      DEFAULT_EMPLOYEE_TYPES.some((t) => t.value === value) ||
      custom.some((t) => t.value === value)
    ) {
      throw new BadRequestException(
        'An employee type with this name already exists.',
      );
    }

    const next = [...custom, { value, label: trimmed }];
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { customEmployeeTypes: next as unknown as Prisma.InputJsonValue },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_TYPE_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { value, label: trimmed },
    });

    return this.findAll(organizationId);
  }

  // Renames a custom type's display label and/or flips its Active status —
  // `value` (the slug actually stored on Employee.employeeType) never
  // changes, so existing employees already set to this type keep working.
  // Built-in types can't be renamed/deleted (their labels/values are the
  // ones business logic and UI copy already reference), but CAN be
  // deactivated — see updateBuiltinActive().
  async update(
    value: string,
    updates: { label?: string; isActive?: boolean },
    organizationId: string,
    actor: Actor,
  ) {
    if (DEFAULT_EMPLOYEE_TYPES.some((t) => t.value === value)) {
      if (updates.label !== undefined) {
        throw new BadRequestException(
          "Built-in employee types can't be renamed.",
        );
      }
      if (updates.isActive !== undefined) {
        return this.updateBuiltinActive(
          value,
          updates.isActive,
          organizationId,
          actor,
        );
      }
      return this.findAll(organizationId);
    }
    const trimmed = updates.label?.trim();
    if (updates.label !== undefined && !trimmed) {
      throw new BadRequestException('Label is required.');
    }

    const custom = await this.getCustomTypes(organizationId);
    if (!custom.some((t) => t.value === value)) {
      throw new NotFoundException('Employee type not found.');
    }
    const next = custom.map((t) =>
      t.value === value
        ? {
            ...t,
            ...(trimmed !== undefined && { label: trimmed }),
            ...(updates.isActive !== undefined && {
              isActive: updates.isActive,
            }),
          }
        : t,
    );
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { customEmployeeTypes: next as unknown as Prisma.InputJsonValue },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_TYPE_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: {
        value,
        ...(trimmed !== undefined && { label: trimmed }),
        ...(updates.isActive !== undefined && {
          isActive: updates.isActive,
        }),
      },
    });

    return this.findAll(organizationId);
  }

  // Deactivating a built-in type just adds its value to the org's
  // inactiveBuiltinEmployeeTypes list (reactivating removes it) — the
  // DEFAULT_EMPLOYEE_TYPES entry itself never changes, so label/value stay
  // exactly what business logic elsewhere expects.
  private async updateBuiltinActive(
    value: string,
    isActive: boolean,
    organizationId: string,
    actor: Actor,
  ) {
    const inactiveBuiltins = await this.getInactiveBuiltins(organizationId);
    const next = isActive
      ? inactiveBuiltins.filter((v) => v !== value)
      : inactiveBuiltins.includes(value)
        ? inactiveBuiltins
        : [...inactiveBuiltins, value];

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { inactiveBuiltinEmployeeTypes: next },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_TYPE_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { value, isActive },
    });

    return this.findAll(organizationId);
  }

  async delete(value: string, organizationId: string, actor: Actor) {
    if (DEFAULT_EMPLOYEE_TYPES.some((t) => t.value === value)) {
      throw new BadRequestException(
        "Built-in employee types can't be deleted.",
      );
    }
    const custom = await this.getCustomTypes(organizationId);
    const next = custom.filter((t) => t.value !== value);
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { customEmployeeTypes: next as unknown as Prisma.InputJsonValue },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_TYPE_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { value },
    });

    return { success: true, message: 'Employee type deleted' };
  }

  async bulkImport(labels: string[], organizationId: string, actor: Actor) {
    const custom = await this.getCustomTypes(organizationId);
    const created: EmployeeTypeEntry[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const seen = new Set([
      ...DEFAULT_EMPLOYEE_TYPES.map((t) => t.value),
      ...custom.map((t) => t.value),
    ]);

    for (const raw of labels) {
      const label = raw?.trim();
      if (!label) {
        skipped.push({ name: raw ?? '(empty)', reason: 'Row has no name.' });
        continue;
      }
      const value = slugifyEmployeeType(label);
      if (!value || seen.has(value)) {
        skipped.push({
          name: label,
          reason: 'An employee type with this name already exists.',
        });
        continue;
      }
      seen.add(value);
      created.push({ value, label });
    }

    if (created.length > 0) {
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: {
          customEmployeeTypes: [
            ...custom,
            ...created,
          ] as unknown as Prisma.InputJsonValue,
        },
      });
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'EMPLOYEE_TYPE_BULK_IMPORTED',
        module: AuditModule.ORGANIZATION,
        organizationId,
        details: { created: created.length, skipped: skipped.length },
      });
    }

    return {
      created: created.map((t) => t.label),
      skipped,
    };
  }
}
