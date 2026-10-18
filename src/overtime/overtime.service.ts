// Purpose: Employee-logged overtime records and manager/HR single-level review.
// Responsibilities: Owns rateMultiplier derivation from `type` (REGULAR/HOLIDAY/WEEKEND/NIGHT) at log time —
// always server-computed, never client-supplied — and department-scoped review authorization via
// assertManagerDeptScope.
// Important: rateMultiplier is fixed per type at creation and not recalculated later, so a later change to
// RATE_MULTIPLIERS only affects new records, not historical ones.
import {
  assertPayrollMonthsUnlocked,
  markPayrollInputsChanged,
} from '../payroll/payroll-period-guard';
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
  CompOffStatus,
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
import {
  pickWorkCompensation,
  resolveWorkCompensation,
  selectableWorkCompensation,
} from './work-compensation';
import {
  daysSince,
  getOvertimePolicy,
  overtimeCapProblem,
  roundOvertimeHours,
} from './overtime-policy';
import { overtimeDayProblem, type DayKind } from './overtime-day-rules';
import {
  isWeeklyOff,
  resolveShiftConfig,
} from '../attendance/attendance-shift-config';
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
// Overtime is paid at not less than twice the normal rate of wages (Code on Wages, 2019, section 14, in force from
// 21-Nov-2025), so no multiplier below this is ever used or saved.
export const MIN_OVERTIME_MULTIPLIER = 2;

