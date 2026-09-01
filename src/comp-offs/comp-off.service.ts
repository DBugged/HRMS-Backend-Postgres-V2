// Purpose: Manages comp-off (compensatory time off) earning, review, expiry, and consumption.
// Responsibilities: Owns comp-off CRUD, balance calculation and expiry sweeping; exposes
// consumeForLeave()/releaseForLeave() for LeavesService to debit/credit balance transactionally when a
// COMPOFF-type Leave is approved or cancelled, rather than duplicating comp-off math there.
// Important: consumeForLeave() throws on insufficient balance rather than partially consuming — callers
// must check availability before approving. sweepExpired() runs inline before reads, not on a cron.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompOff,
  CompOffStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateCompOffDto } from './dto/create-comp-off.dto';
import { ReviewCompOffDto } from './dto/review-comp-off.dto';
import {
  consumeCompOff,
  releaseCompOff,
  sumAvailable,
} from './comp-off-consumption';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { ListCompOffsQueryDto } from './dto/list-comp-offs-query.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  assertManagerScopeOrDelegate,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { formatDateDisplay, resolveOrgDateTimeFormat } from '../payroll/format-date';

type Actor = Omit<User, 'password'>;

// Old system's LEAVE_APPROVE_ROLES — may raise/view comp-off on someone
// else's behalf.
const APPROVE_ROLES: Role[] = [Role.ADMIN, Role.HR, Role.MANAGER];

const CONSUMABLE_STATUSES: CompOffStatus[] = [
  CompOffStatus.APPROVED,
  CompOffStatus.PARTIALLY_AVAILED,
];

@Injectable()
export class CompOffService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly delegationService: ApprovalDelegationService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async earn(dto: CreateCompOffDto, actor: Actor, organizationId: string) {
    const targetEmployeeId =
      dto.employeeId && APPROVE_ROLES.includes(actor.role)
        ? dto.employeeId
        : actor.id;
    // A MANAGER may only earn comp-off on behalf of their own department's
    // employees — ADMIN/HR are unrestricted, EMPLOYEE never reaches this
    // branch since targetEmployeeId already collapses to actor.id above.
    if (dto.employeeId && actor.role === Role.MANAGER) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        targetEmployeeId,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    if (dto.earnedForDate > today) {
      throw new BadRequestException('earnedForDate cannot be in the future.');
    }

    // Duplicate-claim guard: block a new earn request when this employee
    // already has a non-REJECTED CompOff for the same earnedForDate
    // (PENDING/APPROVED/AVAILED/PARTIALLY_AVAILED/EXPIRED all count —
    // any of those means a claim for that date was already accepted into
    // the workflow at some point). REJECTED is deliberately excluded so a
    // manager rejecting a bad/duplicate submission doesn't permanently
    // block the employee from correctly resubmitting for that same date —
    // that's a real, legitimate flow (e.g. reason text was wrong, or the
    // first submission was itself the mistaken duplicate and got rejected
    // to clear the way for the correct one).
    //
    // A DB-level `@@unique([organizationId, employeeId, earnedForDate])`
    // (mirroring Attendance's own per-day uniqueness constraint) was
    // considered and is simpler/race-safe, but it would treat a REJECTED
    // row as a permanent lock on that date, which is the wrong business
    // rule here — Attendance has no "rejected, please resubmit" workflow,
    // so its constraint doesn't need to make this distinction. Hence an
    // application-level check instead. This has a small race window under
    // truly concurrent double-submits for the same date/employee, which is
    // an acceptable trade-off for the correct one being blocked by default.
    const duplicate = await this.scopedPrisma.compOff.findFirst({
      where: {
        organizationId,
        employeeId: targetEmployeeId,
        earnedForDate: dto.earnedForDate,
        status: { not: CompOffStatus.REJECTED },
      },
    });
    if (duplicate) {
      throw new ConflictException(
        'A comp-off request for this date already exists. If your previous request for this date was rejected, you may resubmit it.',
      );
    }

    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const expiryDate = addDays(dto.earnedForDate, settings.compOffExpiryDays);

    const compOff = await this.scopedPrisma.compOff.create({
      data: {
        organizationId,
        employeeId: targetEmployeeId,
        earnedForDate: dto.earnedForDate,
        reason: dto.reason ?? '',
        daysEarned: dto.daysEarned ?? 1,
        expiryDate,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'COMP_OFF_EARNED',
      module: 'LEAVE',
      organizationId,
      targetId: compOff.id,
      details: {
        employeeId: targetEmployeeId,
        earnedForDate: dto.earnedForDate,
        daysEarned: compOff.daysEarned,
      },
    });
    const { dateFormat } = await resolveOrgDateTimeFormat(this.scopedPrisma, organizationId);
    await this.timelineService.logEvent({
      organizationId,
      employeeId: targetEmployeeId,
      eventKey: 'COMP_OFF_GRANTED',
      performedById: actor.id,
      description: `Comp-off earned for ${formatDateDisplay(dto.earnedForDate, '', dateFormat)}.`,
    });

    return compOff;
  }

