import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertPerformanceRatingDto } from './dto/upsert-performance-rating.dto';
import { QueryPerformanceRatingDto } from './dto/query-performance-rating.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class PerformanceRatingsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async findAll(
    query: QueryPerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.PerformanceRatingWhereInput = { organizationId };

    if (actor.role === Role.MANAGER) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: actor.departmentId },
        select: { id: true },
      });
      const deptEmployeeIds = new Set(deptEmployees.map((e) => e.id));
      where.employeeId =
        query.employeeId && deptEmployeeIds.has(query.employeeId)
          ? query.employeeId
          : { in: [...deptEmployeeIds] };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.financialYear) where.financialYear = query.financialYear;

    return this.scopedPrisma.performanceRating.findMany({
      where,
      orderBy: { financialYear: 'desc' },
    });
  }

  async upsert(
    dto: UpsertPerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    if (actor.role === Role.MANAGER) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: dto.employeeId, organizationId },
      });
      if (!employee || employee.departmentId !== actor.departmentId) {
        throw new ForbiddenException(
          'You may only rate employees in your own department.',
        );
      }
    }

    const existing = await this.scopedPrisma.performanceRating.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        financialYear: dto.financialYear,
      },
    });

    const data = {
      rating: dto.rating,
      payoutPercentage: dto.payoutPercentage ?? 100,
      notes: dto.notes ?? '',
      ratedById: actor.id,
    };

    if (existing) {
      await this.scopedPrisma.performanceRating.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      return this.scopedPrisma.performanceRating.findFirstOrThrow({
        where: { id: existing.id, organizationId },
      });
    }

    return this.scopedPrisma.performanceRating.create({
      data: {
        organizationId,
        employeeId: dto.employeeId,
        financialYear: dto.financialYear,
        ...data,
      },
    });
  }
}
