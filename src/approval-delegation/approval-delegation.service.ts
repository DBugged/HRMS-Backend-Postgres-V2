// Purpose: Manages approval-delegation records letting a manager name a stand-in reviewer for a date range.
// Responsibilities: Owns delegation CRUD/cancel; exposes isActiveDelegate() for LeavesService.review() to
// check whether a delegate may act in a manager's place, rather than duplicating that lookup elsewhere.
// Important: isActiveDelegate() mirrors the old leaveController.js's inline check exactly (active
// delegation, today within [fromDate, toDate]) — keep the two in sync if the rule ever changes.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateDelegationDto } from './dto/create-delegation.dto';
import { QueryDelegationDto } from './dto/query-delegation.dto';
import { wrapAll } from '../common/pagination';

type Actor = Omit<User, 'password'>;

const ELEVATED_ROLES: Role[] = [Role.ADMIN, Role.HR];
const VALID_DELEGATE_ROLES: Role[] = [Role.MANAGER, Role.HR, Role.ADMIN];

@Injectable()
export class ApprovalDelegationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async findMine(
    query: QueryDelegationDto,
    actor: Actor,
    organizationId: string,
  ) {
    const delegatorId =
      ELEVATED_ROLES.includes(actor.role) && query.delegator
        ? query.delegator
        : actor.id;

    const data = await this.scopedPrisma.approvalDelegation.findMany({
      where: { organizationId, delegatorId },
      include: {
        delegate: { select: { id: true, name: true, employeeId: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { fromDate: 'desc' },
    });
    return wrapAll(data);
  }

  async create(dto: CreateDelegationDto, actor: Actor, organizationId: string) {
    const delegatorId =
      ELEVATED_ROLES.includes(actor.role) && dto.delegator
        ? dto.delegator
        : actor.id;

    if (new Date(dto.toDate) < new Date(dto.fromDate)) {
      throw new BadRequestException('toDate cannot be before fromDate.');
    }
    if (dto.delegate === delegatorId) {
      throw new BadRequestException('Cannot delegate approvals to yourself.');
    }

    const delegateUser = await this.scopedPrisma.user.findFirst({
      where: { id: dto.delegate, organizationId },
    });
    if (!delegateUser || !VALID_DELEGATE_ROLES.includes(delegateUser.role)) {
      throw new BadRequestException(
        'Delegate must be a manager, HR, or admin.',
      );
    }

    return this.scopedPrisma.approvalDelegation.create({
      data: {
        organizationId,
        delegatorId,
        delegateId: dto.delegate,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        createdById: actor.id,
      },
    });
  }

  async cancel(id: string, actor: Actor, organizationId: string) {
    const delegation = await this.scopedPrisma.approvalDelegation.findFirst({
      where: { id, organizationId },
    });
    if (!delegation) throw new NotFoundException('Delegation not found.');

    const isOwner = delegation.delegatorId === actor.id;
    if (!isOwner && !ELEVATED_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Not authorized to cancel this delegation.');
    }

    await this.scopedPrisma.approvalDelegation.updateMany({
      where: { id, organizationId },
      data: { isActive: false },
    });
    return this.scopedPrisma.approvalDelegation.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Used by LeavesService.review() to let a stand-in reviewer act in a
  // manager's place — mirrors the old leaveController.js's inline check
  // exactly (active delegation, today within [fromDate, toDate]).
  async isActiveDelegate(
    delegatorId: string,
    delegateId: string,
    organizationId: string,
    today: string,
  ): Promise<boolean> {
    const delegation = await this.scopedPrisma.approvalDelegation.findFirst({
      where: {
        organizationId,
        delegatorId,
        delegateId,
        isActive: true,
        fromDate: { lte: today },
        toDate: { gte: today },
      },
    });
    return !!delegation;
  }
}