  async findAll(
    query: ListCompOffsQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.sweepExpired(organizationId);

    const where: Prisma.CompOffWhereInput = { organizationId };
    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    return paginate(
      () =>
        this.scopedPrisma.compOff.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.compOff.count({ where }),
      query.page,
      query.limit,
    );
  }

  async balance(
    employeeId: string | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    const targetEmployeeId =
      employeeId && APPROVE_ROLES.includes(actor.role) ? employeeId : actor.id;
    // Same MANAGER-own-department restriction as earn() — a MANAGER must
    // not be able to read another department's employee's comp-off balance.
    if (employeeId && actor.role === Role.MANAGER) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        targetEmployeeId,
      );
    }
    return {
      available: await this.available(targetEmployeeId, organizationId),
    };
  }

  // Read-only sum of unconsumed comp-off — used here and by LeavesService
  // for COMPOFF-type leave affordability checks.
  async available(employeeId: string, organizationId: string): Promise<number> {
    await this.sweepExpired(organizationId);
    const rows = await this.scopedPrisma.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    return sumAvailable(rows);
  }

  async review(
    id: string,
    dto: ReviewCompOffDto,
    actor: Actor,
    organizationId: string,
  ) {
    const compOff = await this.findByIdOrThrow(id, organizationId);
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      compOff.employeeId,
    );
    if (compOff.status !== CompOffStatus.PENDING) {
      throw new BadRequestException(
        'This comp-off request has already been reviewed.',
      );
    }

    await this.scopedPrisma.compOff.updateMany({
      where: { id, organizationId },
      data: {
        status: dto.decision,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: compOff.employeeId, organizationId },
    });
    if (employee) {
      const { dateFormat } = await resolveOrgDateTimeFormat(this.scopedPrisma, organizationId);
      const title = `Comp-Off Request ${dto.decision}`;
      const message = `Your comp-off request for ${formatDateDisplay(compOff.earnedForDate, '', dateFormat)} has been ${dto.decision.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        // Reuses the LEAVE category, not a separate COMPOFF one — matches
        // the old system exactly.
        message,
        category: NotificationCategory.LEAVE,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'COMP_OFF_DECISION',
        { employeeName: employee.name, decision: dto.decision, earnedForDate: formatDateDisplay(compOff.earnedForDate, '', dateFormat) },
        { subject: title, html: message },
      );
      await this.emailService.send({ to: employee.email, subject: rendered.subject, html: rendered.html });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'COMP_OFF_REVIEWED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: { employeeId: compOff.employeeId, decision: dto.decision },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: compOff.employeeId,
      eventKey: 'COMP_OFF_GRANTED',
      performedById: actor.id,
      description: `Comp-off request ${dto.decision.toLowerCase()}.`,
    });

    return this.findByIdOrThrow(id, organizationId);
  }

  // Called by LeavesService within its own transaction when a COMPOFF-type
  // Leave is approved. Throws if the balance is insufficient rather than
  // partially consuming — caller is expected to have already checked
  // availability before approving.
  async consumeForLeave(
    tx: Prisma.TransactionClient,
    employeeId: string,
    days: number,
    organizationId: string,
  ): Promise<void> {
    const rows = await tx.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    const result = consumeCompOff(rows, days);
    if (result.shortfall > 0) {
      throw new ForbiddenException('Insufficient comp-off balance.');
    }
    for (const update of result.updated) {
      await tx.compOff.updateMany({
        where: { id: update.id, organizationId },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
    }
  }

  // Called by LeavesService within its own transaction when a previously-
  // approved COMPOFF-type Leave is cancelled.
  async releaseForLeave(
    tx: Prisma.TransactionClient,
    employeeId: string,
    days: number,
    organizationId: string,
  ): Promise<void> {
    const rows = await tx.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: [...CONSUMABLE_STATUSES, CompOffStatus.AVAILED] },
      },
    });
    const updates = releaseCompOff(rows, days);
    for (const update of updates) {
      await tx.compOff.updateMany({
        where: { id: update.id, organizationId },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
    }
  }

  private async sweepExpired(organizationId: string) {
    const today = new Date().toISOString().slice(0, 10);
    await this.scopedPrisma.compOff.updateMany({
      where: {
        organizationId,
        status: { in: CONSUMABLE_STATUSES },
        expiryDate: { lt: today },
      },
      data: { status: CompOffStatus.EXPIRED },
    });
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<CompOff> {
    const compOff = await this.scopedPrisma.compOff.findFirst({
      where: { id, organizationId },
    });
    if (!compOff) throw new NotFoundException('Comp-off request not found.');
    return compOff;
  }
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
