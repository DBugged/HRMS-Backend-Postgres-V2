import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateReimbursementDto } from './dto/create-reimbursement.dto';
import { ReviewReimbursementDto } from './dto/review-reimbursement.dto';
import { QueryReimbursementDto } from './dto/query-reimbursement.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async findAll(
    query: QueryReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.ReimbursementWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    return this.scopedPrisma.reimbursement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    dto: CreateReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    return this.scopedPrisma.reimbursement.create({
      data: {
        organizationId,
        employeeId: actor.id,
        category: dto.category,
        amount: dto.amount,
        claimDate: dto.claimDate,
        description: dto.description ?? '',
        receiptUrl: dto.receiptUrl ?? '',
      },
    });
  }

  async review(
    id: string,
    dto: ReviewReimbursementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const claim = await this.scopedPrisma.reimbursement.findFirst({
      where: { id, organizationId },
    });
    if (!claim) throw new NotFoundException('Reimbursement claim not found.');

    await this.scopedPrisma.reimbursement.updateMany({
      where: { id, organizationId },
      data: {
        status: dto.status,
        reviewComments: dto.reviewComments ?? '',
        approvedById: actor.id,
      },
    });
    return this.scopedPrisma.reimbursement.findFirstOrThrow({
      where: { id, organizationId },
    });
  }
}
