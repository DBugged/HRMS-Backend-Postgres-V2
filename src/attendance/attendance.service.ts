// Purpose: Core attendance engine — derives daily Attendance rows from punches, holidays and approved
// leave, and manages punch ingestion, WFH/regularization review, and bulk Excel import workflows.
// Responsibilities: Owns recalculateAttendanceForDay() as the single source of truth for a day's status;
// integrates with LeavesService (write/revertAttendanceForLeave), NotificationsService and EmailService for
// alerts, and EmployeeTimelineService for WFH audit events; delegates geo-fence math to isInsideGeoFence.
// Important: recalculateAttendanceForDay() read-merges rather than blind-upserts, so it never clobbers
// workArrangement/regularization fields owned by other write paths — see the inline comments throughout
// for several other ported-behavior and concurrency-safety notes (e.g. sequential writes in
// executeImportBatch even though Attendance has a unique constraint on (organizationId, employeeId, date)).
import { keepModuleEnabled } from '../module-access/module-gate';
import { holidayInEffect } from '../holidays/holiday-in-effect';
import * as crypto from 'crypto';
import {
  EMPLOYEE_RELATION_ORDER_BY,
  compareEmployees,
} from '../common/employee-order';
import { assertPunchTimeSane } from './punch-time-bounds';
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
  AttendanceImportBatch,
  AttendanceSource,
  AttendanceStatus,
  CompOffStatus,
  Holiday,
  ImportBatchStatus,
  Leave,
  LeaveStatus,
  NotificationCategory,
  OvertimeSource,
  OvertimeStatus,
  OvertimeType,
  PayrollRunStatus,
  Prisma,
  Punch,
  PunchSource,
  RegularizationRequestStatus,
  Role,
  User,
  WfhApprovalStatus,
  WorkArrangement,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { isKeyAllowedForOrg, signFileToken } from '../files/file-token';
import {
  isInsideGeoFenceWithAccuracy,
  MAX_ACCURACY_ALLOWANCE_METERS,
} from '../work-locations/geo-fence';
import { paginate, skip } from '../common/pagination';
import { mapWithConcurrency } from '../common/concurrency';
import { ORG_SUSPENDED_MESSAGE } from '../common/org-status';
import { isEmployedOn } from '../common/managers';
import { alwaysPresentApplies, shiftMinutes } from './always-present';
import { extraMinutesBeyondShift } from './day-detail';
import { zonedWallTimeToUtc } from '../common/zoned-time';
import {
  assertManagerDeptScope,
  assertManagerScopeOrDelegate,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { getLeaveYearConfig } from '../leave-balances/leave-year-config';
import { ImportWfhDto } from './dto/import-wfh.dto';
import { assertPayrollMonthsUnlocked } from '../payroll/payroll-period-guard';
import { isValidCalendarDateString } from '../common/is-valid-calendar-date.validator';
import { wfhDaysPerMonthOf } from '../organizations/org-wfh-policy';
import { currentLeaveYear, leaveYearBounds } from '../leave-balances/leave-year';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import {
  enumerateDateStrings,
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
  type ShiftConfig,
  statusForWorkedMinutes,
} from './attendance-shift-config';
import { IngestPunchDto } from './dto/ingest-punch.dto';
import { ManualPunchDto } from './dto/manual-punch.dto';
import { SelfPunchDto } from './dto/self-punch.dto';
import { SetWorkArrangementDto } from './dto/set-work-arrangement.dto';
import { SelfieStampService } from './selfie-stamp.service';
import { resolveLocationMode } from '../common/location-requirement';
import { PreviewWfhDaysQueryDto } from './dto/preview-wfh-days-query.dto';
import {
  calendarSpan,
  MAX_WFH_RANGE_DAYS,
  wfhRequestDays,
  type WfhRequestDays,
} from './wfh-request-days';
import { QueryAttendanceDto } from './dto/query-attendance.dto';
import { RequestRegularizationDto } from './dto/request-regularization.dto';
import { ReviewRegularizationDto } from './dto/review-regularization.dto';
import { ReviewWfhDto } from './dto/review-wfh.dto';
import { UploadImportBatchDto } from './dto/upload-import-batch.dto';
import { NotifyAbsenteesDto } from './dto/notify-absentees.dto';
import { BackfillAttendanceDto } from './dto/backfill-attendance.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import {
  markPayrollInputsChanged,
  monthsBetween,
} from '../payroll/payroll-period-guard';
import { AuditLogService } from '../audit-log/audit-log.service';
import { getOvertimeRates } from '../overtime/overtime.service';
import { isOvertimePayEnabled } from '../overtime/overtime-pay';
import {
  getOvertimePolicy,
  roundOvertimeHours,
} from '../overtime/overtime-policy';
import {
  formatDateDisplay,
  formatDateTimeDisplay,
  resolveOrgDateTimeFormat,
  dmyText,
} from '../payroll/format-date';
import {
  todayInOrgTz,
  dateStrInOrgTz,
  yesterdayInOrgTz,
  dayRangeInOrgTz,
  startOfDayInOrgTzUtc,
} from '../common/org-date';
import { isSelfieRequired } from '../common/selfie-requirement';

type Actor = Omit<User, 'password'>;
// Either the plain scoped client or a $transaction callback's tx client —
// recalculateAttendanceForDay/the Leave-integration hooks run inside
// whichever one the caller is already using.
type Db = ExtendedPrismaClient | Prisma.TransactionClient;

export interface ImportWfhRowResult {
  row: number;
  employeeId: string;
  employeeName?: string;
  fromDate: string;
  toDate: string;
  status: 'OK' | 'IMPORTED' | 'ERROR';
  days?: number;
  message?: string;
}

export interface ImportWfhResult {
  dryRun: boolean;
  total: number;
  ok: number;
  imported: number;
  failed: number;
  rows: ImportWfhRowResult[];
}

// Shared between list()'s two row sources (a real DB findMany, and
// listWithSyntheticAbsences()'s synthetic rows) so both produce exactly the
// same TS shape for `record.employee` — split apart, Prisma's inferred
// return type for the findMany() branch and the hand-built synthetic rows
// silently diverged (a bare object literal isn't narrowed the same way a
// `select` is), which surfaced as type errors in the shared enrichment code
// below that reads `record.employee` regardless of which source it came
// from.
const ATTENDANCE_LIST_EMPLOYEE_SELECT = {
  id: true,
  name: true,
  employeeId: true,
  workLocation: true,
  department: { include: { workLocation: true } },
} satisfies Prisma.UserSelect;
type AttendanceListEmployee = Prisma.UserGetPayload<{
  select: typeof ATTENDANCE_LIST_EMPLOYEE_SELECT;
}>;
type AttendanceListRow = Attendance & { employee: AttendanceListEmployee };

function utcDateStrOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DEFAULT_ORG_TIMEZONE = 'Asia/Kolkata';
const tzOf = (shiftConfig: { timezone?: string }): string =>
  shiftConfig.timezone ?? DEFAULT_ORG_TIMEZONE;

