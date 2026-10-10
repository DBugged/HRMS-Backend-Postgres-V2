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
import { approvalStep, checkGrantRequest } from './leave-grant-rules';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import {
  assertManagerScopeOrDelegate,
  assertNotOwnRequest,
} from '../common/dept-scope';
import { LeaveGrantsService } from './leave-grants.service';
import {
  ApproveGrantRequestDto,
  CreateGrantRequestDto,
  QueryGrantRequestsDto,
  RejectGrantRequestDto,
} from './dto/leave-grant.dto';

type Caller = Omit<User, 'password'>;

const INCLUDE = {
  leaveType: {
    select: {
      id: true,
      name: true,
      code: true,
      approvalLevels: true,
      requiresApproval: true,
    },
  },
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
    private readonly delegation: ApprovalDelegationService,
  ) {}

  async list(
    query: QueryGrantRequestsDto,
    caller: Caller,
    organizationId: string,
  ) {
    const isHr = caller.role === Role.ADMIN || caller.role === Role.HR;
    let employeeFilter: Prisma.LeaveGrantRequestWhereInput = {
      employeeId: caller.id,
    };
    if (isHr) {
      // HR/Admin see everyone's, or one employee's when asked.
      employeeFilter = query.employeeId ? { employeeId: query.employeeId } : {};
    } else if (caller.role === Role.MANAGER) {
      // A manager sees their own and their team's (direct reports and their department).
      const team = await this.scopedPrisma.user.findMany({
        where: {
          organizationId,
          OR: [
            { reportingManagerId: caller.id },
            ...(caller.departmentId
              ? [{ departmentId: caller.departmentId }]
              : []),
          ],
        },
        select: { id: true },
      });
      const ids = [caller.id, ...team.map((u) => u.id)];
      employeeFilter = {
        employeeId:
          query.employeeId && ids.includes(query.employeeId)
            ? query.employeeId
            : { in: ids },
      };
    }
    return this.scopedPrisma.leaveGrantRequest.findMany({
      where: {
        organizationId,
        ...employeeFilter,
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
    // A leave type that needs no approval grants straight away (the same rule as a leave application).
    if (!leaveType.requiresApproval) {
      return this.finalize(created.id, caller, organizationId, {
        days: created.days,
        note: 'Auto-approved: this leave type needs no approval.',
        allowSelfGrant: true,
      });
    }
    // The reporting manager is told first (HR/Admin when there is none), as for leave applications.
    await this.notifications.notifyReviewers({
      organizationId,
      requester: employee,
      title: 'Event Leave Requested',
      message: `${employee.name} requested ${dto.days} day(s) of ${leaveType.name} for an event on ${dto.eventDate}.`,
      category: NotificationCategory.LEAVE,
      managerFirst: true,
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
      include: INCLUDE,
    });
    if (!request) throw new NotFoundException('Request not found.');
    if (request.status !== 'PENDING') {
      throw new ConflictException('This request has already been decided.');
    }
    // Nobody decides their own request; a manager only acts on their own team (or as a delegate).
    assertNotOwnRequest(caller, request.employeeId);
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegation,
      caller,
      organizationId,
      request.employeeId,
    );

    const step = approvalStep({
      role: caller.role,
      approvalLevels: request.leaveType.approvalLevels,
      level1Done: request.level1ApprovedById !== null,
      levelOneApproverExists: await this.levelOneApproverExists(
        request.employeeId,
        organizationId,
      ),
    });
    if (step.step === 'DENIED') throw new ForbiddenException(step.message);

    if (step.step === 'LEVEL1') {
      // Level-1 sign-off only: the request stays pending for HR/Admin's final decision.
      const claimed = await this.scopedPrisma.leaveGrantRequest.updateMany({
        where: {
          id,
          organizationId,
          status: 'PENDING',
          level1ApprovedById: null,
        },
        data: {
          level1ApprovedById: caller.id,
          level1ApprovedAt: new Date(),
          level1Comments: dto.note?.trim() || null,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'This request has already been signed off.',
        );
      }
      await this.auditLog.log({
        actorId: caller.id,
        action: 'LEAVE_GRANT_REQUEST_LEVEL1_APPROVED',
        module: 'LEAVE',
        organizationId,
        targetId: id,
        details: { employeeId: request.employeeId },
      });
      await this.notifications.notifyReviewers({
        organizationId,
        requester: { id: request.employeeId, reportingManagerId: null },
        title: 'Event Leave Awaiting Final Approval',
        message: `${request.employee.name}'s event leave request for ${request.leaveType.name} has level-1 approval and needs your final decision.`,
        category: NotificationCategory.LEAVE,
      });
      return this.scopedPrisma.leaveGrantRequest.findFirstOrThrow({
        where: { id, organizationId },
        include: INCLUDE,
      });
    }

    return this.finalize(id, caller, organizationId, {
      days: dto.days ?? request.days,
      effectiveDate: dto.effectiveDate,
      note: dto.note,
    });
  }

  // The final approval: claims the request, then creates the grant through the one grant path.
  private async finalize(
    id: string,
    caller: Caller,
    organizationId: string,
    input: {
      days: number;
      effectiveDate?: string;
      note?: string;
      allowSelfGrant?: boolean;
    },
  ) {
    const request = await this.scopedPrisma.leaveGrantRequest.findFirstOrThrow({
      where: { id, organizationId },
    });
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
          effectiveDate: input.effectiveDate,
          days: input.days,
          reason: request.reason,
          documentRef: request.documentRef ?? undefined,
          idempotencyKey: `request:${id}`,
        },
        caller,
        organizationId,
        { allowSelfGrant: input.allowSelfGrant },
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
      data: { grantId: grant.id, decisionNote: input.note?.trim() || null },
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
    assertNotOwnRequest(caller, request.employeeId);
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegation,
      caller,
      organizationId,
      request.employeeId,
    );
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

  // Whether a manager who could give level-1 approval exists for this employee (a manager above them, or one in
  // their department). Used so HR/Admin are never blocked waiting for a sign-off nobody can give.
  private async levelOneApproverExists(
    employeeId: string,
    organizationId: string,
  ): Promise<boolean> {
    const applicant = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { role: true, reportingManagerId: true, departmentId: true },
    });
    if (!applicant) return false;
    if (applicant.role === Role.ADMIN || applicant.role === Role.HR) {
      return false;
    }
    const scope: Prisma.UserWhereInput[] = [];
    if (applicant.reportingManagerId) {
      scope.push({ id: applicant.reportingManagerId });
    }
    if (applicant.departmentId) {
      scope.push({ departmentId: applicant.departmentId });
    }
    if (scope.length === 0) return false;
    const count = await this.scopedPrisma.user.count({
      where: {
        organizationId,
        isActive: true,
        role: Role.MANAGER,
        id: { not: employeeId },
        OR: scope,
      },
    });
    return count > 0;
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
