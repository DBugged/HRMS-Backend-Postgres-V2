// Purpose: Employee-logged overtime records and manager/HR single-level review.
// Responsibilities: Owns rateMultiplier derivation from `type` (REGULAR/HOLIDAY/WEEKEND/NIGHT) at log time —
// always server-computed, never client-supplied — and department-scoped review authorization via
// assertManagerDeptScope.
// Important: rateMultiplier is fixed per type at creation and not recalculated later, so a later change to
// RATE_MULTIPLIERS only affects new records, not historical ones.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
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
import { formatDateDisplay, resolveOrgDateTimeFormat } from '../payroll/format-date';

type Actor = Omit<User, 'password'>;

// Derived server-side from `type`, never client-supplied.
const RATE_MULTIPLIERS: Record<OvertimeType, number> = {
  [OvertimeType.REGULAR]: 1.5,
  [OvertimeType.HOLIDAY]: 2,
  [OvertimeType.WEEKEND]: 2,
  [OvertimeType.NIGHT]: 1.75,
};

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
    const type = dto.type ?? OvertimeType.REGULAR;
    const record = await this.scopedPrisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: actor.id,
        date: dto.date,
        hours: dto.hours,
        type,
        rateMultiplier: RATE_MULTIPLIERS[type],
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
    const { dateFormat } = await resolveOrgDateTimeFormat(this.scopedPrisma, organizationId);
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'OVERTIME_LOGGED',
      performedById: actor.id,
      description: `Logged ${dto.hours} hour(s) of ${type.toLowerCase()} overtime on ${formatDateDisplay(dto.date, '', dateFormat)}.`,
    });

    return record;
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
          orderBy: { date: 'desc' },
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
    if (record.status !== OvertimeStatus.PENDING) {
      throw new BadRequestException(
        'This overtime record has already been reviewed.',
      );
    }

    await this.scopedPrisma.overtimeRecord.updateMany({
      where: { id, organizationId },
      data: { status: dto.status, approvedById: actor.id },
    });

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
      const { dateFormat } = await resolveOrgDateTimeFormat(this.scopedPrisma, organizationId);
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
        { employeeName: employee.name, hours: String(record.hours), date: formatDateDisplay(record.date, '', dateFormat), status: dto.status },
        { subject: title, html: message },
      );
      await this.emailService.send({ to: employee.email, subject: rendered.subject, html: rendered.html });
    }

    return updated;
  }
}
