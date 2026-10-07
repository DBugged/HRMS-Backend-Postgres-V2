// Purpose: Employee-logged overtime records and manager/HR single-level review.
// Responsibilities: Owns rateMultiplier derivation from `type` (REGULAR/HOLIDAY/WEEKEND/NIGHT) at log time —
// always server-computed, never client-supplied — and department-scoped review authorization via
// assertManagerDeptScope.
// Important: rateMultiplier is fixed per type at creation and not recalculated later, so a later change to
// RATE_MULTIPLIERS only affects new records, not historical ones.
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import { OVERTIME_PAY_OFF_MESSAGE, isOvertimePayEnabled } from './overtime-pay';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceStatus,
  NotificationCategory,
  OvertimeStatus,
  OvertimeType,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LogOvertimeDto } from './dto/log-overtime.dto';
import { ReviewOvertimeDto } from './dto/review-overtime.dto';
import { QueryOvertimeDto } from './dto/query-overtime.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerScopeOrDelegate,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import {
  formatDateDisplay,
  resolveOrgDateTimeFormat,
} from '../payroll/format-date';

type Actor = Omit<User, 'password'>;

// Fallback multipliers, used only when the org has no PayrollSettings row yet
// — same values as that table's column defaults.
export const RATE_MULTIPLIERS: Record<OvertimeType, number> = {
  [OvertimeType.REGULAR]: 1.5,
  [OvertimeType.HOLIDAY]: 2,
  [OvertimeType.WEEKEND]: 2,
  [OvertimeType.NIGHT]: 1.75,
};

// The org's overtime multipliers from Payroll Settings. Derived server-side
// from `type`, never client-supplied. Exported so AttendanceService's
// punch-out auto-suggestion uses the same rates without injecting the whole
// OvertimeService.
export async function getOvertimeRates(
  db: Pick<Prisma.TransactionClient, 'payrollSettings'>,
  organizationId: string,
): Promise<Record<OvertimeType, number>> {
  const s = await db.payrollSettings.findFirst({
    where: { organizationId },
    select: {
      otRegularRate: true,
      otHolidayRate: true,
      otWeekendRate: true,
      otNightRate: true,
    },
  });
  if (!s) return RATE_MULTIPLIERS;
  return {
    [OvertimeType.REGULAR]: s.otRegularRate,
    [OvertimeType.HOLIDAY]: s.otHolidayRate,
    [OvertimeType.WEEKEND]: s.otWeekendRate,
    [OvertimeType.NIGHT]: s.otNightRate,
  };
}

