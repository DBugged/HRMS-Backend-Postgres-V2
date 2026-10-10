// Purpose: Lets an employee ask for an event-based leave grant and lets HR/Admin approve or reject the request.
// Important: A request never touches a balance. Approval calls LeaveGrantsService.grant() - the same eligibility,
//   policy-maximum, one-grant-per-event and idempotency checks as a manual grant - so there is one place that credits
//   event leave. A request is validated up front (the same rules) so the employee hears about a problem immediately.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationCategory,
  Prisma,
  Role,
  type LeaveGrant,
  type User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { isEligible } from '../leave-balances/leave-eligibility';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { checkGrantRequest } from './leave-grant-rules';
import { LeaveGrantsService } from './leave-grants.service';
import {
  ApproveGrantRequestDto,
  CreateGrantRequestDto,
  QueryGrantRequestsDto,
  RejectGrantRequestDto,
} from './dto/leave-grant.dto';

type Caller = Omit<User, 'password'>;

const INCLUDE = {
  leaveType: { select: { id: true, name: true, code: true } },
  employee: { select: { id: true, name: true, employeeId: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

@Injectable()
export class LeaveGrantRequestsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly grants: LeaveGrantsService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(
    query: QueryGrantRequestsDto,
    caller: Caller,
    organizationId: string,
  ) {
    const isHr = caller.role === Role.ADMIN || caller.role === Role.HR;
    return this.scopedPrisma.leaveGrantRequest.findMany({
      where: {
        organizationId,
        // Everyone else sees only their own requests; HR/Admin see all, or one employee's when asked.
        ...(isHr
          ? query.employeeId
            ? { employeeId: query.employeeId }
            : {}
          : { employeeId: caller.id }),
        ...(query.status && {
          status: query.status as
            'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED',
        }),
      },
      orderBy: { createdAt: 'desc' },
      include: INCLUDE,
    });
  }

  async create(
    dto: CreateGrantRequestDto,
    caller: Caller,
    organizationId: string,
  ) {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: dto.leaveTypeId, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: caller.id, organizationId },
      select: {
        id: true,
        name: true,
        reportingManagerId: true,
        joiningDate: true,
        departmentId: true,
        employeeType: true,
        gender: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (
      !isEligible(leaveType, employee, new Date(`${dto.eventDate}T00:00:00Z`))
    ) {
      throw new BadRequestException(
        'You do not meet the eligibility rules of this leave type.',
      );
    }
    const active = await this.scopedPrisma.leaveGrant.findMany({
      where: {
        organizationId,
        employeeId: caller.id,
        leaveTypeId: dto.leaveTypeId,
        status: 'ACTIVE',
      },
      select: { eventDate: true },
    });
    const problem = checkGrantRequest(
      leaveType,
      {
        eventDate: dto.eventDate,
        effectiveDate: dto.eventDate,
        days: dto.days,
        documentRef: dto.documentRef,
      },
      active.map((g) => g.eventDate),
    );
    if (problem) throw new BadRequestException(problem);

    let created: Prisma.LeaveGrantRequestGetPayload<{
      include: typeof INCLUDE;
    }>;
    try {
      created = await this.scopedPrisma.leaveGrantRequest.create({
        data: {
          organizationId,
          employeeId: caller.id,
          leaveTypeId: dto.leaveTypeId,
          eventDate: dto.eventDate,
          days: dto.days,
          reason: dto.reason.trim(),
          documentRef: dto.documentRef?.trim() || null,
        },
        include: INCLUDE,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'You already have a pending request for this leave type and event date.',
        );
      }
      throw err;
    }
    await this.notifications.notifyReviewers({
      organizationId,
      requester: employee,
      title: 'Event Leave Requested',
      message: `${employee.name} requested ${dto.days} day(s) of ${leaveType.name} for an event on ${dto.eventDate}.`,
      category: NotificationCategory.LEAVE,
    });
    return created;
  }

  async cancel(id: string, caller: Caller, organizationId: string) {
    const flipped = await this.scopedPrisma.leaveGrantRequest.updateMany({
      where: { id, organizationId, employeeId: caller.id, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new NotFoundException('No pending request of yours with this id.');
    }
    return this.scopedPrisma.leaveGrantRequest.findFirstOrThrow({
      where: { id, organizationId },
      include: INCLUDE,
    });
  }

  async approve(
    id: string,
    dto: ApproveGrantRequestDto,
    caller: Caller,
    organizationId: string,
  ) {
    const request = await this.scopedPrisma.leaveGrantRequest.findFirst({
      where: { id, organizationId },
    });
    if (!request) throw new NotFoundException('Request not found.');
    if (request.employeeId === caller.id && caller.role !== Role.ADMIN) {
      throw new ForbiddenException('You cannot approve your own request.');
    }
    // Claim the request first so two reviewers (or a double click) cannot both approve it.
    const claimed = await this.scopedPrisma.leaveGrantRequest.updateMany({
      where: { id, organizationId, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        decidedById: caller.id,
        decidedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('This request has already been decided.');
    }
    let grant: LeaveGrant;
    try {
      grant = await this.grants.grant(
        {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          eventDate: request.eventDate,
          effectiveDate: dto.effectiveDate,
          days: dto.days ?? request.days,
          reason: request.reason,
          documentRef: request.documentRef ?? undefined,
          idempotencyKey: `request:${id}`,
        },
        caller,
        organizationId,
      );
    } catch (err) {
      // The grant was refused (eligibility, maximum, a grant already exists...): the request is still open.
      await this.scopedPrisma.leaveGrantRequest.updateMany({
        where: { id, organizationId, status: 'APPROVED', grantId: null },
        data: { status: 'PENDING', decidedById: null, decidedAt: null },
      });
      throw err;
    }
    await this.scopedPrisma.leaveGrantRequest.updateMany({
      where: { id, organizationId },
      data: { grantId: grant.id, decisionNote: dto.note?.trim() || null },
    });
    await this.auditLog.log({
      actorId: caller.id,
      action: 'LEAVE_GRANT_REQUEST_APPROVED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: {
        grantId: grant.id,
        days: grant.days,
        employeeId: request.employeeId,
      },
    });
    await this.notifyEmployee(
      organizationId,
      request.employeeId,
      'Event Leave Approved',
      `Your event leave request for an event on ${request.eventDate} was approved for ${grant.days} day(s).`,
    );
    return this.scopedPrisma.leaveGrantRequest.findFirstOrThrow({
      where: { id, organizationId },
      include: INCLUDE,
    });
  }

  async reject(
    id: string,
    dto: RejectGrantRequestDto,
    caller: Caller,
    organizationId: string,
  ) {
    const request = await this.scopedPrisma.leaveGrantRequest.findFirst({
      where: { id, organizationId },
    });
    if (!request) throw new NotFoundException('Request not found.');
    if (request.employeeId === caller.id && caller.role !== Role.ADMIN) {
      throw new ForbiddenException('You cannot decide your own request.');
    }
    const flipped = await this.scopedPrisma.leaveGrantRequest.updateMany({
      where: { id, organizationId, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedById: caller.id,
        decidedAt: new Date(),
        decisionNote: dto.note.trim(),
      },
    });
    if (flipped.count === 0) {
      throw new ConflictException('This request has already been decided.');
    }
    await this.auditLog.log({
      actorId: caller.id,
      action: 'LEAVE_GRANT_REQUEST_REJECTED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: { employeeId: request.employeeId, note: dto.note },
    });
    await this.notifyEmployee(
      organizationId,
      request.employeeId,
      'Event Leave Rejected',
      `Your event leave request for an event on ${request.eventDate} was rejected: ${dto.note.trim()}`,
    );
    return this.scopedPrisma.leaveGrantRequest.findFirstOrThrow({
      where: { id, organizationId },
      include: INCLUDE,
    });
  }

  private async notifyEmployee(
    organizationId: string,
    userId: string,
    title: string,
    message: string,
  ) {
    try {
      await this.notifications.create({
        organizationId,
        userId,
        title,
        message,
        category: NotificationCategory.LEAVE,
      });
    } catch {
      // A notification problem must never undo a decision that was already recorded.
    }
  }
}
