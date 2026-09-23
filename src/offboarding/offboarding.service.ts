// Purpose: Manages the employee exit workflow — initiate (moves the employee to NOTICE_PERIOD), checklist,
// exit interview, settlement linking, completion (deactivates the account and sets the final exit status),
// and cancellation (restores the previous status).
// Responsibilities: Owns the OffboardingCase state machine (INITIATED -> IN_PROGRESS -> COMPLETED/CANCELLED)
// and its completion gate; delegates audit/timeline logging and notification/email delivery to their
// respective services.
// Important: complete() requires assetsReturned, accessRevoked, exitInterviewDone, and a linked settlement
// all present before it will deactivate the account — the deactivation, final employmentStatus (+ status
// history row), refresh-token revocation and case-completion write happen in one transaction so the account
// is never left active with a "completed" case, or vice versa. assetsReturned/complete() are blocked while
// the employee still holds ALLOCATED assets unless HR records an explicit assetOverrideNote.
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetStatus,
  EmploymentStatus,
  LeaveStatus,
  NotificationCategory,
  OffboardingStatus,
  Prisma,
  SettlementStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { InitiateOffboardingDto } from './dto/initiate-offboarding.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { SubmitExitInterviewDto } from './dto/submit-exit-interview.dto';
import { LinkSettlementDto } from './dto/link-settlement.dto';
import { CompleteOffboardingDto } from './dto/complete-offboarding.dto';
import { reassignDirectReportsBeforeDeactivation } from '../common/manager-reassignment';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { ListOffboardingQueryDto } from './dto/list-offboarding-query.dto';
import { paginate, skip } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import {
  formatDateDisplay,
  resolveOrgDateTimeFormat,
} from '../payroll/format-date';

type Actor = Omit<User, 'password'>;

const OPEN_STATUSES: OffboardingStatus[] = [
  OffboardingStatus.INITIATED,
  OffboardingStatus.IN_PROGRESS,
];
const CLOSED_STATUSES: OffboardingStatus[] = [
  OffboardingStatus.COMPLETED,
  OffboardingStatus.CANCELLED,
];

@Injectable()
export class OffboardingService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async findAll(query: ListOffboardingQueryDto, organizationId: string) {
    const where: Prisma.OffboardingCaseWhereInput = { organizationId };
    return paginate(
      () =>
        this.scopedPrisma.offboardingCase.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            settlement: true,
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { createdAt: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.offboardingCase.count({ where }),
      query.page,
      query.limit,
    );
  }

  async findOne(id: string, organizationId: string) {
    const record = await this.findCase(id, organizationId);
    return {
      ...record,
      openAssets: await this.findOpenAssets(record.employeeId, organizationId),
    };
  }