function monthRange(month: number, year: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

@Injectable()
export class OvertimeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly delegationService: ApprovalDelegationService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async log(dto: LogOvertimeDto, actor: Actor, organizationId: string) {
    // With Overtime Pay off, nothing logged here could ever be paid.
    if (!(await isOvertimePayEnabled(this.scopedPrisma, organizationId))) {
      throw new BadRequestException(OVERTIME_PAY_OFF_MESSAGE);
    }
    const type = dto.type ?? OvertimeType.REGULAR;

    // REGULAR/NIGHT overtime means "extra hours on top of a normal working
    // day" — logging it for a day the employee was ABSENT, ON_LEAVE, or
    // INCOMPLETE (punch-out missing, so there's no confirmed base shift
    // either) makes no sense and was previously allowed with no check at
    // all. HOLIDAY/WEEKEND types are deliberately exempt from this check:
    // those exist specifically for days that are *expected* to show a
    // non-PRESENT attendance status (HOLIDAY/WEEKLY_OFF), so the same guard
    // would block the exact case those types exist for. A day with no
    // Attendance row at all (not yet processed) isn't blocked either — only
    // an explicit ABSENT/ON_LEAVE/INCOMPLETE status does.
    if (type === OvertimeType.REGULAR || type === OvertimeType.NIGHT) {
      const attendance = await this.scopedPrisma.attendance.findFirst({
        where: { organizationId, employeeId: actor.id, date: dto.date },
      });
      if (
        attendance &&
        (attendance.status === AttendanceStatus.ABSENT ||
          attendance.status === AttendanceStatus.ON_LEAVE ||
          attendance.status === AttendanceStatus.INCOMPLETE)
      ) {
        throw new BadRequestException(
          `Cannot log ${type.toLowerCase()} overtime for ${dto.date} — attendance for that day is marked ${attendance.status.toLowerCase().replace('_', ' ')}.`,
        );
      }
    }

    // One overtime record per employee/day, regardless of source — without
    // this, a manual log here and AttendanceService's own auto-suggestion
    // (source=AUTO_PUNCH, created when a punch-out overshoots shift end)
    // could both exist for the same day, both get approved independently,
    // and double-pay the same overshoot in payroll's monthly OT sum.
    const existing = await this.scopedPrisma.overtimeRecord.findFirst({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });
    if (existing) {
      throw new ConflictException(
        `An overtime record already exists for ${dto.date} (status: ${existing.status.toLowerCase()}). Edit or cancel it instead of logging a new one.`,
      );
    }

    const record = await this.scopedPrisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: actor.id,
        date: dto.date,
        hours: dto.hours,
        type,
        rateMultiplier: (
          await getOvertimeRates(this.scopedPrisma, organizationId)
        )[type],
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'OVERTIME_LOGGED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: record.id,
      details: { employeeId: actor.id, date: dto.date, hours: dto.hours, type },
    });
    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'OVERTIME_LOGGED',
      performedById: actor.id,
      description: `Logged ${dto.hours} hour(s) of ${type.toLowerCase()} overtime on ${formatDateDisplay(dto.date, '', dateFormat)}.`,
    });
    await this.notificationsService.notifyReviewers({
      organizationId,
      requester: actor,
      title: 'Overtime Requested',
      message: `${actor.name} logged ${dto.hours} hour(s) of overtime for ${formatDateDisplay(dto.date, '', dateFormat)}, pending your approval.`,
      category: NotificationCategory.ATTENDANCE,
      managerFirst: true,
    });

    return record;
  }

  // Current multipliers for each overtime type, so the log form can show
  // them (e.g. "Holiday (2x)") instead of hardcoding them client-side.
  getRates(organizationId: string) {
    return getOvertimeRates(this.scopedPrisma, organizationId);
  }

  // Whether overtime is currently paid (the Overtime Pay salary component is active). The web and mobile apps use it
  // to show or hide "log overtime" instead of letting the employee fill a form the server will refuse.
  async status(organizationId: string) {
    return {
      payEnabled: await isOvertimePayEnabled(this.scopedPrisma, organizationId),
    };
  }

  async findAll(query: QueryOvertimeDto, actor: Actor, organizationId: string) {
    const where: Prisma.OvertimeRecordWhereInput = { organizationId };

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
        // "My Attendance"'s overtime section) instead of the whole
        // department — never widens it: the requested id must already be
        // within the manager's own dept scope, same boundary the
        // unfiltered branch below enforces.
        if (!deptIds.includes(query.employeeId)) {
          throw new ForbiddenException(
            "Not authorized to view this employee's overtime records.",
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
    if (query.month && query.year) {
      const { from, to } = monthRange(query.month, query.year);
      where.date = { gte: from, lte: to };
    }

    return paginate(
      () =>
        this.scopedPrisma.overtimeRecord.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.overtimeRecord.count({ where }),
      query.page,
      query.limit,
    );
  }

  async review(
    id: string,
    dto: ReviewOvertimeDto,
    actor: Actor,
    organizationId: string,
  ) {
    const record = await this.scopedPrisma.overtimeRecord.findFirst({
      where: { id, organizationId },
    });
    if (!record) throw new NotFoundException('Overtime record not found.');
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      record.employeeId,
    );
    await this.auditLogService.logSelfApproval(actor, {
      module: 'ATTENDANCE',
      targetId: id,
      employeeId: record.employeeId,
      request: 'Overtime',
    });
    if (record.status !== OvertimeStatus.PENDING) {
      throw new BadRequestException(
        'This overtime record has already been reviewed.',
      );
    }

    // Guarded compare-and-swap — see LoansService.approve()'s comment for
    // the general reasoning.
    const { count } = await this.scopedPrisma.overtimeRecord.updateMany({
      where: { id, organizationId, status: OvertimeStatus.PENDING },
      data: { status: dto.status, approvedById: actor.id },
    });
    if (count === 0) {
      throw new ConflictException('This overtime record was already reviewed.');
    }

    const updated = await this.scopedPrisma.overtimeRecord.findFirstOrThrow({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'OVERTIME_REVIEWED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
      details: { employeeId: record.employeeId, status: dto.status },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: record.employeeId,
      eventKey: 'OVERTIME_REVIEWED',
      performedById: actor.id,
      description: `Overtime record ${dto.status.toLowerCase()}.`,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: record.employeeId, organizationId },
    });
    if (employee) {
      const { dateFormat } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const title = `Overtime Request ${dto.status}`;
      const message = `Your overtime of ${record.hours} hour(s) on ${formatDateDisplay(record.date, '', dateFormat)} has been ${dto.status.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.ATTENDANCE,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'OVERTIME_STATUS',
        {
          employeeName: employee.name,
          hours: String(record.hours),
          date: formatDateDisplay(record.date, '', dateFormat),
          status: dto.status,
        },
        { subject: title, html: message },
      );
      // Fire-and-forget — the review decision has already committed.
      void this.emailService.send({
        organizationId,
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    }

    return updated;
  }
}
