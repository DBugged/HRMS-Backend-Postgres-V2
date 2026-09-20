// Purpose: Employee resignation requests — submit/withdraw (own), and HR/Admin approve/reject.
// Responsibilities: Owns the Resignation state machine (PENDING -> APPROVED/REJECTED/WITHDRAWN); approving
// delegates the exit itself to OffboardingService.initiate() (which moves the employee to NOTICE_PERIOD) and
// links the resulting case; timeline/audit/in-app notifications are best-effort side effects.
// Important: one open (PENDING) request per employee, only for active employees with no open offboarding
// case. Nobody decides their own resignation, and only an ADMIN decides an HR/ADMIN user's (same rule as the
// privacy module's requests). approvedLwd defaults to submittedOn + noticePeriodDays (no org-level notice
// setting exists, so the days come from the request or the approving HR), else the requested LWD.
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
  OffboardingStatus,
  ResignationStatus,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { OffboardingService } from '../offboarding/offboarding.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { paginate, skip } from '../common/pagination';
import { SubmitResignationDto } from './dto/submit-resignation.dto';
import {
  ApproveResignationDto,
  RejectResignationDto,
} from './dto/decide-resignation.dto';
import { ListResignationsQueryDto } from './dto/list-resignations-query.dto';

type Actor = Omit<User, 'password'>;

