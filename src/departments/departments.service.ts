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
import { wrapAll } from '../common/pagination';

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
  ) {}

  async create(dto: CreateDepartmentDto, organizationId: string) {
    const code = dto.code.toUpperCase();
    const existing = await this.scopedPrisma.department.findFirst({
      where: { organizationId, OR: [{ name: dto.name }, { code }] },
    });
    if (existing) {
      throw new ConflictException(
        'A department with this name or code already exists.',
      );
    }

    return this.scopedPrisma.department.create({
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

  async update(id: string, dto: UpdateDepartmentDto, organizationId: string) {
    await this.findOrThrow(id, organizationId);
    await this.scopedPrisma.department.updateMany({
      where: { id, organizationId },
      data: dto,
    });
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

  async remove(id: string, organizationId: string) {
    await this.findOrThrow(id, organizationId);
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
    return { message: 'Department deleted.' };
  }
}
