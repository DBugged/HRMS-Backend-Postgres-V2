import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateDepartmentDto } from './dto/create-department.dto';

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
      },
    });
  }

  findAll(organizationId: string) {
    return this.scopedPrisma.department.findMany({
      where: { organizationId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }
}
