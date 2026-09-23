// Purpose: Core attendance engine — derives daily Attendance rows from punches, holidays and approved
// leave, and manages punch ingestion, WFH/regularization review, and bulk Excel import workflows.
// Responsibilities: Owns recalculateAttendanceForDay() as the single source of truth for a day's status;
// integrates with LeavesService (write/revertAttendanceForLeave), NotificationsService and EmailService for
// alerts, and EmployeeTimelineService for WFH audit events; delegates geo-fence math to isInsideGeoFence.
// Important: recalculateAttendanceForDay() read-merges rather than blind-upserts, so it never clobbers
// workArrangement/regularization fields owned by other write paths — see the inline comments throughout
// for several other ported-behavior and concurrency-safety notes (e.g. sequential writes in
// executeImportBatch even though Attendance has a unique constraint on (organizationId, employeeId, date)).
import * as crypto from 'crypto';
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  Attendance,
  AttendanceSource,
  AttendanceStatus,
  Holiday,
  ImportBatchStatus,
  Leave,
  LeaveStatus,
  NotificationCategory,
  PayrollRunStatus,
  Prisma,
  Punch,
  PunchSource,
  Role,
  User,
  WfhApprovalStatus,
  WorkArrangement,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { signFileToken } from '../files/file-token';
import { isInsideGeoFence } from '../work-locations/geo-fence';
import { paginate, skip } from '../common/pagination';
import { mapWithConcurrency } from '../common/concurrency';
import { assertManagerScopeOrDelegate } from '../common/dept-scope';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import {
  enumerateDateStrings,
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
  type ShiftConfig,
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
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import {
  formatDateDisplay,
  resolveOrgDateTimeFormat,
} from '../payroll/format-date';

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

// Shift-day partitioning of the punch timeline.
//
// INVARIANT: for any timestamp t and shift config cfg,
//   resolveAttendanceDateForPunch(t, cfg) returns a date D such that t falls
//   inside shiftPunchWindow(D, cfg).
// Both functions are derived from ONE boundary (shiftDayBoundaryOffsetMs), so
// the windows of consecutive days tile the timeline with no gaps and no
// overlaps — every punch belongs to exactly one shift-day.
//
// For a normal shift the boundary is plain UTC midnight (window = calendar
// day). For a crossesMidnight shift (e.g. 22:00-06:00) the "quiet" gap between
// the shift's own end time and its own start time (06:00-22:00 on the same
// calendar day) is split at its midpoint (14:00): a punch in the first half is
// nearer the end of the previous night's shift (a late checkout), a punch in
// the second half is nearer the start of the coming night's shift (an early
// check-in). So day D's window is [D + boundary, D+1 + boundary), which always
// contains shiftStart(D) and shiftEnd(D+1). The boundary is derived from the
// shift's own shiftEndTime/shiftStartTime — never a hardcoded cutoff — so no
// punch is ever orphaned or silently dropped.
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Offset (ms, relative to UTC midnight of day D, may be negative) at which
// shift-day D's punch window begins.
function shiftDayBoundaryOffsetMs(
  shiftConfig: Pick<
    ShiftConfig,
    'crossesMidnight' | 'shiftStartTime' | 'shiftEndTime'
  >,
): number {
  if (!shiftConfig.crossesMidnight) return 0;
  const start = hhmmToMinutes(shiftConfig.shiftStartTime);
  const end = hhmmToMinutes(shiftConfig.shiftEndTime);
  // Length of the off-shift gap from shiftEnd to the next shiftStart.
  const gap = (((start - end) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  // Midpoint of that gap, expressed relative to day D's midnight such that it
  // never lies after shiftStart(D).
  return (start - gap / 2) * 60 * 1000;
}

function shiftPunchWindow(
  dateStr: string,
  shiftConfig: Pick<
    ShiftConfig,
    'crossesMidnight' | 'shiftStartTime' | 'shiftEndTime'
  >,
): { gte: Date; lt: Date } {
  const offset = shiftDayBoundaryOffsetMs(shiftConfig);
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return {
    gte: new Date(dayStart + offset),
    lt: new Date(dayStart + DAY_MS + offset),
  };
}

// Which shift-day a punch made at `punchTime` belongs to — see the invariant
// above. For a normal shift this is the punch's own UTC calendar date; for a
// crossesMidnight 22:00-06:00 shift, anything before 14:00 belongs to the
// previous calendar day's shift instance.
function resolveAttendanceDateForPunch(
  punchTime: Date,
  shiftConfig: Pick<
    ShiftConfig,
    'crossesMidnight' | 'shiftStartTime' | 'shiftEndTime'
  >,
): string {
  const offset = shiftDayBoundaryOffsetMs(shiftConfig);
  return utcDateStrOf(new Date(punchTime.getTime() - offset));
}

// Window within which a repeat punch from the same employee is treated as a
// duplicate tap (double-submit, device retry) rather than a new punch.
const DUPLICATE_PUNCH_WINDOW_MS = 10 * 1000;

// Parses an import-sheet timestamp as UTC. A bare "YYYY-MM-DD HH:mm[:ss]" (or
// with a "T" separator) carries no zone and is interpreted as UTC, matching
// buildShiftDateTime/dayRangeUtc — never server-local time. A string with an
// explicit "Z" or ±HH:mm offset is honored as-is. Returns null if unparseable.
const IMPORT_LOCAL_TS_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
const IMPORT_ZONED_TS_RE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function parseImportTimestampUtc(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  let parsed: Date;
  const local = IMPORT_LOCAL_TS_RE.exec(v);
  if (local) {
    const [, date, hh, mm, ss, frac] = local;
    parsed = new Date(`${date}T${hh}:${mm}:${ss ?? '00'}${frac ?? ''}Z`);
  } else if (IMPORT_ZONED_TS_RE.test(v)) {
    parsed = new Date(v.replace(' ', 'T'));
  } else {
    return null;
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Attendance feeding a LOCKED/PAID payroll run must not be rewritten out from
// under it — same rule (and same message shape) as LeavesService.cancel(): an
// Admin must unlock that payroll run first. Shared by every attendance write
// path so they all enforce it identically.
async function assertPayrollPeriodUnlocked(
  db: Db,
  organizationId: string,
  employeeId: string,
  dateStr: string,
): Promise<void> {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const lockedRun = await db.payrollRun.findFirst({
    where: {
      organizationId,
      employeeId,
      month,
      year,
      status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
    },
  });
  if (lockedRun) {
    throw new BadRequestException(
      `This attendance date (${dateStr}) falls within the ${lockedRun.month}/${lockedRun.year} payroll period, which is already ${lockedRun.status.toLowerCase()}. Ask an Admin to unlock that payroll run before changing this attendance.`,
    );
  }
}

function addDaysStr(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

// Selfies are stored as the storage relativeKey (POST /files/upload/selfies) — not servable as-is, so every read
// signs them, like receipts/documents. External http(s) links and already-signed /files/ URLs pass through.
function signSelfieKey(
  organizationId: string,
  key: string | null,
): string | null {
  if (!key || /^(https?:\/\/|\/files\/)/i.test(key)) return key;
  return `/files/${signFileToken(organizationId, key)}`;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly delegationService: ApprovalDelegationService,
    private readonly emailTemplatesService: EmailTemplatesService,
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

    // Looked up early (not just at write time below) so shift-config
    // resolution can prefer it: an existing row already snapshotted the
    // department it belonged to when first created (see
    // Attendance.departmentId's schema comment). Recalculating an old day
    // — e.g. a regularization review — must keep using *that* department's
    // shift config, not whatever department the employee has been
    // transferred to since; otherwise a retroactive recalculation could
    // silently apply the wrong weekly-offs/shift-hours to a historical day.
    const existing = await db.attendance.findFirst({
      where: { organizationId, employeeId, date: dateStr },
    });
    const departmentForShiftConfig =
      existing?.departmentId && existing.departmentId !== employee.departmentId
        ? await db.department.findFirst({
            where: { id: existing.departmentId, organizationId },
          })
        : employee.department;

    const shiftConfig = resolveShiftConfig(
      departmentForShiftConfig,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );

    const punches = await db.punch.findMany({
      where: {
        organizationId,
        employeeId,
        punchTime: shiftPunchWindow(dateStr, shiftConfig),
      },
      orderBy: { punchTime: 'asc' },
    });

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
    }

    const { status, workDurationMinutes, isLate, isEarlyOut } =
      await this.deriveDayOutcome(db, {
        organizationId,
        employeeId,
        employeeDepartmentId: employee.departmentId,
        dateStr,
        shiftConfig,
        inTime,
        outTime,
      });

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

    if (existing) {
      // Only the fields this engine owns are touched — workArrangement and
      // regularization (set by other write paths) must survive untouched.
      // departmentId is also deliberately absent from `fields`/never
      // touched here — it's a point-in-time snapshot, set once below on
      // first creation only.
      await db.attendance.updateMany({
        where: { id: existing.id, organizationId },
        data: fields,
      });
    } else {
      await db.attendance.create({
        data: {
          organizationId,
          employeeId,
          date: dateStr,
          departmentId: employee.departmentId,
          ...fields,
        },
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

  // The status/duration rules shared by recalculateAttendanceForDay (punch-
  // derived in/out) and executeImportBatch (sheet-supplied in/out), so both
  // apply identical shift-config/holiday/leave/weekly-off logic. A day with
  // only one of inTime/outTime is treated exactly like a single punch
  // (zero-length span).
  private async deriveDayOutcome(
    db: Db,
    params: {
      organizationId: string;
      employeeId: string;
      employeeDepartmentId: string | null;
      dateStr: string;
      shiftConfig: ShiftConfig;
      inTime: Date | null;
      outTime: Date | null;
      // Optional prefetched lookups — when the key is present (even with a
      // null value, meaning "prefetched, none found"), the corresponding
      // per-call DB query below is skipped in favor of this value. Only
      // executeImportBatch's bulk Excel-import path supplies these (one
      // holiday/leave prefetch for the whole file's date range instead of a
      // query per row); every other caller (recalculateAttendanceForDay)
      // omits them and gets the original per-call lookup, unchanged.
      holiday?: Holiday | null;
      approvedLeave?: Leave | null;
    },
  ): Promise<{
    status: AttendanceStatus;
    workDurationMinutes: number;
    isLate: boolean;
    isEarlyOut: boolean;
  }> {
    const { organizationId, employeeId, dateStr, shiftConfig } = params;
    const inTime = params.inTime ?? params.outTime;
    const outTime = params.outTime ?? params.inTime;

    const holiday =
      'holiday' in params
        ? params.holiday
        : await db.holiday.findFirst({
            where: {
              organizationId,
              isActive: true,
              date: dateStr,
              OR: params.employeeDepartmentId
                ? [
                    { departmentId: null },
                    { departmentId: params.employeeDepartmentId },
                  ]
                : [{ departmentId: null }],
            },
          });

    let status: AttendanceStatus;
    let workDurationMinutes = 0;
    let isLate = false;
    let isEarlyOut = false;

    if (inTime && outTime) {
      workDurationMinutes = Math.max(
        0,
        Math.round((outTime.getTime() - inTime.getTime()) / 60000),
      );

      const shiftStart = buildShiftDateTime(
        dateStr,
        shiftConfig.shiftStartTime,
      );
      // shiftEndTime is on the *next* calendar day for a crossesMidnight
      // shift (e.g. 22:00-06:00 — shiftEnd is 06:00 the morning after
      // dateStr), which always lies inside shiftPunchWindow(dateStr).
      const shiftEnd = buildShiftDateTime(
        shiftConfig.crossesMidnight ? addDaysStr(dateStr, 1) : dateStr,
        shiftConfig.shiftEndTime,
      );
      isLate =
        inTime.getTime() - shiftStart.getTime() >
        shiftConfig.lateInThresholdMinutes * 60000;
      isEarlyOut =
        shiftEnd.getTime() - outTime.getTime() >
        shiftConfig.earlyOutThresholdMinutes * 60000;

      // Break time is unpaid — doesn't count toward Present/Half-Day
      // thresholds, only the raw punch-in-to-punch-out span still does
      // (workDurationMinutes itself stays the full span, unadjusted, since
      // that's what's actually displayed/exported elsewhere).
      const hours =
        Math.max(0, workDurationMinutes - shiftConfig.breakMinutes) / 60;
      if (hours >= shiftConfig.minHoursForPresent) {
        status = AttendanceStatus.PRESENT;
      } else if (hours >= shiftConfig.minHoursForHalfDay) {
        status = AttendanceStatus.HALF_DAY;
      } else {
        status = AttendanceStatus.ABSENT;
      }
    } else {
      const approvedLeave =
        ('approvedLeave' in params
          ? params.approvedLeave
          : await db.leave.findFirst({
              where: {
                organizationId,
                employeeId,
                status: LeaveStatus.APPROVED,
                startDate: { lte: dateStr },
                endDate: { gte: dateStr },
              },
            })) ?? null;
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

    return { status, workDurationMinutes, isLate, isEarlyOut };
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
    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const displayDate = formatDateDisplay(dateStr, '', dateFormat);
    if (status === AttendanceStatus.ABSENT) {
      const title = `Marked Absent — ${displayDate}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: employeeId, title },
      });
      if (!alreadyNotified) {
        await this.notificationsService.create({
          organizationId,
          userId: employeeId,
          title,
          message: `You were marked absent for ${displayDate}. Contact HR if this looks wrong.`,
          category: NotificationCategory.ATTENDANCE,
        });
        // The email is sent only alongside the first Notification row for this employee + date
        // (same dedupe key as the in-app notice), so repeated recalculations of the same day don't
        // re-mail the employee (e.g. the daily job plus a manual "notify absentees" run). It used
        // to fire on every recalculation.
        const employee = await this.scopedPrisma.user.findFirst({
          where: { id: employeeId, organizationId },
        });
        if (employee) {
          const fallbackHtml = `You were marked absent for ${displayDate}. Contact HR if this looks wrong.`;
          const { subject, html } =
            await this.emailTemplatesService.renderOccasion(
              organizationId,
              'ABSENT_MARKED',
              { employeeName: employee.name, date: displayDate },
              { subject: title, html: fallbackHtml },
            );
          await this.emailService.send({
            to: employee.email,
            subject,
            html,
            organizationId,
          });
        }
      }
      return;
    }

    if (isLate) {
      const title = `Marked Late — ${displayDate}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: employeeId, title },
      });
      if (!alreadyNotified) {
        await this.notificationsService.create({
          organizationId,
          userId: employeeId,
          title,
          message: `You were marked late for ${displayDate}.`,
          category: NotificationCategory.ATTENDANCE,
        });
      }
    }
  }

  // Shared by every punch-ingestion path (Face API, manual, self) so a
  // punch is always attributed to the right shift-day up front, before the
  // Punch row's own recalculation call — see resolveAttendanceDateForPunch.
  private async resolveEmployeeShiftConfig(
    employeeId: string,
    organizationId: string,
  ): Promise<ShiftConfig> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      include: { department: true },
    });
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    return resolveShiftConfig(
      employee?.department ?? null,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );
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
    const providedKeyHash = crypto
      .createHash('sha256')
      .update(providedKey)
      .digest('hex');
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: dto.organizationId, faceApiKeyHash: providedKeyHash },
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

    const shiftConfig = await this.resolveEmployeeShiftConfig(
      user.id,
      dto.organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      shiftConfig,
    );
    await assertPayrollPeriodUnlocked(
      this.scopedPrisma,
      dto.organizationId,
      user.id,
      attendanceDate,
    );

    // A device retry / double-scan within a few seconds is the same punch —
    // return the existing state rather than writing a duplicate Punch row.
    const duplicate = await this.findDuplicatePunch(
      dto.organizationId,
      user.id,
      punchTime,
    );
    if (duplicate) {
      const attendance = await this.currentAttendanceForDay(
        user.id,
        attendanceDate,
        dto.organizationId,
      );
      return { punch: duplicate, attendance };
    }

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
      attendanceDate,
      dto.organizationId,
    );

    return { punch, attendance };
  }

  // Any existing punch from this employee within ±DUPLICATE_PUNCH_WINDOW_MS
  // of `punchTime` — used by the self-punch and Face-API paths only (HR's
  // manualPunch back-entry stays deliberately permissive).
  private findDuplicatePunch(
    organizationId: string,
    employeeId: string,
    punchTime: Date,
  ) {
    return this.scopedPrisma.punch.findFirst({
      where: {
        organizationId,
        employeeId,
        punchTime: {
          gte: new Date(punchTime.getTime() - DUPLICATE_PUNCH_WINDOW_MS),
          lte: new Date(punchTime.getTime() + DUPLICATE_PUNCH_WINDOW_MS),
        },
      },
      orderBy: { punchTime: 'desc' },
    });
  }

  // The existing Attendance row for a shift-day, recalculating only if (for
  // whatever reason) none exists yet.
  private async currentAttendanceForDay(
    employeeId: string,
    dateStr: string,
    organizationId: string,
  ) {
    const existing = await this.scopedPrisma.attendance.findFirst({
      where: { organizationId, employeeId, date: dateStr },
    });
    return (
      existing ??
      this.recalculateAttendanceForDay(
        this.scopedPrisma,
        employeeId,
        dateStr,
        organizationId,
      )
    );
  }

  async manualPunch(dto: ManualPunchDto, organizationId: string) {
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!user) throw new NotFoundException('Employee not found.');

    const punchTime = dto.punchTime ? new Date(dto.punchTime) : new Date();
    const manualShiftConfig = await this.resolveEmployeeShiftConfig(
      user.id,
      organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      manualShiftConfig,
    );
    await assertPayrollPeriodUnlocked(
      this.scopedPrisma,
      organizationId,
      user.id,
      attendanceDate,
    );

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
      attendanceDate,
      organizationId,
    );

    return { punch, attendance };
  }

  async selfPunch(dto: SelfPunchDto, actor: Actor, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      include: {
        workLocation: true,
        department: { include: { workLocation: true } },
      },
    });
    const fence = employee ? effectiveWorkLocation(employee) : null;
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
    const selfShiftConfig = await this.resolveEmployeeShiftConfig(
      actor.id,
      organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      selfShiftConfig,
    );
    await assertPayrollPeriodUnlocked(
      this.scopedPrisma,
      organizationId,
      actor.id,
      attendanceDate,
    );

    // A double-tap / resubmitted request within a few seconds is the same
    // punch — return the existing state instead of a duplicate Punch row.
    const duplicate = await this.findDuplicatePunch(
      organizationId,
      actor.id,
      punchTime,
    );
    let punch: Punch;
    let attendance: Attendance;
    if (duplicate) {
      punch = duplicate;
      attendance = await this.currentAttendanceForDay(
        actor.id,
        attendanceDate,
        organizationId,
      );
    } else {
      punch = await this.scopedPrisma.punch.create({
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
      attendance = await this.recalculateAttendanceForDay(
        this.scopedPrisma,
        actor.id,
        attendanceDate,
        organizationId,
      );
    }

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
      const { dateFormat } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      await this.timelineService.logEvent({
        organizationId,
        employeeId: actor.id,
        eventKey: 'WFH_REQUESTED',
        performedById: actor.id,
        description: `Requested Work From Home for ${formatDateDisplay(dateStr, '', dateFormat)}.`,
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
    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.notificationsService.create({
      organizationId,
      userId: actor.reportingManagerId,
      title: 'Work From Home Requested',
      message: `${actor.name} requested Work From Home for ${formatDateDisplay(date, '', dateFormat)}, pending your approval.`,
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
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
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
    if (row.workArrangementStatus !== WfhApprovalStatus.PENDING) {
      throw new BadRequestException(
        'This Work From Home request has already been reviewed.',
      );
    }
    // Delegation-aware dept scope: same pattern as reviewRegularization /
    // LeavesService.review() — a manager's active ApprovalDelegation stand-
    // in can also review WFH requests outside their own department.
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      row.employeeId,
    );

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

    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = `Work From Home Request ${dto.decision}`;
    const message = `Your Work From Home request for ${formatDateDisplay(row.date, '', dateFormat)} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
    await this.notificationsService.create({
      organizationId,
      userId: row.employeeId,
      title,
      message,
      category: NotificationCategory.ATTENDANCE,
    });
    {
      const { subject, html } = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'WFH_DECISION',
        {
          employeeName: row.employee.name,
          decision: dto.decision,
          date: formatDateDisplay(row.date, '', dateFormat),
          comments: dto.comments ?? '',
        },
        { subject: title, html: message },
      );
      // Fire-and-forget: send() never throws, and the decision itself has
      // already committed — the actor shouldn't wait on an SMTP/API round
      // trip for the approve/reject click to feel instant.
      void this.emailService.send({
        to: row.employee.email,
        subject,
        html,
        organizationId,
      });
    }

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  async getMyGeoFence(actor: Actor, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      include: {
        workLocation: true,
        department: { include: { workLocation: true } },
      },
    });
    const fence = employee ? effectiveWorkLocation(employee) : null;
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
    if (query.regularizationStatus) {
      where.regularization = {
        path: ['status'],
        equals: query.regularizationStatus,
      };
    }

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
                workLocation: true,
                department: { include: { workLocation: true } },
              },
            },
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.attendance.count({ where }),
      query.page,
      query.limit,
    );

    // Additive lookups for the calendar/table day-detail tooltip: a leave
    // type name for ON_LEAVE/HALF_DAY rows and a holiday name for HOLIDAY
    // rows. Attendance carries no leaveId/holidayId FK (recalculateAttendanceForDay
    // derives status from Holiday/Leave at write time, then forgets the
    // link), so both are re-matched by (employeeId, date) the same way
    // LeaveTrackerService.grid() already does it — only for the page of
    // rows actually being returned, not the whole date range.
    const holidayDates = [
      ...new Set(
        result.data
          .filter((r) => r.status === AttendanceStatus.HOLIDAY)
          .map((r) => r.date),
      ),
    ];
    const leaveRows = result.data.filter(
      (r) =>
        r.status === AttendanceStatus.ON_LEAVE ||
        r.status === AttendanceStatus.HALF_DAY,
    );
    const leaveEmployeeIds = [...new Set(leaveRows.map((r) => r.employeeId))];
    const leaveDates = leaveRows.map((r) => r.date);
    const minLeaveDate = leaveDates.length
      ? leaveDates.reduce((a, b) => (a < b ? a : b))
      : undefined;
    const maxLeaveDate = leaveDates.length
      ? leaveDates.reduce((a, b) => (a > b ? a : b))
      : undefined;

    const [holidays, leaves] = await Promise.all([
      holidayDates.length
        ? this.scopedPrisma.holiday.findMany({
            where: {
              organizationId,
              isActive: true,
              date: { in: holidayDates },
            },
          })
        : Promise.resolve([] as Holiday[]),
      leaveEmployeeIds.length && minLeaveDate && maxLeaveDate
        ? this.scopedPrisma.leave.findMany({
            where: {
              organizationId,
              employeeId: { in: leaveEmployeeIds },
              status: LeaveStatus.APPROVED,
              startDate: { lte: maxLeaveDate },
              endDate: { gte: minLeaveDate },
            },
            include: { leaveType: true },
          })
        : Promise.resolve([]),
    ]);

    const leavesByEmployee = new Map<string, typeof leaves>();
    for (const leave of leaves) {
      const arr = leavesByEmployee.get(leave.employeeId) ?? [];
      arr.push(leave);
      leavesByEmployee.set(leave.employeeId, arr);
    }

    return {
      ...result,
      data: result.data.map((record) => {
        const fence = effectiveWorkLocation(record.employee);
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

        // Prefer a department-specific holiday over a company-wide one for
        // the same date, matching recalculateAttendanceForDay's own lookup.
        let holidayName: string | undefined;
        if (record.status === AttendanceStatus.HOLIDAY) {
          const sameDate = holidays.filter((h) => h.date === record.date);
          const employeeDepartmentId = record.employee.department?.id ?? null;
          const holiday =
            sameDate.find((h) => h.departmentId === employeeDepartmentId) ??
            sameDate.find((h) => h.departmentId === null);
          holidayName = holiday?.name;
        }

        let leaveTypeName: string | undefined;
        if (
          record.status === AttendanceStatus.ON_LEAVE ||
          record.status === AttendanceStatus.HALF_DAY
        ) {
          const matching = (leavesByEmployee.get(record.employeeId) ?? []).find(
            (l) => l.startDate <= record.date && l.endDate >= record.date,
          );
          leaveTypeName = matching?.leaveType.name;
        }

        return {
          ...record,
          checkinSelfieUrl: signSelfieKey(
            record.organizationId,
            record.checkinSelfieUrl,
          ),
          checkoutSelfieUrl: signSelfieKey(
            record.organizationId,
            record.checkoutSelfieUrl,
          ),
          checkinInsideGeoFence,
          ...(holidayName !== undefined && { holidayName }),
          ...(leaveTypeName !== undefined && { leaveTypeName }),
        };
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

    const dates = enumerateDateStrings(leave.startDate, leave.endDate);
    // One findMany + one updateMany + one createMany instead of a
    // findFirst+update/create pair per date — a leave range is usually
    // short, but this is free to batch regardless.
    const existingRows = await tx.attendance.findMany({
      where: {
        organizationId,
        employeeId: leave.employeeId,
        date: { in: dates },
      },
    });
    const existingDates = new Set(existingRows.map((r) => r.date));

    if (existingRows.length > 0) {
      await tx.attendance.updateMany({
        where: { id: { in: existingRows.map((r) => r.id) }, organizationId },
        data: { status, source: AttendanceSource.SYSTEM },
      });
    }
    const missingDates = dates.filter((d) => !existingDates.has(d));
    if (missingDates.length > 0) {
      await tx.attendance.createMany({
        data: missingDates.map((date) => ({
          organizationId,
          employeeId: leave.employeeId,
          date,
          status,
          source: AttendanceSource.SYSTEM,
        })),
      });
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
    const dates = enumerateDateStrings(leave.startDate, leave.endDate).filter(
      (d) => d >= today,
    );
    if (dates.length === 0) return;

    // Only reverts rows this integration itself wrote (source ===
    // SYSTEM) — folded straight into the query instead of a per-date
    // findFirst + a JS source check.
    await tx.attendance.updateMany({
      where: {
        organizationId,
        employeeId: leave.employeeId,
        date: { in: dates },
        source: AttendanceSource.SYSTEM,
      },
      data: {
        status: AttendanceStatus.ABSENT,
        source: AttendanceSource.FACE_API,
      },
    });
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
    // 7-day lookback window — an employee can only regularize something
    // recent, not reach arbitrarily far back into attendance history.
    const earliestAllowedDate = addDaysStr(todayStr(), -7);
    if (dto.date < earliestAllowedDate) {
      throw new BadRequestException(
        'Regularization can only be requested for a date within the last 7 days.',
      );
    }
    await assertPayrollPeriodUnlocked(
      this.scopedPrisma,
      organizationId,
      actor.id,
      dto.date,
    );

    const existing = await this.scopedPrisma.attendance.findFirst({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });
    // A fresh 'none'/never-requested row, or one HR/Manager already
    // rejected, can be (re)submitted — matches this app's own precedent
    // elsewhere of allowing resubmission after rejection (see
    // CompOffService.earn()'s comment on the same trade-off). A 'pending'
    // or already-'approved' regularization cannot be silently overwritten
    // by resubmitting — that used to reset an approved/pending decision
    // straight back to 'pending' with new requested times, with no trace
    // of the original request ever having been reviewed.
    const existingStatus = (
      existing?.regularization as unknown as RegularizationState | undefined
    )?.status;
    if (existingStatus === 'pending' || existingStatus === 'approved') {
      throw new ConflictException(
        existingStatus === 'pending'
          ? 'A regularization request for this date is already pending review.'
          : 'This date has already been regularized and approved.',
      );
    }

    // Admin is above HR/Manager in the review chain — reviewRegularization
    // is @Roles(HR, MANAGER) only, so an Admin's own request would otherwise
    // have no one left who could ever approve it and would sit stuck at
    // "pending" forever. Auto-approve it on submit instead, applying the
    // same requested-time/status effects reviewRegularization would.
    const isSelfApproving = actor.role === Role.ADMIN;
    const requestedInTime = dto.requestedInTime
      ? new Date(dto.requestedInTime)
      : null;
    const requestedOutTime = dto.requestedOutTime
      ? new Date(dto.requestedOutTime)
      : null;

    const regularization: RegularizationState = {
      requested: true,
      reason: dto.reason,
      requestedInTime: dto.requestedInTime ?? null,
      requestedOutTime: dto.requestedOutTime ?? null,
      status: isSelfApproving ? 'approved' : 'pending',
      reviewedBy: isSelfApproving ? actor.id : null,
      reviewedAt: isSelfApproving ? new Date().toISOString() : null,
      reviewComments: isSelfApproving ? 'Self-approved (Admin).' : '',
    };

    let inTime: Date | undefined;
    let outTime: Date | undefined;
    let workDurationMinutes: number | undefined;
    let status: AttendanceStatus = AttendanceStatus.ABSENT;
    let source: AttendanceSource = AttendanceSource.SYSTEM;
    if (isSelfApproving) {
      if (requestedInTime) inTime = requestedInTime;
      if (requestedOutTime) outTime = requestedOutTime;
      if (requestedInTime && requestedOutTime) {
        workDurationMinutes = Math.max(
          0,
          Math.round(
            (requestedOutTime.getTime() - requestedInTime.getTime()) / 60000,
          ),
        );
        status = AttendanceStatus.PRESENT;
      }
      source = AttendanceSource.REGULARIZED;
    }

    if (existing) {
      await this.scopedPrisma.attendance.updateMany({
        where: { id: existing.id, organizationId },
        data: {
          regularization: regularization as unknown as Prisma.InputJsonValue,
          ...(isSelfApproving && {
            inTime,
            outTime,
            workDurationMinutes,
            status,
            source,
          }),
        },
      });
    } else {
      await this.scopedPrisma.attendance.create({
        data: {
          organizationId,
          employeeId: actor.id,
          date: dto.date,
          status,
          source,
          workDurationMinutes,
          inTime,
          outTime,
          regularization: regularization as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (!isSelfApproving) {
      await this.notifyRegularizationRequested(actor, dto.date, organizationId);
    }

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
    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.notificationsService.create({
      organizationId,
      userId: actor.reportingManagerId,
      title: 'Attendance Regularization Requested',
      message: `${actor.name} requested attendance regularization for ${formatDateDisplay(date, '', dateFormat)}.`,
      category: NotificationCategory.REGULARIZATION,
    });
  }

  // Single-level review (HR or Manager, either decides) — `id` is the
  // Attendance row's id, not a separate request id. Unlike the request
  // write above, this SPREADS the existing regularization object (whole-
  // object reassignment, same as the old Sequelize JSON-column comment).
  // A MANAGER is restricted to their own department's employees, same as
  // overtime/comp-off review — see assertManagerScopeOrDelegate. Also lets
  // an active ApprovalDelegation stand-in reviewer act, same pattern as
  // LeavesService.review().
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
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      row.employeeId,
    );
    await assertPayrollPeriodUnlocked(
      this.scopedPrisma,
      organizationId,
      row.employeeId,
      row.date,
    );

    const existingReg = row.regularization as unknown as RegularizationState;
    if (existingReg?.status !== 'pending') {
      throw new BadRequestException(
        'This regularization request has already been reviewed.',
      );
    }
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

    // Guarded compare-and-swap: `regularization` is a JSON blob (not a
    // typed status column), so the still-pending status is re-asserted
    // via a Postgres JSON-path filter in the write's own `where`, not just
    // the pre-check above — two concurrent reviewRegularization() calls on
    // the same request (double-click, or a retried request) can't both
    // win and both apply the attendance override below.
    const { count } = await this.scopedPrisma.attendance.updateMany({
      where: {
        id,
        organizationId,
        regularization: { path: ['status'], equals: 'pending' },
      },
      data,
    });
    if (count === 0) {
      throw new ConflictException(
        'This regularization request was already reviewed.',
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: row.employeeId, organizationId },
    });
    if (employee) {
      const { dateFormat } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const title = `Regularization Request ${dto.decision}`;
      const message = `Your attendance regularization request for ${formatDateDisplay(row.date, '', dateFormat)} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.REGULARIZATION,
      });
      const { subject, html } = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'REGULARIZATION_DECISION',
        {
          employeeName: employee.name,
          decision: dto.decision,
          date: formatDateDisplay(row.date, '', dateFormat),
          comments: dto.comments ?? '',
        },
        { subject: title, html: message },
      );
      // Fire-and-forget, same reasoning as reviewWorkArrangement above — the
      // regularization decision has already committed by this point.
      void this.emailService.send({
        to: employee.email,
        subject,
        html,
        organizationId,
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
          select: { employeeId: true, isActive: true, joiningDate: true },
        })
      : [];
    const knownCodes = new Map(employees.map((e) => [e.employeeId, e]));

    // Sanity bounds on the imported date, mirroring the ±2y/1y window used
    // elsewhere in this codebase for "is this date plausible" checks —
    // format-only validation (DATE_RE) let 1900-01-01 / 2999-12-31 through
    // silently, which is never a real attendance record.
    const now = Date.now();
    const MIN_DATE_MS = now - 2 * 365 * 24 * 60 * 60 * 1000;
    const MAX_DATE_MS = now + 365 * 24 * 60 * 60 * 1000;

    // Rows sharing employeeId+date collapse into a single Attendance row in
    // executeImportBatch (upsert-by-key), so a duplicate pair here isn't a
    // data-corruption risk — but letting it silently pass validation means
    // the batch's later executionResult.imported count would be inflated
    // by one per duplicate, misreporting what was actually written. Since
    // this validate stage's whole contract is "flag anything that won't
    // execute as expected and keep the batch fixable," duplicates are
    // flagged as row errors here (on the second+ occurrence) rather than
    // silently deduped, so the uploader corrects the source file instead of
    // getting a mismatched count.
    const seenKeys = new Map<string, number>();

    const failed: { row: number; error: string }[] = [];
    rows.forEach((row, i) => {
      const rowNum = i + 1;
      const empCode = asString(row.employeeId).trim();
      if (!empCode) {
        failed.push({ row: rowNum, error: 'employeeId is required' });
        return;
      }
      const employee = knownCodes.get(empCode);
      if (!employee) {
        failed.push({ row: rowNum, error: `Employee not found: ${empCode}` });
        return;
      }
      if (!employee.isActive) {
        failed.push({
          row: rowNum,
          error: `Employee is not active: ${empCode}`,
        });
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
        return;
      }
      const dateMs = new Date(`${date}T00:00:00.000Z`).getTime();
      if (dateMs < MIN_DATE_MS || dateMs > MAX_DATE_MS) {
        failed.push({
          row: rowNum,
          error: `Date out of range: ${date} (must be within 2 years in the past and 1 year in the future)`,
        });
        return;
      }
      // No attendance can predate the employee's joining date.
      const joiningDateStr = utcDateStrOf(employee.joiningDate);
      if (date < joiningDateStr) {
        failed.push({
          row: rowNum,
          error: `Date ${date} is before the employee's joining date (${joiningDateStr})`,
        });
        return;
      }
      const inRaw = asString(row.inTime).trim();
      const outRaw = asString(row.outTime).trim();
      if (!inRaw && !outRaw) {
        failed.push({
          row: rowNum,
          error: 'At least one of inTime or outTime is required',
        });
        return;
      }
      // executeImportBatch parses inTime/outTime with the same UTC parser, so
      // an unparseable time (e.g. bare "09:00") must be caught here or the
      // batch "executes" with 0 rows imported.
      const badTime = (['inTime', 'outTime'] as const).find((f) => {
        const v = asString(row[f]).trim();
        return v !== '' && parseImportTimestampUtc(v) === null;
      });
      if (badTime) {
        failed.push({
          row: rowNum,
          error: `Invalid ${badTime} (expected YYYY-MM-DD HH:mm:ss, interpreted as UTC)`,
        });
        return;
      }
      const key = `${empCode}:${date}`;
      const firstRow = seenKeys.get(key);
      if (firstRow !== undefined) {
        failed.push({
          row: rowNum,
          error: `Duplicate employeeId+date within this batch (also appears in row ${firstRow})`,
        });
        return;
      }
      seenKeys.set(key, rowNum);
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
          select: {
            id: true,
            employeeId: true,
            departmentId: true,
            department: true,
          },
        })
      : [];
    const byCode = new Map(employees.map((e) => [e.employeeId, e.id]));
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    // Shift config per imported row is resolved exactly as
    // recalculateAttendanceForDay does — the existing row's snapshotted
    // department wins over the employee's current one. Departments are
    // cached so a large sheet doesn't re-fetch the same row repeatedly.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    const orgPrefs =
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null;
    type DepartmentRow = (typeof employees)[number]['department'];
    const departmentCache = new Map<string, DepartmentRow>();
    for (const e of employees) {
      if (e.department) departmentCache.set(e.department.id, e.department);
    }
    const departmentFor = async (id: string) => {
      if (!departmentCache.has(id)) {
        departmentCache.set(
          id,
          await this.scopedPrisma.department.findFirst({
            where: { id, organizationId },
          }),
        );
      }
      return departmentCache.get(id) ?? null;
    };

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const rowErrors: { row: number; error: string }[] = [];

    // Attendance has a unique constraint on (organizationId, employeeId,
    // date), but two rows sharing a key still can't safely run concurrently
    // here (a naive parallel find-then-create could still race and one
    // side would hit the constraint instead of updating) — writes stay
    // sequential, preserving exact per-row imported/skipped/errors counts
    // even for a malformed file with repeated keys. Only the read side is
    // batched: every touched (employeeId,
    // date)'s existing row fetched in one findMany instead of N
    // sequential findFirst calls, which was most of this loop's latency.
    const rowKeys = rows
      .map((row) => {
        const empId = byCode.get(asString(row.employeeId).trim());
        const date = asString(row.date).trim();
        return empId && date ? { empId, date } : null;
      })
      .filter((k): k is { empId: string; date: string } => k !== null);
    const existingRows =
      rowKeys.length > 0
        ? await this.scopedPrisma.attendance.findMany({
            where: {
              organizationId,
              employeeId: { in: [...new Set(rowKeys.map((k) => k.empId))] },
              date: { in: [...new Set(rowKeys.map((k) => k.date))] },
            },
          })
        : [];
    const existingByKey = new Map(
      existingRows.map((r) => [`${r.employeeId}:${r.date}`, r]),
    );

    // Prefetched once for the whole file instead of once per row inside
    // deriveDayOutcome (a holiday.findFirst + a leave.findFirst per row was
    // most of this loop's remaining latency on a large sheet) — same
    // matching rules as deriveDayOutcome's own per-call queries, just
    // evaluated in memory below instead of re-querying per row.
    const importDates = [...new Set(rowKeys.map((k) => k.date))];
    const minDate = importDates.length
      ? importDates.reduce((a, b) => (a < b ? a : b))
      : null;
    const maxDate = importDates.length
      ? importDates.reduce((a, b) => (a > b ? a : b))
      : null;
    const importDepartmentIds = [
      ...new Set(
        employees
          .map((e) => e.departmentId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const prefetchedHolidays =
      importDates.length > 0
        ? await this.scopedPrisma.holiday.findMany({
            where: {
              organizationId,
              isActive: true,
              date: { in: importDates },
              OR: [
                { departmentId: null },
                ...(importDepartmentIds.length
                  ? [{ departmentId: { in: importDepartmentIds } }]
                  : []),
              ],
            },
          })
        : [];
    const holidaysByDate = new Map<string, Holiday[]>();
    for (const h of prefetchedHolidays) {
      const list = holidaysByDate.get(h.date);
      if (list) list.push(h);
      else holidaysByDate.set(h.date, [h]);
    }
    const holidayFor = (dateStr: string, departmentId: string | null) =>
      (holidaysByDate.get(dateStr) ?? []).find(
        (h) => h.departmentId === null || h.departmentId === departmentId,
      ) ?? null;

    const prefetchedLeaves =
      minDate && maxDate
        ? await this.scopedPrisma.leave.findMany({
            where: {
              organizationId,
              employeeId: { in: [...new Set(rowKeys.map((k) => k.empId))] },
              status: LeaveStatus.APPROVED,
              startDate: { lte: maxDate },
              endDate: { gte: minDate },
            },
          })
        : [];
    const leavesByEmployee = new Map<string, Leave[]>();
    for (const l of prefetchedLeaves) {
      const list = leavesByEmployee.get(l.employeeId);
      if (list) list.push(l);
      else leavesByEmployee.set(l.employeeId, [l]);
    }
    const approvedLeaveFor = (empId: string, dateStr: string) =>
      (leavesByEmployee.get(empId) ?? []).find(
        (l) => l.startDate <= dateStr && l.endDate >= dateStr,
      ) ?? null;

    for (const [i, row] of rows.entries()) {
      const rowNum = i + 1;
      const empCode = asString(row.employeeId).trim();
      const empId = byCode.get(empCode);
      const date = asString(row.date).trim();
      if (!empId || !date) {
        errors += 1;
        rowErrors.push({ row: rowNum, error: 'Unknown employee or date' });
        continue;
      }

      try {
        const existing = existingByKey.get(`${empId}:${date}`) ?? null;
        if (
          existing &&
          existing.source === AttendanceSource.FACE_API &&
          existing.inTime
        ) {
          skipped += 1;
          continue;
        }

        // Per-row: a row in a LOCKED/PAID payroll period becomes a row
        // error, the rest of the batch still executes.
        await assertPayrollPeriodUnlocked(
          this.scopedPrisma,
          organizationId,
          empId,
          date,
        );

        const inRaw = asString(row.inTime).trim();
        const outRaw = asString(row.outTime).trim();
        const inTime = inRaw ? parseImportTimestampUtc(inRaw) : null;
        const outTime = outRaw ? parseImportTimestampUtc(outRaw) : null;
        if ((inRaw && !inTime) || (outRaw && !outTime)) {
          throw new BadRequestException('Invalid inTime/outTime');
        }
        if (!inTime && !outTime) {
          throw new BadRequestException(
            'At least one of inTime or outTime is required',
          );
        }

        const employee = employeeById.get(empId);
        const departmentForShiftConfig =
          existing?.departmentId &&
          existing.departmentId !== employee?.departmentId
            ? await departmentFor(existing.departmentId)
            : (employee?.department ?? null);
        const shiftConfig = resolveShiftConfig(
          departmentForShiftConfig,
          orgPrefs,
        );
        // Same status/duration rules as punch-derived attendance
        // (shift thresholds, break, holiday, leave, weekly-off) — holiday/
        // approvedLeave come from the whole-file prefetch above instead of
        // a per-row query.
        const outcome = await this.deriveDayOutcome(this.scopedPrisma, {
          organizationId,
          employeeId: empId,
          employeeDepartmentId: employee?.departmentId ?? null,
          dateStr: date,
          shiftConfig,
          inTime,
          outTime,
          holiday: holidayFor(date, employee?.departmentId ?? null),
          approvedLeave: approvedLeaveFor(empId, date),
        });

        const fields = {
          ...outcome,
          source: AttendanceSource.EXCEL_IMPORT,
          inTime,
          outTime,
          checkinLocation: row.inLocation ? asString(row.inLocation) : null,
          checkoutLocation: row.outLocation ? asString(row.outLocation) : null,
        };

        if (existing) {
          await this.scopedPrisma.attendance.updateMany({
            where: { id: existing.id, organizationId },
            data: fields,
          });
          existingByKey.set(`${empId}:${date}`, { ...existing, ...fields });
        } else {
          const createdRow = await this.scopedPrisma.attendance.create({
            data: {
              organizationId,
              employeeId: empId,
              date,
              departmentId: employee?.departmentId ?? null,
              ...fields,
            },
          });
          // Keeps a same-key later row in this same file (if any) seeing
          // this write, exactly as the old per-row findFirst-in-loop
          // would have — otherwise it would falsely see "no existing row"
          // from the batched pre-fetch and create a duplicate.
          existingByKey.set(`${empId}:${date}`, createdRow);
        }
        imported += 1;
      } catch (err) {
        errors += 1;
        rowErrors.push({
          row: rowNum,
          error:
            err instanceof BadRequestException
              ? err.message
              : 'Failed to import row',
        });
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
          rowErrors,
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

    // Bounded concurrency — each employee's own attendance row for this
    // one date, no shared state between them, so this is safe to run
    // several at a time instead of fully sequential (a few hundred
    // employees × recalculateAttendanceForDay's several queries each is a
    // slow admin action otherwise).
    const employeeIds: string[] = [];
    await mapWithConcurrency(employees, 8, async (employee) => {
      const row = await this.recalculateAttendanceForDay(
        this.scopedPrisma,
        employee.id,
        date,
        organizationId,
      );
      if (row.status === AttendanceStatus.ABSENT) {
        employeeIds.push(employee.id);
      }
    });

    return { date, notifiedCount: employeeIds.length, employeeIds };
  }

  // Runs notifyAbsentees automatically for every active org, once a day,
  // for the previous full calendar day (not "today" — the shift/day isn't
  // over yet when this fires, so marking it absent this early would be
  // premature for anyone who punches in later). Previously this only ever
  // ran when HR remembered to click "Send Absence Alerts" — relying on
  // that let real attendance gaps go completely unnoticed until payroll
  // silently zeroed out over it. One org's failure is logged and skipped
  // rather than aborting the rest, same reasoning as notifyAbsentees'
  // own bounded-concurrency per-employee isolation.
  @Cron('0 1 * * *')
  async markYesterdayAbsences() {
    const yesterday = utcDateStrOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      try {
        await this.notifyAbsentees({ date: yesterday }, org.id);
      } catch (err) {
        this.logger.error(
          `markYesterdayAbsences failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}
