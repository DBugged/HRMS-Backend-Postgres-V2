import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AttendanceSource,
  AttendanceStatus,
  ImportBatchStatus,
  Leave,
  LeaveStatus,
  NotificationCategory,
  Prisma,
  PunchSource,
  Role,
  User,
  WfhApprovalStatus,
  WorkArrangement,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { isInsideGeoFence } from '../work-locations/geo-fence';
import { paginate } from '../common/pagination';
import {
  enumerateDateStrings,
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from './attendance-shift-config';
import { IngestPunchDto } from './dto/ingest-punch.dto';
import { ManualPunchDto } from './dto/manual-punch.dto';
import { SelfPunchDto } from './dto/self-punch.dto';
import { SetWorkArrangementDto } from './dto/set-work-arrangement.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { RequestRegularizationDto } from './dto/request-regularization.dto';
import { ReviewRegularizationDto } from './dto/review-regularization.dto';
import { ReviewWfhDto } from './dto/review-wfh.dto';
import { UploadImportBatchDto } from './dto/upload-import-batch.dto';
import { NotifyAbsenteesDto } from './dto/notify-absentees.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';

type Actor = Omit<User, 'password'>;
// Either the plain scoped client or a $transaction callback's tx client —
// recalculateAttendanceForDay/the Leave-integration hooks run inside
// whichever one the caller is already using.
type Db = ExtendedPrismaClient | Prisma.TransactionClient;

// Old system's UTC-based day-boundary/`todayStr()` convention — matches
// leaves.service.ts's own todayStr() exactly, since revertAttendanceForLeave
// compares directly against Leave's plain-string startDate/endDate fields.
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcDateStrOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildShiftDateTime(dateStr: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(
    `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`,
  );
}

function dayRangeUtc(dateStr: string): { gte: Date; lt: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { gte: start, lt: end };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors the old Mongo subdocument shape verbatim (see the Attendance
// model's own comment) — kept as a local interface only for typed access
// inside this service, not persisted as anything but plain JSON.
interface RegularizationState {
  requested: boolean;
  reason: string;
  requestedInTime: string | null;
  requestedOutTime: string | null;
  status: 'none' | 'pending' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComments: string;
}

// Untyped, client-parsed spreadsheet cells — coerces only actual
// strings/numbers/booleans rather than blindly calling String() on an
// arbitrary unknown, same reasoning as HolidaysService's asString.
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

interface ImportRow {
  employeeId?: unknown;
  date?: unknown;
  inTime?: unknown;
  outTime?: unknown;
  inLocation?: unknown;
  outLocation?: unknown;
}

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  // The core engine — derives an Attendance row for one employee/day from
  // that day's Punch rows (plus Holiday/Leave context), preserving any
  // fields it doesn't own (notably `regularization` and `workArrangement`)
  // via a read-merge-write pattern rather than a blind upsert.
  async recalculateAttendanceForDay(
    db: Db,
    employeeId: string,
    dateStr: string,
    organizationId: string,
  ) {
    const employee = await db.user.findFirst({
      where: { id: employeeId, organizationId },
      include: { department: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    const shiftConfig = resolveShiftConfig(
      employee.department,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );

    const punches = await db.punch.findMany({
      where: { organizationId, employeeId, punchTime: dayRangeUtc(dateStr) },
      orderBy: { punchTime: 'asc' },
    });

    const holiday = await db.holiday.findFirst({
      where: {
        organizationId,
        date: dateStr,
        OR: employee.departmentId
          ? [{ departmentId: null }, { departmentId: employee.departmentId }]
          : [{ departmentId: null }],
      },
    });

    let status: AttendanceStatus;
    let inTime: Date | null = null;
    let outTime: Date | null = null;
    let checkinLocation: string | null = null;
    let checkinLatitude: number | null = null;
    let checkinLongitude: number | null = null;
    let checkinSelfieUrl: string | null = null;
    let checkoutLocation: string | null = null;
    let checkoutLatitude: number | null = null;
    let checkoutLongitude: number | null = null;
    let checkoutSelfieUrl: string | null = null;
    let workDurationMinutes = 0;
    let isLate = false;
    let isEarlyOut = false;

    if (punches.length > 0) {
      const first = punches[0];
      const last = punches[punches.length - 1];
      inTime = first.punchTime;
      outTime = last.punchTime;
      checkinLocation = first.location;
      checkinLatitude = first.latitude;
      checkinLongitude = first.longitude;
      checkinSelfieUrl = first.selfieUrl;
      checkoutLocation = last.location;
      checkoutLatitude = last.latitude;
      checkoutLongitude = last.longitude;
      checkoutSelfieUrl = last.selfieUrl;
      workDurationMinutes = Math.max(
        0,
        Math.round((outTime.getTime() - inTime.getTime()) / 60000),
      );

      const shiftStart = buildShiftDateTime(
        dateStr,
        shiftConfig.shiftStartTime,
      );
      const shiftEnd = buildShiftDateTime(dateStr, shiftConfig.shiftEndTime);
      isLate =
        inTime.getTime() - shiftStart.getTime() >
        shiftConfig.lateInThresholdMinutes * 60000;
      isEarlyOut =
        shiftEnd.getTime() - outTime.getTime() >
        shiftConfig.earlyOutThresholdMinutes * 60000;

      const hours = workDurationMinutes / 60;
      if (hours >= shiftConfig.minHoursForPresent) {
        status = AttendanceStatus.PRESENT;
      } else if (hours >= shiftConfig.minHoursForHalfDay) {
        status = AttendanceStatus.HALF_DAY;
      } else {
        status = AttendanceStatus.ABSENT;
      }
    } else {
      const approvedLeave = await db.leave.findFirst({
        where: {
          organizationId,
          employeeId,
          status: LeaveStatus.APPROVED,
          startDate: { lte: dateStr },
          endDate: { gte: dateStr },
        },
      });
      status = approvedLeave
        ? approvedLeave.isHalfDay
          ? AttendanceStatus.HALF_DAY
          : AttendanceStatus.ON_LEAVE
        : AttendanceStatus.ABSENT;
    }

    // Overrides, in priority order — a holiday wins even over an
    // approved-leave-derived status; weekly-off only overrides a bare
    // ABSENT (never on_leave/half_day), matching the old system exactly.
    if (holiday) {
      status = AttendanceStatus.HOLIDAY;
    } else if (
      isWeeklyOff(dateStr, shiftConfig.weeklyOffs) &&
      status === AttendanceStatus.ABSENT
    ) {
      status = AttendanceStatus.WEEKLY_OFF;
    }

    const fields = {
      status,
      inTime,
      outTime,
      checkinLocation,
      checkinLatitude,
      checkinLongitude,
      checkinSelfieUrl,
      checkoutLocation,
      checkoutLatitude,
      checkoutLongitude,
      checkoutSelfieUrl,
      workDurationMinutes,
      isLate,
      isEarlyOut,
      // Reflects "how was this row last derived" — always FACE_API on
      // recalculation regardless of which punch source triggered it.
      source: AttendanceSource.FACE_API,
    };

    const existing = await db.attendance.findFirst({
      where: { organizationId, employeeId, date: dateStr },
    });

    if (existing) {
      // Only the fields this engine owns are touched — workArrangement and
      // regularization (set by other write paths) must survive untouched.
      await db.attendance.updateMany({
        where: { id: existing.id, organizationId },
        data: fields,
      });
    } else {
      await db.attendance.create({
        data: { organizationId, employeeId, date: dateStr, ...fields },
      });
    }

    await this.notifyLateOrAbsent(
      employeeId,
      dateStr,
      status,
      isLate,
      organizationId,
    );

    return db.attendance.findFirstOrThrow({
      where: { organizationId, employeeId, date: dateStr },
    });
  }

  // Notifies the employee when this recalculation marks them late (no
  // email) or absent (with email) — deduped per employee/date/reason via a
  // title-match lookup so a re-run of the same day's calc doesn't spam
  // repeat notifications, matching the old system's `alreadyNotified`
  // guard exactly.
  private async notifyLateOrAbsent(
    employeeId: string,
    dateStr: string,
    status: AttendanceStatus,
    isLate: boolean,
    organizationId: string,
  ) {
    if (status === AttendanceStatus.ABSENT) {
      const title = `Marked Absent — ${dateStr}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: employeeId, title },
      });
      if (!alreadyNotified) {
        await this.notificationsService.create({
          organizationId,
          userId: employeeId,
          title,
          message: `You were marked absent for ${dateStr}. Contact HR if this looks wrong.`,
          category: NotificationCategory.ATTENDANCE,
        });
      }
      // The email fires every recalculation run, not deduped — matches the
      // old system's behavior exactly (only the Notification row is deduped).
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
      });
      if (employee) {
        await this.emailService.send({
          to: employee.email,
          subject: title,
          html: `You were marked absent for ${dateStr}. Contact HR if this looks wrong.`,
        });
      }
      return;
    }

    if (isLate) {
      const title = `Marked Late — ${dateStr}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: employeeId, title },
      });
      if (!alreadyNotified) {
        await this.notificationsService.create({
          organizationId,
          userId: employeeId,
          title,
          message: `You were marked late for ${dateStr}.`,
          category: NotificationCategory.ATTENDANCE,
        });
      }
    }
  }

  async ingestFaceApiPunch(
    dto: IngestPunchDto,
    providedKey: string | undefined,
  ) {
    // Per-org key, not a single shared secret — a global key would let
    // anyone holding it forge punches for ANY organization by setting an
    // arbitrary organizationId in the payload (this webhook has no
    // session; organizationId is caller-supplied by design). Fail-closed:
    // an org with no key configured yet can't be punched into via this
    // endpoint at all, rather than falling back to a shared secret.
    if (!providedKey) {
      throw new UnauthorizedException('Invalid or missing Face API key.');
    }
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: dto.organizationId, faceApiKey: providedKey },
      select: { id: true },
    });
    if (!org) {
      throw new UnauthorizedException('Invalid or missing Face API key.');
    }

    const user = await this.scopedPrisma.user.findFirst({
      where: { organizationId: dto.organizationId, employeeId: dto.employeeId },
    });
    if (!user) throw new NotFoundException('Employee not found.');

    const rawPayload = dto.rawPayload as
      { location?: string; latitude?: number; longitude?: number } | undefined;
    const punchTime = dto.punchTime ? new Date(dto.punchTime) : new Date();

    const punch = await this.scopedPrisma.punch.create({
      data: {
        organizationId: dto.organizationId,
        employeeId: user.id,
        punchTime,
        source: PunchSource.FACE_API,
        location: dto.location ?? rawPayload?.location ?? null,
        latitude: dto.latitude ?? rawPayload?.latitude ?? null,
        longitude: dto.longitude ?? rawPayload?.longitude ?? null,
        rawPayload: dto.rawPayload
          ? (dto.rawPayload as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });

    const attendance = await this.recalculateAttendanceForDay(
      this.scopedPrisma,
      user.id,
      utcDateStrOf(punchTime),
      dto.organizationId,
    );

    return { punch, attendance };
  }

  async manualPunch(dto: ManualPunchDto, organizationId: string) {
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!user) throw new NotFoundException('Employee not found.');

    const punchTime = dto.punchTime ? new Date(dto.punchTime) : new Date();
    const punch = await this.scopedPrisma.punch.create({
      data: {
        organizationId,
        employeeId: user.id,
        punchTime,
        source: PunchSource.MANUAL,
        location: dto.location ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      },
    });

    const attendance = await this.recalculateAttendanceForDay(
      this.scopedPrisma,
      user.id,
      utcDateStrOf(punchTime),
      organizationId,
    );

    return { punch, attendance };
  }

  async selfPunch(dto: SelfPunchDto, actor: Actor, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      include: { department: { include: { workLocation: true } } },
    });
    const fence = employee?.department?.workLocation;
    if (fence && fence.isActive) {
      // WFH-only, and only once approved (see WfhApprovalStatus's comment
      // on the schema) — a self-declared-but-unreviewed WFH day, or any
      // other arrangement (HYBRID/CLIENT_SITE included), still enforces
      // the fence exactly as before. Checked fresh on every punch (not
      // just punch-in) so switching arrangement mid-day is respected.
      const today = await this.scopedPrisma.attendance.findFirst({
        where: { organizationId, employeeId: actor.id, date: todayStr() },
        select: { workArrangement: true, workArrangementStatus: true },
      });
      const wfhExempt =
        today?.workArrangement === WorkArrangement.WFH &&
        today?.workArrangementStatus === WfhApprovalStatus.APPROVED;

      if (!wfhExempt) {
        const inside = isInsideGeoFence(dto.latitude, dto.longitude, fence);
        if (inside === false) {
          throw new ForbiddenException(
            `You must be inside your office geo-fence (${fence.name}) to punch in/out.`,
          );
        }
      }
    }

    const punchTime = new Date();
    const punch = await this.scopedPrisma.punch.create({
      data: {
        organizationId,
        employeeId: actor.id,
        punchTime,
        source: PunchSource.MANUAL,
        latitude: dto.latitude,
        longitude: dto.longitude,
        selfieUrl: dto.selfieUrl ?? null,
      },
    });

    const attendance = await this.recalculateAttendanceForDay(
      this.scopedPrisma,
      actor.id,
      utcDateStrOf(punchTime),
      organizationId,
    );

    const punchCount = await this.scopedPrisma.punch.count({
      where: {
        organizationId,
        employeeId: actor.id,
        punchTime: dayRangeUtc(utcDateStrOf(punchTime)),
      },
    });

    return { punch, attendance, punchCount };
  }

  async getTodayPunchCount(actor: Actor, organizationId: string) {
    const punchCount = await this.scopedPrisma.punch.count({
      where: {
        organizationId,
        employeeId: actor.id,
        punchTime: dayRangeUtc(todayStr()),
      },
    });
    return { punchCount };
  }

  async setWorkArrangement(
    dto: SetWorkArrangementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const isWfh = dto.workArrangement === WorkArrangement.WFH;
    if (isWfh) {
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });
      if (!org?.enableWFH) {
        throw new BadRequestException(
          'Work From Home is disabled for this organization.',
        );
      }
    }

    // Only WFH ever needs review (it's the only arrangement that can
    // exempt a punch from geo-fencing — see selfPunch). Switching to any
    // other arrangement always resets to NONE, clearing out a stale
    // pending/approved/rejected WFH review from an earlier change of mind
    // for the same date, same "fresh request clears prior review state"
    // reasoning as requestRegularization.
    const workArrangementFields = {
      workArrangement: dto.workArrangement,
      workArrangementStatus: isWfh
        ? WfhApprovalStatus.PENDING
        : WfhApprovalStatus.NONE,
      workArrangementReviewedById: null,
      workArrangementReviewedAt: null,
      workArrangementReviewComments: null,
    };

    const dateStr = dto.date ?? todayStr();
    const existing = await this.scopedPrisma.attendance.findFirst({
      where: { organizationId, employeeId: actor.id, date: dateStr },
    });

    if (existing) {
      await this.scopedPrisma.attendance.updateMany({
        where: { id: existing.id, organizationId },
        data: workArrangementFields,
      });
    } else {
      await this.scopedPrisma.attendance.create({
        data: {
          organizationId,
          employeeId: actor.id,
          date: dateStr,
          ...workArrangementFields,
        },
      });
    }

    if (isWfh) {
      await this.timelineService.logEvent({
        organizationId,
        employeeId: actor.id,
        eventKey: 'WFH_REQUESTED',
        performedById: actor.id,
        description: `Requested Work From Home for ${dateStr}.`,
      });
      await this.notifyWfhRequested(actor, dateStr, organizationId);
    }

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId: actor.id, date: dateStr },
    });
  }

  // Same ported-against-reportingManagerId reasoning as
  // notifyRegularizationRequested — no manager, no notification (HR still
  // sees it via listPendingWfhRequests).
  private async notifyWfhRequested(
    actor: Actor,
    date: string,
    organizationId: string,
  ) {
    if (!actor.reportingManagerId || actor.reportingManagerId === actor.id) {
      return;
    }
    await this.notificationsService.create({
      organizationId,
      userId: actor.reportingManagerId,
      title: 'Work From Home Requested',
      message: `${actor.name} requested Work From Home for ${date}, pending your approval.`,
      category: NotificationCategory.ATTENDANCE,
    });
  }

  // HR/Admin sees every pending WFH request org-wide; a MANAGER sees only
  // their own department's — same scoping idiom as list()'s MANAGER
  // branch, deliberately not the "any HR/MANAGER reviews anyone" pattern
  // regularization uses, since an unreviewed WFH request is what lets a
  // punch skip geo-fencing (see selfPunch) and a manager approving a
  // stranger's location claim doesn't make sense.
  async listPendingWfhRequests(actor: Actor, organizationId: string) {
    const where: Prisma.AttendanceWhereInput = {
      organizationId,
      workArrangement: WorkArrangement.WFH,
      workArrangementStatus: WfhApprovalStatus.PENDING,
    };

    if (actor.role === Role.MANAGER) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: actor.departmentId },
        select: { id: true },
      });
      where.employeeId = { in: deptEmployees.map((e) => e.id) };
    }

    return this.scopedPrisma.attendance.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  // `id` is the Attendance row's id, same convention as
  // reviewRegularization. MANAGER is restricted to their own department's
  // employees (unlike reviewRegularization) — see listPendingWfhRequests's
  // comment for why.
  async reviewWorkArrangement(
    id: string,
    dto: ReviewWfhDto,
    actor: Actor,
    organizationId: string,
  ) {
    const row = await this.scopedPrisma.attendance.findFirst({
      where: { id, organizationId },
      include: { employee: true },
    });
    if (!row) throw new NotFoundException('Attendance record not found.');
    if (row.workArrangement !== WorkArrangement.WFH) {
      throw new BadRequestException(
        'This attendance record has no Work From Home request.',
      );
    }
    if (actor.role === Role.MANAGER) {
      if (row.employee.departmentId !== actor.departmentId) {
        throw new ForbiddenException(
          "You can only review your own department's requests.",
        );
      }
    }

    const status =
      dto.decision === 'APPROVED'
        ? WfhApprovalStatus.APPROVED
        : WfhApprovalStatus.REJECTED;

    await this.scopedPrisma.attendance.updateMany({
      where: { id, organizationId },
      data: {
        workArrangementStatus: status,
        workArrangementReviewedById: actor.id,
        workArrangementReviewedAt: new Date(),
        workArrangementReviewComments: dto.comments ?? '',
      },
    });

    await this.timelineService.logEvent({
      organizationId,
      employeeId: row.employeeId,
      eventKey: dto.decision === 'APPROVED' ? 'WFH_APPROVED' : 'WFH_REJECTED',
      performedById: actor.id,
      description: dto.comments ?? '',
    });

    const title = `Work From Home Request ${dto.decision}`;
    const message = `Your Work From Home request for ${row.date} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
    await this.notificationsService.create({
      organizationId,
      userId: row.employeeId,
      title,
      message,
      category: NotificationCategory.ATTENDANCE,
    });
    await this.emailService.send({
      to: row.employee.email,
      subject: title,
      html: message,
    });

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async getMyGeoFence(actor: Actor, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      include: { department: { include: { workLocation: true } } },
    });
    const fence = employee?.department?.workLocation;
    if (!fence || fence.isActive === false) {
      return { geoFence: null };
    }
    return { geoFence: fence };
  }

  async list(query: QueryAttendanceDto, actor: Actor, organizationId: string) {
    const where: Prisma.AttendanceWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: actor.departmentId },
        select: { id: true },
      });
      const deptEmployeeIds = new Set(deptEmployees.map((e) => e.id));
      where.employeeId =
        query.employeeId && deptEmployeeIds.has(query.employeeId)
          ? query.employeeId
          : { in: [...deptEmployeeIds] };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    } else if (query.department) {
      const deptEmployees = await this.scopedPrisma.user.findMany({
        where: { organizationId, departmentId: query.department },
        select: { id: true },
      });
      where.employeeId = { in: deptEmployees.map((e) => e.id) };
    }

    if (query.from || query.to) {
      where.date = {
        ...(query.from && { gte: query.from }),
        ...(query.to && { lte: query.to }),
      };
    }
    if (query.status) where.status = query.status;

    const result = await paginate(
      () =>
        this.scopedPrisma.attendance.findMany({
          where,
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                employeeId: true,
                department: { include: { workLocation: true } },
              },
            },
          },
          orderBy: { date: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      () => this.scopedPrisma.attendance.count({ where }),
      query.page,
      query.limit,
    );

    return {
      ...result,
      data: result.data.map((record) => {
        const fence = record.employee.department?.workLocation;
        const checkinInsideGeoFence =
          fence &&
          record.checkinLatitude !== null &&
          record.checkinLongitude !== null
            ? isInsideGeoFence(
                record.checkinLatitude,
                record.checkinLongitude,
                fence,
              )
            : null;
        return { ...record, checkinInsideGeoFence };
      }),
    };
  }

  // Called from LeavesService.review() when a leave transitions to
  // APPROVED — writes exactly {status, source: SYSTEM} for every date in
  // the leave's range, nothing else. Must run inside the same transaction.
  async writeAttendanceForApprovedLeave(
    tx: Prisma.TransactionClient,
    leave: Leave,
    organizationId: string,
  ) {
    const status = leave.isHalfDay
      ? AttendanceStatus.HALF_DAY
      : AttendanceStatus.ON_LEAVE;

    for (const date of enumerateDateStrings(leave.startDate, leave.endDate)) {
      const existing = await tx.attendance.findFirst({
        where: { organizationId, employeeId: leave.employeeId, date },
      });
      if (existing) {
        await tx.attendance.updateMany({
          where: { id: existing.id, organizationId },
          data: { status, source: AttendanceSource.SYSTEM },
        });
      } else {
        await tx.attendance.create({
          data: {
            organizationId,
            employeeId: leave.employeeId,
            date,
            status,
            source: AttendanceSource.SYSTEM,
          },
        });
      }
    }
  }

  // Called from LeavesService's releaseHold() when a previously-approved
  // leave is cancelled/edited — only reverts dates >= today, and only rows
  // this same integration wrote (source === SYSTEM), never a row since
  // regularized/imported/punched over.
  async revertAttendanceForLeave(
    tx: Prisma.TransactionClient,
    leave: Leave,
    organizationId: string,
  ) {
    const today = todayStr();
    for (const date of enumerateDateStrings(leave.startDate, leave.endDate)) {
      if (date < today) continue;
      const existing = await tx.attendance.findFirst({
        where: { organizationId, employeeId: leave.employeeId, date },
      });
      if (existing && existing.source === AttendanceSource.SYSTEM) {
        await tx.attendance.updateMany({
          where: { id: existing.id, organizationId },
          data: {
            status: AttendanceStatus.ABSENT,
            source: AttendanceSource.FACE_API,
          },
        });
      }
    }
  }

  // Employee-initiated — no separate model, writes straight into the
  // Attendance row's `regularization` JSON. A full reassignment (not a
  // spread) so a fresh request always clears any prior review state.
  async requestRegularization(
    dto: RequestRegularizationDto,
    actor: Actor,
    organizationId: string,
  ) {
    if (dto.date > todayStr()) {
      throw new BadRequestException(
        'Cannot request regularization for a future date.',
      );
    }

    const regularization: RegularizationState = {
      requested: true,
      reason: dto.reason,
      requestedInTime: dto.requestedInTime ?? null,
      requestedOutTime: dto.requestedOutTime ?? null,
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewComments: '',
    };

    const existing = await this.scopedPrisma.attendance.findFirst({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });

    if (existing) {
      await this.scopedPrisma.attendance.updateMany({
        where: { id: existing.id, organizationId },
        data: {
          regularization: regularization as unknown as Prisma.InputJsonValue,
        },
      });
    } else {
      await this.scopedPrisma.attendance.create({
        data: {
          organizationId,
          employeeId: actor.id,
          date: dto.date,
          status: AttendanceStatus.ABSENT,
          source: AttendanceSource.SYSTEM,
          regularization: regularization as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await this.notifyRegularizationRequested(actor, dto.date, organizationId);

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });
  }

  // Ported against reportingManagerId rather than Department.departmentHeadId
  // — see the identical note on LeavesService.notifyNewLeaveApplication.
  private async notifyRegularizationRequested(
    actor: Actor,
    date: string,
    organizationId: string,
  ) {
    if (!actor.reportingManagerId || actor.reportingManagerId === actor.id) {
      return;
    }
    await this.notificationsService.create({
      organizationId,
      userId: actor.reportingManagerId,
      title: 'Attendance Regularization Requested',
      message: `${actor.name} requested attendance regularization for ${date}.`,
      category: NotificationCategory.REGULARIZATION,
    });
  }

  // Single-level review (HR or Manager, either decides) — `id` is the
  // Attendance row's id, not a separate request id. Unlike the request
  // write above, this SPREADS the existing regularization object (whole-
  // object reassignment, same as the old Sequelize JSON-column comment).
  async reviewRegularization(
    id: string,
    dto: ReviewRegularizationDto,
    actor: Actor,
    organizationId: string,
  ) {
    const row = await this.scopedPrisma.attendance.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Attendance record not found.');

    const existingReg = row.regularization as unknown as RegularizationState;
    const regularization: RegularizationState = {
      ...existingReg,
      status: dto.decision === 'APPROVED' ? 'approved' : 'rejected',
      reviewedBy: actor.id,
      reviewedAt: new Date().toISOString(),
      reviewComments: dto.comments ?? '',
    };

    const data: Prisma.AttendanceUpdateManyMutationInput = {
      regularization: regularization as unknown as Prisma.InputJsonValue,
    };

    if (dto.decision === 'APPROVED') {
      const inTime = existingReg.requestedInTime
        ? new Date(existingReg.requestedInTime)
        : row.inTime;
      const outTime = existingReg.requestedOutTime
        ? new Date(existingReg.requestedOutTime)
        : row.outTime;
      if (existingReg.requestedInTime) data.inTime = inTime;
      if (existingReg.requestedOutTime) data.outTime = outTime;

      // No shift-based late/half-day recompute here — a hard override,
      // matching the old system exactly.
      if (inTime && outTime) {
        data.workDurationMinutes = Math.max(
          0,
          Math.round((outTime.getTime() - inTime.getTime()) / 60000),
        );
        data.status = AttendanceStatus.PRESENT;
      }
      data.source = AttendanceSource.REGULARIZED;
    }

    await this.scopedPrisma.attendance.updateMany({
      where: { id, organizationId },
      data,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: row.employeeId, organizationId },
    });
    if (employee) {
      const title = `Regularization Request ${dto.decision}`;
      const message = `Your attendance regularization request for ${row.date} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.REGULARIZATION,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Stage 1 of 3 — stages raw rows for review, touches nothing on the
  // live Attendance ledger.
  async uploadImportBatch(
    dto: UploadImportBatchDto,
    actor: Actor,
    organizationId: string,
  ) {
    const batch = await this.scopedPrisma.attendanceImportBatch.create({
      data: {
        organizationId,
        uploadedById: actor.id,
        departmentId: actor.departmentId ?? null,
        fileName: dto.fileName ?? '',
        rows: dto.rows as unknown as Prisma.InputJsonValue,
      },
    });

    const hrUsers = await this.scopedPrisma.user.findMany({
      where: { organizationId, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    await this.notificationsService.createMany(
      hrUsers.map((u) => ({
        organizationId,
        userId: u.id,
        title: 'Attendance Import Batch Uploaded',
        message: `${actor.name} uploaded an attendance import batch${dto.fileName ? ` (${dto.fileName})` : ''} pending validation.`,
        category: NotificationCategory.ATTENDANCE,
      })),
    );

    return batch;
  }

  // MANAGER sees only batches they uploaded; HR/ADMIN sees every batch.
  async listImportBatches(actor: Actor, organizationId: string) {
    return this.scopedPrisma.attendanceImportBatch.findMany({
      where: {
        organizationId,
        ...(actor.role === Role.MANAGER && { uploadedById: actor.id }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Stage 2 of 3 — validates each row independently; stays
  // PENDING_VALIDATION (fixable, not auto-advanced) on any row error.
  async validateImportBatch(id: string, actor: Actor, organizationId: string) {
    const batch = await this.scopedPrisma.attendanceImportBatch.findFirst({
      where: { id, organizationId },
    });
    if (!batch) throw new NotFoundException('Import batch not found.');
    if (batch.status !== ImportBatchStatus.PENDING_VALIDATION) {
      throw new BadRequestException(
        'Only a batch pending validation can be validated.',
      );
    }

    const rows = batch.rows as unknown as ImportRow[];
    const employeeCodes = [
      ...new Set(
        rows.map((r) => asString(r.employeeId).trim()).filter(Boolean),
      ),
    ];
    const employees = employeeCodes.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, employeeId: { in: employeeCodes } },
          select: { employeeId: true },
        })
      : [];
    const knownCodes = new Set(employees.map((e) => e.employeeId));

    const failed: { row: number; error: string }[] = [];
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const empCode = asString(row.employeeId).trim();
      if (!empCode) {
        failed.push({ row: rowNum, error: 'employeeId is required' });
        return;
      }
      if (!knownCodes.has(empCode)) {
        failed.push({ row: rowNum, error: `Employee not found: ${empCode}` });
        return;
      }
      const date = asString(row.date).trim();
      if (
        !date ||
        !DATE_RE.test(date) ||
        Number.isNaN(new Date(date).getTime())
      ) {
        failed.push({
          row: rowNum,
          error: 'Invalid or missing date (expected YYYY-MM-DD)',
        });
      }
    });

    await this.scopedPrisma.attendanceImportBatch.updateMany({
      where: { id, organizationId },
      data: {
        validationErrors: failed,
        status:
          failed.length === 0
            ? ImportBatchStatus.VALIDATED
            : ImportBatchStatus.PENDING_VALIDATION,
        validatedById: actor.id,
        validatedAt: new Date(),
      },
    });

    return this.scopedPrisma.attendanceImportBatch.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Stage 3 of 3 — the only stage that writes to the live Attendance
  // ledger. Never overwrites a row already sourced from a biometric punch.
  async executeImportBatch(id: string, actor: Actor, organizationId: string) {
    const batch = await this.scopedPrisma.attendanceImportBatch.findFirst({
      where: { id, organizationId },
    });
    if (!batch) throw new NotFoundException('Import batch not found.');
    if (batch.status !== ImportBatchStatus.VALIDATED) {
      throw new BadRequestException('Only a validated batch can be executed.');
    }

    const rows = batch.rows as unknown as ImportRow[];
    const employeeCodes = [
      ...new Set(
        rows.map((r) => asString(r.employeeId).trim()).filter(Boolean),
      ),
    ];
    const employees = employeeCodes.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, employeeId: { in: employeeCodes } },
          select: { id: true, employeeId: true },
        })
      : [];
    const byCode = new Map(employees.map((e) => [e.employeeId, e.id]));

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      const empCode = asString(row.employeeId).trim();
      const empId = byCode.get(empCode);
      const date = asString(row.date).trim();
      if (!empId || !date) {
        errors += 1;
        continue;
      }

      try {
        const existing = await this.scopedPrisma.attendance.findFirst({
          where: { organizationId, employeeId: empId, date },
        });
        if (
          existing &&
          existing.source === AttendanceSource.FACE_API &&
          existing.inTime
        ) {
          skipped += 1;
          continue;
        }

        const fields = {
          status: AttendanceStatus.PRESENT,
          source: AttendanceSource.EXCEL_IMPORT,
          inTime: row.inTime ? new Date(asString(row.inTime)) : null,
          outTime: row.outTime ? new Date(asString(row.outTime)) : null,
          checkinLocation: row.inLocation ? asString(row.inLocation) : null,
          checkoutLocation: row.outLocation ? asString(row.outLocation) : null,
        };

        if (existing) {
          await this.scopedPrisma.attendance.updateMany({
            where: { id: existing.id, organizationId },
            data: fields,
          });
        } else {
          await this.scopedPrisma.attendance.create({
            data: { organizationId, employeeId: empId, date, ...fields },
          });
        }
        imported += 1;
      } catch {
        errors += 1;
      }
    }

    await this.scopedPrisma.attendanceImportBatch.updateMany({
      where: { id, organizationId },
      data: {
        status: ImportBatchStatus.EXECUTED,
        executedById: actor.id,
        executedAt: new Date(),
        executionResult: {
          imported,
          skipped,
          errors,
        },
      },
    });

    return this.scopedPrisma.attendanceImportBatch.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async rejectImportBatch(id: string, actor: Actor, organizationId: string) {
    const batch = await this.scopedPrisma.attendanceImportBatch.findFirst({
      where: { id, organizationId },
    });
    if (!batch) throw new NotFoundException('Import batch not found.');

    await this.scopedPrisma.attendanceImportBatch.updateMany({
      where: { id, organizationId },
      data: {
        status: ImportBatchStatus.REJECTED,
        validatedById: actor.id,
        validatedAt: new Date(),
      },
    });

    return this.scopedPrisma.attendanceImportBatch.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Forces a same-day recalculation for every employee/manager in the org
  // and reports who resolves to ABSENT. Actual notification/email delivery
  // is Batch 9 — this endpoint's shape is preserved so that batch can wire
  // in real delivery without a contract change.
  async notifyAbsentees(dto: NotifyAbsenteesDto, organizationId: string) {
    const date = dto.date ?? todayStr();

    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: [Role.EMPLOYEE, Role.MANAGER] },
      },
      select: { id: true },
    });

    const employeeIds: string[] = [];
    for (const employee of employees) {
      const row = await this.recalculateAttendanceForDay(
        this.scopedPrisma,
        employee.id,
        date,
        organizationId,
      );
      if (row.status === AttendanceStatus.ABSENT) {
        employeeIds.push(employee.id);
      }
    }

    return { date, notifiedCount: employeeIds.length, employeeIds };
  }
}