// The instant at which `hhmm` on calendar day `dateStr` happens on the organisation's wall clock. Shift times are
// entered (and shown, on the mobile app) as organisation-local times, so they must be placed on the timeline in the
// organisation's timezone, not read as UTC - which put a 09:30 IST shift at 15:00 IST.
function buildShiftDateTime(
  dateStr: string,
  hhmm: string,
  timezone: string,
): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(
    startOfDayInOrgTzUtc(dateStr, timezone).getTime() +
      ((h || 0) * 60 + (m || 0)) * 60000,
  );
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
  > & { timezone?: string },
): { gte: Date; lt: Date } {
  const offset = shiftDayBoundaryOffsetMs(shiftConfig);
  const tz = tzOf(shiftConfig);
  // Local midnights of this day and the next, so a day is the organisation's calendar day.
  const dayStart = startOfDayInOrgTzUtc(dateStr, tz).getTime();
  const nextDayStart = startOfDayInOrgTzUtc(
    addDaysStr(dateStr, 1),
    tz,
  ).getTime();
  return {
    gte: new Date(dayStart + offset),
    lt: new Date(nextDayStart + offset),
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
  > & { timezone?: string },
): string {
  const offset = shiftDayBoundaryOffsetMs(shiftConfig);
  return dateStrInOrgTz(
    tzOf(shiftConfig),
    new Date(punchTime.getTime() - offset),
  );
}

// Window within which a repeat punch from the same employee is treated as a
// duplicate tap (double-submit, device retry) rather than a new punch.
const DUPLICATE_PUNCH_WINDOW_MS = 10 * 1000;

// Clock skew allowed between the client that picked a time and this server when checking "not in the future".
const FUTURE_TIME_TOLERANCE_MS = 5 * 60 * 1000;

// Attendance records what already happened. A punch or requested In/Out time ahead of the clock can't be real, and
// accepting one (HR back-entry, a regularization request, an import) lets someone mark a day before it has happened;
// the supported route for correcting a day is a regularization request for a past date.
function assertNotInFuture(time: Date, label: string): void {
  if (time.getTime() > Date.now() + FUTURE_TIME_TOLERANCE_MS) {
    throw new BadRequestException(
      `${label} cannot be in the future. Attendance can only be recorded for times that have already happened.`,
    );
  }
}

// Parses an import-sheet timestamp as UTC. A bare "YYYY-MM-DD HH:mm[:ss]" (or
// with a "T" separator) carries no zone and is interpreted as UTC, matching
// buildShiftDateTime — never server-local time. A string with an
// explicit "Z" or ±HH:mm offset is honored as-is. Returns null if unparseable.
const IMPORT_LOCAL_TS_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
const IMPORT_ZONED_TS_RE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function parseImportTimestampUtc(
  value: string,
  // When given, a bare time is read as wall-clock time in this IANA timezone instead of UTC.
  timeZone?: string,
): Date | null {
  const v = value.trim();
  if (!v) return null;
  let parsed: Date;
  const local = IMPORT_LOCAL_TS_RE.exec(v);
  if (local) {
    const [, date, hh, mm, ss, frac] = local;
    parsed = timeZone
      ? zonedWallTimeToUtc(
          date,
          Number(hh),
          Number(mm),
          Number(ss ?? 0),
          timeZone,
        )
      : new Date(`${date}T${hh}:${mm}:${ss ?? '00'}${frac ?? ''}Z`);
  } else if (IMPORT_ZONED_TS_RE.test(v)) {
    parsed = new Date(v.replace(' ', 'T'));
  } else {
    return null;
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Employees whose payroll for this month is already LOCKED or PAID. Used by the bulk sweeps, which skip them rather than
// fail the whole batch the way a single edit does (assertPayrollPeriodUnlocked).
async function lockedEmployeeIdsForMonth(
  db: Db,
  organizationId: string,
  year: number,
  month: number,
): Promise<Set<string>> {
  const runs = await db.payrollRun.findMany({
    where: {
      organizationId,
      month,
      year,
      status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
    },
    select: { employeeId: true },
  });
  return new Set(runs.map((r) => r.employeeId));
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
      `This attendance date (${dmyText(dateStr)}) falls within the ${lockedRun.month}/${lockedRun.year} payroll period, which is already ${lockedRun.status.toLowerCase()}. Ask an Admin to unlock that payroll run before changing this attendance.`,
    );
  }
  // Any calculated run was built on the old attendance: mark it outdated (and send a signed-off one back to
  // CALCULATED) so it is recalculated before it can be verified, approved or locked.
  await markPayrollInputsChanged(db, organizationId, employeeId, [
    { month, year },
  ]);
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
  // Optional supporting document - a stored relativeKey, signed fresh by signedRegularization() on every read.
  evidenceUrl?: string | null;
}

// A day with no request in force: what a new row starts with, and what withdrawing a pending request goes back to.
const NO_REGULARIZATION: RegularizationState = {
  requested: false,
  reason: '',
  requestedInTime: null,
  requestedOutTime: null,
  status: 'none',
  reviewedBy: null,
  reviewedAt: null,
  reviewComments: '',
  evidenceUrl: null,
};

// Adds the reviewer's display name next to the stored reviewedBy id, so the UI can say "Approved by …" without
// a second lookup. Rows with no review are returned untouched.
function withReviewerName(
  regularization: unknown,
  nameById: Map<string, string>,
  organizationId: string,
): unknown {
  const reg = regularization as RegularizationState | null;
  if (!reg) return regularization;
  const named = reg.reviewedBy
    ? { ...reg, reviewedByName: nameById.get(reg.reviewedBy) ?? null }
    : reg;
  return signedEvidence(named, organizationId);
}

// The request's supporting document as a signed, short-lived URL (the stored value is a bare key that serves nothing).
function signedEvidence<T extends { evidenceUrl?: string | null }>(
  item: T,
  organizationId: string,
): T & { evidenceFileName?: string } {
  if (!item.evidenceUrl) return item;
  return {
    ...item,
    evidenceUrl: `/files/${signFileToken(organizationId, item.evidenceUrl)}`,
    evidenceFileName: item.evidenceUrl.split('/').pop(),
  };
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

// Stored in AttendanceImportBatch.executionResult once a batch is EXECUTED.
type ImportExecutionResult = {
  imported: number;
  skipped: number;
  errors: number;
  // Pending overtime requests this import created (weekend / holiday work, or time past the shift end).
  overtimeRequests?: number;
  rowErrors: { row: number; error: string }[];
};

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
    private readonly auditLogService: AuditLogService,
    // Last, so tests that build the service by position keep working; stamps the selfie of a self punch.
    private readonly selfieStampService: SelfieStampService,
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
    // quiet: the day is being filled in after the fact (a joining date moved earlier, an HR backfill). The row is written
    // exactly the same, but nobody is told about it: no overtime suggestion and no "marked absent" notification or e-mail
    // for a day that is long past.
    // deferAbsenceNotice: the day is still written (so payroll and dashboards see it), but the "Marked Absent" notice and
    // e-mail are left for the morning job (sendMorningAbsenceNotices), so they land when people read them.
    opts?: { quiet?: boolean; deferAbsenceNotice?: boolean },
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
      org?.timezone ?? DEFAULT_ORG_TIMEZONE,
    );

    const punches = await db.punch.findMany({
      where: {
        organizationId,
        employeeId,
        punchTime: shiftPunchWindow(dateStr, shiftConfig),
      },
      orderBy: { punchTime: 'asc' },
    });

    // A day set by a regularization or an Excel import has no punches behind it. Deriving it from punches again would
    // turn it into an absence and erase the approved or imported times, so such a row is left exactly as it is until
    // someone records a real punch for the day.
    if (
      existing &&
      punches.length === 0 &&
      (existing.source === AttendanceSource.REGULARIZED ||
        existing.source === AttendanceSource.EXCEL_IMPORT)
    ) {
      return existing;
    }

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
      inTime = first.punchTime;
      checkinLocation = first.location;
      checkinLatitude = first.latitude;
      checkinLongitude = first.longitude;
      checkinSelfieUrl = first.selfieUrl;
      // A single punch is a check-in with no check-out yet — checkout
      // fields must stay null. With only `first`, `last` would equal
      // `first` and duplicate the check-in's own time/location/selfie
      // into the checkout columns, making an in-progress day look like a
      // completed one.
      if (punches.length > 1) {
        const last = punches[punches.length - 1];
        outTime = last.punchTime;
        checkoutLocation = last.location;
        checkoutLatitude = last.latitude;
        checkoutLongitude = last.longitude;
        checkoutSelfieUrl = last.selfieUrl;
      }
    }

    const outcome = await this.deriveDayOutcome(db, {
      organizationId,
      employeeId,
      employeeDepartmentId: employee.departmentId,
      dateStr,
      shiftConfig,
      inTime,
      outTime,
    });
    let { status, workDurationMinutes, isLate, isEarlyOut } = outcome;
    // Marked always-present: a working day with no approved leave is Present, never Absent, and - with no punches - shows the
    // person's own shift timings. A day of approved leave stays leave (balance and pay follow the normal leave rules). A real punch keeps its times. Weekly offs and holidays stay as the schedule says.
    let autoPresent = false;
    if (alwaysPresentApplies(employee, dateStr, status)) {
      autoPresent = true;
      status = AttendanceStatus.PRESENT;
      isLate = false;
      isEarlyOut = false;
      if (punches.length === 0) {
        const tz = shiftConfig.timezone ?? DEFAULT_ORG_TIMEZONE;
        inTime = buildShiftDateTime(dateStr, shiftConfig.shiftStartTime, tz);
        outTime = buildShiftDateTime(shiftConfig.crossesMidnight ? addDaysStr(dateStr, 1) : dateStr, shiftConfig.shiftEndTime, tz);
        workDurationMinutes = shiftMinutes(shiftConfig.shiftStartTime, shiftConfig.shiftEndTime, shiftConfig.crossesMidnight, shiftConfig.breakMinutes);
      }
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
      source: autoPresent && punches.length === 0 ? AttendanceSource.SYSTEM : AttendanceSource.FACE_API,
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

    if (!opts?.quiet) {
      await this.suggestOvertimeFromPunchOut(
        db,
        organizationId,
        employeeId,
        dateStr,
        status,
        outTime,
        shiftConfig,
        workDurationMinutes,
      );

      await this.notifyLateOrAbsent(
        employeeId,
        dateStr,
        status,
        isLate,
        organizationId,
        // A punch-in with no punch-out yet: the person is at work, so the day must not be reported as an absence.
        inTime !== null && outTime === null,
        opts?.deferAbsenceNotice === true,
      );
    }

    return db.attendance.findFirstOrThrow({
      where: { organizationId, employeeId, date: dateStr },
    });
  }

  // The status/duration rules shared by recalculateAttendanceForDay (punch-
  // derived in/out) and executeImportBatch (sheet-supplied in/out), so both
  // apply identical shift-config/holiday/leave/weekly-off logic. A day with
  // only one of inTime/outTime resolves to INCOMPLETE once that day's shift
  // has ended (see hasDanglingPunchIn below) — before then, the employee is
  // simply at work: Present (in progress) with no duration yet, never Absent.
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
              AND: [holidayInEffect],
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
    // A real punch-in with the shift still running and no punch-out yet (see below).
    let inProgress = false;

    if (inTime && outTime) {
      // A *real* punch-in with no punch-out (as opposed to no punches at
      // all) — params.inTime/outTime are the raw, un-defaulted values, so
      // exactly one being present means the other was never recorded.
      const hasDanglingPunchIn = !!params.inTime && !params.outTime;

      const shiftStart = buildShiftDateTime(
        dateStr,
        shiftConfig.shiftStartTime,
        tzOf(shiftConfig),
      );
      // shiftEndTime is on the *next* calendar day for a crossesMidnight
      // shift (e.g. 22:00-06:00 — shiftEnd is 06:00 the morning after
      // dateStr), which always lies inside shiftPunchWindow(dateStr).
      const shiftEnd = buildShiftDateTime(
        shiftConfig.crossesMidnight ? addDaysStr(dateStr, 1) : dateStr,
        shiftConfig.shiftEndTime,
        tzOf(shiftConfig),
      );

      // Once the shift has actually ended, a dangling punch-in is missing
      // data, not a worked (or unworked) day — it's just as consistent with
      // "worked the full shift and forgot to punch out" as with "punched in
      // and left after ten minutes", so guessing hours either way is unsafe
      // (see the weekly-off override below, which still treats this like
      // the old ABSENT default for day-type purposes). Surfaced as its own
      // status instead, resolved later via regularization. While the shift
      // is still ongoing today (shiftEnd hasn't passed yet), this falls
      // through to the unchanged original behavior below — there's nothing
      // wrong yet, the employee just hasn't punched out because their shift
      // isn't over.
      if (hasDanglingPunchIn && Date.now() >= shiftEnd.getTime()) {
        status = AttendanceStatus.INCOMPLETE;
        isLate =
          inTime.getTime() - shiftStart.getTime() >
          shiftConfig.lateInThresholdMinutes * 60000;
        // workDurationMinutes/isEarlyOut stay at their safe defaults
        // (0/false) — never derived from a guessed punch-out.
      } else if (hasDanglingPunchIn) {
        // Punched in, shift not over, no punch-out yet: the employee is at work. Judging a zero-length span would
        // call them Absent - and send the "Marked Absent" in-app notice and e-mail the moment they punch in. Shown
        // as Present (in progress) with no duration until the punch-out arrives (or the shift ends and the day
        // becomes Incomplete, above).
        inProgress = true;
        status = AttendanceStatus.PRESENT;
        isLate =
          inTime.getTime() - shiftStart.getTime() >
          shiftConfig.lateInThresholdMinutes * 60000;
      } else {
        workDurationMinutes = Math.max(
          0,
          Math.round((outTime.getTime() - inTime.getTime()) / 60000),
        );
        isLate =
          inTime.getTime() - shiftStart.getTime() >
          shiftConfig.lateInThresholdMinutes * 60000;
        isEarlyOut =
          shiftEnd.getTime() - outTime.getTime() >
          shiftConfig.earlyOutThresholdMinutes * 60000;

        // Present is judged on hours after the unpaid break, Half-Day on the hours on the clock (see
        // statusForWorkedMinutes). workDurationMinutes itself stays the full span, since that's what's displayed.
        status =
          AttendanceStatus[
            statusForWorkedMinutes(workDurationMinutes, shiftConfig)
          ];
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
    // ABSENT or INCOMPLETE (never on_leave/half_day), matching the old
    // system exactly (INCOMPLETE is treated like ABSENT here — a stray
    // single punch on a day off is still a day off, not something to
    // regularize).
    if (holiday) {
      status = AttendanceStatus.HOLIDAY;
    } else if (
      isWeeklyOff(dateStr, shiftConfig.weeklyOffs) &&
      (status === AttendanceStatus.ABSENT ||
        status === AttendanceStatus.INCOMPLETE ||
        // A stray single punch on a day off, shift still running: still a day off, as before.
        (inProgress && status === AttendanceStatus.PRESENT))
    ) {
      status = AttendanceStatus.WEEKLY_OFF;
    }

    return { status, workDurationMinutes, isLate, isEarlyOut };
  }

  // Present / Half-day / Absent from the worked span, using the employee's shift thresholds (break is unpaid) — so a
  // regularized 1-hour day is not counted as a full Present day.
  private async statusForWorkedMinutes(
    employeeId: string,
    organizationId: string,
    minutes: number,
  ): Promise<AttendanceStatus> {
    const cfg = await this.resolveEmployeeShiftConfig(
      employeeId,
      organizationId,
    );
    return AttendanceStatus[statusForWorkedMinutes(minutes, cfg)];
  }

  // A department's shift, weekly offs or Present / Half-Day hours changed: this month's attendance that was already
  // saved under the old rules (a Saturday that is now a working day, a 4-hour day that is now a Half-Day) is judged
  // again under the new ones. Only the status and the figures derived from the times are rewritten; the punch times,
  // source, regularization and work arrangement are left exactly as they were. Left alone: months before this one,
  // employees whose payroll for this month is already locked or paid, rows kept under another department's rules,
  // and today's row while nobody has punched (the day is not over). Never throws - the edit that triggered it has
  // already been saved.
  async rederiveCurrentMonth(
    organizationId: string,
    departmentIds: string[],
    actorId?: string | null,
  ): Promise<{ updated: number }> {
    try {
      if (departmentIds.length === 0) return { updated: 0 };
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });
      const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
      const yesterday = addDaysStr(today, -1);
      const monthStart = `${today.slice(0, 7)}-01`;
      const month = Number(today.slice(5, 7));
      const year = Number(today.slice(0, 4));

      const employees = await this.scopedPrisma.user.findMany({
        where: {
          organizationId,
          isActive: true,
          departmentId: { in: departmentIds },
        },
        select: { id: true, departmentId: true, joiningDate: true, exitDate: true },
      });
      if (employees.length === 0) return { updated: 0 };
      const lockedRuns = await this.scopedPrisma.payrollRun.findMany({
        where: {
          organizationId,
          month,
          year,
          employeeId: { in: employees.map((e) => e.id) },
          status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
        },
        select: { employeeId: true },
      });
      const locked = new Set(lockedRuns.map((r) => r.employeeId));
      const eligible = employees.filter((e) => !locked.has(e.id));
      const employeeById = new Map(eligible.map((e) => [e.id, e]));
      const departments = await this.scopedPrisma.department.findMany({
        where: { organizationId, id: { in: departmentIds } },
      });
      const departmentById = new Map(departments.map((d) => [d.id, d]));

      const rows = await this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: { in: eligible.map((e) => e.id) },
          date: { gte: monthStart, lte: today },
        },
      });
      let updated = 0;
      const changedEmployees = new Set<string>();
      await mapWithConcurrency(rows, 8, async (row) => {
        const employee = employeeById.get(row.employeeId);
        if (!employee) return;
        if (row.departmentId && row.departmentId !== employee.departmentId) {
          return;
        }
        if (row.date < utcDateStrOf(employee.joiningDate)) return;
        if (!isEmployedOn(employee.exitDate, row.date)) return;
        const hasPunch = !!(row.inTime || row.outTime);
        if (row.date > yesterday && !hasPunch) return;
        const department = employee.departmentId
          ? (departmentById.get(employee.departmentId) ?? null)
          : null;
        const shiftConfig = resolveShiftConfig(
          department,
          org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
          org?.timezone ?? DEFAULT_ORG_TIMEZONE,
        );
        const outcome = await this.deriveDayOutcome(this.scopedPrisma, {
          organizationId,
          employeeId: row.employeeId,
          employeeDepartmentId: employee.departmentId,
          dateStr: row.date,
          shiftConfig,
          inTime: row.inTime,
          outTime: row.outTime,
        });
        if (
          outcome.status === row.status &&
          outcome.workDurationMinutes === row.workDurationMinutes &&
          outcome.isLate === row.isLate &&
          outcome.isEarlyOut === row.isEarlyOut
        ) {
          return;
        }
        await this.scopedPrisma.attendance.updateMany({
          where: { id: row.id, organizationId },
          data: {
            status: outcome.status,
            workDurationMinutes: outcome.workDurationMinutes,
            isLate: outcome.isLate,
            isEarlyOut: outcome.isEarlyOut,
          },
        });
        updated += 1;
        changedEmployees.add(row.employeeId);
      });
      // Their days changed under the new schedule, so a payroll already calculated for this month is out of date.
      for (const employeeId of changedEmployees) {
        await markPayrollInputsChanged(this.scopedPrisma, organizationId, employeeId, [{ month, year }]);
      }
      if (updated > 0 && actorId) {
        await this.auditLogService.log({
          actorId,
          action: 'ATTENDANCE_RECALCULATED',
          module: 'ATTENDANCE',
          organizationId,
          details: { month, year, daysUpdated: updated },
        });
      }
      return { updated };
    } catch (err) {
      this.logger.error(
        `Re-deriving this month's attendance failed for org ${organizationId}: ${err instanceof Error ? err.message : err}`,
      );
      return { updated: 0 };
    }
  }

  // Below this overshoot, a punch-out isn't worth a review-queue entry —
  // clocking out 5-10 minutes late is noise, not overtime.
  private static readonly AUTO_OVERTIME_MIN_MINUTES = 30;

  // Suggests overtime the moment a punch-out lands past the resolved shift
  // end — instead of relying on the employee to remember to self-submit it
  // (POST /overtime) after the fact. Still PENDING, still goes through the
  // same review() approval gate; this never auto-approves anything, it only
  // saves the employee the manual step for the common case (they were
  // physically punched in past their shift end). Idempotent: re-running
  // this for the same day (e.g. the nightly absence-sweep re-deriving an
  // already-closed day) updates the existing AUTO_PUNCH row rather than
  // duplicating it, and never touches one HR has already reviewed.
  private async suggestOvertimeFromPunchOut(
    db: Db,
    organizationId: string,
    employeeId: string,
    dateStr: string,
    status: AttendanceStatus,
    outTime: Date | null,
    shiftConfig: ShiftConfig,
    workDurationMinutes: number,
    source: OvertimeSource = OvertimeSource.AUTO_PUNCH,
  ): Promise<void> {
    if (!outTime) return;
    // Overtime Pay is off: overtime could never be paid, so don't suggest any (existing suggestions are left as they
    // are for HR to review).
    if (!(await isOvertimePayEnabled(db, organizationId))) return;
    // The Admin's overtime policy: no suggestions when overtime is entered by hand only.
    const policy = await getOvertimePolicy(db, organizationId);
    if (policy.creationMode === 'SELF') return;
    // No real shift was worked — nothing to overshoot.
    if (
      status === AttendanceStatus.ABSENT ||
      status === AttendanceStatus.ON_LEAVE
    ) {
      return;
    }

    const shiftEnd = buildShiftDateTime(
      shiftConfig.crossesMidnight ? addDaysStr(dateStr, 1) : dateStr,
      shiftConfig.shiftEndTime,
      tzOf(shiftConfig),
    );
    // A weekly off or holiday has no regular shift to go past: everything worked that day (less the unpaid break) is
    // overtime, at the weekend/holiday rate. On an ordinary day only the time beyond the shift end counts.
    const isHolidayDay = status === AttendanceStatus.HOLIDAY;
    const isOffDay =
      isHolidayDay || isWeeklyOff(dateStr, shiftConfig.weeklyOffs);
    const overshootMinutes = isOffDay
      ? Math.max(0, workDurationMinutes - (shiftConfig.breakMinutes ?? 0))
      : Math.round((outTime.getTime() - shiftEnd.getTime()) / 60000);

    // One day, one benefit: work already claimed as comp-off is not also suggested as overtime.
    if (isOffDay) {
      const claimedCompOff = await db.compOff.findFirst({
        where: {
          organizationId,
          employeeId,
          earnedForDate: dateStr,
          status: { not: CompOffStatus.REJECTED },
        },
      });
      if (claimedCompOff) return;
    }

    // Looked up WITHOUT filtering by source: OvertimeRecord now has a
    // (organizationId, employeeId, date) unique constraint (one overtime
    // record per employee/day, any source — see its schema comment), so a
    // day the employee already manually logged overtime for (source=SELF)
    // must be left alone here, not raced against with a second create.
    const existing = await db.overtimeRecord.findFirst({
      where: { organizationId, employeeId, date: dateStr },
    });
    const existingAuto =
      existing && existing.source !== OvertimeSource.SELF ? existing : null;

    if (overshootMinutes < policy.minMinutes) {
      // A correction (e.g. a regularization) can shrink a day's punch span
      // below the threshold after an auto-suggestion was already created —
      // only ever clean up our own not-yet-reviewed suggestion, never a
      // decision HR already made.
      if (existingAuto && existingAuto.status === OvertimeStatus.PENDING) {
        await db.overtimeRecord.deleteMany({
          where: { id: existingAuto.id, organizationId },
        });
      }
      return;
    }

    // A manually-logged (non-AUTO_PUNCH) record already covers this day —
    // the employee (or someone on their behalf) already accounted for it,
    // so don't also create a second, auto-suggested one for the same day.
    if (existing && !existingAuto) return;

    // By the calendar, not the attendance status: a weekly off with real punches is marked PRESENT, which used to
    // make its overtime REGULAR (1.5x) instead of weekend (2x).
    const type = isHolidayDay
      ? OvertimeType.HOLIDAY
      : isOffDay
        ? OvertimeType.WEEKEND
        : OvertimeType.REGULAR;
    const hours = roundOvertimeHours(overshootMinutes / 60, policy);
    if (hours <= 0) return;
    const rateMultiplier = (await getOvertimeRates(db, organizationId))[type];

    if (existingAuto) {
      if (existingAuto.status !== OvertimeStatus.PENDING) return;
      await db.overtimeRecord.updateMany({
        where: { id: existingAuto.id, organizationId },
        data: { hours, type, rateMultiplier },
      });
    } else {
      await db.overtimeRecord.create({
        data: {
          organizationId,
          employeeId,
          date: dateStr,
          hours,
          type,
          rateMultiplier,
          source,
        },
      });
    }
  }

  // Notifies the employee when this recalculation marks them late (no
  // email) or absent (with email) — deduped per employee/date/reason via a
  // title-match lookup so a re-run of the same day's calc doesn't spam
  // repeat notifications, matching the original release's `alreadyNotified`
  // guard exactly.
  private async notifyLateOrAbsent(
    employeeId: string,
    dateStr: string,
    status: AttendanceStatus,
    isLate: boolean,
    organizationId: string,
    // A punch-in with no punch-out yet: still working, not absent. Until the punch-out arrives (or the day closes as
    // Incomplete) the "Marked Absent" notice and email are not sent - they used to go out the moment someone punched in.
    punchInProgress = false,
    // Leave the "Marked Absent" notice and e-mail for the morning job; every other notice still goes out now.
    deferAbsenceNotice = false,
  ) {
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const displayDate = formatDateDisplay(dateStr, '', dateFormat, timeZone);
    // A dangling punch-in gets its own nudge instead of the "Marked Absent"
    // one — it's actionable (submit a regularization request) rather than
    // just informational, and wrongly telling someone who clearly showed up
    // that they were marked absent is exactly the confusion this status
    // exists to avoid.
    if (status === AttendanceStatus.INCOMPLETE) {
      const title = `Punch-Out Missing — ${displayDate}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: employeeId, title },
      });
      if (!alreadyNotified) {
        await this.notificationsService.create({
          organizationId,
          userId: employeeId,
          title,
          message: `We found a punch-in for ${displayDate} but no punch-out, so this day is marked Incomplete. Submit a regularization request with the correct times to resolve it.`,
          category: NotificationCategory.ATTENDANCE,
        });
      }
      return;
    }

    if (
      status === AttendanceStatus.ABSENT &&
      !punchInProgress &&
      !deferAbsenceNotice
    ) {
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
  // Resolves the org's configured IANA timezone for "today"/"yesterday"
  // calendar-day computations (see src/common/org-date.ts). Accepts an
  // explicit db client so callers already inside a transaction (e.g.
  // revertAttendanceForLeave) can read through the same tx rather than a
  // separate connection.
  private async getOrgTimezone(
    organizationId: string,
    db: Db = this.scopedPrisma,
  ): Promise<string> {
    const org = await db.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

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
      org?.timezone ?? DEFAULT_ORG_TIMEZONE,
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
      select: { id: true, isActive: true },
    });
    if (!org) {
      throw new UnauthorizedException('Invalid or missing Face API key.');
    }
    // A company the platform has suspended or archived records nothing, device key or not.
    if (!org.isActive) {
      throw new ForbiddenException(ORG_SUSPENDED_MESSAGE);
    }

    const user = await this.scopedPrisma.user.findFirst({
      where: { organizationId: dto.organizationId, employeeId: dto.employeeId },
    });
    if (!user) throw new NotFoundException('Employee not found.');
    if (!user.isActive) {
      throw new BadRequestException(
        'This employee is inactive. Attendance cannot be added for an inactive employee.',
      );
    }

    const rawPayload = dto.rawPayload as
      { location?: string; latitude?: number; longitude?: number } | undefined;
    const punchTime = dto.punchTime ? new Date(dto.punchTime) : new Date();
    assertPunchTimeSane(punchTime);

    const shiftConfig = await this.resolveEmployeeShiftConfig(
      user.id,
      dto.organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      shiftConfig,
    );
    if (attendanceDate < utcDateStrOf(user.joiningDate)) {
      throw new BadRequestException(
        `The date ${dmyText(attendanceDate)} is before this employee's joining date (${dmyText(utcDateStrOf(user.joiningDate))}).`,
      );
    }
    if (!isEmployedOn(user.exitDate, attendanceDate)) {
      throw new BadRequestException(
        `The date ${dmyText(attendanceDate)} is after this employee's last working day (${dmyText(user.exitDate!)}).`,
      );
    }
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

  async manualPunch(
    dto: ManualPunchDto,
    organizationId: string,
    actorId: string,
  ) {
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (!user) throw new NotFoundException('Employee not found.');
    if (!user.isActive) {
      throw new BadRequestException(
        'This employee is inactive. Attendance cannot be added for an inactive employee.',
      );
    }

    const punchTime = dto.punchTime ? new Date(dto.punchTime) : new Date();
    assertNotInFuture(punchTime, 'A punch time');
    const manualShiftConfig = await this.resolveEmployeeShiftConfig(
      user.id,
      organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      manualShiftConfig,
    );

    // Optional check-out, recorded with the check-in in one request so HR doesn't have to know to add a second punch.
    // In/out are still derived from the day's earliest/latest punch; this only validates that the two entered times
    // are a coherent pair.
    const outPunchTime = dto.outPunchTime
      ? new Date(dto.outPunchTime)
      : undefined;
    if (outPunchTime) {
      assertNotInFuture(outPunchTime, 'The Out time');
      if (!dto.punchTime) {
        throw new BadRequestException(
          'An In time (punchTime) is required when an Out time is given.',
        );
      }
      if (outPunchTime.getTime() <= punchTime.getTime()) {
        throw new BadRequestException('Out time must be after In time.');
      }
      if (
        resolveAttendanceDateForPunch(outPunchTime, manualShiftConfig) !==
        attendanceDate
      ) {
        throw new BadRequestException(
          'In and Out times must belong to the same shift day.',
        );
      }
    }
    if (attendanceDate < utcDateStrOf(user.joiningDate)) {
      throw new BadRequestException(
        `The date ${dmyText(attendanceDate)} is before this employee's joining date (${dmyText(utcDateStrOf(user.joiningDate))}).`,
      );
    }
    if (!isEmployedOn(user.exitDate, attendanceDate)) {
      throw new BadRequestException(
        `The date ${dmyText(attendanceDate)} is after this employee's last working day (${dmyText(user.exitDate!)}).`,
      );
    }
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
    let outPunch: Punch | undefined;
    if (outPunchTime) {
      try {
        outPunch = await this.scopedPrisma.punch.create({
          data: {
            organizationId,
            employeeId: user.id,
            punchTime: outPunchTime,
            source: PunchSource.MANUAL,
            location: dto.location ?? null,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
          },
        });
      } catch (err) {
        // Don't leave a lone check-in behind when the pair was requested.
        await this.scopedPrisma.punch.deleteMany({
          where: { id: punch.id, organizationId },
        });
        throw err;
      }
    }

    const attendance = await this.recalculateAttendanceForDay(
      this.scopedPrisma,
      user.id,
      attendanceDate,
      organizationId,
    );

    // HR/Admin back-entering a punch on someone else's behalf changes their
    // attendance (and so payroll) — recorded like other HR write actions.
    await this.auditLogService.log({
      actorId,
      action: 'ATTENDANCE_MANUAL_PUNCH',
      module: 'ATTENDANCE',
      organizationId,
      targetId: punch.id,
      details: {
        employeeId: user.id,
        punchTime: punchTime.toISOString(),
        ...(outPunch && { outPunchTime: outPunch.punchTime.toISOString() }),
        attendanceDate,
        attendanceId: attendance?.id ?? null,
      },
    });

    return { punch, ...(outPunch && { outPunch }), attendance };
  }

  async selfPunch(dto: SelfPunchDto, actor: Actor, organizationId: string) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      include: {
        workLocation: true,
        department: { include: { workLocation: true } },
      },
    });
    // What location this punch needs (their own setting, else the organization's): ENFORCED, RECORD_ONLY or NOT_NEEDED.
    const orgForPunch = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        orgPayrollAttendancePrefs: true,
        name: true,
        companyName: true,
      },
    });
    const locationMode = resolveLocationMode(
      employee?.locationRequirement,
      orgForPunch?.orgPayrollAttendancePrefs,
    );
    const hasLocation =
      typeof dto.latitude === 'number' && typeof dto.longitude === 'number';
    if (locationMode !== 'NOT_NEEDED' && !hasLocation) {
      throw new BadRequestException(
        'Your location is needed to check in or out. Allow location access and try again.',
      );
    }
    // A location from a fake-location app proves nothing about where the person is, so the punch is refused - and the
    // attempt is recorded, since it is the only trace HR will have. The device is the only source of this signal (Android
    // reports it; iOS and browsers do not), so it is a deterrent for honest clients rather than a guarantee.
    if (locationMode !== 'NOT_NEEDED' && dto.mockedLocation === true) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'ATTENDANCE_MOCK_LOCATION_BLOCKED',
        module: 'ATTENDANCE',
        organizationId,
        details: {
          employeeId: actor.id,
          attendanceDate: dateStrInOrgTz(
            await this.getOrgTimezone(organizationId),
          ),
        },
      });
      throw new ForbiddenException(
        'Your device reports a mock (fake) location, so this punch was not recorded. Turn off any mock-location app and try again.',
      );
    }
    const orgTimezone = await this.getOrgTimezone(organizationId);
    const punchTime = new Date();
    const selfShiftConfig = await this.resolveEmployeeShiftConfig(
      actor.id,
      organizationId,
    );
    const attendanceDate = resolveAttendanceDateForPunch(
      punchTime,
      selfShiftConfig,
    );
    // Not before they have joined, and not after their last working day (the account stays open until the exit is
    // completed, but they are no longer working).
    if (employee && attendanceDate < utcDateStrOf(employee.joiningDate)) {
      throw new BadRequestException(
        `You can check in from your joining date (${dmyText(utcDateStrOf(employee.joiningDate))}).`,
      );
    }
    if (employee && !isEmployedOn(employee.exitDate, attendanceDate)) {
      throw new BadRequestException(
        `Your last working day was ${dmyText(employee.exitDate!)}, so attendance can no longer be recorded.`,
      );
    }

    // Selfie at check-in/out: the employee's own setting, else the org's
    // (common/selfie-requirement.ts). Enforced here, not just in the app, so
    // a punch can't skip it when it's required.
    if (!dto.selfieUrl?.trim()) {
      const org = await this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { orgPayrollAttendancePrefs: true },
      });
      if (
        isSelfieRequired(
          employee?.selfieRequirement,
          org?.orgPayrollAttendancePrefs,
        )
      ) {
        throw new BadRequestException(
          'A selfie is required to check in or out.',
        );
      }
    }

    const fence = employee ? effectiveWorkLocation(employee) : null;
    // Only ENFORCED looks at the work location at all: RECORD_ONLY stores the point and NOT_NEEDED takes none.
    if (
      locationMode === 'ENFORCED' &&
      !fence &&
      employee?.requireWorkLocationForPunch
    ) {
      // Per-employee, not org-wide: an office-based employee is marked
      // this way so a missing location is a real data gap that blocks
      // them, not an implicit "exempt from geo-fencing" — a remote/field
      // employee with this left off still punches from anywhere, same as
      // before.
      throw new ForbiddenException(
        'No work location is assigned to you yet — contact HR before you can punch in/out.',
      );
    }
    if (locationMode === 'ENFORCED' && fence && fence.isActive) {
      // WFH-only, and only once approved (see WfhApprovalStatus's comment
      // on the schema) — a self-declared-but-unreviewed WFH day, or any
      // other arrangement (HYBRID/CLIENT_SITE included), still enforces
      // the fence exactly as before. Checked fresh on every punch (not
      // just punch-in) so switching arrangement mid-day is respected.
      // Looked up by `attendanceDate` — the same shift-day this punch will
      // itself be attributed to (resolveAttendanceDateForPunch) — not by
      // todayInOrgTz(orgTimezone): those two disagree for part of every day
      // for a non-crossesMidnight shift (date attribution here is UTC-based,
      // org-timezone-agnostic), which previously caused an approved WFH row
      // for "today" to go unmatched — and the fence to wrongly apply — for
      // employees punching in during that mismatch window.
      const today = await this.scopedPrisma.attendance.findFirst({
        where: {
          organizationId,
          employeeId: actor.id,
          date: attendanceDate,
        },
        select: { workArrangement: true, workArrangementStatus: true },
      });
      const wfhExempt =
        today?.workArrangement === WorkArrangement.WFH &&
        today?.workArrangementStatus === WfhApprovalStatus.APPROVED;

      if (!wfhExempt) {
        // The device's own accuracy widens the fence slightly (capped), so a good-faith punch from the edge of the
        // area is not refused because of GPS drift.
        const inside = isInsideGeoFenceWithAccuracy(
          dto.latitude as number,
          dto.longitude as number,
          fence,
          dto.accuracyMeters,
        );
        if (inside === false) {
          throw new ForbiddenException(
            `You must be inside your office geo-fence (${fence.name}) to punch in/out.`,
          );
        }
      }
    }

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
      // The selfie is stamped with the facts of the punch (time, place, battery, who) before the row is written, so
      // every place that shows it shows the stamped copy; the photo as taken is kept alongside. Best-effort.
      let selfieUrl: string | null = dto.selfieUrl ?? null;
      let selfieOriginalUrl: string | null = null;
      if (dto.selfieUrl) {
        const stamped = await this.stampSelfie(
          dto,
          actor,
          organizationId,
          punchTime,
          orgForPunch?.companyName ?? orgForPunch?.name ?? '',
          locationMode,
        );
        if (stamped) {
          selfieOriginalUrl = dto.selfieUrl;
          selfieUrl = stamped;
        }
      }
      punch = await this.scopedPrisma.punch.create({
        data: {
          organizationId,
          employeeId: actor.id,
          punchTime,
          source: PunchSource.MANUAL,
          // No location is stored when the rule says none is needed.
          latitude:
            locationMode === 'NOT_NEEDED' ? null : (dto.latitude ?? null),
          longitude:
            locationMode === 'NOT_NEEDED' ? null : (dto.longitude ?? null),
          selfieUrl,
          selfieOriginalUrl,
          batteryPercent: dto.batteryPercent ?? null,
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
        // The org-local calendar day the punch itself falls in (not a
        // literal UTC day range) — see dayRangeInOrgTz's doc comment for
        // why the naive UTC range silently drops punches near the org's
        // own day boundary.
        punchTime: dayRangeInOrgTz(
          todayInOrgTz(orgTimezone, punchTime),
          orgTimezone,
        ),
      },
    });

    return { punch, attendance, punchCount };
  }

  // Stamps the punch's selfie (see SelfieStampService); returns the stamped copy's key, or null to keep the original.
  private async stampSelfie(
    dto: SelfPunchDto,
    actor: Actor,
    organizationId: string,
    punchTime: Date,
    companyName: string,
    locationMode: 'ENFORCED' | 'RECORD_ONLY' | 'NOT_NEEDED',
  ): Promise<string | null> {
    if (!dto.selfieUrl) return null;
    const { timeFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const orgTimezone = await this.getOrgTimezone(organizationId);
    // The first punch of the day is the check-in, the next the check-out, and so on - the same reading the app uses.
    const before = await this.scopedPrisma.punch.count({
      where: {
        organizationId,
        employeeId: actor.id,
        punchTime: dayRangeInOrgTz(
          todayInOrgTz(orgTimezone, punchTime),
          orgTimezone,
        ),
      },
    });
    const kind = before % 2 === 0 ? 'Check-in' : 'Check-out';
    const code = (actor as { employeeId?: string | null }).employeeId;
    const place =
      locationMode !== 'NOT_NEEDED' &&
      typeof dto.latitude === 'number' &&
      typeof dto.longitude === 'number'
        ? `Lat ${dto.latitude.toFixed(6)}, Lng ${dto.longitude.toFixed(6)}${
            typeof dto.accuracyMeters === 'number'
              ? ` (+/-${Math.round(dto.accuracyMeters)} m)`
              : ''
          }`
        : null;
    return this.selfieStampService.stamp(dto.selfieUrl, {
      title: `${kind} - ${formatDateTimeDisplay(punchTime, '', 'DD-MM-YYYY', timeFormat, timeZone)}`,
      who: `${actor.name}${code ? ` (${code})` : ''}${companyName ? ` - ${companyName}` : ''}`,
      place,
      batteryPercent:
        typeof dto.batteryPercent === 'number' ? dto.batteryPercent : null,
    });
  }

  // Migration of PAST Work From Home from a spreadsheet (Admin/HR): each row is a range of days one employee worked from
  // home, recorded as already approved - by the importer, with no notification to the employee. The days count as
  // Present (they were worked), so nobody loses pay for them; a day that already has real punches keeps them. Weekly
  // offs, holidays and full-day leave inside a range are left out, like a normal request. dryRun (the default) only
  // checks every row; a month whose payroll is already locked is refused, as for imported leave.
  async importWfh(
    dto: ImportWfhDto,
    importer: Actor,
    organizationId: string,
  ): Promise<ImportWfhResult> {
    const dryRun = dto.dryRun !== false;
    const str = (v: unknown) =>
      v === undefined || v === null ? '' : String(v).trim();
    const todayStr = todayInOrgTz(await this.getOrgTimezone(organizationId));

    const codes = new Set(
      dto.rows.map((r) => str(r.employeeId).toLowerCase()).filter(Boolean),
    );
    const employees = codes.size
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId },
          omit: { password: true },
        })
      : [];
    const byCode = new Map(
      employees.map((e) => [e.employeeId.toLowerCase(), e]),
    );
    // Dates already given earlier in this same file, per employee: a repeated day is the same day, not a second request.
    const seen = new Map<string, Set<string>>();

    const results: ImportWfhRowResult[] = [];
    for (const [i, row] of dto.rows.entries()) {
      const from = str(row.fromDate);
      const to = str(row.toDate) || from;
      const out: ImportWfhRowResult = {
        row: i + 1,
        employeeId: str(row.employeeId),
        fromDate: from,
        toDate: to,
        status: 'ERROR',
      };
      results.push(out);
      try {
        const employee = byCode.get(str(row.employeeId).toLowerCase());
        if (!employee) throw new BadRequestException('Unknown employee ID.');
        out.employeeName = employee.name;
        // Same boundary as editing someone's personal data: only an Admin touches an HR or Admin employee's record.
        if (
          importer.role !== Role.ADMIN &&
          (employee.role === Role.ADMIN || employee.role === Role.HR)
        ) {
          throw new ForbiddenException(
            'Only an Admin can import Work From Home for an HR or Admin employee.',
          );
        }
        if (
          !isValidCalendarDateString(from) ||
          !isValidCalendarDateString(to)
        ) {
          throw new BadRequestException(
            'From and To must be real dates (DD-MM-YYYY).',
          );
        }
        if (to < from) {
          throw new BadRequestException('To cannot be before From.');
        }
        if (to > todayStr) {
          throw new BadRequestException(
            'Only past days can be imported - the To date cannot be after today. Employees request upcoming days themselves.',
          );
        }
        if (from < utcDateStrOf(employee.joiningDate)) {
          throw new BadRequestException(
            `The date is before the employee's joining date (${dmyText(utcDateStrOf(employee.joiningDate))}).`,
          );
        }
        if (calendarSpan(from, to) > MAX_WFH_RANGE_DAYS) {
          throw new BadRequestException(
            `A row can cover at most ${MAX_WFH_RANGE_DAYS} days - split a longer period over several rows.`,
          );
        }
        const { days: candidates, skipped } = await this.wfhDaysFor(
          employee,
          organizationId,
          from,
          to,
        );
        const taken = seen.get(employee.id) ?? new Set<string>();
        const days = candidates.filter((d) => !taken.has(d));
        const repeated = candidates.length - days.length;
        if (days.length === 0) {
          throw new BadRequestException(
            candidates.length > 0
              ? 'Every day of this row is already given by an earlier row of the file.'
              : 'There is no working day to record in that range (weekly offs, holidays, leave and days that already have Work From Home are not included).',
          );
        }
        // The payroll month must still be open: the day becomes Present and the month's attendance changes.
        await assertPayrollMonthsUnlocked(
          this.scopedPrisma,
          organizationId,
          employee.id,
          [
            ...new Map(
              days.map((d) => [
                d.slice(0, 7),
                { month: Number(d.slice(5, 7)), year: Number(d.slice(0, 4)) },
              ]),
            ).values(),
          ],
          'Work From Home',
        );
        out.days = days.length;
        const left = skipped.length + repeated;
        const note = left > 0 ? ` (${left} other day(s) in the range left out)` : '';
        if (dryRun) {
          out.status = 'OK';
          out.message = `Would record ${days.length} day(s)${note}.`;
        } else {
          await this.recordImportedWfh(
            employee,
            importer,
            organizationId,
            days,
            str(row.reason),
          );
          out.status = 'IMPORTED';
          out.message = `Recorded ${days.length} day(s)${note}.`;
        }
        days.forEach((d) => taken.add(d));
        seen.set(employee.id, taken);
      } catch (err) {
        out.status = 'ERROR';
        out.message =
          err instanceof Error
            ? err.message
            : 'The row could not be processed.';
      }
    }

    const imported = results.filter((r) => r.status === 'IMPORTED').length;
    const ok = results.filter((r) => r.status === 'OK').length;
    const failed = results.filter((r) => r.status === 'ERROR').length;
    if (!dryRun) {
      await this.auditLogService.log({
        actorId: importer.id,
        action: 'WFH_IMPORT_RUN',
        module: 'ATTENDANCE',
        organizationId,
        details: { rows: results.length, imported, failed },
      });
    }
    return { dryRun, total: results.length, ok, imported, failed, rows: results };
  }

  // Writes one imported row: every day becomes an approved Work From Home day (approved by the importer, one request id
  // for a multi-day row) and a Present day, in one transaction so a row is all or nothing.
  private async recordImportedWfh(
    employee: { id: string; name: string; employeeId: string },
    importer: Actor,
    organizationId: string,
    days: string[],
    reason: string,
  ) {
    const requestId = days.length > 1 ? crypto.randomUUID() : null;
    await this.scopedPrisma.$transaction(async (tx) => {
      for (const day of days) {
        // Marks a payroll run already calculated for the month as outdated (it is recalculated before it can be approved).
        await assertPayrollPeriodUnlocked(
          tx,
          organizationId,
          employee.id,
          day,
        );
        const fields = {
          workArrangement: WorkArrangement.WFH,
          workArrangementStatus: WfhApprovalStatus.APPROVED,
          workArrangementReviewedById: importer.id,
          workArrangementReviewedAt: new Date(),
          workArrangementReviewComments: `Imported${reason ? `: ${reason}` : ''}`,
          wfhRequestId: requestId,
        };
        const existing = await tx.attendance.findFirst({
          where: { organizationId, employeeId: employee.id, date: day },
        });
        if (existing) {
          // The day was worked: an Absent / Incomplete day becomes Present; one with real punches, a half day or leave
          // keeps what it is.
          const becomesPresent =
            existing.status === AttendanceStatus.ABSENT ||
            existing.status === AttendanceStatus.INCOMPLETE;
          await tx.attendance.updateMany({
            where: { id: existing.id, organizationId },
            data: {
              ...fields,
              ...(becomesPresent
                ? {
                    status: AttendanceStatus.PRESENT,
                    source: AttendanceSource.EXCEL_IMPORT,
                  }
                : {}),
            },
          });
        } else {
          await tx.attendance.create({
            data: {
              organizationId,
              employeeId: employee.id,
              date: day,
              status: AttendanceStatus.PRESENT,
              source: AttendanceSource.EXCEL_IMPORT,
              ...fields,
            },
          });
        }
      }
    });
    const label =
      days.length === 1
        ? days[0]
        : `${days[0]} to ${days[days.length - 1]} (${days.length} days)`;
    await this.timelineService.logEvent({
      organizationId,
      employeeId: employee.id,
      eventKey: 'WFH_APPROVED',
      performedById: importer.id,
      description: `Imported Work From Home for ${label}${reason ? `: ${reason}` : ''}.`,
      metadata: { wfhRequestId: requestId, days, imported: true },
    });
    await this.auditLogService.log({
      actorId: importer.id,
      action: 'WFH_IMPORTED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: employee.id,
      details: { employeeCode: employee.employeeId, days, requestId },
    });
  }

  // WFH "balance" for the employee profile. Work From Home has no quota in this system (no allowance to count down
  // from), so this is the usage side: approved WFH days in the leave year so far and in this month, approved days still
  // to come, and days awaiting approval. An employee sees their own; Admin/HR anyone; a Manager their department.
  async getWfhSummary(
    employeeIdParam: string | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    let employeeId = actor.id;
    if (employeeIdParam && employeeIdParam !== actor.id) {
      if (
        actor.role !== Role.ADMIN &&
        actor.role !== Role.HR &&
        actor.role !== Role.MANAGER
      ) {
        throw new ForbiddenException(
          "You cannot view another employee's Work From Home balance.",
        );
      }
      const exists = await this.scopedPrisma.user.findFirst({
        where: { id: employeeIdParam, organizationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Employee not found.');
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employeeIdParam,
      );
      employeeId = employeeIdParam;
    }
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true, enableWFH: true, policies: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const cfg = await getLeaveYearConfig(this.scopedPrisma, organizationId);
    const year = leaveYearBounds(currentLeaveYear(today, cfg), cfg);
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthEnd = `${today.slice(0, 7)}-${String(
      new Date(
        Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0),
      ).getUTCDate(),
    ).padStart(2, '0')}`;
    const wfh = {
      organizationId,
      employeeId,
      workArrangement: WorkArrangement.WFH,
    };
    const count = (
      status: WfhApprovalStatus,
      date: { gte?: string; lte?: string },
    ) =>
      this.scopedPrisma.attendance.count({
        where: { ...wfh, workArrangementStatus: status, date },
      });
    const [usedThisYear, usedThisMonth, upcoming, pending] = await Promise.all(
      [
        count(WfhApprovalStatus.APPROVED, {
          gte: year.start,
          lte: today < year.end ? today : year.end,
        }),
        count(WfhApprovalStatus.APPROVED, {
          gte: monthStart,
          lte: today < monthEnd ? today : monthEnd,
        }),
        // Approved days after today (a request is approved before its day arrives).
        this.scopedPrisma.attendance.count({
          where: {
            ...wfh,
            workArrangementStatus: WfhApprovalStatus.APPROVED,
            date: { gt: today },
          },
        }),
        this.scopedPrisma.attendance.count({
          where: {
            ...wfh,
            workArrangementStatus: WfhApprovalStatus.PENDING,
            date: { gte: year.start },
          },
        }),
      ],
    );
    return {
      enabled: org?.enableWFH !== false,
      // The company's WFH days allowed per month (null = no limit): what usedThisMonth is shown "out of".
      allowedPerMonth: wfhDaysPerMonthOf(
        (org?.policies as { wfhDaysPerMonth?: unknown } | null)?.wfhDaysPerMonth,
      ),
      yearStart: year.start,
      yearEnd: year.end,
      usedThisYear,
      usedThisMonth,
      upcoming,
      pending,
    };
  }

  async getTodayPunchCount(actor: Actor, organizationId: string) {
    const orgTimezone = await this.getOrgTimezone(organizationId);
    const punchCount = await this.scopedPrisma.punch.count({
      where: {
        organizationId,
        employeeId: actor.id,
        punchTime: dayRangeInOrgTz(todayInOrgTz(orgTimezone), orgTimezone),
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
      // A single day stands alone; a group id left from an earlier multi-day request must not stick to it.
      wfhRequestId: null,
    };

    // A date range is a different request: several days, reviewed together.
    if (isWfh && dto.endDate && dto.date && dto.endDate !== dto.date) {
      return this.requestWfhRange(dto, actor, organizationId);
    }
    if (dto.endDate && !dto.date) {
      throw new BadRequestException('endDate needs a start date.');
    }

    const todayStr = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const dateStr = dto.date ?? todayStr;
    if (dto.date) {
      if (dateStr < addDaysStr(todayStr, -31)) {
        throw new BadRequestException(
          'The date is too far in the past. A work arrangement can be set for the last 31 days or up to 60 days ahead.',
        );
      }
      if (dateStr > addDaysStr(todayStr, 60)) {
        throw new BadRequestException(
          'The date is too far ahead. A work arrangement can be set up to 60 days ahead.',
        );
      }
      const me = await this.scopedPrisma.user.findFirst({
        where: { id: actor.id, organizationId },
        select: { joiningDate: true },
      });
      if (me && dateStr < utcDateStrOf(me.joiningDate)) {
        throw new BadRequestException(
          `The date is before your joining date (${dmyText(utcDateStrOf(me.joiningDate))}).`,
        );
      }
      await assertPayrollPeriodUnlocked(
        this.scopedPrisma,
        organizationId,
        actor.id,
        dateStr,
      );
    }
    const meEmployment = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      select: { joiningDate: true, exitDate: true },
    });
    if (meEmployment && dateStr < utcDateStrOf(meEmployment.joiningDate)) {
      throw new BadRequestException(
        `The date is before your joining date (${dmyText(utcDateStrOf(meEmployment.joiningDate))}).`,
      );
    }
    if (meEmployment && !isEmployedOn(meEmployment.exitDate, dateStr)) {
      throw new BadRequestException(
        `The date is after your last working day (${dmyText(meEmployment.exitDate!)}).`,
      );
    }
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
      const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      await this.timelineService.logEvent({
        organizationId,
        employeeId: actor.id,
        eventKey: 'WFH_REQUESTED',
        performedById: actor.id,
        description: `Requested Work From Home for ${formatDateDisplay(dateStr, '', dateFormat, timeZone)}.`,
      });
      await this.notifyWfhRequested(actor, dateStr, organizationId);
    }

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId: actor.id, date: dateStr },
    });
  }

  // The working days a multi-day Work From Home request would cover for the caller, and the days left out with why.
  // Shared by the preview and by the request itself, so what is shown is what is asked for.
  private async wfhDaysFor(
    actor: Actor,
    organizationId: string,
    from: string,
    to: string,
  ): Promise<WfhRequestDays> {
    const [employee, org] = await Promise.all([
      this.scopedPrisma.user.findFirst({
        where: { id: actor.id, organizationId },
        include: { department: true },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
      }),
    ]);
    const { weeklyOffs } = resolveShiftConfig(
      employee?.department ?? null,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
      org?.timezone ?? DEFAULT_ORG_TIMEZONE,
    );
    const [holidays, leaves, existing] = await Promise.all([
      this.scopedPrisma.holiday.findMany({
        where: {
          organizationId,
          AND: [holidayInEffect],
          isOptional: false,
          date: { gte: from, lte: to },
          OR: employee?.departmentId
            ? [{ departmentId: null }, { departmentId: employee.departmentId }]
            : [{ departmentId: null }],
        },
        select: { date: true },
      }),
      this.scopedPrisma.leave.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          isHalfDay: false,
          status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { startDate: true, endDate: true },
      }),
      this.scopedPrisma.attendance.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          date: { gte: from, lte: to },
          workArrangement: WorkArrangement.WFH,
          workArrangementStatus: {
            in: [WfhApprovalStatus.PENDING, WfhApprovalStatus.APPROVED],
          },
        },
        select: { date: true },
      }),
    ]);
    const leaveDates = new Set<string>();
    for (const l of leaves) {
      const start = l.startDate > from ? l.startDate : from;
      const end = l.endDate < to ? l.endDate : to;
      for (let d = start; d <= end; d = addDaysStr(d, 1)) leaveDates.add(d);
    }
    // Only days they are employed: not before joining, not after the last working day.
    const joinedStr = employee ? utcDateStrOf(employee.joiningDate) : from;
    const effFrom = from < joinedStr ? joinedStr : from;
    const effTo = employee?.exitDate && employee.exitDate < to ? employee.exitDate : to;
    const result = wfhRequestDays({
      from: effFrom,
      to: effTo,
      isWeeklyOff: (date) => isWeeklyOff(date, weeklyOffs),
      holidayDates: new Set(holidays.map((h) => h.date)),
      leaveDates,
    });
    // A day that is already requested or approved is not asked for again (that would reset its review).
    const already = new Set(existing.map((e) => e.date));
    if (already.size === 0) return result;
    return {
      days: result.days.filter((d) => !already.has(d)),
      skipped: [
        ...result.skipped,
        ...result.days
          .filter((d) => already.has(d))
          .map((date) => ({ date, reason: 'ALREADY_REQUESTED' as const })),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  // What a multi-day request would cover, before it is sent (nothing is written).
  async previewWfhDays(
    query: PreviewWfhDaysQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    if (query.to < query.from) {
      throw new BadRequestException(
        'The end date cannot be before the start date.',
      );
    }
    if (calendarSpan(query.from, query.to) > MAX_WFH_RANGE_DAYS) {
      throw new BadRequestException(
        `A Work From Home request can cover at most ${MAX_WFH_RANGE_DAYS} days.`,
      );
    }
    const r = await this.wfhDaysFor(
      actor,
      organizationId,
      query.from,
      query.to,
    );
    return { ...r, count: r.days.length };
  }

  // One request for several days: each working day becomes its own attendance row (that is where the arrangement and
  // its review live), all sharing one wfhRequestId so the approver sees and decides them as a single request.
  private async requestWfhRange(
    dto: SetWorkArrangementDto,
    actor: Actor,
    organizationId: string,
  ) {
    const from = dto.date as string;
    const to = dto.endDate as string;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org?.enableWFH) {
      throw new BadRequestException(
        'Work From Home is disabled for this organization.',
      );
    }
    if (to < from) {
      throw new BadRequestException(
        'The end date cannot be before the start date.',
      );
    }
    if (calendarSpan(from, to) > MAX_WFH_RANGE_DAYS) {
      throw new BadRequestException(
        `A Work From Home request can cover at most ${MAX_WFH_RANGE_DAYS} days.`,
      );
    }
    const todayStr = todayInOrgTz(await this.getOrgTimezone(organizationId));
    if (from < addDaysStr(todayStr, -31)) {
      throw new BadRequestException(
        'The date is too far in the past. A work arrangement can be set for the last 31 days or up to 60 days ahead.',
      );
    }
    if (to > addDaysStr(todayStr, 60)) {
      throw new BadRequestException(
        'The date is too far ahead. A work arrangement can be set up to 60 days ahead.',
      );
    }
    const me = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      select: { joiningDate: true },
    });
    if (me && from < utcDateStrOf(me.joiningDate)) {
      throw new BadRequestException(
        `The date is before your joining date (${dmyText(utcDateStrOf(me.joiningDate))}).`,
      );
    }
    const { days, skipped } = await this.wfhDaysFor(
      actor,
      organizationId,
      from,
      to,
    );
    if (days.length === 0) {
      throw new BadRequestException(
        'There is no working day left to request in that range (weekly offs, holidays, leave and days already requested are not included).',
      );
    }
    for (const day of days) {
      await assertPayrollPeriodUnlocked(
        this.scopedPrisma,
        organizationId,
        actor.id,
        day,
      );
    }
    const requestId = crypto.randomUUID();
    const fields = {
      workArrangement: WorkArrangement.WFH,
      workArrangementStatus: WfhApprovalStatus.PENDING,
      workArrangementReviewedById: null,
      workArrangementReviewedAt: null,
      workArrangementReviewComments: null,
      wfhRequestId: requestId,
    };
    for (const day of days) {
      const existing = await this.scopedPrisma.attendance.findFirst({
        where: { organizationId, employeeId: actor.id, date: day },
      });
      if (existing) {
        await this.scopedPrisma.attendance.updateMany({
          where: { id: existing.id, organizationId },
          data: fields,
        });
      } else {
        await this.scopedPrisma.attendance.create({
          data: { organizationId, employeeId: actor.id, date: day, ...fields },
        });
      }
    }
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const label = `${formatDateDisplay(days[0], '', dateFormat, timeZone)} to ${formatDateDisplay(days[days.length - 1], '', dateFormat, timeZone)} (${days.length} day${days.length === 1 ? '' : 's'})`;
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'WFH_REQUESTED',
      performedById: actor.id,
      description: `Requested Work From Home for ${label}.`,
      metadata: { wfhRequestId: requestId, days },
    });
    await this.notifyWfhRequested(actor, label, organizationId, true);
    return { requestId, days, skipped, count: days.length };
  }

  private async notifyWfhRequested(
    actor: Actor,
    date: string,
    organizationId: string,
    // `date` is already a display label (a range), not a single YYYY-MM-DD.
    preformatted = false,
  ) {
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.notificationsService.notifyReviewers({
      organizationId,
      requester: actor,
      title: 'Work From Home Requested',
      message: `${actor.name} requested Work From Home for ${preformatted ? date : formatDateDisplay(date, '', dateFormat, timeZone)}, pending your approval.`,
      category: NotificationCategory.ATTENDANCE,
      managerFirst: true,
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
      // deptScopedEmployeeIds scopes a departmentless manager to nobody —
      // a raw `departmentId: actor.departmentId` filter would turn into
      // `IS NULL` and match every unassigned employee in the org.
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }

    return this.scopedPrisma.attendance.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
    });
  }

  // Decided Work From Home days (same scoping as the pending queue), newest first, each with the reviewer's name.
  async listDecidedWfhRequests(
    actor: Actor,
    organizationId: string,
    query: { status?: 'approved' | 'rejected' | 'decided'; from?: string },
  ) {
    const statuses =
      query.status === 'approved'
        ? [WfhApprovalStatus.APPROVED]
        : query.status === 'rejected'
          ? [WfhApprovalStatus.REJECTED]
          : [WfhApprovalStatus.APPROVED, WfhApprovalStatus.REJECTED];
    const where: Prisma.AttendanceWhereInput = {
      organizationId,
      workArrangement: WorkArrangement.WFH,
      workArrangementStatus: { in: statuses },
    };
    if (query.from) where.date = { gte: query.from };
    if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }
    const rows = await this.scopedPrisma.attendance.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { date: 'desc' }],
    });
    const reviewerIds = [
      ...new Set(
        rows.map((r) => r.workArrangementReviewedById).filter(Boolean),
      ),
    ] as string[];
    const reviewers = reviewerIds.length
      ? await this.scopedPrisma.user.findMany({
          where: { id: { in: reviewerIds }, organizationId },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(reviewers.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      ...r,
      workArrangementReviewedByName: r.workArrangementReviewedById
        ? (nameById.get(r.workArrangementReviewedById) ?? null)
        : null,
    }));
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
    await this.auditLogService.logSelfApproval(actor, {
      module: 'ATTENDANCE',
      targetId: id,
      employeeId: row.employeeId,
      request: 'Work From Home',
    });

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

    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = `Work From Home Request ${dto.decision}`;
    const message = `Your Work From Home request for ${formatDateDisplay(row.date, '', dateFormat, timeZone)} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
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
          date: formatDateDisplay(row.date, '', dateFormat, timeZone),
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

  // Decide a multi-day Work From Home request as one: every still-pending day sharing the request id gets the same
  // decision. One timeline entry, one notification and one email summarise it (not one per day). A day already
  // reviewed on its own is left as it is. Scope and delegation rules are the same as for a single day.
  async reviewWfhRequestGroup(
    requestId: string,
    dto: ReviewWfhDto,
    actor: Actor,
    organizationId: string,
  ) {
    const rows = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        wfhRequestId: requestId,
        workArrangement: WorkArrangement.WFH,
        workArrangementStatus: WfhApprovalStatus.PENDING,
      },
      include: { employee: true },
      orderBy: { date: 'asc' },
    });
    if (rows.length === 0) {
      throw new NotFoundException(
        'No pending Work From Home days found for this request - it may already have been reviewed.',
      );
    }
    const employee = rows[0].employee;
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      employee.id,
    );
    await this.auditLogService.logSelfApproval(actor, {
      module: 'ATTENDANCE',
      targetId: requestId,
      employeeId: employee.id,
      request: 'Work From Home',
    });
    const status =
      dto.decision === 'APPROVED'
        ? WfhApprovalStatus.APPROVED
        : WfhApprovalStatus.REJECTED;
    await this.scopedPrisma.attendance.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, organizationId },
      data: {
        workArrangementStatus: status,
        workArrangementReviewedById: actor.id,
        workArrangementReviewedAt: new Date(),
        workArrangementReviewComments: dto.comments ?? '',
      },
    });
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const first = rows[0].date;
    const last = rows[rows.length - 1].date;
    const label =
      rows.length === 1
        ? formatDateDisplay(first, '', dateFormat, timeZone)
        : `${formatDateDisplay(first, '', dateFormat, timeZone)} to ${formatDateDisplay(last, '', dateFormat, timeZone)} (${rows.length} days)`;
    await this.timelineService.logEvent({
      organizationId,
      employeeId: employee.id,
      eventKey: dto.decision === 'APPROVED' ? 'WFH_APPROVED' : 'WFH_REJECTED',
      performedById: actor.id,
      description: `${label}${dto.comments ? `: ${dto.comments}` : ''}`,
      metadata: { wfhRequestId: requestId, days: rows.map((r) => r.date) },
    });
    const title = `Work From Home Request ${dto.decision}`;
    const message = `Your Work From Home request for ${label} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.ATTENDANCE,
    });
    {
      const { subject, html } = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'WFH_DECISION',
        {
          employeeName: employee.name,
          decision: dto.decision,
          date: label,
          comments: dto.comments ?? '',
        },
        { subject: title, html: message },
      );
      void this.emailService.send({
        to: employee.email,
        subject,
        html,
        organizationId,
      });
    }
    return { requestId, decision: dto.decision, count: rows.length };
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

  // One employee's day for the Attendance Tracker popup: the attendance record, any overtime logged for it, the person's shift and how long
  // they worked beyond it. ADMIN/HR may open anyone; a MANAGER only their department; an employee only themself.
  async getDayDetail(employeeId: string, date: string, actor: Actor, organizationId: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date must be YYYY-MM-DD.');
    if (actor.role === Role.EMPLOYEE && actor.id !== employeeId) throw new ForbiddenException('You can only view your own attendance.');
    if (actor.role === Role.MANAGER && actor.id !== employeeId) {
      const ids = new Set(await deptScopedEmployeeIds(this.scopedPrisma, actor, organizationId));
      if (!ids.has(employeeId)) throw new ForbiddenException('You can only view attendance for your own department.');
    }
    const employee = await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, include: { department: true } });
    if (!employee) throw new NotFoundException('Employee not found.');
    const [record, overtime, org] = await Promise.all([
      this.scopedPrisma.attendance.findFirst({ where: { organizationId, employeeId, date } }),
      this.scopedPrisma.overtimeRecord.findMany({ where: { organizationId, employeeId, date }, orderBy: { createdAt: 'asc' } }),
      this.prisma.organization.findUnique({ where: { id: organizationId } }),
    ]);
    const shift = resolveShiftConfig(employee.department, org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null, org?.timezone ?? DEFAULT_ORG_TIMEZONE);
    const shiftNetMinutes = shiftMinutes(shift.shiftStartTime, shift.shiftEndTime, shift.crossesMidnight, shift.breakMinutes);
    return {
      date,
      record,
      overtime,
      shift: { startTime: shift.shiftStartTime, endTime: shift.shiftEndTime, minutes: shiftNetMinutes },
      extraMinutes: extraMinutesBeyondShift(record?.workDurationMinutes ?? 0, shiftNetMinutes),
    };
  }

  async list(query: QueryAttendanceDto, actor: Actor, organizationId: string) {
    const where: Prisma.AttendanceWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      // Same null-department guard as listPendingWfhRequests.
      const deptEmployeeIds = new Set(
        await deptScopedEmployeeIds(this.scopedPrisma, actor, organizationId),
      );
      where.employeeId =
        query.employeeId && deptEmployeeIds.has(query.employeeId)
          ? query.employeeId
          : { in: [...deptEmployeeIds] };
    } else if (query.employeeId) {
      // Not an employee of this organisation: "not found", like every other employee endpoint, rather than an empty list.
      const exists = await this.scopedPrisma.user.findFirst({
        where: { id: query.employeeId, organizationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Employee not found.');
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

    // No record is shown for a day before the employee joined (an import, a manual entry or an old row can carry
    // one): rows dated before that person's joining date are left out of the list, the count and the summary.
    const beforeJoining = await this.rowsBeforeJoining(
      where.employeeId as Prisma.UserWhereInput['id'] | undefined,
      query.from,
      query.to,
      organizationId,
    );
    if (beforeJoining)
      where.AND = [...((where.AND as []) ?? []), beforeJoining];

    // A bounded date range (≤31 days — the Attendance Records page's own
    // Month filter sends exactly this) gets the same "no row = Absent (or
    // Holiday/Weekly Off/On Leave)" backfill the Attendance & Leave Tracker
    // dashboard grid already applies, so the two pages agree — a range with
    // no punches ever recorded used to show real zero-count summary cards
    // here while the dashboard showed a grid full of Absent, which read as
    // the two pages disagreeing about the same data. An unbounded query
    // (no from/to) skips this — synthesizing across an employee's entire
    // history on every request isn't bounded work.
    const rangeDays =
      query.from && query.to
        ? enumerateDateStrings(query.from, query.to)
        : null;
    const result =
      rangeDays && rangeDays.length <= 31
        ? await this.listWithSyntheticAbsences(
            where,
            rangeDays,
            query,
            organizationId,
          )
        : await paginate(
            () =>
              this.scopedPrisma.attendance.findMany({
                where,
                include: {
                  employee: {
                    select: ATTENDANCE_LIST_EMPLOYEE_SELECT,
                  },
                },
                // Newest day first, then by employee. Ordering by employee first made every page a slice of one
                // person's whole history, so a month's records started mid-month and jumped between months.
                orderBy: [{ date: 'desc' }, ...EMPLOYEE_RELATION_ORDER_BY],
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
              AND: [holidayInEffect],
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

    // Reviewer names for the Regularization column ("Approved by …"); regularization.reviewedBy is just an id.
    const reviewerIds = [
      ...new Set(
        result.data
          .map(
            (r) =>
              (r.regularization as unknown as RegularizationState | null)
                ?.reviewedBy,
          )
          .filter((id): id is string => !!id),
      ),
    ];
    const reviewers = reviewerIds.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, id: { in: reviewerIds } },
          select: { id: true, name: true },
        })
      : [];
    const reviewerNameById = new Map(reviewers.map((u) => [u.id, u.name]));

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
            ? isInsideGeoFenceWithAccuracy(
                record.checkinLatitude,
                record.checkinLongitude,
                fence,
                // The accuracy allowance a punch may have been accepted with (the reading's own accuracy is not
                // stored), so a punch the server accepted never shows here as outside.
                MAX_ACCURACY_ALLOWANCE_METERS,
              )
            : null;
        // Same verdict for the check-out point, so the Attendance table's Checkout Location can show the
        // inside/outside result on its map the way Checkin Location does.
        const checkoutInsideGeoFence =
          fence &&
          record.checkoutLatitude !== null &&
          record.checkoutLongitude !== null
            ? isInsideGeoFenceWithAccuracy(
                record.checkoutLatitude,
                record.checkoutLongitude,
                fence,
                // The accuracy allowance a punch may have been accepted with (the reading's own accuracy is not
                // stored), so a punch the server accepted never shows here as outside.
                MAX_ACCURACY_ALLOWANCE_METERS,
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
          checkoutInsideGeoFence,
          regularization: withReviewerName(
            record.regularization,
            reviewerNameById,
            record.organizationId,
          ),
          // A day with a punch-in and no punch-out yet is stored as PRESENT (in progress) so the employee is not
          // called Absent while at work. Clients show it as 'Checked in' until the punch-out arrives (or the shift
          // ends and the day becomes Incomplete).
          inProgress:
            record.status === AttendanceStatus.PRESENT &&
            !!record.inTime &&
            !record.outTime,
          ...(holidayName !== undefined && { holidayName }),
          ...(leaveTypeName !== undefined && { leaveTypeName }),
        };
      }),
    };
  }

  // A where-fragment that leaves out rows dated before the employee's own joining date (an import, a manual entry or
  // an old row can carry one), or undefined when there are none. Found with one SQL join, so it is exact for any
  // number of employees; such rows are anomalies, so the id list stays small (capped at 5,000, the most that can be
  // excluded this way - the list is paged and the automatic rows already respect the joining date).
  private async rowsBeforeJoining(
    employeeIdFilter: Prisma.UserWhereInput['id'] | undefined,
    from: string | undefined,
    to: string | undefined,
    organizationId: string,
  ): Promise<Prisma.AttendanceWhereInput | undefined> {
    const scopeIds =
      typeof employeeIdFilter === 'string'
        ? [employeeIdFilter]
        : employeeIdFilter &&
            typeof employeeIdFilter === 'object' &&
            'in' in employeeIdFilter
          ? (employeeIdFilter.in as string[] | undefined)
          : undefined;
    if (scopeIds && scopeIds.length === 0) return undefined;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT a.id
      FROM attendances a
      JOIN users u ON u.id = a."employeeId"
      WHERE a."organizationId" = ${organizationId}
        AND (a.date < to_char(u."joiningDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
          OR (u."exitDate" IS NOT NULL AND a.date > u."exitDate"))
        ${from ? Prisma.sql`AND a.date >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND a.date <= ${to}` : Prisma.empty}
        ${scopeIds ? Prisma.sql`AND a."employeeId" = ANY(${scopeIds}::text[])` : Prisma.empty}
      LIMIT 5000
    `);
    if (rows.length === 0) return undefined;
    return { id: { notIn: rows.map((r) => r.id) } };
  }

  // list()'s bounded-range path: fetches whatever real Attendance rows
  // exist, then fills in a synthetic row (via the same deriveDayOutcome()
  // recalculateAttendanceForDay itself uses — read-only here, nothing is
  // persisted) for every employee × day in range that has none, so the
  // rows and the client-computed summary counts on the Attendance Records
  // page agree with the dashboard grid's own Absent/Holiday/Weekly Off/On
  // Leave backfill instead of silently showing fewer rows than it.
  private async listWithSyntheticAbsences(
    where: Prisma.AttendanceWhereInput,
    rangeDays: string[],
    query: QueryAttendanceDto,
    organizationId: string,
  ): Promise<{
    data: AttendanceListRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    // where.employeeId was built against Prisma.AttendanceWhereInput's own
    // `id` filter type, which is structurally identical to User's but
    // nominally distinct — Prisma brands them per model, so this needs an
    // explicit cast even though the runtime shape (string | {in: string[]})
    // is exactly what user.findMany's own `id` filter accepts.
    const employeeIdFilter = where.employeeId as
      Prisma.UserWhereInput['id'] | undefined;

    const [org, employees, realRows] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organizationId } }),
      this.scopedPrisma.user.findMany({
        where: {
          organizationId,
          ...(employeeIdFilter ? { id: employeeIdFilter } : {}),
        },
        select: {
          ...ATTENDANCE_LIST_EMPLOYEE_SELECT,
          joiningDate: true,
          departmentId: true,
          createdAt: true,
          exitDate: true,
        },
      }),
      this.scopedPrisma.attendance.findMany({
        where,
        include: { employee: { select: ATTENDANCE_LIST_EMPLOYEE_SELECT } },
      }),
    ]);

    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    // One person's list (their own calendar) also shows the holidays still to come this period, taken from the holiday
    // calendar, so an employee sees "Holiday" on the day before it arrives. A list of many people stays limited to days
    // that have happened - upcoming holidays are not spread across every row of a table.
    const upcomingDays = rangeDays.filter((d) => d >= today);
    const upcomingHolidays =
      employees.length === 1 && upcomingDays.length > 0
        ? await this.scopedPrisma.holiday.findMany({
            where: {
              organizationId,
              AND: [holidayInEffect],
              isOptional: false,
              date: { in: upcomingDays },
            },
            select: { date: true, departmentId: true },
          })
        : [];
    const orgPrefs = (org?.attendancePayrollPrefs ??
      null) as OrganizationAttendancePrefs | null;
    const existingKeys = new Set(
      realRows.map((r) => `${r.employeeId}|${r.date}`),
    );

    const synthetic: AttendanceListRow[] = [];
    for (const employee of employees) {
      const joiningDateStr = employee.joiningDate.toISOString().slice(0, 10);
      // Blank rows start on the day the employee was added to the system, never earlier: an employee added today
      // with a past joining date used to get a screenful of blank Absent rows from that date, while one joining today
      // got none. (The joining date still bounds the range; payroll proration is not affected - this is the list only.)
      const addedDateStr = dateStrInOrgTz(
        org?.timezone ?? 'Asia/Kolkata',
        employee.createdAt,
      );
      const shiftConfig = resolveShiftConfig(
        employee.department,
        orgPrefs,
        org?.timezone ?? DEFAULT_ORG_TIMEZONE,
      );
      // The public row shape carries only the fields ATTENDANCE_LIST_EMPLOYEE_SELECT
      // picks — joiningDate/departmentId above are for this loop's own use only.
      const {
        joiningDate: _joiningDate,
        departmentId: _departmentId,
        createdAt: _createdAt,
        exitDate: _exitDate,
        ...publicEmployee
      } = employee;
      void _joiningDate;
      void _departmentId;
      void _createdAt;
      void _exitDate;
      const exitDate = employee.exitDate;

      for (const dateStr of rangeDays) {
        if (existingKeys.has(`${employee.id}|${dateStr}`)) continue;
        if (dateStr < joiningDateStr) continue; // not yet an employee
        if (!isEmployedOn(exitDate, dateStr)) continue; // past their last working day
        if (dateStr >= today) {
          // Today and later: only a holiday from the calendar is shown (nothing else about those days is known yet).
          const isHoliday = upcomingHolidays.some(
            (h) =>
              h.date === dateStr &&
              (h.departmentId === null ||
                h.departmentId === employee.departmentId),
          );
          if (!isHoliday) continue;
        } else if (dateStr < addedDateStr) {
          continue; // added to the system later than this day
        }

        const { status, workDurationMinutes, isLate, isEarlyOut } =
          await this.deriveDayOutcome(this.scopedPrisma, {
            organizationId,
            employeeId: employee.id,
            employeeDepartmentId: employee.departmentId,
            dateStr,
            shiftConfig,
            inTime: null,
            outTime: null,
          });
        if (query.status && status !== query.status) continue;

        synthetic.push({
          id: `synthetic:${employee.id}:${dateStr}`,
          organizationId,
          employeeId: employee.id,
          date: dateStr,
          departmentId: employee.departmentId,
          status,
          inTime: null,
          outTime: null,
          checkinLocation: null,
          checkinLatitude: null,
          checkinLongitude: null,
          checkinSelfieUrl: null,
          checkoutLocation: null,
          checkoutLatitude: null,
          checkoutLongitude: null,
          checkoutSelfieUrl: null,
          workDurationMinutes,
          isLate,
          isEarlyOut,
          source: null,
          workArrangement: WorkArrangement.OFFICE,
          workArrangementStatus: WfhApprovalStatus.NONE,
          workArrangementReviewedById: null,
          workArrangementReviewedAt: null,
          workArrangementReviewComments: null,
          // Same shape as the column's own schema default — never persisted,
          // just matching what a real never-touched row would carry.
          regularization: {
            requested: false,
            reason: '',
            requestedInTime: null,
            requestedOutTime: null,
            status: 'none',
            reviewedBy: null,
            reviewedAt: null,
            reviewComments: '',
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          employee: publicEmployee,
        } as unknown as AttendanceListRow);
      }
    }

    const merged: AttendanceListRow[] = [...realRows, ...synthetic].sort(
      (a, b) =>
        (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
        compareEmployees(a.employee, b.employee),
    );
    const total = merged.length;
    const start = skip(query.page, query.limit);
    return {
      data: merged.slice(start, start + query.limit),
      total,
      page: query.page,
      limit: query.limit,
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

    for (const r of existingRows) {
      // A day already stamped HALF_DAY by another approved half-day leave (the morning under one leave, the afternoon
      // under another) is now a whole day off; what the day was before any leave stamped it is already remembered.
      const alreadyHalfLeave =
        leave.isHalfDay &&
        r.status === AttendanceStatus.HALF_DAY &&
        r.source === AttendanceSource.SYSTEM;
      await tx.attendance.updateMany({
        where: { id: r.id, organizationId },
        data: alreadyHalfLeave
          ? {
              status: AttendanceStatus.ON_LEAVE,
              source: AttendanceSource.SYSTEM,
            }
          : {
              status,
              source: AttendanceSource.SYSTEM,
              // Remember the day as it was, so cancelling the leave can put it back.
              leaveOverriddenStatus: r.leaveOverriddenStatus ?? r.status,
              leaveOverriddenSource: r.leaveOverriddenSource ?? r.source,
            },
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

  // Called from LeavesService's releaseHold() when a previously-approved leave is cancelled/edited. Every day the leave
  // stamped (past or future) goes back to what it was before: a day that held another status (present, weekly off,
  // holiday, a regularized or imported day...) is restored exactly, and a day the leave itself created is removed - it
  // then reads as any other day with no record (payroll pays a weekly off / holiday from the calendar and counts a
  // working day with no record as unpaid). Only rows this integration wrote (source SYSTEM) are touched, never a day
  // since regularized, imported or punched over. A day still covered by another approved leave (the other half of a
  // half-day pair) keeps that leave's stamp.
  async revertAttendanceForLeave(
    tx: Prisma.TransactionClient,
    leave: Leave,
    organizationId: string,
  ) {
    const dates = enumerateDateStrings(leave.startDate, leave.endDate);
    if (dates.length === 0) return;

    const [rows, otherLeaves] = await Promise.all([
      tx.attendance.findMany({
        where: {
          organizationId,
          employeeId: leave.employeeId,
          date: { in: dates },
          source: AttendanceSource.SYSTEM,
          status: {
            in: [AttendanceStatus.ON_LEAVE, AttendanceStatus.HALF_DAY],
          },
        },
      }),
      tx.leave.findMany({
        where: {
          organizationId,
          employeeId: leave.employeeId,
          status: LeaveStatus.APPROVED,
          id: { not: leave.id },
          startDate: { lte: leave.endDate },
          endDate: { gte: leave.startDate },
        },
        select: { startDate: true, endDate: true, isHalfDay: true },
      }),
    ]);

    for (const row of rows) {
      const covering = otherLeaves.filter(
        (o) => o.startDate <= row.date && o.endDate >= row.date,
      );
      if (covering.length > 0) {
        // Another approved leave still covers this day: it keeps a stamp (a half day when only half-day leaves remain).
        await tx.attendance.updateMany({
          where: { id: row.id, organizationId },
          data: {
            status: covering.every((o) => o.isHalfDay)
              ? AttendanceStatus.HALF_DAY
              : AttendanceStatus.ON_LEAVE,
          },
        });
      } else if (row.leaveOverriddenStatus) {
        await tx.attendance.updateMany({
          where: { id: row.id, organizationId },
          data: {
            status: row.leaveOverriddenStatus,
            source: row.leaveOverriddenSource ?? AttendanceSource.FACE_API,
            leaveOverriddenStatus: null,
            leaveOverriddenSource: null,
          },
        });
      } else {
        await tx.attendance.deleteMany({
          where: { id: row.id, organizationId },
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
    const orgTimezone = await this.getOrgTimezone(organizationId);
    const today = todayInOrgTz(orgTimezone);
    if (dto.date > today) {
      throw new BadRequestException(
        'Cannot request regularization for a future date.',
      );
    }
    // Lookback window (Organization.regularizationWindowDays, 7 unless HR changed it) - an employee can only regularize
    // something recent, not reach arbitrarily far back into attendance history.
    const windowDays = await this.getRegularizationWindowDays(organizationId);
    const earliestAllowedDate = addDaysStr(today, -windowDays);
    if (dto.date < earliestAllowedDate) {
      throw new BadRequestException(
        `Regularization can only be requested for a date within the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`,
      );
    }
    // No attendance can predate the day the person joined, and nobody who has left can be regularized.
    const requester = await this.scopedPrisma.user.findFirst({
      where: { id: actor.id, organizationId },
      select: { joiningDate: true, isActive: true },
    });
    if (requester && !requester.isActive) {
      throw new BadRequestException(
        'This employee is inactive. Attendance cannot be regularized for an inactive employee.',
      );
    }
    if (requester && dto.date < utcDateStrOf(requester.joiningDate)) {
      throw new BadRequestException(
        `The date ${dmyText(dto.date)} is before your joining date (${dmyText(utcDateStrOf(requester.joiningDate))}).`,
      );
    }
    if (dto.evidenceUrl !== undefined && dto.evidenceUrl !== '') {
      // Only a file this organisation uploaded (the key's own prefix says so); nothing external, no path tricks.
      if (!isKeyAllowedForOrg(organizationId, dto.evidenceUrl)) {
        throw new BadRequestException('The supporting document is not valid.');
      }
    }
    // The date can't be in the future (checked above), and neither can the times being asked for: a request dated
    // today could otherwise carry tomorrow's In/Out, and an Admin's own request applies immediately.
    if (dto.requestedInTime) {
      assertNotInFuture(new Date(dto.requestedInTime), 'The requested In time');
    }
    if (dto.requestedOutTime) {
      assertNotInFuture(
        new Date(dto.requestedOutTime),
        'The requested Out time',
      );
    }
    if (!dto.requestedInTime && !dto.requestedOutTime) {
      throw new BadRequestException(
        'Enter the In time, the Out time, or both for the regularization.',
      );
    }
    if (dto.requestedInTime && dto.requestedOutTime) {
      const spanMs =
        new Date(dto.requestedOutTime).getTime() -
        new Date(dto.requestedInTime).getTime();
      if (!(spanMs > 0)) {
        throw new BadRequestException('Out time must be after In time.');
      }
      if (spanMs > 24 * 3600000) {
        throw new BadRequestException(
          'In and Out times cannot be more than 24 hours apart.',
        );
      }
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
    // Asking for only the In or only the Out time works when the day already has the other one (a forgotten punch-out).
    // With nothing recorded on the other side the day could never get a full In/Out pair, so say so now instead of
    // leaving a request that no one can approve.
    if (!dto.requestedInTime && !existing?.inTime) {
      throw new BadRequestException(
        'There is no In time recorded for this date - enter both the In time and the Out time.',
      );
    }
    if (!dto.requestedOutTime && !existing?.outTime) {
      throw new BadRequestException(
        'There is no Out time recorded for this date - enter both the In time and the Out time.',
      );
    }
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

    // The Admin-set caps (blank = no limit). An Admin's own request is exempt: it is approved on the spot and there is
    // no one above them to be asked twice.
    if (actor.role !== Role.ADMIN) {
      const usage = await this.getRegularizationUsage(
        actor.id,
        dto.date,
        organizationId,
      );
      if (
        usage.resubmitLimit !== null &&
        usage.rejectedForDate > usage.resubmitLimit
      ) {
        throw new BadRequestException(
          `This date was rejected ${usage.rejectedForDate} time${usage.rejectedForDate === 1 ? '' : 's'} and can be re-sent at most ${usage.resubmitLimit} time${usage.resubmitLimit === 1 ? '' : 's'}. Please speak to HR.`,
        );
      }
      if (
        usage.monthlyLimit !== null &&
        usage.usedThisMonth >= usage.monthlyLimit
      ) {
        throw new BadRequestException(
          `You have used all ${usage.monthlyLimit} regularization request${usage.monthlyLimit === 1 ? '' : 's'} allowed for ${usage.month}. Please speak to HR.`,
        );
      }
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
      evidenceUrl: dto.evidenceUrl || null,
    };

    let inTime: Date | undefined;
    let outTime: Date | undefined;
    let workDurationMinutes: number | undefined;
    let status: AttendanceStatus = AttendanceStatus.ABSENT;
    let source: AttendanceSource = AttendanceSource.SYSTEM;
    let isLate: boolean | undefined;
    let isEarlyOut: boolean | undefined;
    if (isSelfApproving) {
      const outcome = await this.regularizationOutcome(
        {
          date: dto.date,
          employeeId: actor.id,
          departmentId: existing?.departmentId ?? null,
          inTime: existing?.inTime ?? null,
          outTime: existing?.outTime ?? null,
        },
        regularization,
        organizationId,
      );
      inTime = outcome.inTime;
      outTime = outcome.outTime;
      workDurationMinutes = outcome.workDurationMinutes;
      status = outcome.status;
      isLate = outcome.isLate;
      isEarlyOut = outcome.isEarlyOut;
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
            isLate,
            isEarlyOut,
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
          isLate,
          isEarlyOut,
          regularization: regularization as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const attendanceRow = await this.scopedPrisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });
    // Every submission is kept, so a later resubmission or withdrawal does not erase it.
    await this.scopedPrisma.attendanceRegularizationRequest.create({
      data: {
        organizationId,
        attendanceId: attendanceRow.id,
        employeeId: actor.id,
        date: dto.date,
        reason: dto.reason,
        requestedInTime,
        requestedOutTime,
        evidenceUrl: dto.evidenceUrl || null,
        status: isSelfApproving
          ? RegularizationRequestStatus.APPROVED
          : RegularizationRequestStatus.PENDING,
        reviewedById: isSelfApproving ? actor.id : null,
        reviewedAt: isSelfApproving ? new Date() : null,
        reviewComments: isSelfApproving ? 'Self-approved (Admin).' : '',
      },
    });

    if (isSelfApproving) {
      // An Admin's own request applies at once, so the trail has to say so: a reviewer's approval is logged, this one
      // was not.
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'REGULARIZATION_APPROVED',
        module: 'ATTENDANCE',
        organizationId,
        targetId: attendanceRow.id,
        details: {
          employeeId: actor.id,
          date: dto.date,
          selfApproved: true,
          previousInTime: existing?.inTime?.toISOString() ?? null,
          previousOutTime: existing?.outTime?.toISOString() ?? null,
          requestedInTime: dto.requestedInTime ?? null,
          requestedOutTime: dto.requestedOutTime ?? null,
          previousStatus: existing?.status ?? null,
          newStatus: status,
          reason: dto.reason,
        },
      });
    } else {
      await this.notifyRegularizationRequested(actor, dto.date, organizationId);
    }

    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId: actor.id, date: dto.date },
    });
  }

  // The lookback window for regularization requests (Organization.regularizationWindowDays; 7 until HR changes it).
  async getRegularizationWindowDays(organizationId: string): Promise<number> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { regularizationWindowDays: true },
    });
    return org?.regularizationWindowDays ?? 7;
  }

  // What the request form needs to know before the employee fills it in.
  async getRegularizationSettings(organizationId: string) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        regularizationMonthlyLimit: true,
        regularizationResubmitLimit: true,
      },
    });
    return {
      windowDays: await this.getRegularizationWindowDays(organizationId),
      monthlyLimit: org?.regularizationMonthlyLimit ?? null,
      resubmitLimit: org?.regularizationResubmitLimit ?? null,
    };
  }

  // An employee's standing against the Admin-set caps for the month of `date` (and for that date itself): what the
  // limits are (null = none), how many requests they have made for that month - every one submitted counts except a
  // withdrawn one - and how many times this date was rejected. The request form shows it; requestRegularization enforces it.
  async getRegularizationUsage(
    employeeId: string,
    date: string,
    organizationId: string,
  ) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        regularizationMonthlyLimit: true,
        regularizationResubmitLimit: true,
      },
    });
    const monthKey = date.slice(0, 7);
    const [usedThisMonth, rejectedForDate] = await Promise.all([
      this.scopedPrisma.attendanceRegularizationRequest.count({
        where: {
          organizationId,
          employeeId,
          date: { startsWith: monthKey },
          status: { not: RegularizationRequestStatus.CANCELLED },
        },
      }),
      this.scopedPrisma.attendanceRegularizationRequest.count({
        where: {
          organizationId,
          employeeId,
          date,
          status: RegularizationRequestStatus.REJECTED,
        },
      }),
    ]);
    const monthlyLimit = org?.regularizationMonthlyLimit ?? null;
    const resubmitLimit = org?.regularizationResubmitLimit ?? null;
    const monthDate = new Date(`${monthKey}-01T00:00:00Z`);
    return {
      date,
      month: monthDate.toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      monthlyLimit,
      usedThisMonth,
      remainingThisMonth:
        monthlyLimit === null
          ? null
          : Math.max(0, monthlyLimit - usedThisMonth),
      resubmitLimit,
      rejectedForDate,
      // How many more times this date can be sent again after a rejection (null = unlimited).
      remainingResubmits:
        resubmitLimit === null
          ? null
          : rejectedForDate === 0
            ? resubmitLimit
            : Math.max(0, resubmitLimit - rejectedForDate + 1),
    };
  }

  // Records the decision on the pending history row of a day (the request currently in force). A no-op for a request that
  // pre-dates the history table and has no row.
  private async closeRegularizationRequest(
    attendanceId: string,
    organizationId: string,
    status: RegularizationRequestStatus,
    extra: {
      reviewedById: string | null;
      reviewComments: string;
      autoApproved?: boolean;
    },
  ): Promise<void> {
    await this.scopedPrisma.attendanceRegularizationRequest.updateMany({
      where: {
        organizationId,
        attendanceId,
        status: RegularizationRequestStatus.PENDING,
      },
      data: {
        status,
        reviewedById: extra.reviewedById,
        reviewedAt: new Date(),
        reviewComments: extra.reviewComments,
        autoApproved: extra.autoApproved ?? false,
      },
    });
  }

  // The employee withdraws their own request while it is still pending (a wrong date or time sent by mistake). The day
  // goes back to having no request, so a corrected one can be submitted; the withdrawn one stays in the history.
  async cancelRegularization(id: string, actor: Actor, organizationId: string) {
    const row = await this.scopedPrisma.attendance.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new NotFoundException('Attendance record not found.');
    if (row.employeeId !== actor.id) {
      throw new ForbiddenException('You can only withdraw your own request.');
    }
    const reg = row.regularization as unknown as RegularizationState;
    if (reg?.status !== 'pending') {
      throw new BadRequestException(
        reg?.status === 'approved' || reg?.status === 'rejected'
          ? 'This request has already been reviewed, so it can no longer be withdrawn.'
          : 'There is no pending regularization request for this day.',
      );
    }
    // Same guarded compare-and-swap as a review: a reviewer approving it at this moment wins, and the withdrawal then
    // finds it already decided.
    const { count } = await this.scopedPrisma.attendance.updateMany({
      where: {
        id,
        organizationId,
        regularization: { path: ['status'], equals: 'pending' },
      },
      data: {
        regularization: NO_REGULARIZATION as unknown as Prisma.InputJsonValue,
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This request was reviewed just now, so it can no longer be withdrawn.',
      );
    }
    await this.closeRegularizationRequest(
      id,
      organizationId,
      RegularizationRequestStatus.CANCELLED,
      { reviewedById: actor.id, reviewComments: 'Withdrawn by the employee.' },
    );
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'REGULARIZATION_CANCELLED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
      details: {
        employeeId: row.employeeId,
        date: row.date,
        requestedInTime: reg.requestedInTime ?? null,
        requestedOutTime: reg.requestedOutTime ?? null,
        reason: reg.reason,
      },
    });
    return this.scopedPrisma.attendance.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Every regularization request ever made for one day, newest first, with the reviewer's name and the supporting
  // document as a signed URL. The employee sees their own; HR and Admin any; a manager only their team's.
  async getRegularizationHistory(
    id: string,
    actor: Actor,
    organizationId: string,
  ) {
    const row = await this.scopedPrisma.attendance.findFirst({
      where: { id, organizationId },
      select: { id: true, employeeId: true, date: true },
    });
    if (!row) throw new NotFoundException('Attendance record not found.');
    if (actor.role === Role.EMPLOYEE && row.employeeId !== actor.id) {
      throw new ForbiddenException('Not authorized to view this record.');
    }
    if (actor.role === Role.MANAGER && row.employeeId !== actor.id) {
      await assertManagerScopeOrDelegate(
        this.scopedPrisma,
        this.delegationService,
        actor,
        organizationId,
        row.employeeId,
      );
    }
    const requests =
      await this.scopedPrisma.attendanceRegularizationRequest.findMany({
        where: { organizationId, attendanceId: id },
        orderBy: { createdAt: 'desc' },
      });
    const reviewerIds = [
      ...new Set(requests.map((r) => r.reviewedById).filter(Boolean)),
    ] as string[];
    const reviewers = reviewerIds.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, id: { in: reviewerIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(reviewers.map((u) => [u.id, u.name]));
    return {
      date: row.date,
      data: requests.map((r) => ({
        ...signedEvidence(r, organizationId),
        reviewedByName: r.reviewedById
          ? (nameById.get(r.reviewedById) ?? null)
          : null,
      })),
    };
  }

  // What approving a regularization does to the day, in one place for the three ways a request can be approved (a
  // reviewer, the Admin's own request, the "no action in X hours" sweep) so they cannot drift apart again.
  //   - The In/Out times are the requested ones, falling back to what the day already has for the side not requested.
  //   - Both must exist afterwards: a single time cannot give worked hours, and used to be marked PRESENT regardless.
  //   - Status is judged on the hours worked with the employee's shift thresholds (so a regularized 1-hour day is not a
  //     full Present day); late / early-out are recalculated for the corrected times on the organisation's wall clock.
  //   - Like before, a regularized day is a hard override: a holiday or weekly off does not turn it back.
  private async regularizationOutcome(
    row: {
      date: string;
      employeeId: string;
      departmentId: string | null;
      inTime: Date | null;
      outTime: Date | null;
    },
    reg: Pick<RegularizationState, 'requestedInTime' | 'requestedOutTime'>,
    organizationId: string,
  ): Promise<{
    inTime: Date;
    outTime: Date;
    workDurationMinutes: number;
    status: AttendanceStatus;
    isLate: boolean;
    isEarlyOut: boolean;
  }> {
    const inTime = reg.requestedInTime
      ? new Date(reg.requestedInTime)
      : row.inTime;
    const outTime = reg.requestedOutTime
      ? new Date(reg.requestedOutTime)
      : row.outTime;
    if (!inTime || !outTime) {
      throw new BadRequestException(
        `This cannot be approved: the day would still have no ${inTime ? 'Out' : 'In'} time. Reject it and ask the employee to send both times.`,
      );
    }
    if (outTime.getTime() <= inTime.getTime()) {
      throw new BadRequestException(
        'The requested Out time is not after the In time, so this cannot be approved. Reject it and ask the employee to send it again.',
      );
    }

    const [employee, org] = await Promise.all([
      this.scopedPrisma.user.findFirst({
        where: { id: row.employeeId, organizationId },
        include: { department: true },
      }),
      this.prisma.organization.findUnique({ where: { id: organizationId } }),
    ]);
    // The department the day was recorded under, not necessarily the employee's current one.
    const department =
      row.departmentId && row.departmentId !== employee?.departmentId
        ? await this.scopedPrisma.department.findFirst({
            where: { id: row.departmentId, organizationId },
          })
        : (employee?.department ?? null);
    const shiftConfig = resolveShiftConfig(
      department,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
      org?.timezone ?? DEFAULT_ORG_TIMEZONE,
    );

    const workDurationMinutes = Math.max(
      0,
      Math.round((outTime.getTime() - inTime.getTime()) / 60000),
    );
    const tz = tzOf(shiftConfig);
    const shiftStart = buildShiftDateTime(
      row.date,
      shiftConfig.shiftStartTime,
      tz,
    );
    const shiftEnd = buildShiftDateTime(
      shiftConfig.crossesMidnight ? addDaysStr(row.date, 1) : row.date,
      shiftConfig.shiftEndTime,
      tz,
    );
    return {
      inTime,
      outTime,
      workDurationMinutes,
      status:
        AttendanceStatus[
          statusForWorkedMinutes(workDurationMinutes, shiftConfig)
        ],
      isLate:
        inTime.getTime() - shiftStart.getTime() >
        shiftConfig.lateInThresholdMinutes * 60000,
      isEarlyOut:
        shiftEnd.getTime() - outTime.getTime() >
        shiftConfig.earlyOutThresholdMinutes * 60000,
    };
  }

  // Ported against reportingManagerId rather than Department.departmentHeadId
  // — see the identical note on LeavesService.notifyNewLeaveApplication.
  private async notifyRegularizationRequested(
    actor: Actor,
    date: string,
    organizationId: string,
  ) {
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    await this.notificationsService.notifyReviewers({
      organizationId,
      requester: actor,
      title: 'Attendance Regularization Requested',
      message: `${actor.name} requested attendance regularization for ${formatDateDisplay(date, '', dateFormat, timeZone)}.`,
      category: NotificationCategory.REGULARIZATION,
      managerFirst: true,
    });
  }

  // Single-level review (HR or Manager, either decides) — `id` is the
  // Attendance row's id, not a separate request id. Unlike the request
  // write above, this SPREADS the existing regularization object (whole-
  // object reassignment, same as the original JSON-column comment).
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
    await this.auditLogService.logSelfApproval(actor, {
      module: 'ATTENDANCE',
      targetId: id,
      employeeId: row.employeeId,
      request: 'Attendance regularization',
    });
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
      const outcome = await this.regularizationOutcome(
        row,
        existingReg,
        organizationId,
      );
      data.inTime = outcome.inTime;
      data.outTime = outcome.outTime;
      data.workDurationMinutes = outcome.workDurationMinutes;
      data.status = outcome.status;
      data.isLate = outcome.isLate;
      data.isEarlyOut = outcome.isEarlyOut;
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

    await this.closeRegularizationRequest(
      id,
      organizationId,
      dto.decision === 'APPROVED'
        ? RegularizationRequestStatus.APPROVED
        : RegularizationRequestStatus.REJECTED,
      { reviewedById: actor.id, reviewComments: dto.comments ?? '' },
    );

    await this.auditLogService.log({
      actorId: actor.id,
      action:
        dto.decision === 'APPROVED'
          ? 'REGULARIZATION_APPROVED'
          : 'REGULARIZATION_REJECTED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
      details: {
        employeeId: row.employeeId,
        date: row.date,
        previousInTime: row.inTime?.toISOString() ?? null,
        previousOutTime: row.outTime?.toISOString() ?? null,
        requestedInTime: existingReg.requestedInTime ?? null,
        requestedOutTime: existingReg.requestedOutTime ?? null,
        previousStatus: row.status,
        newStatus: data.status ?? row.status,
        comments: dto.comments ?? '',
      },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: row.employeeId, organizationId },
    });
    if (employee) {
      const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
        this.scopedPrisma,
        organizationId,
      );
      const title = `Regularization Request ${dto.decision}`;
      const message = `Your attendance regularization request for ${formatDateDisplay(row.date, '', dateFormat, timeZone)} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;
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
          date: formatDateDisplay(row.date, '', dateFormat, timeZone),
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
        timeBasis: dto.timeBasis ?? 'UTC',
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
      include: {
        uploadedBy: { select: { name: true, employeeId: true } },
      },
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
        rows
          .map((r) => asString(r.employeeId).trim().toUpperCase())
          .filter(Boolean),
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
    // Attendance can't be imported for a day that hasn't happened: the latest allowed date is today in the
    // organization's timezone (a future date used to be accepted up to a year ahead).
    const orgTimezone = await this.getOrgTimezone(organizationId);
    const todayInTz = todayInOrgTz(orgTimezone);
    // ORG batches carry times in the organisation's own timezone; the old UTC reading stays the default.
    const importZone = batch.timeBasis === 'ORG' ? orgTimezone : undefined;

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
      const empCode = asString(row.employeeId).trim().toUpperCase();
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
          error: 'Invalid or missing date (expected DD-MM-YYYY)',
        });
        return;
      }
      const dateMs = new Date(`${date}T00:00:00.000Z`).getTime();
      if (date > todayInTz) {
        failed.push({
          row: rowNum,
          error: `Date ${date} is in the future — attendance can only be imported for today or earlier`,
        });
        return;
      }
      if (dateMs < MIN_DATE_MS) {
        failed.push({
          row: rowNum,
          error: `Date out of range: ${date} (must be within the last 2 years)`,
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
        return v !== '' && parseImportTimestampUtc(v, importZone) === null;
      });
      if (badTime) {
        failed.push({
          row: rowNum,
          error: `Invalid ${badTime} (expected DD-MM-YYYY HH:mm:ss, read as ${importZone ?? 'UTC'} time)`,
        });
        return;
      }
      if (inRaw && outRaw) {
        const spanMs =
          (parseImportTimestampUtc(outRaw, importZone)?.getTime() ?? 0) -
          (parseImportTimestampUtc(inRaw, importZone)?.getTime() ?? 0);
        if (spanMs <= 0) {
          failed.push({
            row: rowNum,
            error: 'outTime must be after inTime',
          });
          return;
        }
        if (spanMs > 24 * 3600000) {
          failed.push({
            row: rowNum,
            error: 'inTime and outTime are more than 24 hours apart',
          });
          return;
        }
      }
      if (!inRaw && outRaw) {
        failed.push({
          row: rowNum,
          error: 'inTime is required when outTime is given',
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

    // Claim the batch before touching the ledger (guarded compare-and-swap,
    // same convention as the rest of the codebase). The status check above
    // is only a fast-path for a friendly error — two concurrent executes
    // (double-click, retried request) could both pass it and both import
    // every row. Only the request that flips VALIDATED -> EXECUTING runs.
    const { count: claimed } =
      await this.scopedPrisma.attendanceImportBatch.updateMany({
        where: { id, organizationId, status: ImportBatchStatus.VALIDATED },
        data: {
          status: ImportBatchStatus.EXECUTING,
          executedById: actor.id,
          executedAt: new Date(),
        },
      });
    if (claimed === 0) {
      throw new ConflictException(
        'This import batch is already being executed or was already executed.',
      );
    }

    let result: ImportExecutionResult;
    const executionStartedAt = new Date();
    try {
      result = await this.applyImportBatchRows(batch, organizationId);
    } catch (err) {
      // An unexpected failure (per-row errors are already caught inside)
      // must not leave the batch stuck in EXECUTING forever. Rows written
      // before the failure stay written; the batch is marked FAILED.
      await this.scopedPrisma.attendanceImportBatch.updateMany({
        where: { id, organizationId, status: ImportBatchStatus.EXECUTING },
        data: {
          status: ImportBatchStatus.FAILED,
          executionResult: {
            imported: 0,
            skipped: 0,
            errors: 0,
            failure:
              err instanceof Error ? err.message : 'Import execution failed',
          },
        },
      });
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'ATTENDANCE_IMPORT_FAILED',
        module: 'ATTENDANCE',
        organizationId,
        targetId: id,
        details: { fileName: batch.fileName },
      });
      throw err;
    }

    // The overtime this import turned into pending requests: say so, so the approvers do not find them by chance.
    const overtimeRequests = await this.scopedPrisma.overtimeRecord.count({
      where: {
        organizationId,
        source: OvertimeSource.IMPORT,
        status: OvertimeStatus.PENDING,
        createdAt: { gte: executionStartedAt },
      },
    });
    result = { ...result, overtimeRequests };
    if (overtimeRequests > 0) {
      const approvers = await this.scopedPrisma.user.findMany({
        where: {
          organizationId,
          isActive: true,
          role: { in: [Role.HR, Role.ADMIN] },
        },
        select: { id: true },
      });
      await this.notificationsService.createMany(
        approvers.map((u) => ({
          organizationId,
          userId: u.id,
          title: 'Overtime requests from an attendance import',
          message: `The attendance import${batch.fileName ? ` (${batch.fileName})` : ''} created ${overtimeRequests} overtime ${overtimeRequests === 1 ? 'request' : 'requests'} waiting for review. Open Attendance Records > Overtime to approve them.`,
          category: NotificationCategory.ATTENDANCE,
        })),
      );
    }

    await this.scopedPrisma.attendanceImportBatch.updateMany({
      where: { id, organizationId, status: ImportBatchStatus.EXECUTING },
      data: {
        status: ImportBatchStatus.EXECUTED,
        executedById: actor.id,
        executedAt: new Date(),
        executionResult: result,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ATTENDANCE_IMPORT_EXECUTED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
      details: {
        fileName: batch.fileName,
        uploadedById: batch.uploadedById,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
      },
    });

    return this.scopedPrisma.attendanceImportBatch.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // The ledger-writing body of executeImportBatch, run only after the batch
  // has been claimed (EXECUTING). Per-row failures are collected into
  // rowErrors; anything thrown out of here marks the batch FAILED.
  private async applyImportBatchRows(
    batch: AttendanceImportBatch,
    organizationId: string,
  ): Promise<ImportExecutionResult> {
    const rows = batch.rows as unknown as ImportRow[];
    const importZone =
      batch.timeBasis === 'ORG'
        ? await this.getOrgTimezone(organizationId)
        : undefined;
    const employeeCodes = [
      ...new Set(
        rows
          .map((r) => asString(r.employeeId).trim().toUpperCase())
          .filter(Boolean),
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
        const empId = byCode.get(asString(row.employeeId).trim().toUpperCase());
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
              AND: [holidayInEffect],
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
      const empCode = asString(row.employeeId).trim().toUpperCase();
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
        const inTime = inRaw
          ? parseImportTimestampUtc(inRaw, importZone)
          : null;
        const outTime = outRaw
          ? parseImportTimestampUtc(outRaw, importZone)
          : null;
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
          org?.timezone ?? DEFAULT_ORG_TIMEZONE,
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
        // Work on a weekly off / holiday (or past the shift end) in the imported sheet becomes a pending overtime
        // request, exactly as a live punch would - the approver then decides how it is compensated. Never lets a
        // failure here fail the row: the attendance itself is already saved.
        try {
          await this.suggestOvertimeFromPunchOut(
            this.scopedPrisma,
            organizationId,
            empId,
            date,
            outcome.status,
            outTime,
            shiftConfig,
            outcome.workDurationMinutes,
            OvertimeSource.IMPORT,
          );
        } catch {
          // best effort
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

    return { imported, skipped, errors, rowErrors };
  }

  async rejectImportBatch(id: string, actor: Actor, organizationId: string) {
    const batch = await this.scopedPrisma.attendanceImportBatch.findFirst({
      where: { id, organizationId },
    });
    if (!batch) throw new NotFoundException('Import batch not found.');

    // A batch that is executing (or already executed) has written to the
    // ledger — flipping it to REJECTED would misrepresent that, and could
    // race executeImportBatch's own final status write. Guarded in the
    // write's where-clause, not just a pre-check.
    const { count } = await this.scopedPrisma.attendanceImportBatch.updateMany({
      where: {
        id,
        organizationId,
        status: {
          notIn: [ImportBatchStatus.EXECUTING, ImportBatchStatus.EXECUTED],
        },
      },
      data: {
        status: ImportBatchStatus.REJECTED,
        validatedById: actor.id,
        validatedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This import batch is being executed or was already executed and can no longer be rejected.',
      );
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'ATTENDANCE_IMPORT_REJECTED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
      details: {
        fileName: batch.fileName,
        uploadedById: batch.uploadedById,
        previousStatus: batch.status,
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
  async notifyAbsentees(
    dto: NotifyAbsenteesDto,
    organizationId: string,
    // true for the early-morning sweep: write the absences but hold the notices back for sendMorningAbsenceNotices.
    deferNotices = false,
  ) {
    // Only a day that has finished can be called an absence: today an employee who has not punched in yet may still
    // do so, and marking them absent (with an in-app notice and an email) before the day ends is wrong. So the default
    // is yesterday and nothing later than yesterday is accepted.
    const yesterday = yesterdayInOrgTz(
      await this.getOrgTimezone(organizationId),
      new Date(),
    );
    const date = dto.date ?? yesterday;
    if (date > yesterday) {
      throw new BadRequestException(
        `Absence alerts can only be sent for a day that has finished. The latest date allowed is yesterday (${dmyText(yesterday)}).`,
      );
    }

    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        // Same roles payroll pays (see PayrollService): a user left out here never got the weekly-off / holiday /
        // absent rows the nightly sweep writes, and payroll counts a day with no row as LOP — so their weekends and
        // holidays went unpaid. An Admin is on payroll like anyone else, so is swept too.
        role: { in: [Role.EMPLOYEE, Role.MANAGER, Role.HR, Role.ADMIN] },
      },
      select: { id: true, exitDate: true, joiningDate: true },
    });

    // Attendance of a payroll month that is already locked or paid is never rewritten by a sweep: a payslip was issued
    // against it. (An Admin unlocks the run first if a correction is really needed.)
    const lockedEmployees = await lockedEmployeeIdsForMonth(
      this.scopedPrisma,
      organizationId,
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)),
    );
    const skippedLocked = employees.filter((e) =>
      lockedEmployees.has(e.id),
    ).length;

    // Bounded concurrency — each employee's own attendance row for this
    // one date, no shared state between them, so this is safe to run
    // several at a time instead of fully sequential (a few hundred
    // employees × recalculateAttendanceForDay's several queries each is a
    // slow admin action otherwise).
    const employeeIds: string[] = [];
    await mapWithConcurrency(employees, 8, async (employee) => {
      if (lockedEmployees.has(employee.id)) return;
      // Serving out notice is over after the last working day: no Absent row (or alert) for days they were not employed.
      if (!isEmployedOn(employee.exitDate, date)) return;
      if (date < utcDateStrOf(employee.joiningDate)) return; // not yet joined
      const row = await this.recalculateAttendanceForDay(
        this.scopedPrisma,
        employee.id,
        date,
        organizationId,
        deferNotices ? { deferAbsenceNotice: true } : undefined,
      );
      if (row.status === AttendanceStatus.ABSENT) {
        employeeIds.push(employee.id);
      }
    });

    return {
      date,
      notifiedCount: employeeIds.length,
      employeeIds,
      skippedLocked,
    };
  }

  // One-off repair for the gap the nightly sweep used to leave: HR users were never swept, so on any day they did not
  // punch in there is no attendance row, and payroll counts a day with no row as unpaid (weekends and holidays
  // included). This creates the rows that are MISSING for active HR users between startDate and endDate, using the
  // same day derivation as the nightly sweep (punches, approved leave, holidays, weekly offs), so the result is
  // what the sweep would have written.
  // Safety: it never touches a day that already has a row; skips dates before the person joined; only runs for past
  // days (up to yesterday); and is a dry run unless dryRun is explicitly false. It does NOT recalculate payroll —
  // recalculate the affected, still-open months afterwards. Inactive users are skipped (no exit date is stored).
  // Reference holidays (a past-dated holiday calendar upload) are real holidays for attendance, so a day that is only
  // an empty Absent row on one of them - typically from an attendance import done before the holiday was known - is
  // turned into Holiday. Rows with any punch / time, rows on or before nothing special, rows before the person joined,
  // and months whose payroll is locked or paid are left exactly as they are. Quiet: no notification or e-mail.
  async applyReferenceHolidays(
    organizationId: string,
    actorId?: string,
  ): Promise<{ updated: number; skippedLocked: number }> {
    const today = todayInOrgTz(await this.getOrgTimezone(organizationId));
    const holidays = await this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        isReference: true,
        isOptional: false,
        date: { lt: today },
      },
      select: { date: true },
    });
    const dates = [...new Set(holidays.map((h) => h.date))];
    if (dates.length === 0) return { updated: 0, skippedLocked: 0 };

    const rows = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        date: { in: dates },
        status: AttendanceStatus.ABSENT,
        inTime: null,
        outTime: null,
      },
      take: 20000,
    });
    if (rows.length === 0) return { updated: 0, skippedLocked: 0 };

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        id: { in: [...new Set(rows.map((r) => r.employeeId))] },
      },
      include: { department: true },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    const lockedByMonth = new Map<string, Set<string>>();
    for (const monthKey of new Set(rows.map((r) => r.date.slice(0, 7)))) {
      const [y, m] = monthKey.split('-').map(Number);
      lockedByMonth.set(
        monthKey,
        new Set(
          await lockedEmployeeIdsForMonth(
            this.scopedPrisma,
            organizationId,
            y,
            m,
          ),
        ),
      );
    }

    let updated = 0;
    let skippedLocked = 0;
    await mapWithConcurrency(rows, 8, async (row) => {
      const employee = employeeById.get(row.employeeId);
      if (!employee) return;
      if (lockedByMonth.get(row.date.slice(0, 7))?.has(row.employeeId)) {
        skippedLocked += 1;
        return;
      }
      if (row.date < utcDateStrOf(employee.joiningDate)) return;
      const shiftConfig = resolveShiftConfig(
        employee.department,
        org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
        org?.timezone ?? DEFAULT_ORG_TIMEZONE,
      );
      const outcome = await this.deriveDayOutcome(this.scopedPrisma, {
        organizationId,
        employeeId: row.employeeId,
        employeeDepartmentId: employee.departmentId,
        dateStr: row.date,
        shiftConfig,
        inTime: null,
        outTime: null,
      });
      if (outcome.status === AttendanceStatus.ABSENT) return;
      await this.scopedPrisma.attendance.updateMany({
        where: { id: row.id, organizationId },
        data: {
          status: outcome.status,
          workDurationMinutes: outcome.workDurationMinutes,
          isLate: outcome.isLate,
          isEarlyOut: outcome.isEarlyOut,
        },
      });
      updated += 1;
    });
    if (updated > 0 && actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'ATTENDANCE_REFERENCE_HOLIDAYS_APPLIED',
        module: 'ATTENDANCE',
        organizationId,
        details: { updated, skippedLocked },
      });
    }
    return { updated, skippedLocked };
  }

  async backfillMissingAttendance(
    dto: BackfillAttendanceDto,
    actor: Actor,
    organizationId: string,
  ) {
    const dryRun = dto.dryRun !== false;
    const yesterday = yesterdayInOrgTz(
      await this.getOrgTimezone(organizationId),
      new Date(),
    );
    if (dto.startDate > dto.endDate) {
      throw new BadRequestException('startDate must not be after endDate.');
    }
    if (dto.endDate > yesterday) {
      throw new BadRequestException(
        `endDate cannot be later than yesterday (${dmyText(yesterday)}).`,
      );
    }
    const dates = enumerateDateStrings(dto.startDate, dto.endDate);
    if (dates.length > 100) {
      throw new BadRequestException(
        'Backfill at most 100 days at a time; run it in smaller ranges.',
      );
    }

    const [users, org] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: {
          organizationId,
          isActive: true,
          role: { in: [Role.HR, Role.ADMIN] },
        },
        include: { department: true },
        orderBy: { employeeId: 'asc' },
      }),
      this.prisma.organization.findUnique({ where: { id: organizationId } }),
    ]);
    const holidays = await this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        AND: [holidayInEffect],
        date: { gte: dto.startDate, lte: dto.endDate },
      },
      select: { date: true, departmentId: true },
    });
    const orgPrefs = (org?.attendancePayrollPrefs ??
      null) as OrganizationAttendancePrefs | null;

    // Months of payroll that are already locked or paid are never backfilled: a payslip was issued against them.
    const lockedMonths = new Set<string>();
    for (const m of monthsBetween(dto.startDate, dto.endDate)) {
      const ids = await lockedEmployeeIdsForMonth(
        this.scopedPrisma,
        organizationId,
        m.year,
        m.month,
      );
      for (const id of ids) {
        lockedMonths.add(`${id}:${m.year}-${String(m.month).padStart(2, '0')}`);
      }
    }
    let skippedLocked = 0;

    const report: {
      employeeId: string;
      name: string;
      missingDays: number;
      wouldBe: { weeklyOff: number; holiday: number; other: number };
      created: Record<string, number>;
    }[] = [];

    for (const user of users) {
      const joined = user.joiningDate.toISOString().slice(0, 10);
      const existing = new Set(
        (
          await this.scopedPrisma.attendance.findMany({
            where: {
              organizationId,
              employeeId: user.id,
              date: { gte: dto.startDate, lte: dto.endDate },
            },
            select: { date: true },
          })
        ).map((r) => r.date),
      );
      const missing = dates.filter(
        (d) =>
          d >= joined &&
          !existing.has(d) &&
          !lockedMonths.has(`${user.id}:${d.slice(0, 7)}`),
      );
      skippedLocked += dates.filter(
        (d) =>
          d >= joined &&
          !existing.has(d) &&
          lockedMonths.has(`${user.id}:${d.slice(0, 7)}`),
      ).length;
      const shiftConfig = resolveShiftConfig(
        user.department,
        orgPrefs,
        org?.timezone ?? DEFAULT_ORG_TIMEZONE,
      );
      const wouldBe = { weeklyOff: 0, holiday: 0, other: 0 };
      for (const d of missing) {
        const isHoliday = holidays.some(
          (h) =>
            h.date === d &&
            (h.departmentId === null || h.departmentId === user.departmentId),
        );
        if (isHoliday) wouldBe.holiday += 1;
        else if (isWeeklyOff(d, shiftConfig.weeklyOffs)) wouldBe.weeklyOff += 1;
        else wouldBe.other += 1;
      }
      const created: Record<string, number> = {};
      if (!dryRun) {
        await mapWithConcurrency(missing, 4, async (d) => {
          // Past days written after the fact: no absence notice or e-mail for each of them.
          const row = await this.recalculateAttendanceForDay(
            this.scopedPrisma,
            user.id,
            d,
            organizationId,
            { quiet: true },
          );
          created[row.status] = (created[row.status] ?? 0) + 1;
        });
      }
      if (missing.length > 0 || !dryRun) {
        report.push({
          employeeId: user.employeeId,
          name: user.name,
          missingDays: missing.length,
          wouldBe,
          created,
        });
      }
    }

    const totalMissing = report.reduce((s, r) => s + r.missingDays, 0);
    if (!dryRun && totalMissing > 0) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'ATTENDANCE_BACKFILL_HR',
        module: 'ATTENDANCE',
        organizationId,
        details: {
          startDate: dto.startDate,
          endDate: dto.endDate,
          users: report.length,
          recordsCreated: totalMissing,
        },
      });
    }
    return {
      dryRun,
      startDate: dto.startDate,
      endDate: dto.endDate,
      users: report,
      totalMissingDays: totalMissing,
      skippedLockedDays: skippedLocked,
      note: dryRun
        ? 'Nothing was changed. Send dryRun: false to create these records, then recalculate payroll for the open months.'
        : 'Records created. Recalculate payroll for the affected months that are still open.',
    };
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
    const now = new Date();
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    for (const org of organizations) {
      try {
        // Each org's own "yesterday", not one UTC-derived date shared
        // across every org — otherwise an org whose local day is already
        // ahead/behind UTC at 01:00 UTC would get the wrong calendar day
        // marked.
        const yesterday = yesterdayInOrgTz(org.timezone, now);
        // Written now, announced at 08:00 org-local time by sendMorningAbsenceNotices.
        await this.notifyAbsentees({ date: yesterday }, org.id, true);
      } catch (err) {
        this.logger.error(
          `markYesterdayAbsences failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  // Nightly safety net for the reference-holiday repair: an attendance import (or any other write) that landed after a
  // past-dated holiday was known leaves empty Absent rows on it, so every organization is swept once a night. Idempotent,
  // quiet, and it never touches locked / paid payroll months (see applyReferenceHolidays).
  @Cron('30 2 * * *')
  async applyReferenceHolidaysNightly() {
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    for (const org of organizations) {
      try {
        await this.applyReferenceHolidays(org.id);
      } catch (err) {
        this.logger.error(
          `applyReferenceHolidays failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  // Writes (or rewrites) the Present days of an always-present employee from `from` up to yesterday, so turning the setting on today
  // also fixes the days since the effective date. Skips months whose payroll is locked or paid, days before joining and after the last
  // working day, and goes back at most 92 days. Returns how many days were written.
  async backfillAlwaysPresent(employeeId: string, from: string, organizationId: string): Promise<number> {
    const employee = await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { joiningDate: true, exitDate: true } });
    if (!employee) return 0;
    const yesterday = yesterdayInOrgTz(await this.getOrgTimezone(organizationId), new Date());
    const earliest = addDaysStr(yesterday, -92);
    let day = [from, utcDateStrOf(employee.joiningDate), earliest].sort().pop() as string;
    const locked = new Map<string, boolean>();
    let written = 0;
    for (; day <= yesterday; day = addDaysStr(day, 1)) {
      if (!isEmployedOn(employee.exitDate, day)) break;
      const monthKey = day.slice(0, 7);
      if (!locked.has(monthKey)) {
        const ids = await lockedEmployeeIdsForMonth(this.scopedPrisma, organizationId, Number(day.slice(0, 4)), Number(day.slice(5, 7)));
        locked.set(monthKey, ids.has(employeeId));
      }
      if (locked.get(monthKey)) continue;
      await this.recalculateAttendanceForDay(this.scopedPrisma, employeeId, day, organizationId, { quiet: true });
      written += 1;
    }
    return written;
  }

  // Tells employees about yesterday's absence at 08:00 in their organization's own timezone, instead of at 01:00 when the
  // mail would sit unread overnight. Runs hourly and acts only for orgs whose local hour is 8, so each org is handled
  // once a day. The day is recalculated first, so a night shift that ended after the 01:00 sweep, a late regularization
  // or an approved leave is picked up before anyone is told they were absent. Re-running is safe: the notice and e-mail
  // are de-duplicated per employee and date (notifyLateOrAbsent).
  @Cron('0 * * * *')
  async sendMorningAbsenceNotices() {
    const now = new Date();
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    for (const org of organizations) {
      try {
        const localHour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: org.timezone,
            hour: '2-digit',
            hour12: false,
          }).format(now),
        );
        if (localHour !== 8) continue;
        await this.notifyAbsentees(
          { date: yesterdayInOrgTz(org.timezone, now) },
          org.id,
        );
      } catch (err) {
        this.logger.error(
          `sendMorningAbsenceNotices failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  // How far ahead of shift end to nudge — long enough to actually be
  // useful (not a 1-minute-warning nobody can act on), short enough that
  // it's clearly tied to "your shift is ending now", not a vague
  // end-of-day reminder.
  private static readonly PUNCH_OUT_REMINDER_WINDOW_MINUTES = 15;

  // Nudges an employee shortly before their shift ends if they're still
  // punched in — the whole point of the auto-suggested-overtime feature
  // (suggestOvertimeFromPunchOut) and accurate day-status both depend on a
  // real punch-out actually happening, not on someone remembering. Runs
  // every 5 minutes; per-employee/day title-dedupe (same convention as
  // notifyLateOrAbsent) means each employee gets at most one nudge per day
  // regardless of how many 5-minute ticks land inside the reminder window.
  @Cron('*/5 * * * *')
  async remindUpcomingPunchOuts() {
    const now = new Date();
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    for (const org of organizations) {
      try {
        await this.remindUpcomingPunchOutsForOrg(org.id, now);
      } catch (err) {
        this.logger.error(
          `remindUpcomingPunchOuts failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async remindUpcomingPunchOutsForOrg(
    organizationId: string,
    now: Date,
  ) {
    // Still punched in: has an in-time, no out-time yet. Deliberately NOT
    // filtered by `date: todayInOrgTz(...)` — Attendance.date is attributed
    // in literal UTC (resolveAttendanceDateForPunch has no org-timezone
    // awareness), so for an org ahead of UTC (e.g. Asia/Kolkata, +5:30) the
    // org-local "today" and the row's own UTC-attributed date disagree for
    // part of every day (currently 18:30-23:59 UTC) — a date filter here
    // would silently skip every open row during that window. A bounded
    // recency filter on inTime (36h, generous enough for a crossesMidnight
    // shift still mid-shift near its end) does the same "don't resurface
    // ancient stuck-open rows" job without needing to guess "today" at all.
    const openRows = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        inTime: { not: null, gte: new Date(now.getTime() - 36 * 60 * 60000) },
        outTime: null,
      },
      include: { employee: { include: { department: true } } },
    });
    if (openRows.length === 0) return;

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    const orgPrefs =
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null;

    for (const row of openRows) {
      const shiftConfig = resolveShiftConfig(
        row.employee.department,
        orgPrefs,
        org?.timezone ?? DEFAULT_ORG_TIMEZONE,
      );
      const shiftEnd = buildShiftDateTime(
        shiftConfig.crossesMidnight ? addDaysStr(row.date, 1) : row.date,
        shiftConfig.shiftEndTime,
        tzOf(shiftConfig),
      );
      const minutesUntilEnd = Math.round(
        (shiftEnd.getTime() - now.getTime()) / 60000,
      );
      if (
        minutesUntilEnd <= 0 ||
        minutesUntilEnd > AttendanceService.PUNCH_OUT_REMINDER_WINDOW_MINUTES
      ) {
        continue;
      }

      const title = `Punch-Out Reminder — ${formatDateDisplay(row.date)}`;
      const alreadyNotified = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: row.employeeId, title },
      });
      if (alreadyNotified) continue;

      await this.notificationsService.create({
        organizationId,
        userId: row.employeeId,
        title,
        message: `Your shift ends in about ${minutesUntilEnd} minute(s) — don't forget to punch out.`,
        category: NotificationCategory.ATTENDANCE,
      });
    }
  }

  // Same "auto-approve after N hours with no reviewer action" idea
  // LeavesService.autoApprovePendingLeaves already gives HR per leave type
  // (LeaveType.autoApproveIfNoAction/autoApproveHours) — WFH and
  // Regularization requests have no "type" of their own to hang a toggle
  // off, so this reads Organization.wfhAutoApproveIfNoAction/
  // regularizationAutoApproveIfNoAction instead. Off by default: only an
  // org that's explicitly turned this on (Organization Settings > Work
  // Arrangement) is ever swept. Runs every 15 minutes, same cadence as
  // the leave sweep.
  @Cron('*/15 * * * *')
  async autoApprovePendingWorkArrangementsAndRegularizations() {
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: {
        isActive: true,
        OR: [
          { wfhAutoApproveIfNoAction: true },
          { regularizationAutoApproveIfNoAction: true },
        ],
      },
      select: {
        id: true,
        wfhAutoApproveIfNoAction: true,
        wfhAutoApproveHours: true,
        regularizationAutoApproveIfNoAction: true,
        regularizationAutoApproveHours: true,
      },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.attendance');
    for (const org of organizations) {
      try {
        if (org.wfhAutoApproveIfNoAction) {
          await this.autoApprovePendingWfhForOrg(
            org.id,
            org.wfhAutoApproveHours,
          );
        }
        if (org.regularizationAutoApproveIfNoAction) {
          await this.autoApprovePendingRegularizationsForOrg(
            org.id,
            org.regularizationAutoApproveHours,
          );
        }
      } catch (err) {
        this.logger.error(
          `autoApprovePendingWorkArrangementsAndRegularizations failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private static readonly AUTO_APPROVE_COMMENT =
    'Auto-approved: no reviewer action within the configured window.';

  private async autoApprovePendingWfhForOrg(
    organizationId: string,
    hours: number,
  ) {
    // updatedAt, not createdAt — the Attendance row can predate the WFH
    // request itself (e.g. already had punches for that date), same
    // "closest available requested at" reasoning the WFH Requests table's
    // own Requested At column already relies on for this same row.
    const cutoff = new Date(Date.now() - hours * 60 * 60000);
    const candidates = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        workArrangement: WorkArrangement.WFH,
        workArrangementStatus: WfhApprovalStatus.PENDING,
        updatedAt: { lte: cutoff },
      },
      include: { employee: true },
    });
    if (candidates.length === 0) return;
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    for (const row of candidates) {
      try {
        // Same compare-and-swap guarantee as reviewWorkArrangement — a
        // human reviewer acting on this row at the same moment this sweep
        // reaches it can't race into a double-decision either way.
        const { count } = await this.scopedPrisma.attendance.updateMany({
          where: {
            id: row.id,
            organizationId,
            workArrangementStatus: WfhApprovalStatus.PENDING,
          },
          data: {
            workArrangementStatus: WfhApprovalStatus.APPROVED,
            workArrangementReviewedById: null,
            workArrangementReviewedAt: new Date(),
            workArrangementReviewComments:
              AttendanceService.AUTO_APPROVE_COMMENT,
          },
        });
        if (count === 0) continue;

        await this.timelineService.logEvent({
          organizationId,
          employeeId: row.employeeId,
          eventKey: 'WFH_APPROVED',
          performedById: null,
          description: AttendanceService.AUTO_APPROVE_COMMENT,
        });

        const title = 'Work From Home Request APPROVED';
        const message = `Your Work From Home request for ${formatDateDisplay(row.date, '', dateFormat, timeZone)} was automatically approved — no reviewer acted within the configured window.`;
        await this.notificationsService.create({
          organizationId,
          userId: row.employeeId,
          title,
          message,
          category: NotificationCategory.ATTENDANCE,
        });
        const { subject, html } =
          await this.emailTemplatesService.renderOccasion(
            organizationId,
            'WFH_DECISION',
            {
              employeeName: row.employee.name,
              decision: 'APPROVED',
              date: formatDateDisplay(row.date, '', dateFormat, timeZone),
              comments: AttendanceService.AUTO_APPROVE_COMMENT,
            },
            { subject: title, html: message },
          );
        void this.emailService.send({
          to: row.employee.email,
          subject,
          html,
          organizationId,
        });
      } catch (err) {
        this.logger.error(
          `Auto-approve WFH failed for attendance ${row.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async autoApprovePendingRegularizationsForOrg(
    organizationId: string,
    hours: number,
  ) {
    const cutoff = new Date(Date.now() - hours * 60 * 60000);
    const candidates = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        regularization: { path: ['status'], equals: 'pending' },
        updatedAt: { lte: cutoff },
      },
      include: { employee: true },
    });
    if (candidates.length === 0) return;
    const { dateFormat, timeZone } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    // The audit log needs a user as its actor, and a sweep has none: the organisation's oldest active Admin stands in,
    // and every entry is marked details.source = 'SCHEDULED' so it is never mistaken for something they did.
    const systemActor = await this.scopedPrisma.user.findFirst({
      where: { organizationId, isActive: true, role: Role.ADMIN },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    for (const row of candidates) {
      try {
        const existingReg =
          row.regularization as unknown as RegularizationState;
        // The same rules as a reviewer's approval. A request that cannot be approved as a reviewer would - the payroll
        // for that month is locked or paid, or the day would still lack an In or Out time - stays pending for a person
        // to deal with, instead of being forced through.
        let outcome: Awaited<ReturnType<typeof this.regularizationOutcome>>;
        try {
          await assertPayrollPeriodUnlocked(
            this.scopedPrisma,
            organizationId,
            row.employeeId,
            row.date,
          );
          outcome = await this.regularizationOutcome(
            row,
            existingReg,
            organizationId,
          );
        } catch (blocked) {
          if (blocked instanceof BadRequestException) {
            this.logger.warn(
              `Auto-approve skipped for attendance ${row.id}: ${blocked.message}`,
            );
            continue;
          }
          throw blocked;
        }
        const regularization: RegularizationState = {
          ...existingReg,
          status: 'approved',
          reviewedBy: null,
          reviewedAt: new Date().toISOString(),
          reviewComments: AttendanceService.AUTO_APPROVE_COMMENT,
        };
        const data: Prisma.AttendanceUpdateManyMutationInput = {
          regularization: regularization as unknown as Prisma.InputJsonValue,
          inTime: outcome.inTime,
          outTime: outcome.outTime,
          workDurationMinutes: outcome.workDurationMinutes,
          status: outcome.status,
          isLate: outcome.isLate,
          isEarlyOut: outcome.isEarlyOut,
          source: AttendanceSource.REGULARIZED,
        };

        // Same compare-and-swap guarantee as reviewRegularization — a
        // human reviewer acting on this row at the same moment can't race
        // this sweep into a double-decision either way.
        const { count } = await this.scopedPrisma.attendance.updateMany({
          where: {
            id: row.id,
            organizationId,
            regularization: { path: ['status'], equals: 'pending' },
          },
          data,
        });
        if (count === 0) continue;

        await this.closeRegularizationRequest(
          row.id,
          organizationId,
          RegularizationRequestStatus.APPROVED,
          {
            reviewedById: null,
            reviewComments: AttendanceService.AUTO_APPROVE_COMMENT,
            autoApproved: true,
          },
        );

        if (systemActor) {
          await this.auditLogService.log({
            actorId: systemActor.id,
            action: 'REGULARIZATION_APPROVED',
            module: 'ATTENDANCE',
            organizationId,
            targetId: row.id,
            details: {
              source: 'SCHEDULED',
              autoApproved: true,
              employeeId: row.employeeId,
              date: row.date,
              previousInTime: row.inTime?.toISOString() ?? null,
              previousOutTime: row.outTime?.toISOString() ?? null,
              requestedInTime: existingReg.requestedInTime ?? null,
              requestedOutTime: existingReg.requestedOutTime ?? null,
              previousStatus: row.status,
              newStatus: outcome.status,
            },
          });
        }

        const title = 'Regularization Request APPROVED';
        const message = `Your attendance regularization request for ${formatDateDisplay(row.date, '', dateFormat, timeZone)} was automatically approved — no reviewer acted within the configured window.`;
        await this.notificationsService.create({
          organizationId,
          userId: row.employeeId,
          title,
          message,
          category: NotificationCategory.REGULARIZATION,
        });
        const { subject, html } =
          await this.emailTemplatesService.renderOccasion(
            organizationId,
            'REGULARIZATION_DECISION',
            {
              employeeName: row.employee.name,
              decision: 'APPROVED',
              date: formatDateDisplay(row.date, '', dateFormat, timeZone),
              comments: AttendanceService.AUTO_APPROVE_COMMENT,
            },
            { subject: title, html: message },
          );
        void this.emailService.send({
          to: row.employee.email,
          subject,
          html,
          organizationId,
        });
      } catch (err) {
        this.logger.error(
          `Auto-approve regularization failed for attendance ${row.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}