export const RATE_MULTIPLIERS: Record<OvertimeType, number> = {
  [OvertimeType.REGULAR]: 2,
  [OvertimeType.HOLIDAY]: 2,
  [OvertimeType.WEEKEND]: 2,
  [OvertimeType.NIGHT]: 2,
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
  // A rate saved before the legal minimum applied is still raised to it.
  const atLeastMinimum = (rate: number) =>
    Math.max(rate, MIN_OVERTIME_MULTIPLIER);
  return {
    [OvertimeType.REGULAR]: atLeastMinimum(s.otRegularRate),
    [OvertimeType.HOLIDAY]: atLeastMinimum(s.otHolidayRate),
    [OvertimeType.WEEKEND]: atLeastMinimum(s.otWeekendRate),
    [OvertimeType.NIGHT]: atLeastMinimum(s.otNightRate),
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

    // The Admin's overtime policy (Org Settings > General Settings > Overtime): who may log, how late, how much.
    const policy = await getOvertimePolicy(this.scopedPrisma, organizationId);
    if (policy.creationMode === 'AUTO') {
      throw new BadRequestException(
        'Overtime is recorded automatically from your punches, so it cannot be logged by hand.',
      );
    }
    if (policy.claimWithinDays !== null) {
      const { timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(
        new Date(),
      );
      if (daysSince(dto.date, today) > policy.claimWithinDays) {
        throw new BadRequestException(
          `Overtime can be requested within ${policy.claimWithinDays} day(s) of the date. Please speak to HR.`,
        );
      }
    }
    const hours = roundOvertimeHours(dto.hours, policy);
    if (hours * 60 < policy.minMinutes) {
      throw new BadRequestException(
        `Overtime under ${policy.minMinutes} minute(s) is not counted.`,
      );
    }
    const { usedThisMonth } = await this.usageFor(
      actor.id,
      dto.date,
      organizationId,
    );
    const capProblem = overtimeCapProblem(policy, hours, 0, usedThisMonth);
    if (capProblem.block) throw new BadRequestException(capProblem.block);

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
          `Cannot log ${type.toLowerCase()} overtime for ${formatDateDisplay(dto.date)} — attendance for that day is marked ${attendance.status.toLowerCase().replace('_', ' ')}.`,
        );
      }
    }

    await this.assertDayAllowsOvertime(dto, type, actor, organizationId);

    // One day, one benefit: weekend/holiday work already claimed as comp-off is not also logged as overtime.
    if (type === OvertimeType.WEEKEND || type === OvertimeType.HOLIDAY) {
      const claimedCompOff = await this.scopedPrisma.compOff.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          earnedForDate: dto.date,
          status: { not: CompOffStatus.REJECTED },
        },
      });
      if (claimedCompOff) {
        throw new ConflictException(
          `A comp-off was already claimed for ${formatDateDisplay(dto.date)}. The same work cannot also be logged as overtime.`,
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
        `An overtime record already exists for ${formatDateDisplay(dto.date)} (status: ${existing.status.toLowerCase()}). Edit or cancel it instead of logging a new one.`,
      );
    }

    const record = await this.scopedPrisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: actor.id,
        date: dto.date,
        hours,
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
      details: { employeeId: actor.id, date: dto.date, hours, type },
    });
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'OVERTIME_LOGGED',
      performedById: actor.id,
      description: `Logged ${hours} hour(s) of ${type.toLowerCase()} overtime on ${formatDateDisplay(dto.date, '', dateFormat, timeZone)}.`,
    });
    await this.notificationsService.notifyReviewers({
      organizationId,
      requester: actor,
      title: 'Overtime Requested',
      message: `${actor.name} logged ${hours} hour(s) of overtime for ${formatDateDisplay(dto.date, '', dateFormat, timeZone)}, pending your approval.`,
      category: NotificationCategory.ATTENDANCE,
      managerFirst: true,
    });

    // WARN mode: saved, but the person is told the cap was passed.
    return capProblem.warn ? { ...record, warning: capProblem.warn } : record;
  }

  // Overtime already logged (pending or approved) in the month of `date`, and on that day.
  async usageFor(employeeId: string, date: string, organizationId: string) {
    const [y, m] = date.split('-').map(Number);
    const { from, to } = monthRange(m, y);
    const rows = await this.scopedPrisma.overtimeRecord.findMany({
      where: {
        organizationId,
        employeeId,
        date: { gte: from, lte: to },
        status: { not: OvertimeStatus.REJECTED },
      },
      select: { date: true, hours: true },
    });
    return {
      usedThisMonth: rows.reduce((a, r) => a + r.hours, 0),
      usedToday: rows
        .filter((r) => r.date === date)
        .reduce((a, r) => a + r.hours, 0),
    };
  }

  // The policy plus the caller's own usage this month, so the log form can show "x of y hours used" and hide itself
  // for someone who is not eligible.
  async myPolicy(actor: Actor, organizationId: string) {
    const policy = await getOvertimePolicy(this.scopedPrisma, organizationId);
    const { timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(
      new Date(),
    );
    const { usedThisMonth } = await this.usageFor(
      actor.id,
      today,
      organizationId,
    );
    return {
      creationMode: policy.creationMode,
      minMinutes: policy.minMinutes,
      roundingMinutes: policy.roundingMinutes,
      maxHoursPerDay: policy.maxHoursPerDay,
      maxHoursPerMonth: policy.maxHoursPerMonth,
      capMode: policy.capMode,
      claimWithinDays: policy.claimWithinDays,
      usedThisMonth: Math.round(usedThisMonth * 100) / 100,
    };
  }

  // The type picks the pay rate, so it has to match the calendar (weekly off -> weekend, holiday -> holiday, else
  // regular/night), the date cannot be in the future, and the hours have to fit inside the time actually punched.
  private async assertDayAllowsOvertime(
    dto: LogOvertimeDto,
    type: OvertimeType,
    actor: Actor,
    organizationId: string,
  ) {
    const [org, employee, attendance] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true, timezone: true },
      }),
      this.scopedPrisma.user.findFirst({
        where: { id: actor.id, organizationId },
        include: { department: true },
      }),
      this.scopedPrisma.attendance.findFirst({
        where: { organizationId, employeeId: actor.id, date: dto.date },
      }),
    ]);
    const timeZone = org?.timezone || 'Asia/Kolkata';
    const shiftConfig = resolveShiftConfig(
      employee?.department ?? null,
      org?.attendancePayrollPrefs as never,
      timeZone,
    );
    const holiday = await this.scopedPrisma.holiday.findFirst({
      where: {
        organizationId,
        isActive: true,
        date: dto.date,
        OR: employee?.departmentId
          ? [{ departmentId: null }, { departmentId: employee.departmentId }]
          : [{ departmentId: null }],
      },
    });
    // A holiday wins over a weekly off, same as the attendance engine.
    const dayKind: DayKind = holiday
      ? 'HOLIDAY'
      : isWeeklyOff(dto.date, shiftConfig.weeklyOffs)
        ? 'WEEKLY_OFF'
        : 'WORKING';
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const problem = overtimeDayProblem({
      type,
      date: dto.date,
      today,
      dayKind,
      workedMinutes: attendance?.workDurationMinutes ?? 0,
      hours: dto.hours,
      breakMinutes: shiftConfig.breakMinutes ?? 0,
    });
    if (problem) throw new BadRequestException(problem);
  }

  // The compensation options for weekend/holiday work and which one is the default.
  async compensationOptions(organizationId: string) {
    const settings = await this.scopedPrisma.payrollSettings.findFirst({
      where: { organizationId },
      select: { workCompensation: true },
    });
    // Only the options that grant something: 0 / 0 placeholders are not offered, and not accepted on approval.
    return selectableWorkCompensation(
      resolveWorkCompensation(settings?.workCompensation),
    );
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
            // Who decided it, so the employee's list can say "Approved by ...".
            approvedBy: { select: { id: true, name: true } },
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
    // Approved overtime is paid through payroll for its month: reviewing it after that month is locked/paid would
    // never reach the payslip, and a signed-off run must be recalculated to pick it up.
    const overtimeMonth = [
      {
        month: Number(record.date.slice(5, 7)),
        year: Number(record.date.slice(0, 4)),
      },
    ];
    await assertPayrollMonthsUnlocked(
      this.scopedPrisma,
      organizationId,
      record.employeeId,
      overtimeMonth,
      'overtime',
    );

    // Weekend/holiday work can be compensated in comp-off and/or whole days of pay instead of hours x multiplier. The
    // approver's choice (or the organisation's default) is stored on the record; payroll and the comp-off balance
    // follow from it. Ordinary-day overtime stays on the hourly rate.
    const isOffDayWork =
      record.type === OvertimeType.WEEKEND ||
      record.type === OvertimeType.HOLIDAY;
    if (dto.status === OvertimeStatus.REJECTED && dto.compensationKey) {
      throw new BadRequestException(
        'A compensation option can only be chosen when approving.',
      );
    }
    if (dto.compensationKey && !isOffDayWork) {
      throw new BadRequestException(
        'Compensation options apply only to weekend and holiday work.',
      );
    }
    const option =
      dto.status === OvertimeStatus.APPROVED && isOffDayWork
        ? pickWorkCompensation(
            await this.compensationOptions(organizationId),
            dto.compensationKey,
          )
        : null;

    // One day, one benefit: a comp-off already claimed for the same day (or granted by an approved record) stops a
    // second reward for the same work.
    if (dto.status === OvertimeStatus.APPROVED && isOffDayWork) {
      const claimed = await this.scopedPrisma.compOff.findFirst({
        where: {
          organizationId,
          employeeId: record.employeeId,
          earnedForDate: record.date,
          status: { not: CompOffStatus.REJECTED },
        },
      });
      if (claimed) {
        throw new ConflictException(
          'A comp-off was already claimed for this day. Reject one of the two, so the same work is not rewarded twice.',
        );
      }
    }

    // Guarded compare-and-swap — see LoansService.approve()'s comment for
    // the general reasoning. The comp-off (when the option grants one) is created in the same transaction.
    const settings =
      option && option.compOffDays > 0
        ? await this.scopedPrisma.payrollSettings.findFirst({
            where: { organizationId },
            select: { compOffExpiryDays: true },
          })
        : null;
    const reviewed = await this.scopedPrisma.$transaction(async (tx) => {
      const { count } = await tx.overtimeRecord.updateMany({
        where: { id, organizationId, status: OvertimeStatus.PENDING },
        data: {
          status: dto.status,
          approvedById: actor.id,
          decisionNote: dto.comments?.trim() || null,
          ...(option && {
            compensationKey: option.key,
            payDays: option.payDays,
            compOffDays: option.compOffDays,
          }),
        },
      });
      if (count === 0) return false;
      if (option && option.compOffDays > 0) {
        let expiryDate: string | null = null;
        const expiryDays = settings?.compOffExpiryDays ?? 90;
        if (expiryDays > 0) {
          const expiry = new Date(`${record.date}T00:00:00.000Z`);
          expiry.setUTCDate(expiry.getUTCDate() + expiryDays);
          expiryDate = expiry.toISOString().slice(0, 10);
        }
        const compOff = await tx.compOff.create({
          data: {
            organizationId,
            employeeId: record.employeeId,
            earnedForDate: record.date,
            reason: `Weekend/holiday work (overtime approved): ${option.label}`,
            daysEarned: option.compOffDays,
            expiryDate,
            status: CompOffStatus.APPROVED,
            approvedById: actor.id,
            approvedAt: new Date(),
          },
        });
        await tx.overtimeRecord.updateMany({
          where: { id, organizationId },
          data: { compOffId: compOff.id },
        });
      }
      return true;
    });
    if (!reviewed) {
      throw new ConflictException('This overtime record was already reviewed.');
    }

    if (dto.status === OvertimeStatus.APPROVED) {
      await markPayrollInputsChanged(
        this.scopedPrisma,
        organizationId,
        record.employeeId,
        overtimeMonth,
      );
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
      details: {
        employeeId: record.employeeId,
        status: dto.status,
        ...(dto.comments?.trim() && { comments: dto.comments.trim() }),
        ...(option && {
          compensation: option.key,
          compOffDays: option.compOffDays,
          payDays: option.payDays,
        }),
      },
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
      const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const title = `Overtime Request ${dto.status}`;
      const message = `Your overtime of ${record.hours} hour(s) on ${formatDateDisplay(record.date, '', dateFormat, timeZone)} has been ${dto.status.toLowerCase()}.${dto.comments?.trim() ? ` Comments: ${dto.comments.trim()}` : ''}`;
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
          date: formatDateDisplay(record.date, '', dateFormat, timeZone),
          status: dto.status,
          comments: dto.comments?.trim() ?? '',
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
