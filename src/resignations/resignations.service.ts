// Purpose: Employee resignation requests — submit/withdraw (own), HR/Admin approve/reject, and the employee's request
// to withdraw an approved one (raised here, decided by HR/Admin).
// Responsibilities: Owns the Resignation state machine (PENDING -> APPROVED/REJECTED/WITHDRAWN); approving
// delegates the exit itself to OffboardingService.initiate() (which moves the employee to RESIGNED, the notice stage) and
// links the resulting case; timeline/audit/in-app notifications are best-effort side effects.
// Important: one open (PENDING) request per employee, only for active employees with no open offboarding
// case. Nobody decides their own resignation, and only an ADMIN decides an HR/ADMIN user's (same rule as the
// privacy module's requests). approvedLwd defaults to the last working day the employee asked for; an approver may
// move it, and a date before the notice period ends (an early release) needs a note explaining why.
import { managerIdsOf, reportsToWhere } from '../common/managers';
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
  WithdrawalRequestStatus,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { OffboardingService } from '../offboarding/offboarding.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { escapeHtml } from '../email-templates/email-layout';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';
import { DecideWithdrawalDto } from './dto/decide-withdrawal.dto';
import { paginate, skip } from '../common/pagination';
import { SubmitResignationDto } from './dto/submit-resignation.dto';
import { RecordResignationDto } from './dto/record-resignation.dto';
import {
  ApproveResignationDto,
  RejectResignationDto,
} from './dto/decide-resignation.dto';
import { ListResignationsQueryDto } from './dto/list-resignations-query.dto';
import { todayInOrgTz } from '../common/org-date';

function addDaysToDateStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Actor = Omit<User, 'password'>;

