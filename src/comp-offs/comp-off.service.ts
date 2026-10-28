// Purpose: Manages comp-off (compensatory time off) earning, review, expiry, and consumption.
// Responsibilities: Owns comp-off CRUD, balance calculation and expiry sweeping; exposes
// consumeForLeave()/releaseForLeave() for LeavesService to debit/credit balance transactionally when a
// COMPOFF-type Leave is approved or cancelled, rather than duplicating comp-off math there.
// Important: consumeForLeave() throws on insufficient balance rather than partially consuming — callers
// must check availability before approving. sweepExpired() runs inline before reads, not on a cron.
import { isEmployedOn } from '../common/managers';
import { todayInOrgTz } from '../common/org-date';
import { holidayInEffect } from '../holidays/holiday-in-effect';
import {
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
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
  Department,
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
  sumAvailableOn,
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
  assertNotSelfApproval,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import {
  formatDateDisplay,
  resolveOrgDateTimeFormat,
  dmyText,
} from '../payroll/format-date';

type Actor = Omit<User, 'password'>;

// The original release's LEAVE_APPROVE_ROLES — may raise/view comp-off on someone
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

    // Today in the organisation's own time zone: the server's UTC date is still yesterday for the first hours of an Indian
    // morning, which refused a comp-off for the day just worked.
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    if (dto.earnedForDate > today) {
      throw new BadRequestException('earnedForDate cannot be in the future.');
    }

    const targetEmployee = await this.scopedPrisma.user.findFirst({
      where: { id: targetEmployeeId, organizationId },
      include: { department: true },
    });
    if (!targetEmployee) throw new NotFoundException('Employee not found.');
    if (!targetEmployee.isActive) {
      throw new BadRequestException('Comp-off cannot be earned for a deactivated employee.');
    }
    // ...nor for a day after their last working day.
    if (!isEmployedOn(targetEmployee.exitDate, dto.earnedForDate)) {
      throw new BadRequestException(
        `Comp-off cannot be earned for a date after the last working day (${dmyText(targetEmployee.exitDate!)}).`,
      );
    }
    // Nobody earns comp-off before they have joined (the same rule as punches, regularization, WFH and leave).
    const joinedOn = targetEmployee.joiningDate.toISOString().slice(0, 10);
    if (dto.earnedForDate < joinedOn) {
      throw new BadRequestException(
        `Comp-off cannot be earned for a date before the joining date (${dmyText(joinedOn)}).`,
      );
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

    // One day, one benefit: work already logged as overtime (waiting, or approved - possibly compensated with its own
    // comp-off) is not also claimed as comp-off. A rejected overtime record does not block it.
    const overtimeForDay = await this.scopedPrisma.overtimeRecord.findFirst({
      where: {
        organizationId,
        employeeId: targetEmployeeId,
        date: dto.earnedForDate,
        status: { not: 'REJECTED' },
      },
    });
    if (overtimeForDay) {
      throw new ConflictException(
        'This day is already logged as overtime. Overtime and comp-off cannot both be claimed for the same day; the approver chooses how to compensate it.',
      );
    }

    await this.assertDayOffWorked(targetEmployee, dto.earnedForDate, organizationId);

    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    // Valid for the org's compOffExpiryDays after the date it was earned for; 0 means it never expires.
    let expiryDate: string | null = null;
    if (settings.compOffExpiryDays > 0) {
      const expiry = new Date(`${dto.earnedForDate}T00:00:00.000Z`);
      expiry.setUTCDate(expiry.getUTCDate() + settings.compOffExpiryDays);
      expiryDate = expiry.toISOString().slice(0, 10);
    }

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
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.timelineService.logEvent({
      organizationId,
      employeeId: targetEmployeeId,
      eventKey: 'COMP_OFF_GRANTED',
      performedById: actor.id,
      description: `Comp-off earned for ${formatDateDisplay(dto.earnedForDate, '', dateFormat, timeZone)}.`,
    });
    // Only a request the employee raised for themselves is waiting on someone; one a reviewer logged on their behalf
    // is not.
    if (targetEmployeeId === actor.id && compOff.status === 'PENDING') {
      await this.notificationsService.notifyReviewers({
        organizationId,
        requester: actor,
        title: 'Comp-Off Requested',
        message: `${actor.name} requested comp-off for ${formatDateDisplay(dto.earnedForDate, '', dateFormat, timeZone)}, pending your approval.`,
        category: NotificationCategory.ATTENDANCE,
        managerFirst: true,
      });
    }

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
      const deptIds = await deptScopedEmployeeIds(
        this.scopedPrisma,
        actor,
        organizationId,
      );
      if (query.employeeId) {
        // Narrows to one department member (or the manager themself, for
        // "My Comp-Off") instead of the whole department — never widens
        // it: the requested id must already be within the manager's own
        // dept scope, same boundary the unfiltered branch below enforces.
        if (!deptIds.includes(query.employeeId)) {
          throw new ForbiddenException(
            "Not authorized to view this employee's comp-offs.",
          );
        }
        where.employeeId = query.employeeId;
      } else {
        where.employeeId = { in: deptIds };
      }
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
          // Requests still waiting for a decision come first (PENDING is the first value of the status enum), so a new
          // request is on the first page for the approver however many past records there are.
          orderBy: [
            { status: 'asc' },
            ...EMPLOYEE_RELATION_ORDER_BY,
            { createdAt: 'desc' },
          ],
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

  // Unconsumed comp-off that is still valid on `asOf` (the date the leave would start): a credit that expires before
  // that date cannot cover it. Used by LeavesService when someone applies for comp-off leave.
  async availableOn(
    employeeId: string,
    organizationId: string,
    asOf: string,
  ): Promise<number> {
    await this.sweepExpired(organizationId);
    const rows = await this.scopedPrisma.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    return sumAvailableOn(rows, asOf);
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

  // Batched variant of available() for callers that need the figure for a
  // whole scoped list of employees at once (e.g. LeaveTrackerService's
  // balances grid) — sweeps once for the org instead of once per employee,
  // and fetches every employee's rows in a single findMany instead of N,
  // while returning exactly what N calls to available() would have.
  async availableForEmployees(
    employeeIds: string[],
    organizationId: string,
  ): Promise<Map<string, number>> {
    await this.sweepExpired(organizationId);
    const rows = await this.scopedPrisma.compOff.findMany({
      where: {
        organizationId,
        employeeId: { in: employeeIds },
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    const rowsByEmployee = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = rowsByEmployee.get(row.employeeId);
      if (existing) {
        existing.push(row);
      } else {
        rowsByEmployee.set(row.employeeId, [row]);
      }
    }
    const result = new Map<string, number>();
    for (const employeeId of employeeIds) {
      result.set(
        employeeId,
        sumAvailable(rowsByEmployee.get(employeeId) ?? []),
      );
    }
    return result;
  }

  // Comp-off is time off for working on a day off. A regular working day is already paid through attendance, so it
  // earns none: only the employee's weekly off (their department's shift, else the organisation's default) or a
  // holiday that applies to them qualifies. A public holiday missing from the calendar is added there first.
  private async assertDayOffWorked(
    employee: { departmentId: string | null; department: Department | null },
    date: string,
    organizationId: string,
  ) {
    const [org, holiday] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { timezone: true, attendancePayrollPrefs: true },
      }),
      this.scopedPrisma.holiday.findFirst({
        where: {
          organizationId,
          AND: [holidayInEffect],
          date,
          isOptional: false,
          OR: employee.departmentId
            ? [{ departmentId: null }, { departmentId: employee.departmentId }]
            : [{ departmentId: null }],
        },
        select: { id: true },
      }),
    ]);
    const { weeklyOffs } = resolveShiftConfig(
      employee.department,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
      org?.timezone ?? 'Asia/Kolkata',
    );
    if (!holiday && !isWeeklyOff(date, weeklyOffs)) {
      throw new BadRequestException(
        `${dmyText(date)} is a regular working day, so it does not earn a comp-off. Comp-off is only for work on a weekly off or a holiday - if this day was a public holiday, add it to the Holiday calendar first.`,
      );
    }
  }

  async review(
    id: string,
    dto: ReviewCompOffDto,
    actor: Actor,
    organizationId: string,
  ) {
    const compOff = await this.findByIdOrThrow(id, organizationId);
    // HR and managers never review their own request; an Admin may (it is written to the audit trail below).
    assertNotSelfApproval(actor, compOff.employeeId);
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      compOff.employeeId,
    );
    await this.auditLogService.logSelfApproval(actor, {
      module: 'LEAVE',
      targetId: id,
      employeeId: compOff.employeeId,
      request: 'Comp-off',
    });
    if (compOff.status !== CompOffStatus.PENDING) {
      throw new BadRequestException(
        'This comp-off request has already been reviewed.',
      );
    }
    // A request raised before the weekly-off / holiday rule existed can still be pending for a regular working day: it
    // cannot be approved now either (it can be rejected).
    if (dto.decision === CompOffStatus.APPROVED) {
      const requester = await this.scopedPrisma.user.findFirst({
        where: { id: compOff.employeeId, organizationId },
        include: { department: true },
      });
      if (requester) {
        await this.assertDayOffWorked(
          requester,
          compOff.earnedForDate,
          organizationId,
        );
      }
    }

    // Guarded compare-and-swap: PENDING re-asserted in the write's own
    // `where`, not just the pre-check above — two concurrent review()
    // calls on the same request (double-click, or a retried request)
    // can't both win.
    const { count } = await this.scopedPrisma.compOff.updateMany({
      where: { id, organizationId, status: CompOffStatus.PENDING },
      data: {
        status: dto.decision,
        approvedById: actor.id,
        approvedAt: new Date(),
        decisionNote: dto.comments?.trim() || null,
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This comp-off request was already reviewed.',
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: compOff.employeeId, organizationId },
    });
    if (employee) {
      const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const title = `Comp-Off Request ${dto.decision}`;
      const message = `Your comp-off request for ${formatDateDisplay(compOff.earnedForDate, '', dateFormat, timeZone)} has been ${dto.decision.toLowerCase()}.${dto.comments?.trim() ? ` Comments: ${dto.comments.trim()}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        // Reuses the LEAVE category, not a separate COMPOFF one — matches
        // the original release exactly.
        message,
        category: NotificationCategory.LEAVE,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'COMP_OFF_DECISION',
        {
          employeeName: employee.name,
          decision: dto.decision,
          earnedForDate: formatDateDisplay(
            compOff.earnedForDate,
            '',
            dateFormat,
          ),
          comments: dto.comments?.trim() ?? '',
        },
        { subject: title, html: message },
      );
      // Fire-and-forget: send() never throws, and the review has already
      // committed — the HR/manager's approve/reject click shouldn't wait on
      // an SMTP/API round trip to feel instant.
      void this.emailService.send({
        organizationId,
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'COMP_OFF_REVIEWED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: {
        employeeId: compOff.employeeId,
        decision: dto.decision,
        ...(dto.comments?.trim() && { comments: dto.comments.trim() }),
      },
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
        // Expiry is only swept lazily (sweepExpired runs on the read paths,
        // never on a schedule), so an expired credit can still be sitting
        // in a CONSUMABLE status at approval time — status alone is not
        // proof of validity. Without this, a comp-off leave applied for
        // while the credit was valid but approved after expiry consumed
        // the expired credit. Null expiryDate means "never expires".
        OR: [
          { expiryDate: null },
          { expiryDate: { gte: new Date().toISOString().slice(0, 10) } },
        ],
      },
    });
    const result = consumeCompOff(rows, days);
    if (result.shortfall > 0) {
      throw new ForbiddenException('Insufficient comp-off balance.');
    }
    // Guarded compare-and-swap, not a blind overwrite: each update's WHERE
    // re-asserts the exact daysAvailed this calculation was based on. Two
    // concurrent approvals reading the same starting balance would
    // otherwise both compute a "correct" absolute newAvailed and the
    // second write would silently clobber the first's — a real lost-update
    // reproduced under concurrent comp-off-leave approval. If the guard
    // misses (another transaction already changed this row), surface it as
    // a conflict rather than corrupt the ledger; the caller (LeavesService,
    // inside its own transaction) rolls back and the reviewer retries.
    const byId = new Map(rows.map((row) => [row.id, row.daysAvailed]));
    for (const update of result.updated) {
      const previousDaysAvailed = byId.get(update.id)!;
      const { count } = await tx.compOff.updateMany({
        where: {
          id: update.id,
          organizationId,
          daysAvailed: previousDaysAvailed,
        },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
      if (count === 0) {
        throw new ConflictException(
          'This comp-off balance was just updated elsewhere — please retry.',
        );
      }
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
    // Same guarded compare-and-swap as consumeForLeave above — see its
    // comment for why a blind updateMany is unsafe here.
    const byId = new Map(rows.map((row) => [row.id, row.daysAvailed]));
    for (const update of updates) {
      const previousDaysAvailed = byId.get(update.id)!;
      const { count } = await tx.compOff.updateMany({
        where: {
          id: update.id,
          organizationId,
          daysAvailed: previousDaysAvailed,
        },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
      if (count === 0) {
        throw new ConflictException(
          'This comp-off balance was just updated elsewhere — please retry.',
        );
      }
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
