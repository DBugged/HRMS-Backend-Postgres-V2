// Purpose: Manages the employee exit workflow — initiate (moves the employee to RESIGNED, the notice stage), checklist,
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
  PERSONAL_EMAIL_REQUIRED_MESSAGE,
  personalEmailOf,
} from '../common/personal-email';
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
  OrgListType,
  Prisma,
  ResignationStatus,
  SettlementStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { InitiateOffboardingDto } from './dto/initiate-offboarding.dto';
import { UpdateChecklistDto } from './dto/update-checklist.dto';
import { SubmitExitInterviewDto } from './dto/submit-exit-interview.dto';
import { LinkSettlementDto } from './dto/link-settlement.dto';
import { UpdateLastWorkingDayDto } from './dto/update-last-working-day.dto';
import { todayInOrgTz } from '../common/org-date';
import { isCleanDraft } from '../settlements/settlement-clean';
import { markPayrollInputsChanged, monthsBetween } from '../payroll/payroll-period-guard';
import { CompleteOffboardingDto } from './dto/complete-offboarding.dto';
import { reassignDirectReportsBeforeDeactivation } from '../common/manager-reassignment';
import { assertAccountCanLeave } from '../common/account-guard';
import { reportsToWhere, managerIdsOf } from '../common/managers';
import { LettersService } from '../letters/letters.service';
import { UpdateChecklistOwnerDto } from './dto/update-checklist-owner.dto';
import {
  CHECKLIST_ITEM_KEYS,
  CHECKLIST_ITEM_LABELS,
  defaultChecklistMeta,
  defaultDueDate,
  isOverdue,
  itemsDone,
  readExitAutomation,
  readyToComplete,
  waitingFor,
  type CaseState,
  type ChecklistItemKey,
  type ChecklistMeta,
} from './offboarding-checklist';
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
  dmyText,
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
    private readonly lettersService: LettersService,
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

  // After a leaver's team is moved, the new manager is told how many of those people's requests are waiting for a decision,
  // so nothing sits unnoticed with a manager who has gone. Best-effort: the exit must not fail on a notice.
  private async tellNewManagerOfPending(leaverId: string, newManagerId: string | undefined, organizationId: string) {
    if (!newManagerId) return;
    try {
      const reports = await this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, ...reportsToWhere(newManagerId) },
        select: { id: true },
      });
      const ids = reports.map((r) => r.id);
      if (ids.length === 0) return;
      const [leaves, loans] = await Promise.all([
        this.scopedPrisma.leave.count({ where: { organizationId, employeeId: { in: ids }, status: 'PENDING' } }),
        this.scopedPrisma.loan.count({ where: { organizationId, employeeId: { in: ids }, status: 'PENDING' } }),
      ]);
      if (leaves + loans === 0) return;
      const leaver = await this.scopedPrisma.user.findFirst({ where: { id: leaverId, organizationId }, select: { name: true } });
      await this.notifyOnce(
        organizationId,
        [newManagerId],
        `Team taken over from ${leaver?.name ?? 'a leaver'}: requests waiting`,
        `Your team now includes people who reported to ${leaver?.name ?? 'the manager who left'}. ${leaves} leave request(s) and ${loans} loan request(s) from your team are waiting for a decision.`,
      );
    } catch {
      // best-effort notice
    }
  }

  // The exit tracker for HR: every open exit with days left, each checklist item's owner and due date, what it is waiting for,
  // and the state of the final settlement - overdue exits first, then the ones leaving soonest.
  async overview(organizationId: string) {
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const cases = await this.scopedPrisma.offboardingCase.findMany({
      where: { organizationId, status: { in: OPEN_STATUSES } },
      include: { employee: { select: { id: true, name: true, employeeId: true } }, settlement: true },
    });
    const rows = await Promise.all(
      cases.map(async (c) => {
        const view = await this.buildView(c as never, organizationId);
        const dayNo = (ymd: string) => Math.round(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / 86400000);
        const overdueItems = view.checklist.filter((i) => i.overdue);
        return {
          id: c.id,
          employee: c.employee,
          lastWorkingDay: c.lastWorkingDay,
          // Negative once the last working day has passed.
          daysLeft: dayNo(c.lastWorkingDay) - dayNo(today),
          checklist: view.checklist,
          overdueCount: overdueItems.length,
          waitingFor: view.waitingFor,
          readyToComplete: view.readyToComplete,
          settlementStage: !c.settlement ? 'NOT_STARTED' : c.settlement.status,
          cleanDraft: !!c.settlement && isCleanDraft(c.settlement),
          pendingClearedAt: c.pendingClearedAt,
          exitPackSentAt: c.exitPackSentAt,
        };
      }),
    );
    rows.sort((a, b) => b.overdueCount - a.overdueCount || a.daysLeft - b.daysLeft);
    return {
      today,
      summary: {
        open: rows.length,
        withOverdueItems: rows.filter((r) => r.overdueCount > 0).length,
        pastLastWorkingDay: rows.filter((r) => r.daysLeft < 0).length,
        readyToComplete: rows.filter((r) => r.readyToComplete).length,
        cleanDrafts: rows.filter((r) => r.cleanDraft).length,
      },
      cases: rows,
    };
  }

  // The employee's own exit progress, for the mobile/web "Exit status" card. Deliberately narrow: the last working
  // day, the checklist ticks, a coarse settlement stage and where their documents will go - never the settlement
  // figures, the reason, HR's notes or the exit interview answers. null when they have no exit under way.
  async findMine(actor: Actor) {
    const record = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        organizationId: actor.organizationId,
        employeeId: actor.id,
        status: { in: [...OPEN_STATUSES, OffboardingStatus.COMPLETED] },
      },
      orderBy: { createdAt: 'desc' },
      include: { settlement: { select: { status: true } } },
    });
    if (!record) return null;
    const settlementStage = !record.settlement
      ? 'NOT_STARTED'
      : record.settlement.status === SettlementStatus.PAID
        ? 'PAID'
        : record.settlement.status === SettlementStatus.PROCESSED
          ? 'PROCESSED'
          : 'BEING_PREPARED';
    const interviewRequired =
      record.exitStatus !== EmploymentStatus.TERMINATED &&
      record.exitStatus !== EmploymentStatus.ABSCONDED;
    // The choices for the exit interview form, offered only while it is still to be filled.
    const reasonsForLeaving =
      interviewRequired && !record.exitInterviewDone && record.status !== OffboardingStatus.COMPLETED
        ? (
            await this.scopedPrisma.orgListItem.findMany({
              where: { organizationId: actor.organizationId, type: OrgListType.REASON_FOR_LEAVING, isActive: true },
              orderBy: { name: 'asc' },
              select: { name: true },
            })
          ).map((r) => r.name)
        : [];
    return {
      status: record.status,
      lastWorkingDay: record.lastWorkingDay,
      reasonsForLeaving,
      // Sign-in ends the day after the last working day; the last payslips are then emailed to the personal address.
      assetsReturned: record.assetsReturned,
      accessRevoked: record.accessRevoked,
      interviewRequired,
      exitInterviewDone: record.exitInterviewDone,
      settlementStage,
      // Whether the relieving / experience letters have been emailed (on completion, for resignations and releases).
      lettersSent: !!record.lettersSentAt,
      documentsGoToPersonalEmail: personalEmailOf(actor.personalData) !== null,
    };
  }

  async findOne(id: string, organizationId: string) {
    // Bringing the case up to date first ticks what the system can tick by itself and flags it ready to complete.
    await this.reconcile(id, organizationId).catch(() => undefined);
    const record = await this.findCase(id, organizationId);
    const [openAssets, view] = await Promise.all([
      this.findOpenAssets(record.employeeId, organizationId),
      this.buildView(record, organizationId),
    ]);
    return { ...record, openAssets, ...view };
  }

  // The checklist as the screen reads it: each item with its owner, due date and whether the system ticked it, plus whether the
  // team is handed over, whether the case is ready to complete, and what it is still waiting for.
  private async buildView(record: Awaited<ReturnType<OffboardingService['findCase']>>, organizationId: string) {
    const [state, org] = await Promise.all([
      this.caseState(record, organizationId),
      this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true, policies: true } }),
    ]);
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const meta = (record.checklistMeta ?? {}) as ChecklistMeta;
    const auto = (record.autoTicked ?? {}) as Partial<Record<ChecklistItemKey, boolean>>;
    const ownerIds = [...new Set(CHECKLIST_ITEM_KEYS.map((k) => meta[k]?.ownerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length
      ? await this.scopedPrisma.user.findMany({ where: { id: { in: ownerIds }, organizationId }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(owners.map((o) => [o.id, o.name]));
    const done = itemsDone(state.state);
    return {
      checklist: CHECKLIST_ITEM_KEYS.map((key) => ({
        key,
        label: CHECKLIST_ITEM_LABELS[key],
        done: done[key],
        // Not asked for at all (a termination has no exit interview).
        notNeeded: key === 'interview' && !state.state.interviewNeeded,
        autoTicked: !!auto[key] && done[key],
        ownerId: meta[key]?.ownerId ?? null,
        ownerName: meta[key]?.ownerId ? (nameOf.get(meta[key]!.ownerId!) ?? null) : null,
        dueDate: meta[key]?.dueDate ?? null,
        overdue: isOverdue(meta[key]?.dueDate, today, done[key]),
      })),
      teamHandedOver: state.state.teamHandedOver,
      activeReportsCount: state.activeReportsCount,
      settlementPaid: state.state.settlementPaid,
      readyToComplete: readyToComplete(state.state),
      waitingFor: waitingFor(state.state),
      automation: readExitAutomation(org?.policies),
    };
  }

  // Everything the checklist rules need, read from the database for one case.
  private async caseState(record: Awaited<ReturnType<OffboardingService['findCase']>>, organizationId: string) {
    const activeReportsCount = await this.scopedPrisma.user.count({
      where: { organizationId, isActive: true, id: { not: record.employeeId }, ...reportsToWhere(record.employeeId) },
    });
    const interviewNeeded = record.exitStatus !== EmploymentStatus.TERMINATED && record.exitStatus !== EmploymentStatus.ABSCONDED;
    const state: CaseState = {
      assetsReturned: record.assetsReturned,
      accessRevoked: record.accessRevoked,
      interviewNeeded,
      exitInterviewDone: record.exitInterviewDone,
      teamHandedOver: activeReportsCount === 0,
      settlementPaid: record.settlement?.status === SettlementStatus.PAID,
      settlementMatchesLastWorkingDay: !!record.settlement && record.settlement.lastWorkingDay.slice(0, 10) === record.lastWorkingDay.slice(0, 10),
    };
    return { state, activeReportsCount };
  }

  // Brings an open case up to date by itself: ticks "assets returned" once nothing is allocated, and keeps the "ready to complete"
  // marker true only while every item is done and the settlement is paid. The first time a case becomes ready, HR and Admin are
  // told (once). Returns whether it is ready and whether that just changed. A closed case is left as it is.
  async reconcile(id: string, organizationId: string): Promise<{ ready: boolean; becameReady: boolean }> {
    let record = await this.findCase(id, organizationId);
    if (CLOSED_STATUSES.includes(record.status)) return { ready: false, becameReady: false };
    if (!record.assetsReturned) {
      const open = await this.findOpenAssets(record.employeeId, organizationId);
      if (open.length === 0) {
        const auto = { ...((record.autoTicked ?? {}) as Record<string, boolean>), assets: true };
        await this.scopedPrisma.offboardingCase.updateMany({ where: { id, organizationId }, data: { assetsReturned: true, autoTicked: auto } });
        record = await this.findCase(id, organizationId);
      }
    }
    const { state } = await this.caseState(record, organizationId);
    const ready = readyToComplete(state);
    if (ready && !record.readyToCompleteAt) {
      await this.scopedPrisma.offboardingCase.updateMany({ where: { id, organizationId }, data: { readyToCompleteAt: new Date() } });
      await this.notifyHr(
        organizationId,
        [record.initiatedById],
        `Exit ready to complete: ${record.employee.name}`,
        `${record.employee.name} (${record.employee.employeeId}) has finished clearance and the final settlement is paid. Open Offboarding and confirm to close the account.`,
      );
      return { ready, becameReady: true };
    }
    if (!ready && record.readyToCompleteAt) {
      await this.scopedPrisma.offboardingCase.updateMany({ where: { id, organizationId }, data: { readyToCompleteAt: null } });
    }
    return { ready, becameReady: false };
  }

  // A notice to every active HR / Admin (and the extra people given), skipping anyone who already has this exact one in the last day.
  async notifyHr(organizationId: string, alsoIds: string[], title: string, message: string) {
    const hr = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: ['HR', 'ADMIN'] } },
      select: { id: true },
    });
    const ids = [...new Set([...hr.map((u) => u.id), ...alsoIds])];
    await this.notifyOnce(organizationId, ids, title, message);
  }

  async notifyOnce(organizationId: string, userIds: string[], title: string, message: string) {
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const already = await this.scopedPrisma.notification.findMany({
      where: { organizationId, userId: { in: userIds }, title, createdAt: { gte: since } },
      select: { userId: true },
    });
    const have = new Set(already.map((n) => n.userId));
    await this.notificationsService.createMany(
      userIds
        .filter((u) => !have.has(u))
        .map((userId) => ({ organizationId, userId, title, message, category: NotificationCategory.GENERAL })),
    );
  }

  // HR / Admin change who owns one checklist item and by when. The owner is told about it; a finished item cannot be re-assigned.
  async updateChecklistOwner(id: string, dto: UpdateChecklistOwnerDto, organizationId: string) {
    const record = await this.assertOpenCase(id, organizationId);
    const meta = { ...((record.checklistMeta ?? {}) as ChecklistMeta) };
    const current = meta[dto.item] ?? { ownerId: null, dueDate: null };
    let ownerId = current.ownerId;
    if (dto.ownerId !== undefined) {
      if (dto.ownerId === '') ownerId = null;
      else {
        const owner = await this.scopedPrisma.user.findFirst({
          where: { id: dto.ownerId, organizationId, isActive: true },
          select: { id: true, role: true },
        });
        if (!owner || owner.id === record.employeeId) throw new BadRequestException('Pick an active colleague (not the person leaving) as the owner.');
        ownerId = owner.id;
      }
    }
    const dueDate = dto.dueDate !== undefined ? dto.dueDate : current.dueDate;
    meta[dto.item] = { ownerId, dueDate };
    await this.scopedPrisma.offboardingCase.updateMany({ where: { id, organizationId }, data: { checklistMeta: meta as unknown as Prisma.InputJsonValue } });
    if (ownerId && ownerId !== current.ownerId) {
      await this.notificationsService.create({
        organizationId,
        userId: ownerId,
        title: `Exit task assigned: ${CHECKLIST_ITEM_LABELS[dto.item]}`,
        message: `${record.employee.name} (${record.employee.employeeId}) is leaving on ${dmyText(record.lastWorkingDay)}. You own "${CHECKLIST_ITEM_LABELS[dto.item]}"${dueDate ? `, due ${dmyText(dueDate)}` : ''}.`,
        category: NotificationCategory.GENERAL,
      });
    }
    return this.findOne(id, organizationId);
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
    await assertAccountCanLeave(this.scopedPrisma, dto.employeeId, organizationId);

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

    await this.assertLastWorkingDayInRange(
      dto.lastWorkingDay,
      employee.joiningDate,
      organizationId,
    );
    // A termination or an abscondment is a company decision that has to say why - it is what the record, the
    // relieving letter and any later dispute rest on. (A resignation's reason is the employee's own.)
    // Once the exit completes the company mailbox is closed; the personal address is the only way the final payslip,
    // settlement statement and tax certificate can reach them - so there has to be one before the exit starts.
    if (!personalEmailOf(employee.personalData)) {
      throw new BadRequestException(PERSONAL_EMAIL_REQUIRED_MESSAGE);
    }
    // A resignation ends as RELEASED: RESIGNED is the notice stage, not a final status (an older client may still send
    // RESIGNED as the exit type).
    const exit =
      !dto.exitStatus || dto.exitStatus === EmploymentStatus.RESIGNED
        ? EmploymentStatus.RELEASED
        : dto.exitStatus;
    if (
      (exit === EmploymentStatus.TERMINATED ||
        exit === EmploymentStatus.ABSCONDED) &&
      !dto.reason?.trim()
    ) {
      throw new BadRequestException(
        `A reason is required to record ${exit === EmploymentStatus.TERMINATED ? 'a termination' : 'an abscondment'}.`,
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
        `This employee has an approved leave (${formatDateDisplay(overlappingLeave.startDate)} to ${formatDateDisplay(overlappingLeave.endDate)}) extending past the chosen last working day. Adjust the last working day, or cancel/shorten the leave first.`,
      );
    }

    // The employee enters RESIGNED - the notice stage - (with a status-history row) in the same transaction as the
    // case; the prior status is remembered on the case so cancel() can restore it. A termination or an abscondment has
    // no notice stage: those keep their working status until complete() applies the final one.
    const entersNotice = exit === EmploymentStatus.RELEASED;
    const alreadyInNotice =
      employee.employmentStatus === EmploymentStatus.RESIGNED;
    const offboardingCase = await this.scopedPrisma.$transaction(async (tx) => {
      const created = await tx.offboardingCase.create({
        data: {
          organizationId,
          employeeId: dto.employeeId,
          initiatedById: actor.id,
          lastWorkingDay: dto.lastWorkingDay,
          reason: dto.reason,
          exitStatus: exit,
          previousEmploymentStatus: employee.employmentStatus,
        },
      });
      // Last working day drives who still shows on trackers/lists after leaving (account stays active until completion).
      await tx.user.updateMany({
        where: { id: dto.employeeId, organizationId },
        data: { exitDate: dto.lastWorkingDay },
      });
      await this.markPayrollStale(tx, organizationId, dto.employeeId, dto.lastWorkingDay);
      if (entersNotice && !alreadyInNotice) {
        await tx.user.updateMany({
          where: { id: dto.employeeId, organizationId },
          data: { employmentStatus: EmploymentStatus.RESIGNED },
        });
        await tx.employmentStatusHistory.create({
          data: {
            organizationId,
            employeeId: dto.employeeId,
            previousStatus: employee.employmentStatus,
            newStatus: EmploymentStatus.RESIGNED,
            note: 'Offboarding initiated',
            changedById: actor.id,
          },
        });
      }
      return created;
    });

    // The checklist starts with owners and due dates, so nothing waits on someone remembering to assign it.
    const orgForToday = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
    const meta = defaultChecklistMeta({
      initiatorId: actor.id,
      managerId: managerIdsOf(employee).find((m) => m !== employee.id) ?? null,
      lastWorkingDay: dto.lastWorkingDay,
      today: todayInOrgTz(orgForToday?.timezone ?? 'Asia/Kolkata'),
    });
    await this.scopedPrisma.offboardingCase.updateMany({
      where: { id: offboardingCase.id, organizationId },
      data: { checklistMeta: meta as unknown as Prisma.InputJsonValue },
    });
    // Someone who manages people needs a replacement named early, not as a blocker on the last day.
    const reportsCount = await this.scopedPrisma.user.count({
      where: { organizationId, isActive: true, id: { not: employee.id }, ...reportsToWhere(employee.id) },
    });
    if (reportsCount > 0) {
      await this.notifyOnce(
        organizationId,
        [...new Set([actor.id, ...managerIdsOf(employee)])].filter((u) => u !== employee.id),
        `Choose a new manager for ${employee.name}'s team`,
        `${employee.name} manages ${reportsCount} ${reportsCount === 1 ? 'person' : 'people'} and is leaving on ${dmyText(dto.lastWorkingDay)}. Open Offboarding and use "Reassign all" to name the replacement manager.`,
      );
    }

    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = 'Offboarding Process Initiated';
    const message = `Your offboarding has been initiated with a last working day of ${formatDateDisplay(dto.lastWorkingDay, '', dateFormat, timeZone)}. HR will reach out with the exit checklist.`;
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
        lastWorkingDay: formatDateDisplay(
          dto.lastWorkingDay,
          '',
          dateFormat,
          timeZone,
        ),
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

  // A change of last working day changes what a regular run for that month (and later ones) should pay, so any run already
  // calculated from that date on is marked out of date and has to be recalculated before it can be signed off.
  private markPayrollStale(
    tx: Prisma.TransactionClient,
    organizationId: string,
    employeeId: string,
    fromDate: string,
  ) {
    const to = new Date(`${fromDate}T00:00:00.000Z`);
    to.setUTCDate(to.getUTCDate() + 366);
    return markPayrollInputsChanged(tx, organizationId, employeeId, monthsBetween(fromDate, to.toISOString().slice(0, 10)));
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
    return this.saveExitInterview(record, dto, actor, organizationId);
  }

  // The leaver fills in their own exit interview. This ticks the checklist item itself, so HR no longer has to key it in.
  async submitMyExitInterview(dto: SubmitExitInterviewDto, actor: Actor) {
    const mine = await this.scopedPrisma.offboardingCase.findFirst({
      where: { organizationId: actor.organizationId, employeeId: actor.id, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!mine) throw new NotFoundException('You have no exit under way.');
    const record = await this.assertOpenCase(mine.id, actor.organizationId);
    if (record.exitStatus === EmploymentStatus.TERMINATED || record.exitStatus === EmploymentStatus.ABSCONDED) {
      throw new BadRequestException('An exit interview is not asked for in your case.');
    }
    await this.saveExitInterview(record, dto, actor, actor.organizationId);
    return this.findMine(actor);
  }

  private async saveExitInterview(
    record: Awaited<ReturnType<OffboardingService['assertOpenCase']>>,
    dto: SubmitExitInterviewDto,
    actor: Actor,
    organizationId: string,
  ) {
    const id = record.id;
    // Reasons are org-configurable (Organization → Reasons for Leaving).
    const reason = await this.scopedPrisma.orgListItem.findFirst({
      where: {
        organizationId,
        type: OrgListType.REASON_FOR_LEAVING,
        name: dto.reasonForLeaving,
        isActive: true,
      },
      select: { id: true },
    });
    if (!reason) {
      throw new BadRequestException(
        'Select a reason from the Reasons for Leaving list.',
      );
    }

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

  // The last working day cannot precede the joining date, nor be more than a year away.
  private async assertLastWorkingDayInRange(
    lastWorkingDay: string,
    joiningDate: Date,
    organizationId: string,
  ) {
    const joined = joiningDate.toISOString().slice(0, 10);
    if (lastWorkingDay < joined) {
      throw new BadRequestException(
        `The last working day (${dmyText(lastWorkingDay)}) cannot be before the joining date (${dmyText(joined)}).`,
      );
    }
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const limit = new Date(
      `${todayInOrgTz(org?.timezone ?? 'Asia/Kolkata')}T00:00:00.000Z`,
    );
    limit.setUTCDate(limit.getUTCDate() + 365);
    if (lastWorkingDay > limit.toISOString().slice(0, 10)) {
      throw new BadRequestException(
        'The last working day cannot be more than a year from today.',
      );
    }
  }

  // Early release or an extended notice: moves the case's last working day. A final settlement is figured for one
  // date, so a linked draft is unlinked (to be recalculated for the new date); one already processed must be
  // reversed first.
  async updateLastWorkingDay(
    id: string,
    dto: UpdateLastWorkingDayDto,
    actor: Actor,
    organizationId: string,
  ) {
    const record = await this.assertOpenCase(id, organizationId);
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: record.employeeId, organizationId },
      select: { joiningDate: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (dto.lastWorkingDay === record.lastWorkingDay) {
      throw new BadRequestException(
        'The last working day is already that date.',
      );
    }
    await this.assertLastWorkingDayInRange(
      dto.lastWorkingDay,
      employee.joiningDate,
      organizationId,
    );
    const settled = record.settlement?.status;
    if (
      settled === SettlementStatus.PROCESSED ||
      settled === SettlementStatus.PAID
    ) {
      throw new BadRequestException(
        'The final settlement is already processed for the current last working day - reverse it before changing the date.',
      );
    }
    await this.scopedPrisma.$transaction(async (tx) => {
      await tx.offboardingCase.updateMany({
        where: { id, organizationId },
        data: {
          lastWorkingDay: dto.lastWorkingDay,
          // The draft was figured for the old date: it has to be recalculated and linked again.
          ...(record.settlementId ? { settlementId: null } : {}),
        },
      });
      await tx.user.updateMany({
        where: { id: record.employeeId, organizationId },
        data: { exitDate: dto.lastWorkingDay },
      });
      await this.markPayrollStale(
        tx,
        organizationId,
        record.employeeId,
        dto.lastWorkingDay < record.lastWorkingDay ? dto.lastWorkingDay : record.lastWorkingDay,
      );
      await tx.resignation.updateMany({
        where: {
          organizationId,
          offboardingCaseId: id,
          status: ResignationStatus.APPROVED,
        },
        data: { approvedLwd: dto.lastWorkingDay },
      });
    });
    // Checklist due dates that were still the automatic ones (two days before the old last working day) move with the new date;
    // a date HR set by hand is left alone.
    {
      const orgTz = (await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } }))?.timezone ?? 'Asia/Kolkata';
      const today = todayInOrgTz(orgTz);
      const oldDefault = defaultDueDate(record.lastWorkingDay, today);
      const newDefault = defaultDueDate(dto.lastWorkingDay, today);
      const meta = { ...((record.checklistMeta ?? {}) as ChecklistMeta) };
      let changed = false;
      for (const key of CHECKLIST_ITEM_KEYS) {
        if (meta[key]?.dueDate === oldDefault) {
          meta[key] = { ownerId: meta[key]!.ownerId, dueDate: newDefault };
          changed = true;
        }
      }
      if (changed) await this.scopedPrisma.offboardingCase.updateMany({ where: { id, organizationId }, data: { checklistMeta: meta as unknown as Prisma.InputJsonValue } });
    }
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'OFFBOARDING_LWD_CHANGED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: record.employeeId,
      details: {
        offboardingCaseId: id,
        from: record.lastWorkingDay,
        to: dto.lastWorkingDay,
        reason: dto.reason,
        settlementUnlinked: !!record.settlementId,
      },
    });
    await this.notificationsService.create({
      organizationId,
      userId: record.employeeId,
      title: 'Last Working Day Updated',
      message: `Your last working day is now ${dto.lastWorkingDay} (was ${record.lastWorkingDay}).`,
      category: NotificationCategory.GENERAL,
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

    // The settlement is figured for one last working day; it has to be the exit's.
    if (
      settlement.lastWorkingDay.slice(0, 10) !==
      record.lastWorkingDay.slice(0, 10)
    ) {
      throw new BadRequestException(
        `This settlement is for last working day ${dmyText(settlement.lastWorkingDay.slice(0, 10))}, but the exit's is ${dmyText(record.lastWorkingDay.slice(0, 10))} - recalculate the settlement for the exit's date.`,
      );
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
    await assertAccountCanLeave(this.scopedPrisma, record.employeeId, organizationId);

    const leaver = await this.scopedPrisma.user.findFirst({
      where: { id: record.employeeId, organizationId },
      select: { personalData: true },
    });
    if (!personalEmailOf(leaver?.personalData)) {
      throw new BadRequestException(PERSONAL_EMAIL_REQUIRED_MESSAGE);
    }

    const missing: string[] = [];
    if (!record.assetsReturned) missing.push('assetsReturned');
    else if (!record.assetOverrideNote)
      await this.assertNoOpenAssets(record.employeeId, organizationId);
    if (!record.accessRevoked) missing.push('accessRevoked');
    // Someone terminated or who absconded cannot be asked to sit an exit interview.
    const interviewNeeded =
      record.exitStatus !== EmploymentStatus.TERMINATED &&
      record.exitStatus !== EmploymentStatus.ABSCONDED;
    if (interviewNeeded && !record.exitInterviewDone)
      missing.push('exitInterviewDone');
    if (!record.settlementId) missing.push('settlement');
    else if (record.settlement?.status === SettlementStatus.DRAFT)
      missing.push(
        'settlement processing (still DRAFT — run POST /settlements/:id/process first)',
      );
    // The final settlement must actually be paid before the account is closed (processed is not enough).
    else if (record.settlement?.status !== SettlementStatus.PAID)
      missing.push('settlement payment (mark the settlement as paid first)');
    if (
      record.settlement &&
      record.settlement.lastWorkingDay.slice(0, 10) !==
        record.lastWorkingDay.slice(0, 10)
    ) {
      missing.push(
        `settlement last working day (${record.settlement.lastWorkingDay.slice(0, 10)}) differs from the exit's (${record.lastWorkingDay.slice(0, 10)})`,
      );
    }
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
    await this.tellNewManagerOfPending(record.employeeId, dto.reassignManagerId, organizationId);

    // A case still carrying the old RESIGNED exit type ends as RELEASED (RESIGNED is the notice stage now).
    const finalStatus =
      record.exitStatus === EmploymentStatus.RESIGNED
        ? EmploymentStatus.RELEASED
        : record.exitStatus;
    await this.scopedPrisma.$transaction(async (tx) => {
      await tx.offboardingCase.updateMany({
        where: { id, organizationId },
        data: {
          status: OffboardingStatus.COMPLETED,
          completedById: actor.id,
          completedAt: new Date(),
        },
      });
      // Final employment status per the case's exit type (RELEASED/TERMINATED/ABSCONDED), with a
      // history row, and every session revoked — the account can no longer refresh a token after exit.
      const current = await tx.user.findFirst({
        where: { id: record.employeeId, organizationId },
        select: { employmentStatus: true },
      });
      await tx.user.updateMany({
        where: { id: record.employeeId, organizationId },
        data: { isActive: false, employmentStatus: finalStatus },
      });
      if (current && current.employmentStatus !== finalStatus) {
        await tx.employmentStatusHistory.create({
          data: {
            organizationId,
            employeeId: record.employeeId,
            previousStatus: current.employmentStatus,
            newStatus: finalStatus,
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
    // Resignations and releases get the relieving letter and experience certificate by email straight away; a termination or an
    // abscondment is left to HR. A letter that cannot be sent never undoes the completed exit.
    if (finalStatus === EmploymentStatus.RELEASED) await this.sendExitLetters(id, record.employeeId, actor, organizationId);
    return this.findOne(id, organizationId);
  }

  private async sendExitLetters(caseId: string, employeeId: string, actor: Actor, organizationId: string) {
    const sent: string[] = [];
    const failed: string[] = [];
    for (const key of ['relievingLetter', 'experienceCertificate']) {
      try {
        await this.lettersService.send(employeeId, key, actor, organizationId);
        sent.push(key);
      } catch (err) {
        failed.push(`${key}: ${err instanceof Error ? err.message : 'not sent'}`);
      }
    }
    if (sent.length > 0) {
      await this.scopedPrisma.offboardingCase.updateMany({ where: { id: caseId, organizationId }, data: { lettersSentAt: new Date() } });
    }
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'LETTER_EMAILED',
      performedById: actor.id,
      description: sent.length > 0
        ? `Exit letters emailed on completion (${sent.join(', ')}).${failed.length ? ` Not sent: ${failed.join('; ')}.` : ''}`
        : `Exit letters could not be emailed: ${failed.join('; ')}. Send them from the Letters tab.`,
    });
    if (failed.length > 0) {
      await this.notifyHr(organizationId, [actor.id], 'Exit letters not sent', `Some exit letters could not be emailed (${failed.join('; ')}). Send them from the employee's Letters tab.`);
    }
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
        select: { name: true, personalData: true, brandId: true },
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
      const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const variables = {
        employeeName: employee.name,
        lastWorkingDay: formatDateDisplay(
          lastWorkingDay,
          '',
          dateFormat,
          timeZone,
        ),
      };
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'EXIT_COMPLETED',
        variables,
        this.emailTemplatesService.defaultFor('EXIT_COMPLETED', variables),
        { brandId: employee.brandId },
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
    // A processed settlement has already closed the employee's loans, paid their claims and taken their leave
    // balance, and regular payroll skips them from the last working day. Cancelling the exit now would return
    // them to service unpaid - the settlement has to be reversed first (or, once paid, the exit stands).
    const settled = record.settlement?.status;
    if (settled === SettlementStatus.PAID) {
      throw new BadRequestException(
        'The final settlement has already been paid, so this exit cannot be cancelled.',
      );
    }
    if (settled === SettlementStatus.PROCESSED) {
      throw new BadRequestException(
        'The final settlement has been processed - reverse it first (Settlements -> Reverse), then cancel the offboarding.',
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
      // Cancelled exit: they are staying, so the last working day no longer applies.
      if (count > 0) {
        await tx.user.updateMany({
          where: { id: record.employeeId, organizationId },
          data: { exitDate: null },
        });
        await this.markPayrollStale(tx, organizationId, record.employeeId, record.lastWorkingDay);
      }
      // Restore the pre-notice status only on the first cancel of an open case, and only if the
      // employee is still RESIGNED (HR may have changed it manually since).
      const wasOpen = OPEN_STATUSES.includes(record.status);
      if (count > 0 && wasOpen && record.previousEmploymentStatus) {
        const restored = await tx.user.updateMany({
          where: {
            id: record.employeeId,
            organizationId,
            employmentStatus: EmploymentStatus.RESIGNED,
          },
          data: { employmentStatus: record.previousEmploymentStatus },
        });
        if (
          restored.count > 0 &&
          record.previousEmploymentStatus !== EmploymentStatus.RESIGNED
        ) {
          await tx.employmentStatusHistory.create({
            data: {
              organizationId,
              employeeId: record.employeeId,
              previousStatus: EmploymentStatus.RESIGNED,
              newStatus: record.previousEmploymentStatus,
              note: 'Offboarding cancelled',
              changedById: actorId ?? record.initiatedById,
            },
          });
        }
      }
      // The resignation that started this case no longer stands: the employee is back in service, so it is closed
      // too (not left saying "approved, leaving on <date>").
      if (count > 0 && wasOpen) {
        await tx.resignation.updateMany({
          where: {
            organizationId,
            offboardingCaseId: id,
            status: ResignationStatus.APPROVED,
          },
          data: {
            status: ResignationStatus.WITHDRAWN,
            decisionNote: 'Offboarding was cancelled.',
          },
        });
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