const HR_ROLES: Role[] = [Role.HR, Role.ADMIN];

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class ResignationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly offboardingService: OffboardingService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async submit(dto: SubmitResignationDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
    });
    if (!employee || !employee.isActive) {
      throw new BadRequestException(
        'Only an active employee can submit a resignation.',
      );
    }
    const submittedOn = todayStr();
    if (dto.requestedLwd < submittedOn) {
      throw new BadRequestException('requestedLwd cannot be before today.');
    }
    const open = await this.scopedPrisma.resignation.findFirst({
      where: {
        organizationId,
        employeeId: actor.id,
        status: ResignationStatus.PENDING,
      },
    });
    if (open) {
      throw new BadRequestException(
        'You already have a pending resignation request.',
      );
    }
    const openCase = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        organizationId,
        employeeId: actor.id,
        status: {
          in: [OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS],
        },
      },
    });
    if (openCase) {
      throw new BadRequestException(
        'An offboarding process is already in progress for you.',
      );
    }

    const created = await this.scopedPrisma.resignation.create({
      data: {
        organizationId,
        employeeId: actor.id,
        submittedOn,
        requestedLwd: dto.requestedLwd,
        noticePeriodDays: dto.noticePeriodDays,
        reason: dto.reason,
      },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'RESIGNATION_SUBMITTED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: actor.id,
      details: { resignationId: created.id, requestedLwd: dto.requestedLwd },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'RESIGNATION_SUBMITTED',
      performedById: actor.id,
      description: dto.reason ?? '',
      metadata: { resignationId: created.id, requestedLwd: dto.requestedLwd },
    });
    // In-app notice to the reporting manager and every HR/Admin (never the requester). Best-effort.
    const recipients = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        id: { not: actor.id },
        OR: [
          { role: { in: HR_ROLES } },
          ...(employee.reportingManagerId
            ? [{ id: employee.reportingManagerId }]
            : []),
        ],
      },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) =>
        this.notify(
          organizationId,
          r.id,
          'Resignation Submitted',
          `${employee.name} has submitted a resignation (requested last working day ${dto.requestedLwd}).`,
        ),
      ),
    );
    return created;
  }

  findMine(actor: Actor) {
    return this.scopedPrisma.resignation.findMany({
      where: { organizationId: actor.organizationId, employeeId: actor.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  findAll(query: ListResignationsQueryDto, organizationId: string) {
    const where = {
      organizationId,
      ...(query.status && { status: query.status }),
    };
    return paginate(
      () =>
        this.scopedPrisma.resignation.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.resignation.count({ where }),
      query.page,
      query.limit,
    );
  }

  async findOne(id: string, actor: Actor) {
    const record = await this.scopedPrisma.resignation.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
    });
    if (!record) throw new NotFoundException('Resignation not found.');
    if (record.employeeId !== actor.id && !HR_ROLES.includes(actor.role)) {
      throw new NotFoundException('Resignation not found.');
    }
    return record;
  }

  async withdraw(id: string, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.scopedPrisma.resignation.findFirst({
      where: { id, organizationId, employeeId: actor.id },
    });
    if (!record) throw new NotFoundException('Resignation not found.');
    const { count } = await this.scopedPrisma.resignation.updateMany({
      where: { id, organizationId, status: ResignationStatus.PENDING },
      data: { status: ResignationStatus.WITHDRAWN },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Only a pending resignation can be withdrawn.',
      );
    }
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'RESIGNATION_WITHDRAWN',
      performedById: actor.id,
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'RESIGNATION_WITHDRAWN',
      module: 'EMPLOYEE',
      organizationId,
      targetId: actor.id,
      details: { resignationId: id },
    });
    return this.scopedPrisma.resignation.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async approve(id: string, dto: ApproveResignationDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.loadForDecision(id, actor);

    const noticePeriodDays = dto.noticePeriodDays ?? record.noticePeriodDays;
    const approvedLwd =
      dto.approvedLwd ??
      (noticePeriodDays != null
        ? addDays(record.submittedOn, noticePeriodDays)
        : record.requestedLwd);

    // Guarded flip first so two concurrent approvals can't both initiate an offboarding case; reverted if
    // initiate() refuses (e.g. an approved leave extends past the LWD).
    const { count } = await this.scopedPrisma.resignation.updateMany({
      where: { id, organizationId, status: ResignationStatus.PENDING },
      data: {
        status: ResignationStatus.APPROVED,
        approvedLwd,
        noticePeriodDays: noticePeriodDays ?? null,
        decidedById: actor.id,
        decidedAt: new Date(),
        decisionNote: dto.decisionNote,
      },
    });
    if (count === 0) {
      throw new ConflictException('This resignation was already decided.');
    }
    let offboardingCaseId: string;
    try {
      const offboardingCase = await this.offboardingService.initiate(
        {
          employeeId: record.employeeId,
          lastWorkingDay: approvedLwd,
          reason: record.reason ?? 'Resignation',
          exitStatus: 'RESIGNED',
        },
        actor,
        organizationId,
      );
      offboardingCaseId = offboardingCase.id;
    } catch (err) {
      await this.scopedPrisma.resignation.updateMany({
        where: { id, organizationId },
        data: {
          status: ResignationStatus.PENDING,
          approvedLwd: null,
          decidedById: null,
          decidedAt: null,
          decisionNote: null,
        },
      });
      throw err;
    }
    await this.scopedPrisma.resignation.updateMany({
      where: { id, organizationId },
      data: { offboardingCaseId },
    });
    await this.afterDecision(record.employeeId, id, 'APPROVED', actor, {
      approvedLwd,
    });
    return this.scopedPrisma.resignation.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async reject(id: string, dto: RejectResignationDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.loadForDecision(id, actor);
    const { count } = await this.scopedPrisma.resignation.updateMany({
      where: { id, organizationId, status: ResignationStatus.PENDING },
      data: {
        status: ResignationStatus.REJECTED,
        decidedById: actor.id,
        decidedAt: new Date(),
        decisionNote: dto.decisionNote,
      },
    });
    if (count === 0) {
      throw new ConflictException('This resignation was already decided.');
    }
    await this.afterDecision(record.employeeId, id, 'REJECTED', actor, {});
    return this.scopedPrisma.resignation.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Own-request + tiering rule, same as the privacy module: nobody decides their own, and only an ADMIN
  // decides an HR/ADMIN user's resignation.
  private async loadForDecision(id: string, actor: Actor) {
    const record = await this.scopedPrisma.resignation.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!record) throw new NotFoundException('Resignation not found.');
    if (record.employeeId === actor.id) {
      throw new ForbiddenException(
        'You cannot decide your own resignation; ask another administrator.',
      );
    }
    const requester = await this.scopedPrisma.user.findFirst({
      where: { id: record.employeeId, organizationId: actor.organizationId },
      select: { role: true },
    });
    if (
      requester &&
      HR_ROLES.includes(requester.role) &&
      actor.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Only an Admin can decide an HR or Admin employee’s resignation.',
      );
    }
    if (record.status !== ResignationStatus.PENDING) {
      throw new BadRequestException(
        'Only a pending resignation can be decided.',
      );
    }
    return record;
  }

  private async afterDecision(
    employeeId: string,
    resignationId: string,
    outcome: 'APPROVED' | 'REJECTED',
    actor: Actor,
    extra: Record<string, unknown>,
  ) {
    const organizationId = actor.organizationId;
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: `RESIGNATION_${outcome}`,
      performedById: actor.id,
      metadata: { resignationId, ...extra },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: `RESIGNATION_${outcome}`,
      module: 'EMPLOYEE',
      organizationId,
      targetId: employeeId,
      details: { resignationId, ...extra },
    });
    await this.notify(
      organizationId,
      employeeId,
      `Resignation ${outcome === 'APPROVED' ? 'Approved' : 'Rejected'}`,
      outcome === 'APPROVED'
        ? `Your resignation has been approved. Your last working day is ${String(extra.approvedLwd)}.`
        : 'Your resignation request was not approved. Please speak to HR for details.',
    );
  }

  private async notify(
    organizationId: string,
    userId: string,
    title: string,
    message: string,
  ) {
    try {
      await this.notificationsService.create({
        organizationId,
        userId,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
    } catch {
      // best-effort — the resignation action itself has already succeeded
    }
  }
}