const HR_ROLES: Role[] = [Role.HR, Role.ADMIN];

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
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  private async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

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
    const submittedOn = todayInOrgTz(await this.getOrgTimezone(organizationId));
    if (dto.requestedLwd < submittedOn) {
      throw new BadRequestException('requestedLwd cannot be before today.');
    }
    // The last working day has to leave room for the notice period (the employee's own figure, else the company's
    // default), and cannot be years away.
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { policies: true },
    });
    const defaultNotice = Number(
      (org?.policies as { defaultNoticeDays?: number } | null)
        ?.defaultNoticeDays ?? 0,
    );
    // The notice period is the organization's default and is not the employee's to choose: whatever the client sent
    // is ignored. A different period (an early release, a longer one) is HR's decision when the resignation is
    // approved or recorded on the employee's behalf.
    const notice = defaultNotice;
    const earliestLwd = addDaysToDateStr(submittedOn, notice);
    if (dto.requestedLwd < earliestLwd) {
      throw new BadRequestException(
        `With a notice period of ${notice} day(s), the last working day cannot be before ${earliestLwd}.`,
      );
    }
    if (dto.requestedLwd > addDaysToDateStr(submittedOn, 365)) {
      throw new BadRequestException(
        'The last working day cannot be more than a year from today.',
      );
    }
    // One resignation at a time: a pending one, or one already approved (its offboarding is under way).
    const open = await this.scopedPrisma.resignation.findFirst({
      where: {
        organizationId,
        employeeId: actor.id,
        status: { in: [ResignationStatus.PENDING, ResignationStatus.APPROVED] },
      },
    });
    if (open) {
      throw new BadRequestException(
        open.status === ResignationStatus.APPROVED
          ? 'Your resignation has already been approved.'
          : 'You already have a pending resignation request.',
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
        noticePeriodDays: notice,
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
    await this.notifyApprovers(
      organizationId,
      employee,
      'Resignation Submitted',
      `${employee.name} has submitted a resignation (requested last working day ${dto.requestedLwd}).`,
    );
    return created;
  }

  // The people who handle a resignation: every active HR/Admin and the employee's reporting manager, never the
  // employee themself. Best-effort in-app notices.
  private async notifyApprovers(
    organizationId: string,
    employee: { id: string; reportingManagerId: string | null; additionalReportingManagerIds?: string[] | null },
    title: string,
    message: string,
  ) {
    const recipients = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        id: { not: employee.id },
        OR: [
          { role: { in: HR_ROLES } },
          ...managerIdsOf(employee).map((id) => ({ id })),
        ],
      },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) => this.notify(organizationId, r.id, title, message)),
    );
  }

  // Adds `recordedBy: { id, name } | null` - who entered a resignation on the employee's behalf.
  private async withRecordedBy<T extends { recordedById: string | null }>(
    rows: T[],
    organizationId: string,
  ): Promise<(T & { recordedBy: { id: string; name: string } | null })[]> {
    const ids = [
      ...new Set(
        rows.map((r) => r.recordedById).filter((x): x is string => !!x),
      ),
    ];
    const people = ids.length
      ? await this.scopedPrisma.user.findMany({
          where: { id: { in: ids }, organizationId },
          select: { id: true, name: true },
        })
      : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({
      ...r,
      recordedBy: r.recordedById ? (byId.get(r.recordedById) ?? null) : null,
    }));
  }

  async findMine(actor: Actor) {
    const rows = await this.scopedPrisma.resignation.findMany({
      where: { organizationId: actor.organizationId, employeeId: actor.id },
      orderBy: { createdAt: 'desc' },
    });
    return this.withRecordedBy(rows, actor.organizationId);
  }

  // Resignations of the people who report to the caller (read-only): the manager is told when one is submitted,
  // and this is where they can see it and what became of it.
  async findTeam(actor: Actor) {
    const rows = await this.scopedPrisma.resignation.findMany({
      where: {
        organizationId: actor.organizationId,
        employee: reportsToWhere(actor.id),
      },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.withRecordedBy(rows, actor.organizationId);
  }

  findAll(query: ListResignationsQueryDto, organizationId: string) {
    const where = {
      organizationId,
      ...(query.status && { status: query.status }),
    };
    return paginate(
      async () =>
        this.withRecordedBy(
          await this.scopedPrisma.resignation.findMany({
            where,
            include: {
              // role: lets the screen show that an HR/Admin person's resignation is for an Admin to decide.
              employee: {
                select: { id: true, name: true, employeeId: true, role: true },
              },
            },
            orderBy: { createdAt: 'desc' },
            skip: skip(query.page, query.limit),
            take: query.limit,
          }),
          organizationId,
        ),
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
      // A reporting manager may read (not decide) their direct report's resignation.
      const reportsToActor = await this.scopedPrisma.user.findFirst({
        where: {
          id: record.employeeId,
          organizationId: actor.organizationId,
          ...reportsToWhere(actor.id),
        },
        select: { id: true },
      });
      if (!reportsToActor)
        throw new NotFoundException('Resignation not found.');
    }
    const [row] = await this.withRecordedBy([record], actor.organizationId);
    return row;
  }

  // HR / Admin records a resignation the employee gave outside the system (by email, in person). It is the same
  // resignation as a self-submitted one - it appears in the Resignations list, can be approved or rejected, and
  // approving it opens the offboarding case and moves the employee to Resigned - but it carries who entered it
  // (recordedById) so it is clear it was entered on their behalf, and the date it was actually received.
  async recordOnBehalf(dto: RecordResignationDto, actor: Actor) {
    const organizationId = actor.organizationId;
    if (dto.employeeId === actor.id) {
      throw new BadRequestException(
        'Submit your own resignation from My Resignation; it cannot be recorded on your own behalf.',
      );
    }
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (!employee.isActive) {
      throw new BadRequestException(
        'A resignation can only be recorded for an active employee.',
      );
    }
    // Same tier rule as deciding one: only an Admin handles an HR or Admin employee's resignation.
    if (HR_ROLES.includes(employee.role) && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'Only an Admin can record a resignation for an HR or Admin employee.',
      );
    }

    const timezone = await this.getOrgTimezone(organizationId);
    const today = todayInOrgTz(timezone);
    const receivedOn = dto.receivedOn ?? today;
    if (receivedOn > today) {
      throw new BadRequestException(
        'The date received cannot be in the future.',
      );
    }
    const joined = employee.joiningDate.toISOString().slice(0, 10);
    if (receivedOn < joined) {
      throw new BadRequestException(
        `The date received cannot be before the joining date (${joined}).`,
      );
    }
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { policies: true },
    });
    const defaultNotice = Number(
      (org?.policies as { defaultNoticeDays?: number } | null)
        ?.defaultNoticeDays ?? 0,
    );
    const notice =
      dto.noticePeriodDays ?? (defaultNotice > 0 ? defaultNotice : 0);
    const earliestLwd = addDaysToDateStr(receivedOn, notice);
    if (dto.requestedLwd < today) {
      throw new BadRequestException(
        'The last working day cannot be in the past.',
      );
    }
    if (dto.requestedLwd < earliestLwd) {
      throw new BadRequestException(
        `With a notice period of ${notice} day(s) from ${receivedOn}, the last working day cannot be before ${earliestLwd}.`,
      );
    }
    if (dto.requestedLwd > addDaysToDateStr(receivedOn, 365)) {
      throw new BadRequestException(
        'The last working day cannot be more than a year after the date received.',
      );
    }

    const open = await this.scopedPrisma.resignation.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        status: { in: [ResignationStatus.PENDING, ResignationStatus.APPROVED] },
      },
    });
    if (open) {
      throw new BadRequestException(
        open.status === ResignationStatus.APPROVED
          ? 'This employee already has an approved resignation.'
          : 'This employee already has a pending resignation request.',
      );
    }
    const openCase = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        status: {
          in: [OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS],
        },
      },
    });
    if (openCase) {
      throw new BadRequestException(
        'An offboarding process is already in progress for this employee.',
      );
    }

    const created = await this.scopedPrisma.resignation.create({
      data: {
        organizationId,
        employeeId: dto.employeeId,
        submittedOn: receivedOn,
        requestedLwd: dto.requestedLwd,
        noticePeriodDays: dto.noticePeriodDays,
        reason: dto.reason,
        recordedById: actor.id,
      },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'RESIGNATION_RECORDED_ON_BEHALF',
      module: 'EMPLOYEE',
      organizationId,
      targetId: dto.employeeId,
      details: {
        resignationId: created.id,
        receivedOn,
        requestedLwd: dto.requestedLwd,
        approveNow: !!dto.approveNow,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: dto.employeeId,
      eventKey: 'RESIGNATION_SUBMITTED',
      performedById: actor.id,
      description: `Recorded by ${actor.name} on the employee's behalf (received ${receivedOn}).${dto.reason ? ` ${dto.reason}` : ''}`,
      metadata: {
        resignationId: created.id,
        requestedLwd: dto.requestedLwd,
        recordedById: actor.id,
      },
    });
    // The employee is told it was entered for them; the reporting manager and every other HR/Admin hear of it as
    // with a self-submitted one (never the person who entered it).
    await this.notify(
      organizationId,
      dto.employeeId,
      'Resignation recorded',
      `${actor.name} recorded your resignation (received ${receivedOn}, requested last working day ${dto.requestedLwd}).`,
    );
    const recipients = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        id: { notIn: [actor.id, dto.employeeId] },
        OR: [
          { role: { in: HR_ROLES } },
          ...managerIdsOf(employee).map((id) => ({ id })),
        ],
      },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) =>
        this.notify(
          organizationId,
          r.id,
          'Resignation Recorded',
          `A resignation was recorded for ${employee.name} by ${actor.name} (requested last working day ${dto.requestedLwd}).`,
        ),
      ),
    );

    // Recorded as already approved: the same decision flow as a normal approval - the offboarding case opens and the
    // employee moves to Resigned. If that is refused (an approved leave runs past the date, say) the resignation
    // stays Pending and the reason comes back, instead of failing a record that was saved.
    let approvalError: string | null = null;
    if (dto.approveNow) {
      try {
        await this.approve(
          created.id,
          {
            approvedLwd: dto.requestedLwd,
            noticePeriodDays: dto.noticePeriodDays,
            decisionNote:
              'Recorded and approved by HR on the employee’s behalf.',
          },
          actor,
        );
      } catch (err) {
        approvalError =
          err instanceof Error ? err.message : 'It could not be approved.';
      }
    }
    const [row] = await this.withRecordedBy(
      [
        await this.scopedPrisma.resignation.findFirstOrThrow({
          where: { id: created.id, organizationId },
        }),
      ],
      organizationId,
    );
    return { ...row, approvalError };
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
    // HR/Admin and the manager would otherwise keep an approval open for a request that no longer exists.
    await this.notifyApprovers(
      organizationId,
      actor,
      'Resignation Withdrawn',
      `${actor.name} has withdrawn their resignation.`,
    );
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

  // Once approved, the employee cannot withdraw it themselves (the offboarding case is HR's to cancel). They can ask:
  // this tells HR/Admin and the manager, with the reason, and leaves a trace on the audit trail and the timeline.
  async requestWithdrawal(id: string, dto: RequestWithdrawalDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.scopedPrisma.resignation.findFirst({
      where: { id, organizationId, employeeId: actor.id },
    });
    if (!record) throw new NotFoundException('Resignation not found.');
    if (record.status !== ResignationStatus.APPROVED) {
      throw new BadRequestException(
        record.status === ResignationStatus.PENDING
          ? 'This resignation is still pending - you can withdraw it yourself.'
          : 'Only an approved resignation needs a withdrawal request.',
      );
    }
    if (record.withdrawalStatus === WithdrawalRequestStatus.REQUESTED) {
      throw new ConflictException(
        'Your withdrawal request is already with HR. They will answer it here.',
      );
    }
    // The request is kept on the resignation so it shows as waiting (and HR can act on it); a declined one can be
    // raised again. The status check in the where makes a double tap a no-op rather than a second request.
    const { count } = await this.scopedPrisma.resignation.updateMany({
      where: {
        id,
        organizationId,
        employeeId: actor.id,
        status: ResignationStatus.APPROVED,
        OR: [
          { withdrawalStatus: null },
          { withdrawalStatus: { not: WithdrawalRequestStatus.REQUESTED } },
        ],
      },
      data: {
        withdrawalStatus: WithdrawalRequestStatus.REQUESTED,
        withdrawalReason: dto.reason,
        withdrawalRequestedAt: new Date(),
        withdrawalDecidedById: null,
        withdrawalDecidedAt: null,
        withdrawalDecisionNote: null,
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'Your withdrawal request is already with HR. They will answer it here.',
      );
    }
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      select: { id: true, name: true, reportingManagerId: true, additionalReportingManagerIds: true },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'RESIGNATION_WITHDRAWAL_REQUESTED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: actor.id,
      details: { resignationId: id, reason: dto.reason },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'RESIGNATION_WITHDRAWAL_REQUESTED',
      performedById: actor.id,
      description: dto.reason,
      metadata: { resignationId: id },
    });
    await this.notifyApprovers(
      organizationId,
      employee ?? { id: actor.id, reportingManagerId: null },
      'Resignation Withdrawal Requested',
      `${actor.name} has asked to withdraw their approved resignation: ${dto.reason}`,
    );
    // `message` keeps the success toast the clients already show for this call.
    return {
      ...(await this.scopedPrisma.resignation.findFirstOrThrow({
        where: { id, organizationId },
      })),
      message: 'Your request was sent to HR.',
    };
  }

  // HR / Admin answers a withdrawal request. Approving cancels the exit (the same cancel HR can do from Offboarding,
  // which also withdraws this resignation and restores the employee's previous status); if that cannot be done - e.g. a
  // processed settlement has to be reversed first - the error is returned and the request stays open. Declining
  // needs a note, which the employee sees. Same tier rule as every resignation decision.
  async decideWithdrawal(id: string, dto: DecideWithdrawalDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.loadForDecision(
      id,
      actor,
      ResignationStatus.APPROVED,
    );
    if (record.withdrawalStatus !== WithdrawalRequestStatus.REQUESTED) {
      throw new BadRequestException(
        'There is no withdrawal request waiting for a decision on this resignation.',
      );
    }
    const note = dto.note?.trim() || undefined;
    const approve = dto.decision === 'APPROVE';
    if (!approve && !note) {
      throw new BadRequestException(
        'Add a note explaining why the withdrawal is declined - the employee will see it.',
      );
    }

    if (approve) {
      if (record.offboardingCaseId) {
        // Throws when the exit cannot be cancelled (completed, or its settlement is processed / paid).
        await this.offboardingService.cancel(
          record.offboardingCaseId,
          organizationId,
          actor.id,
        );
      } else {
        await this.scopedPrisma.resignation.updateMany({
          where: { id, organizationId, status: ResignationStatus.APPROVED },
          data: {
            status: ResignationStatus.WITHDRAWN,
            decisionNote: 'Withdrawal approved.',
          },
        });
      }
    }
    const { count } = await this.scopedPrisma.resignation.updateMany({
      where: {
        id,
        organizationId,
        withdrawalStatus: WithdrawalRequestStatus.REQUESTED,
      },
      data: {
        withdrawalStatus: approve
          ? WithdrawalRequestStatus.APPROVED
          : WithdrawalRequestStatus.DECLINED,
        withdrawalDecidedById: actor.id,
        withdrawalDecidedAt: new Date(),
        withdrawalDecisionNote: note ?? null,
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This withdrawal request was already decided.',
      );
    }

    const outcome = approve ? 'APPROVED' : 'DECLINED';
    await this.timelineService.logEvent({
      organizationId,
      employeeId: record.employeeId,
      eventKey: `RESIGNATION_WITHDRAWAL_${outcome}`,
      performedById: actor.id,
      description: note,
      metadata: { resignationId: id },
    });
    await this.auditLogService.logSelfApproval(actor, {
      module: 'EMPLOYEE',
      targetId: id,
      employeeId: record.employeeId,
      request: 'Resignation withdrawal',
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: `RESIGNATION_WITHDRAWAL_${outcome}`,
      module: 'EMPLOYEE',
      organizationId,
      targetId: record.employeeId,
      details: { resignationId: id, note },
    });
    await this.notify(
      organizationId,
      record.employeeId,
      approve ? 'Withdrawal Approved' : 'Withdrawal Declined',
      approve
        ? 'HR approved your request: your resignation is withdrawn and your exit is cancelled.'
        : `HR declined your request to withdraw your resignation: ${note}`,
    );
    return this.scopedPrisma.resignation.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async approve(id: string, dto: ApproveResignationDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const record = await this.loadForDecision(id, actor);

    const noticePeriodDays = dto.noticePeriodDays ?? record.noticePeriodDays;
    // The date the employee asked for, unless the approver moves it.
    const approvedLwd = dto.approvedLwd ?? record.requestedLwd;
    // Releasing someone before their notice period ends is allowed, but it is a deliberate exception: it needs a
    // note, and it is recorded on the audit trail.
    const noticeEndsOn = addDays(record.submittedOn, noticePeriodDays ?? 0);
    const earlyRelease = approvedLwd < noticeEndsOn;
    if (earlyRelease && !dto.decisionNote?.trim()) {
      throw new BadRequestException(
        `This is before the notice period ends (${noticeEndsOn}); add a note explaining the early release.`,
      );
    }

    // The approved date has to be a real working window: not before the resignation was given, not before the
    // person joined, not more than a year ahead.
    const joined = (
      await this.scopedPrisma.user.findFirst({
        where: { id: record.employeeId, organizationId },
        select: { joiningDate: true },
      })
    )?.joiningDate
      .toISOString()
      .slice(0, 10);
    if (approvedLwd < record.submittedOn) {
      throw new BadRequestException(
        `The approved last working day cannot be before the resignation was submitted (${record.submittedOn}).`,
      );
    }
    if (joined && approvedLwd < joined) {
      throw new BadRequestException(
        `The approved last working day cannot be before the joining date (${joined}).`,
      );
    }
    if (approvedLwd > addDays(record.submittedOn, 365)) {
      throw new BadRequestException(
        'The approved last working day cannot be more than a year after the resignation was submitted.',
      );
    }

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
          exitStatus: 'RELEASED',
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
          // Put back what the request carried before this attempt (the approver's override is not kept).
          noticePeriodDays: record.noticePeriodDays,
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
      ...(earlyRelease ? { earlyRelease: true, noticeEndsOn } : {}),
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
  private async loadForDecision(
    id: string,
    actor: Actor,
    expectedStatus: ResignationStatus = ResignationStatus.PENDING,
  ) {
    const record = await this.scopedPrisma.resignation.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!record) throw new NotFoundException('Resignation not found.');
    // Only an Admin may decide their own (HR and everyone else need someone else); it is audited as SELF_APPROVAL.
    if (record.employeeId === actor.id && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'You cannot decide your own resignation; ask an Admin.',
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
    if (record.status !== expectedStatus) {
      throw new BadRequestException(
        expectedStatus === ResignationStatus.PENDING
          ? 'Only a pending resignation can be decided.'
          : 'Only an approved resignation has a withdrawal request.',
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
    await this.auditLogService.logSelfApproval(actor, {
      module: 'EMPLOYEE',
      targetId: resignationId,
      employeeId,
      request: 'Resignation',
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
    // Also by email: an in-app notice alone is easy to miss for a decision this important. Best-effort.
    try {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: { name: true, email: true },
      });
      if (employee?.email) {
        const approved = outcome === 'APPROVED';
        const company = (
          await this.scopedPrisma.organization.findFirst({
            where: { id: organizationId },
            select: { companyName: true },
          })
        )?.companyName;
        // Through the shared email shell (organization header and footer, styled body).
        const rendered = await this.emailTemplatesService.renderOccasion(
          organizationId,
          'RESIGNATION_DECISION',
          { employeeName: employee.name, companyName: company ?? '' },
          {
            subject: `Your resignation has been ${approved ? 'approved' : 'declined'}`,
            html: `<p>Hi ${escapeHtml(employee.name)},</p><p>${
              approved
                ? `Your resignation has been approved. Your last working day is <strong>${escapeHtml(String(extra.approvedLwd))}</strong>.`
                : 'Your resignation request was not approved. Please speak to HR for details.'
            }</p>`,
          },
        );
        await this.emailService.send({
          organizationId,
          to: employee.email,
          subject: rendered.subject,
          html: rendered.html,
        });
      }
    } catch {
      // best-effort — the decision itself has already been saved
    }
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
