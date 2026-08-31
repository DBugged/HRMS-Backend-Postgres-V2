// Purpose: CRUD for Department records, department-head assignment, and employee-to-department mapping.
// Responsibilities: Owns department lifecycle including deletion guard (blocks delete while employees are
// mapped); assignHead() folds a role promotion (to MANAGER) into the same call as head assignment.
// Important: assignHead() refuses to promote a user who already holds ADMIN/HR (NON_DEMOTABLE_ROLES) since
// that would silently demote their real role to MANAGER — mirrors the frontend's own NON_DEMOTABLE_ROLES list.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { MapEmployeesDto } from './dto/map-employees.dto';
import { BulkImportDepartmentsDto } from './dto/bulk-import-departments.dto';
import { wrapAll } from '../common/pagination';
import { AuditLogService } from '../audit-log/audit-log.service';

// Mirrors the frontend's own NON_DEMOTABLE_ROLES — these roles already
// carry broader-than-department authority, so assigning one of these users
// as a department head must never overwrite their real role with MANAGER
// (that would silently demote them). Only a plain employee gets promoted.
const NON_DEMOTABLE_ROLES: Role[] = [Role.ADMIN, Role.HR];

const DEPARTMENT_INCLUDE = {
  departmentHead: {
    select: { id: true, name: true, employeeId: true, email: true },
  },
  workLocation: true,
} satisfies Prisma.DepartmentInclude;

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    dto: CreateDepartmentDto,
    organizationId: string,
    actorId?: string,
  ) {
    const code = dto.code.toUpperCase();
    const existing = await this.scopedPrisma.department.findFirst({
      where: { organizationId, OR: [{ name: dto.name }, { code }] },
    });
    if (existing) {
      throw new ConflictException(
        'A department with this name or code already exists.',
      );
    }

    const department = await this.scopedPrisma.department.create({
      data: {
        organizationId,
        name: dto.name,
        code,
        description: dto.description ?? '',
        ...(dto.shiftStartTime && { shiftStartTime: dto.shiftStartTime }),
        ...(dto.shiftEndTime && { shiftEndTime: dto.shiftEndTime }),
        ...(dto.weeklyOffs && { weeklyOffs: dto.weeklyOffs }),
      },
      include: DEPARTMENT_INCLUDE,
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_CREATED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: department.id,
        details: { name: department.name, code: department.code },
      });
    }

    return department;
  }

  // Client-parsed Excel/CSV import — same Promise.allSettled per-row
  // isolation as OrgListItemsService/DocumentRequirementsService's bulk
  // imports. Reuses create() itself for each row rather than duplicating
  // its duplicate-check/audit-log logic.
  async bulkImport(
    dto: BulkImportDepartmentsDto,
    organizationId: string,
    actorId?: string,
  ) {
    const results = await Promise.allSettled(
      dto.rows.map((row) => {
        const name = row.name?.trim();
        const code = row.code?.trim();
        if (!name || !code) {
          return Promise.reject(new Error('Row needs both a name and a code.'));
        }
        return this.create(
          { name, code, description: row.description?.trim() },
          organizationId,
          actorId,
        );
      }),
    );

    const created: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        created.push(result.value.name);
      } else {
        const reason =
          result.reason instanceof ConflictException
            ? 'A department with this name or code already exists.'
            : result.reason instanceof Error
              ? result.reason.message
              : 'Failed to import row.';
        skipped.push({ name: dto.rows[idx]?.name ?? '(unknown)', reason });
      }
    });

    return { created, skipped };
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.department.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
      include: DEPARTMENT_INCLUDE,
    });
    return wrapAll(data);
  }

  private async findOrThrow(id: string, organizationId: string) {
    const department = await this.scopedPrisma.department.findFirst({
      where: { id, organizationId },
    });
    if (!department) throw new NotFoundException('Department not found.');
    return department;
  }

  async update(
    id: string,
    dto: UpdateDepartmentDto,
    organizationId: string,
    actorId?: string,
  ) {
    await this.findOrThrow(id, organizationId);
    await this.scopedPrisma.department.updateMany({
      where: { id, organizationId },
      data: dto,
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_UPDATED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: id,
      });
    }

    return this.scopedPrisma.department.findFirstOrThrow({
      where: { id, organizationId },
      include: DEPARTMENT_INCLUDE,
    });
  }

  // Promotes a plain employee to MANAGER and stamps them as this
  // department's head in one step — mirrors the old system's
  // assignDepartmentHead, which folds the role change into the same call
  // rather than requiring a separate PATCH /employees/:id afterwards.
  async assignHead(id: string, userId: string, organizationId: string) {
    await this.findOrThrow(id, organizationId);
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: userId, organizationId },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (NON_DEMOTABLE_ROLES.includes(user.role)) {
      throw new BadRequestException(
        `${user.name} already has the ${user.role} role, which already covers every department — assign a regular employee as department head instead.`,
      );
    }

    await this.scopedPrisma.$transaction([
      this.scopedPrisma.department.updateMany({
        where: { id, organizationId },
        data: { departmentHeadId: userId },
      }),
      this.scopedPrisma.user.updateMany({
        where: { id: userId, organizationId },
        data: { role: Role.MANAGER, departmentId: id },
      }),
    ]);

    return this.scopedPrisma.department.findFirstOrThrow({
      where: { id, organizationId },
      include: DEPARTMENT_INCLUDE,
    });
  }

  async mapEmployees(id: string, dto: MapEmployeesDto, organizationId: string) {
    const department = await this.findOrThrow(id, organizationId);
    const { count } = await this.scopedPrisma.user.updateMany({
      where: { id: { in: dto.employeeIds }, organizationId },
      data: { departmentId: id },
    });
    return { message: `${count} employee(s) mapped to ${department.name}` };
  }

  async remove(id: string, organizationId: string, actorId?: string) {
    const existing = await this.findOrThrow(id, organizationId);
    const employeeCount = await this.scopedPrisma.user.count({
      where: { departmentId: id, organizationId },
    });
    if (employeeCount > 0) {
      throw new BadRequestException(
        'Cannot delete a department with employees mapped to it.',
      );
    }
    await this.scopedPrisma.department.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'DEPARTMENT_DELETED',
        module: 'DEPARTMENT',
        organizationId,
        targetId: id,
        details: { name: existing.name, code: existing.code },
      });
    }

    return { message: 'Department deleted.' };
  }
}