  private async findCase(id: string, organizationId: string) {
    const record = await this.scopedPrisma.offboardingCase.findFirst({
      where: { id, organizationId },
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        settlement: true,
      },
    });
    if (!record) throw new NotFoundException('Offboarding case not found.');
    return record;
  }

  // Company assets still allocated (not returned/lost, not soft-deleted) to the employee.
  private findOpenAssets(employeeId: string, organizationId: string) {
    return this.scopedPrisma.employeeAsset.findMany({
      where: {
        organizationId,
        employeeId,
        isActive: true,
        status: AssetStatus.ALLOCATED,
      },
      select: { id: true, assetType: true, assetName: true, assetTag: true },
    });
  }

  private async assertNoOpenAssets(employeeId: string, organizationId: string) {
    const open = await this.findOpenAssets(employeeId, organizationId);
    if (open.length > 0) {
      const list = open
        .map((a) => `${a.assetName}${a.assetTag ? ` (${a.assetTag})` : ''}`)
        .join(', ');
      throw new BadRequestException(
        `Cannot mark assets as returned — ${open.length} asset(s) still allocated: ${list}. Mark them returned first, or record an assetOverrideNote.`,
      );
    }
  }

  async initiate(
    dto: InitiateOffboardingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const existing = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        employeeId: dto.employeeId,
        organizationId,
        status: { in: OPEN_STATUSES },
      },
    });
    if (existing) {
      throw new BadRequestException(
        'An offboarding case is already in progress for this employee.',
      );
    }

    // An APPROVED leave already reserved this employee's future dates
    // (attendance/payroll already account for it) — initiating an exit
    // with a lastWorkingDay that falls inside it silently orphans the
    // tail end of that leave with no warning. Blocked rather than
    // allowed-silently or auto-adjusted: HR should either pick a
    // lastWorkingDay after the leave ends, or cancel/shorten the leave
    // first, both explicit decisions this service shouldn't make for them.
    const overlappingLeave = await this.scopedPrisma.leave.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        status: LeaveStatus.APPROVED,
        endDate: { gt: dto.lastWorkingDay },
      },
    });
    if (overlappingLeave) {
      throw new BadRequestException(
        `This employee has an approved leave (${overlappingLeave.startDate} to ${overlappingLeave.endDate}) extending past the chosen last working day. Adjust the last working day, or cancel/shorten the leave first.`,
      );
    }

    // The employee enters NOTICE_PERIOD (with a status-history row) in the same transaction as the case;
    // the prior status is remembered on the case so cancel() can restore it.
    const alreadyInNotice =
      employee.employmentStatus === EmploymentStatus.NOTICE_PERIOD;
    const offboardingCase = await this.scopedPrisma.$transaction(async (tx) => {
      const created = await tx.offboardingCase.create({
        data: {
          organizationId,
          employeeId: dto.employeeId,
          initiatedById: actor.id,
          lastWorkingDay: dto.lastWorkingDay,
          reason: dto.reason,
          exitStatus: dto.exitStatus ?? EmploymentStatus.RELEASED,
          previousEmploymentStatus: employee.employmentStatus,
        },
      });
      if (!alreadyInNotice) {
        await tx.user.updateMany({
          where: { id: dto.employeeId, organizationId },
          data: { employmentStatus: EmploymentStatus.NOTICE_PERIOD },
        });
        await tx.employmentStatusHistory.create({
          data: {
            organizationId,
            employeeId: dto.employeeId,
            previousStatus: employee.employmentStatus,
            newStatus: EmploymentStatus.NOTICE_PERIOD,
            note: 'Offboarding initiated',
            changedById: actor.id,
          },
        });
      }
      return created;
    });

    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = 'Offboarding Process Initiated';
    const message = `Your offboarding has been initiated with a last working day of ${formatDateDisplay(dto.lastWorkingDay, '', dateFormat)}. HR will reach out with the exit checklist.`;
    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.GENERAL,
    });
    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'OFFBOARDING_INITIATED',
      {
        employeeName: employee.name,
        lastWorkingDay: formatDateDisplay(dto.lastWorkingDay, '', dateFormat),
      },
      { subject: title, html: message },
    );
    await this.emailService.send({
      organizationId,
      to: employee.email,
      subject: rendered.subject,
      html: rendered.html,
    });
    // NOTICE_PERIOD_STARTED — same "log next to the notification" pattern
    // used elsewhere in this file (see complete()'s RELIEVED event); the
    // EXIT category on the timeline was otherwise silent until completion.
    await this.timelineService.logEvent({
      organizationId,
      employeeId: employee.id,
      eventKey: 'NOTICE_PERIOD_STARTED',
      performedById: actor.id,
      description: dto.reason ?? '',
    });

    return offboardingCase;
  }

  async updateChecklist(
    id: string,
    dto: UpdateChecklistDto,
    organizationId: string,
  ) {
    const record = await this.assertOpenCase(id, organizationId);

    const data: Prisma.OffboardingCaseUpdateManyMutationInput = {};
    if (dto.assetOverrideNote !== undefined)
      data.assetOverrideNote = dto.assetOverrideNote.trim() || null;
    if (dto.assetsReturned === true && !dto.assetOverrideNote?.trim()) {
      await this.assertNoOpenAssets(record.employeeId, organizationId);
    }
    if (dto.assetsReturned !== undefined)
      data.assetsReturned = dto.assetsReturned;
    if (dto.accessRevoked !== undefined) data.accessRevoked = dto.accessRevoked;
    if (record.status === OffboardingStatus.INITIATED) {
      data.status = OffboardingStatus.IN_PROGRESS;
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data,
    });
    return this.findOne(id, organizationId);
  }

  // Basic exit-interview questionnaire — captured once per case, then
  // effectively locked (re-submitting overwrites, same as any other
  // checklist correction — there's no separate "edit" endpoint since HR can
  // just call this again).
  async submitExitInterview(
    id: string,
    dto: SubmitExitInterviewDto,
    actor: Actor,
    organizationId: string,
  ) {
    const record = await this.assertOpenCase(id, organizationId);

    const data: Prisma.OffboardingCaseUpdateManyMutationInput = {
      exitInterviewResponses: {
        reasonForLeaving: dto.reasonForLeaving,
        overallExperience: dto.overallExperience,
        wouldRecommend: !!dto.wouldRecommend,
        likedMost: dto.likedMost ?? '',
        improvementAreas: dto.improvementAreas ?? '',
        additionalComments: dto.additionalComments ?? '',
      } satisfies Prisma.InputJsonValue,
      exitInterviewDone: true,
    };
    if (record.status === OffboardingStatus.INITIATED) {
      data.status = OffboardingStatus.IN_PROGRESS;
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data,
    });
    // EXIT_INTERVIEW_COMPLETED — same pairing convention as complete()'s
    // RELIEVED event; previously this step left no timeline trace at all.
    await this.timelineService.logEvent({
      organizationId,
      employeeId: record.employeeId,
      eventKey: 'EXIT_INTERVIEW_COMPLETED',
      performedById: actor.id,
    });
    return this.findOne(id, organizationId);
  }

  async linkSettlement(
    id: string,
    dto: LinkSettlementDto,
    organizationId: string,
  ) {
    const record = await this.findCase(id, organizationId);
    const settlement = await this.scopedPrisma.settlement.findFirst({
      where: { id: dto.settlementId, organizationId },
    });
    if (!settlement || settlement.employeeId !== record.employeeId) {
      throw new BadRequestException('Settlement not found for this employee.');
    }

    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id, organizationId },
      data: { settlementId: dto.settlementId },
    });
    return this.findOne(id, organizationId);
  }

  // Requires the full checklist done and a *processed* settlement before an
  // exit can be finalized — mirrors the "no critical issues remain" gate
  // used elsewhere for other certification-style sign-offs. Completing it
  // deactivates the account.
  // Important: linkSettlement() only requires the settlement to exist for
  // this employee — it can still be sitting in DRAFT (never run through
  // POST /settlements/:id/process, which is what actually books the
  // PayrollRun/payslip, closes out loans, and emails the payout). Without
  // this extra check, HR could link a draft, satisfy every checklist item,
  // and complete() would happily deactivate the employee while the final
  // payout was never processed — an account gone with an orphaned DRAFT
  // settlement and no payslip behind it.
  async complete(
    id: string,
    dto: CompleteOffboardingDto,
    actor: Actor,
    organizationId: string,
  ) {
    // findOne() (via assertOpenCase) already includes the linked
    // `settlement` relation, so its current status is available here
    // without a second query.
    const record = await this.assertOpenCase(id, organizationId);

    const missing: string[] = [];
    if (!record.assetsReturned) missing.push('assetsReturned');
    else if (!record.assetOverrideNote)
      await this.assertNoOpenAssets(record.employeeId, organizationId);
    if (!record.accessRevoked) missing.push('accessRevoked');
    if (!record.exitInterviewDone) missing.push('exitInterviewDone');
    if (!record.settlementId) missing.push('settlement');
    else if (record.settlement?.status === SettlementStatus.DRAFT)
      missing.push(
        'settlement processing (still DRAFT — run POST /settlements/:id/process first)',
      );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot complete offboarding — outstanding: ${missing.join(', ')}`,
      );
    }

    // Same dangling-reportingManagerId protection as
    // EmployeesService.deactivate() — this path deactivates the account
    // too, and completing an exit shouldn't be able to leave someone
    // else's direct reports pointing at a manager who's about to be
    // relieved.
    await reassignDirectReportsBeforeDeactivation(
      {
        scopedPrisma: this.scopedPrisma,
        timelineService: this.timelineService,
        auditLogService: this.auditLogService,
      },
      record.employeeId,
      dto.reassignManagerId,
      organizationId,
      actor.id,
    );

    await this.scopedPrisma.$transaction(async (tx) => {
      await tx.offboardingCase.updateMany({
        where: { id, organizationId },
        data: {
          status: OffboardingStatus.COMPLETED,
          completedById: actor.id,
          completedAt: new Date(),
        },
      });
      // Final employment status per the case's exit type (RESIGNED/RELEASED/TERMINATED/ABSCONDED), with a
      // history row, and every session revoked — the account can no longer refresh a token after exit.
      const current = await tx.user.findFirst({
        where: { id: record.employeeId, organizationId },
        select: { employmentStatus: true },
      });
      await tx.user.updateMany({
        where: { id: record.employeeId, organizationId },
        data: { isActive: false, employmentStatus: record.exitStatus },
      });
      if (current && current.employmentStatus !== record.exitStatus) {
        await tx.employmentStatusHistory.create({
          data: {
            organizationId,
            employeeId: record.employeeId,
            previousStatus: current.employmentStatus,
            newStatus: record.exitStatus,
            note: 'Offboarding completed',
            changedById: actor.id,
          },
        });
      }
      await tx.refreshToken.updateMany({
        where: { userId: record.employeeId, organizationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYEE_DEACTIVATED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: record.employeeId,
      details: { reason: 'offboarding_completed' },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: record.employeeId,
      eventKey: 'RELIEVED',
      performedById: actor.id,
      status: 'inactive',
    });
    void this.sendExitCompletedEmail(
      record.employeeId,
      record.lastWorkingDay,
      organizationId,
    );
    return this.findOne(id, organizationId);
  }

  // Goes to the employee's PERSONAL email only — completing the exit deactivates the work account,
  // so a message to it would never be read — and is skipped entirely when no personal email is on
  // file. Best-effort: the exit has already been completed and must not fail on a mail problem.
  private async sendExitCompletedEmail(
    employeeId: string,
    lastWorkingDay: string,
    organizationId: string,
  ): Promise<void> {
    try {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: { name: true, personalData: true },
      });
      const personalData = (employee?.personalData ?? {}) as Record<
        string,
        unknown
      >;
      const personalEmail =
        typeof personalData.personalEmail === 'string'
          ? personalData.personalEmail
          : '';
      if (!employee || !personalEmail) return;
      const { dateFormat } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const variables = {
        employeeName: employee.name,
        lastWorkingDay: formatDateDisplay(lastWorkingDay, '', dateFormat),
      };
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'EXIT_COMPLETED',
        variables,
        this.emailTemplatesService.defaultFor('EXIT_COMPLETED', variables),
      );
      await this.emailService.send({
        organizationId,
        to: personalEmail,
        subject: rendered.subject,
        html: rendered.html,
      });
    } catch {
      // best-effort notice
    }
  }

  async cancel(id: string, organizationId: string, actorId?: string) {
    const record = await this.findCase(id, organizationId);
    if (record.status === OffboardingStatus.COMPLETED) {
      throw new BadRequestException(
        'A completed offboarding case cannot be cancelled.',
      );
    }

    await this.scopedPrisma.$transaction(async (tx) => {
      const { count } = await tx.offboardingCase.updateMany({
        where: {
          id,
          organizationId,
          status: { in: [...OPEN_STATUSES, OffboardingStatus.CANCELLED] },
        },
        data: { status: OffboardingStatus.CANCELLED },
      });
      // Restore the pre-notice status only on the first cancel of an open case, and only if the
      // employee is still in NOTICE_PERIOD (HR may have changed it manually since).
      const wasOpen = OPEN_STATUSES.includes(record.status);
      if (count > 0 && wasOpen && record.previousEmploymentStatus) {
        const restored = await tx.user.updateMany({
          where: {
            id: record.employeeId,
            organizationId,
            employmentStatus: EmploymentStatus.NOTICE_PERIOD,
          },
          data: { employmentStatus: record.previousEmploymentStatus },
        });
        if (
          restored.count > 0 &&
          record.previousEmploymentStatus !== EmploymentStatus.NOTICE_PERIOD
        ) {
          await tx.employmentStatusHistory.create({
            data: {
              organizationId,
              employeeId: record.employeeId,
              previousStatus: EmploymentStatus.NOTICE_PERIOD,
              newStatus: record.previousEmploymentStatus,
              note: 'Offboarding cancelled',
              changedById: actorId ?? record.initiatedById,
            },
          });
        }
      }
    });
    return this.findOne(id, organizationId);
  }

  private async assertOpenCase(id: string, organizationId: string) {
    const record = await this.findCase(id, organizationId);
    if (CLOSED_STATUSES.includes(record.status)) {
      throw new BadRequestException('This offboarding case is already closed.');
    }
    return record;
  }
}
