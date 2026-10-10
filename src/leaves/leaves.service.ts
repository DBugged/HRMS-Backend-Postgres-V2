// Purpose: End-to-end leave lifecycle — apply, edit, single/two-level review, cancel — and its balance and
// attendance side effects.
// Responsibilities: Owns rule validation (via leave-rules/leave-balance-check), the pending/availed balance
// hold-and-release dance (createLeaveInternal/releaseHold), and orchestrates AttendanceService
// (write/revert attendance for approved leave), CompOffService (consume/release for COMPOFF-type leave),
// and ApprovalDelegationService (stand-in reviewer support) — none of those own their own side of this flow.
// Important: review() implements a two-level workflow where a MANAGER's approval on a 2-level leave type
// only records level-1 sign-off (status stays PENDING); only ADMIN/HR can give final approval. releaseHold()
// is the single place that reverses whatever a leave's current status implied, shared by update() and cancel().
import { EMPLOYEE_RELATION_ORDER_BY } from '../common/employee-order';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AllocationType,
  Leave,
  LeaveStatus,
  LeaveType,
  NotificationCategory,
  OffboardingStatus,
  PayrollRunStatus,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { isEligible } from '../leave-balances/leave-eligibility';
import { LEAVE_TYPE_CODES } from '../common/reserved-codes';
import { CompOffService } from '../comp-offs/comp-off.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ApplyLeaveDto } from './dto/apply-leave.dto';
import { UpdateLeaveDto } from './dto/update-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { ListLeavesQueryDto } from './dto/list-leaves-query.dto';
import { TeamCalendarQueryDto } from './dto/team-calendar-query.dto';
import {
  checkLeaveRules,
  applicationDocumentRule,
  effectiveLeaveRules,
  rangesOverlap,
  LeaveRules,
} from './leave-rules';
import {
  resolveShiftConfig,
  OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import { checkAffordability, NegativeBalanceRule } from './leave-balance-check';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  assertManagerScopeOrDelegate,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  formatDateDisplay,
  resolveOrgDateTimeFormat,
} from '../payroll/format-date';
import { todayInOrgTz } from '../common/org-date';
import {
  assertPayrollMonthsUnlocked,
  monthsBetween,
  reopenSignedOffPayrollMonths,
} from '../payroll/payroll-period-guard';

type Actor = Omit<User, 'password'>;

// The balance-changing actions LeaveTypesService writes (older accrual entries stay on record) — same fixed list the
// old system's getCreditHistory filtered on.
const CREDIT_HISTORY_ACTIONS = [
  'LEAVE_ACCRUAL_RUN',
  'LEAVE_ACCRUAL_REPAIRED',
  'LEAVE_BALANCES_RECALCULATED',
  'LEAVE_TYPE_POLICY_CHANGED',
  'LEAVE_CARRYFORWARD_RUN',
];

// Old system's LEAVE_APPROVE_ROLES / LEAVE_VIEW_ROLES both collapse to this
// set — see the Batch 4b plan's role-mapping note.
const APPROVE_ROLES: Role[] = [Role.ADMIN, Role.HR, Role.MANAGER];
// Old system's LEAVE_CONFIG_ROLES — HR override for cancellation.
const CANCEL_OVERRIDE_ROLES: Role[] = [Role.ADMIN, Role.HR];

function deriveLeaveYear(startDate: string): number {
  return Number(startDate.slice(0, 4));
}

// Every distinct (month, year) a leave's date range touches, as
// PayrollRun-style `{ month, year }` filters — used by cancel()'s
// payroll-lock check so a leave spanning a month boundary is checked
// against every PayrollRun it could actually affect, not just the one its
// startDate happens to fall in.
function monthsInRange(
  startDate: string,
  endDate: string,
): { month: number; year: number }[] {
  const months: { month: number; year: number }[] = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const NO_GRANT_MESSAGE =
  'No leave has been granted for this leave type, or the granted days are used up. HR grants it for a qualifying event.';

const INSUFFICIENT_BALANCE_MESSAGE =
  'Insufficient leave balance. For the extra days, apply for Leave Without Pay (pay is deducted for those days).';

function isCompOffType(leaveType: LeaveType): boolean {
  return leaveType.code === LEAVE_TYPE_CODES.COMPOFF;
}

// True for any leave type with no balance ledger to check/debit at all —
// UNLIMITED types (e.g. LWP), and NONE-allocation types other than
// COMPOFF (e.g. SPL, which is HR-discretionary and has no ledger of its
// own, unlike COMPOFF which is backed by the separate CompOff table).
// isCompOffType() must be checked first by callers — COMPOFF itself is
// also AllocationType.NONE but is handled by the comp-off ledger instead.
function isUnbalancedType(leaveType: LeaveType): boolean {
  return (
    leaveType.allocationType === AllocationType.UNLIMITED ||
    leaveType.allocationType === AllocationType.NONE
  );
}

@Injectable()
export class LeavesService {
  private readonly logger = new Logger(LeavesService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly compOffService: CompOffService,
    private readonly attendanceService: AttendanceService,
    private readonly delegationService: ApprovalDelegationService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async apply(dto: ApplyLeaveDto, actor: Actor, organizationId: string) {
    // A leave for a month whose payroll is already locked/paid could never take effect in that payslip.
    if (dto.startDate && dto.endDate) {
      await assertPayrollMonthsUnlocked(
        this.scopedPrisma,
        organizationId,
        actor.id,
        monthsBetween(dto.startDate, dto.endDate),
        'leave',
      );
    }
    return this.createLeaveInternal(dto, actor, organizationId);
  }

  // History of periodic accrual/carry-forward runs, visible to whoever can
  // approve leave (HR triggers them, Managers get a read-only view) —
  // mirrors the old system's getCreditHistory, sourced from the audit log
  // rather than a dedicated table since these are infrequent admin actions.
  async getCreditHistory(organizationId: string) {
    const logs = await this.scopedPrisma.auditLog.findMany({
      where: {
        organizationId,
        module: 'LEAVE',
        action: { in: CREDIT_HISTORY_ACTIONS },
      },
      include: {
        actor: {
          select: { id: true, name: true, employeeId: true, role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { history: logs };
  }

  async findAll(
    query: ListLeavesQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.LeaveWhereInput = { organizationId };
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
        // "My Leave") instead of the whole department — never widens it:
        // the requested id must already be within the manager's own dept
        // scope, same boundary the unfiltered branch below enforces.
        if (!deptIds.includes(query.employeeId)) {
          throw new ForbiddenException(
            "Not authorized to view this employee's leaves.",
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
        this.scopedPrisma.leave.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            leaveType: {
              select: {
                id: true,
                name: true,
                code: true,
                approvalLevels: true,
              },
            },
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { createdAt: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.leave.count({ where }),
      query.page,
      query.limit,
    );
  }

  async getBalance(
    employeeIdParam: string | undefined,
    year: number | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    const targetEmployeeId = await this.resolveViewTarget(
      employeeIdParam,
      actor,
      organizationId,
    );
    const resolvedYear = year ?? new Date().getFullYear();

    const eligible = await this.leaveBalanceService.getEligibleLeaveTypes(
      targetEmployeeId,
      organizationId,
    );
    const balanceEligible = eligible.filter(
      (lt) =>
        lt.code !== LEAVE_TYPE_CODES.COMPOFF &&
        lt.allocationType !== AllocationType.NONE &&
        lt.allocationType !== AllocationType.UNLIMITED,
    );

    const balances = await this.scopedPrisma.$transaction(async (tx) => {
      const rows: (Prisma.LeaveBalanceGetPayload<object> & {
        leaveType: {
          id: string;
          name: string;
          code: string;
          // Web's Leave Encashment "Request" button reads
          // b.leaveType.encashment.allowed off this exact response — it was
          // dropped when this projection was narrowed to {id,name,code},
          // which silently left the button permanently disabled for every
          // employee (leaveType.encashment is on the Prisma row already in
          // scope below, just wasn't carried through).
          encashment: Prisma.JsonValue;
          // Profiles/dashboards sum only types with this on.
          countInTotalBalance: boolean;
          // Lets My Leave treat an event-based type (built from HR grants) differently from a yearly one.
          allocationType: AllocationType;
        };
      })[] = [];
      for (const leaveType of balanceEligible) {
        const row = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          targetEmployeeId,
          leaveType.id,
          resolvedYear,
          organizationId,
        );
        rows.push({
          ...row,
          leaveType: {
            id: leaveType.id,
            name: leaveType.name,
            code: leaveType.code,
            encashment: leaveType.encashment,
            countInTotalBalance: leaveType.countInTotalBalance,
            allocationType: leaveType.allocationType,
          },
        });
      }
      return rows;
    });

    // `closing` still counts carried-in days that lapsed unused; what an employee can actually use (apply, encash)
    // does not, so the balances shown here exclude them and say how many lapsed.
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const lapsedByRow = await this.leaveBalanceService.forfeitedCarryIn(
      this.scopedPrisma,
      balances,
      organizationId,
      new Date().getFullYear() > resolvedYear
        ? `${resolvedYear}-12-31`
        : todayInOrgTz(org?.timezone ?? 'Asia/Kolkata'),
    );
    // `available` is what the employee can still apply for: closing minus the days already held by pending requests
    // (closing itself ignores pending), never below zero.
    const shown = balances.map((b) => {
      const lapsed = lapsedByRow.get(b.id) ?? 0;
      const closing = Math.round((b.closing - lapsed) * 100) / 100;
      const available = Math.max(
        0,
        Math.round((closing - b.pending) * 100) / 100,
      );
      return lapsed > 0
        ? { ...b, closing, available, forfeitedCarryIn: lapsed }
        : { ...b, available };
    });

    const compOffAvailable = await this.compOffService.available(
      targetEmployeeId,
      organizationId,
    );

    return { balances: shown, compOffAvailable };
  }

  async getTeamCalendar(
    query: TeamCalendarQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.LeaveWhereInput = {
      organizationId,
      status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
      startDate: { lte: query.to },
      endDate: { gte: query.from },
    };
    if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    }

    return this.scopedPrisma.leave.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, employeeId: true } },
        leaveType: { select: { id: true, name: true, color: true } },
      },
      orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { startDate: 'asc' }],
    });
  }

  async getHistory(employeeId: string, actor: Actor, organizationId: string) {
    if (employeeId !== actor.id && !APPROVE_ROLES.includes(actor.role)) {
      throw new ForbiddenException(
        "You cannot view another employee's leave history.",
      );
    }
    if (employeeId !== actor.id) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employeeId,
      );
    }

    const [leaves, balances] = await Promise.all([
      this.scopedPrisma.leave.findMany({
        where: { organizationId, employeeId },
        include: {
          leaveType: { select: { id: true, name: true, code: true } },
        },
        orderBy: { startDate: 'desc' },
      }),
      this.scopedPrisma.leaveBalance.findMany({
        where: { organizationId, employeeId },
        include: {
          leaveType: { select: { id: true, name: true, code: true } },
        },
        orderBy: { year: 'desc' },
      }),
    ]);

    return { leaves, balances };
  }

  async update(
    id: string,
    dto: UpdateLeaveDto,
    actor: Actor,
    organizationId: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    if (existing.employeeId !== actor.id) {
      throw new ForbiddenException(
        'You can only edit your own leave requests.',
      );
    }
    if (existing.status !== LeaveStatus.PENDING) {
      throw new BadRequestException(
        'Only pending leave requests can be edited.',
      );
    }

    await this.scopedPrisma.$transaction(async (tx) => {
      // Same compare-and-swap-then-release ordering as cancel() below —
      // only the caller that wins this guarded update (still PENDING)
      // proceeds to release the pending hold, so a concurrent double-edit
      // can't decrement `pending` twice for one request.
      const { count } = await tx.leave.updateMany({
        where: { id, organizationId, status: LeaveStatus.PENDING },
        data: { status: LeaveStatus.CANCELLED },
      });
      if (count === 0) {
        throw new ConflictException(
          'This leave request was already reviewed or cancelled.',
        );
      }
      await this.releaseHold(tx, existing, organizationId);
    });

    return this.createLeaveInternal(dto, actor, organizationId, id);
  }

  async review(
    id: string,
    dto: ReviewLeaveDto,
    actor: Actor,
    organizationId: string,
  ) {
    const leave = await this.findByIdOrThrow(id, organizationId);
    if (leave.status !== LeaveStatus.PENDING) {
      throw new BadRequestException(
        'This leave request has already been reviewed.',
      );
    }

    // An Admin may approve or reject their own leave (it is audit-logged as a self-approval above); HR and managers
    // cannot - assertManagerScopeOrDelegate below refuses a self-review from anyone but an Admin.

    // A rejection or return has to say why - the employee sees this text on the request and in the notification.
    if (
      (dto.decision === 'REJECTED' || dto.decision === 'RETURNED') &&
      !dto.comments?.trim()
    ) {
      throw new BadRequestException(
        'A comment is required when rejecting or returning a leave request.',
      );
    }

    // Same department-scope-or-delegate boundary as findAll()'s pending
    // queue (deptScopedEmployeeIds) and every other review action in the
    // app (attendance/overtime/comp-off — see assertManagerScopeOrDelegate).
    // This used to be a bespoke reportingManagerId-only check here, which
    // let a leave show up in a MANAGER's pending list (department match)
    // while still 403-ing them on the actual review — e.g. any employee
    // whose reportingManagerId isn't set (or points elsewhere) even though
    // they're in the reviewing manager's own department.
    await assertManagerScopeOrDelegate(
      this.scopedPrisma,
      this.delegationService,
      actor,
      organizationId,
      leave.employeeId,
    );
    await this.auditLogService.logSelfApproval(actor, {
      module: 'LEAVE',
      targetId: id,
      employeeId: leave.employeeId,
      request: 'Leave',
    });

    const leaveType = await this.scopedPrisma.leaveType.findFirstOrThrow({
      where: { id: leave.leaveTypeId, organizationId },
    });

    // Two-level workflow: a MANAGER's approval on a 2-level leave type only
    // records level-1 sign-off — status stays PENDING, balance untouched,
    // final decision (approve/reject/return) still required from ADMIN/HR.
    if (
      leaveType.approvalLevels === 2 &&
      actor.role === Role.MANAGER &&
      leave.level1ApprovedById === null &&
      dto.decision === 'APPROVED'
    ) {
      await this.scopedPrisma.leave.updateMany({
        where: { id, organizationId },
        data: {
          level1ApprovedById: actor.id,
          level1ApprovedAt: new Date(),
          level1Comments: dto.comments ?? '',
        },
      });
      await this.notifyLevel1Approved(leave, organizationId);
      return this.findByIdOrThrow(id, organizationId);
    }

    // A MANAGER cannot give the FINAL approval on a 2-level type — only
    // the level-1 sign-off above, or a reject/return (handled below,
    // matches the old system's "a rejection/return at any level" carve-out).
    if (
      leaveType.approvalLevels === 2 &&
      actor.role === Role.MANAGER &&
      dto.decision === 'APPROVED'
    ) {
      throw new ForbiddenException(
        'This leave type requires final approval from HR/Admin after level-1 sign-off.',
      );
    }

    // ...and HR/Admin cannot skip level 1: while the reporting manager's sign-off is still outstanding, the final
    // approval has to wait for it (rejecting or returning is always allowed). If there is nobody who could give
    // level-1 (no manager above the employee), the final approver decides alone so the request is never stuck.
    if (
      leaveType.approvalLevels === 2 &&
      actor.role !== Role.MANAGER &&
      leave.level1ApprovedById === null &&
      dto.decision === 'APPROVED' &&
      (await this.levelOneApproverExists(leave, organizationId))
    ) {
      throw new BadRequestException(
        "This leave type needs level-1 approval from the employee's manager first. It is still waiting for them.",
      );
    }

    return this.applyDecision(
      leave,
      leaveType,
      dto.decision,
      dto.comments ?? '',
      actor.id,
      organizationId,
    );
  }

  // The actual status flip + balance/attendance/comp-off side effects,
  // shared by review() (a human decision) and autoApprovePendingLeaves
  // below (an unattended one — reviewedById is null there). Callers are
  // responsible for whatever permission/two-level checks apply to them;
  // this only enforces the data-integrity guarantee (status:PENDING
  // compare-and-swap) that makes it safe to call from either place,
  // including both racing for the same leave at once.
  private async applyDecision(
    leave: Leave,
    leaveType: LeaveType,
    decision: 'APPROVED' | 'REJECTED' | 'RETURNED',
    comments: string,
    reviewedById: string | null,
    organizationId: string,
  ) {
    // Approving a leave rewrites attendance and balances for its dates: refuse when one of those months is already
    // locked/paid, and send a signed-off run back for recalculation (see payroll-period-guard.ts).
    const leaveMonths = monthsBetween(leave.startDate, leave.endDate);
    if (decision === 'APPROVED') {
      await assertPayrollMonthsUnlocked(
        this.scopedPrisma,
        organizationId,
        leave.employeeId,
        leaveMonths,
        'leave',
      );
    }
    await this.scopedPrisma.$transaction(async (tx) => {
      // status: PENDING re-asserted here (not just in whatever check the
      // caller already ran) so a second concurrent call — double-click, a
      // retried request, or this same leave's own auto-approve deadline
      // firing mid-review — can't slip past and re-apply the balance/
      // attendance/comp-off side effects below a second time. count === 0
      // means another decision already won the race; bail out instead of
      // double-crediting or double-debiting.
      const { count } = await tx.leave.updateMany({
        where: { id: leave.id, organizationId, status: LeaveStatus.PENDING },
        data: {
          status: decision,
          reviewedById,
          reviewedAt: new Date(),
          reviewComments: comments,
        },
      });
      if (count === 0) {
        throw new ConflictException('This leave request was already reviewed.');
      }

      if (decision === 'APPROVED') {
        await this.attendanceService.writeAttendanceForApprovedLeave(
          tx,
          leave,
          organizationId,
        );
        await reopenSignedOffPayrollMonths(
          tx,
          organizationId,
          leave.employeeId,
          leaveMonths,
        );
        if (isCompOffType(leaveType)) {
          await this.compOffService.consumeForLeave(
            tx,
            leave.employeeId,
            leave.totalDays,
            organizationId,
          );
        } else if (!isUnbalancedType(leaveType)) {
          const year = deriveLeaveYear(leave.startDate);
          const row = await this.leaveBalanceService.ensureBalanceRow(
            tx,
            leave.employeeId,
            leave.leaveTypeId,
            year,
            organizationId,
          );
          // Atomic increment/decrement — see the comment on the apply()
          // pending update above for why a JS-computed `row.field ± delta`
          // here would lose an update under concurrent review calls.
          await tx.leaveBalance.updateMany({
            where: { id: row.id, organizationId },
            data: {
              pending: { decrement: leave.totalDays },
              availed: { increment: leave.totalDays },
            },
          });
          await this.leaveBalanceService.recalculate(
            tx,
            row.id,
            organizationId,
          );
        }
      } else if (!isCompOffType(leaveType) && !isUnbalancedType(leaveType)) {
        // REJECTED/RETURNED — release the pending hold, nothing was ever
        // deducted from availed.
        const year = deriveLeaveYear(leave.startDate);
        const row = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          leave.employeeId,
          leave.leaveTypeId,
          year,
          organizationId,
        );
        await tx.leaveBalance.updateMany({
          where: { id: row.id, organizationId },
          data: { pending: { decrement: leave.totalDays } },
        });
        await this.leaveBalanceService.recalculate(tx, row.id, organizationId);
      }
    });

    await this.notifyLeaveDecision(
      leave,
      { decision, comments },
      organizationId,
    );
    return this.findByIdOrThrow(leave.id, organizationId);
  }

  // Sweeps every org for PENDING leave requests whose LeaveType has
  // autoApproveIfNoAction on and have sat past their own createdAt +
  // autoApproveHours deadline with no reviewer decision — gives HR a
  // configurable SLA instead of a request waiting forever. Runs every 15
  // minutes; applyDecision's own status:PENDING compare-and-swap means a
  // human reviewing the same leave at the same moment can't race this into
  // a double-decision either way.
  @Cron('*/15 * * * *')
  async autoApprovePendingLeaves() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      try {
        await this.autoApprovePendingLeavesForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `autoApprovePendingLeaves failed for org ${org.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private async autoApprovePendingLeavesForOrg(organizationId: string) {
    const now = new Date();
    const candidates = await this.scopedPrisma.leave.findMany({
      where: {
        organizationId,
        status: LeaveStatus.PENDING,
        leaveType: { autoApproveIfNoAction: true, autoApproveHours: { gt: 0 } },
      },
      include: { leaveType: true },
    });
    for (const leave of candidates) {
      const deadline = new Date(
        leave.createdAt.getTime() +
          leave.leaveType.autoApproveHours * 60 * 60000,
      );
      if (now < deadline) continue;
      try {
        await this.applyDecision(
          leave,
          leave.leaveType,
          'APPROVED',
          'Auto-approved: no reviewer action within the configured window.',
          null,
          organizationId,
        );
      } catch (err) {
        this.logger.error(
          `Auto-approve failed for leave ${leave.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  // True when someone could actually give this leave's level-1 sign-off: an active MANAGER who is the employee's
  // reporting manager or sits in the employee's department. Only employees and managers have a level 1; an HR or Admin
  // applicant goes straight to final approval.
  private async levelOneApproverExists(
    leave: Leave,
    organizationId: string,
  ): Promise<boolean> {
    const applicant = await this.scopedPrisma.user.findFirst({
      where: { id: leave.employeeId, organizationId },
      select: { role: true, reportingManagerId: true, departmentId: true },
    });
    if (!applicant) return false;
    if (applicant.role === Role.ADMIN || applicant.role === Role.HR) {
      return false;
    }
    const scope: Prisma.UserWhereInput[] = [];
    if (applicant.reportingManagerId) {
      scope.push({ id: applicant.reportingManagerId });
    }
    if (applicant.departmentId) {
      scope.push({ departmentId: applicant.departmentId });
    }
    if (scope.length === 0) return false;
    const count = await this.scopedPrisma.user.count({
      where: {
        organizationId,
        isActive: true,
        role: Role.MANAGER,
        id: { not: leave.employeeId },
        OR: scope,
      },
    });
    return count > 0;
  }

  private async notifyLevel1Approved(leave: Leave, organizationId: string) {
    const [hrUsers, { dateFormat }] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, role: { in: [Role.HR, Role.ADMIN] } },
        select: { id: true },
      }),
      resolveOrgDateTimeFormat(this.scopedPrisma, organizationId),
    ]);
    await this.notificationsService.createMany(
      hrUsers.map((u) => ({
        organizationId,
        userId: u.id,
        title: 'Leave Application Pending Final Approval',
        message: `A leave request (${formatDateDisplay(leave.startDate, '', dateFormat)} to ${formatDateDisplay(leave.endDate, '', dateFormat)}) has been level-1 approved and needs your final decision.`,
        category: NotificationCategory.LEAVE,
      })),
    );
  }

  private async notifyLeaveDecision(
    leave: Leave,
    dto: ReviewLeaveDto,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: leave.employeeId, organizationId },
    });
    if (!employee) return;

    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = `Leave Request ${dto.decision}`;
    const message = `Your leave request from ${formatDateDisplay(leave.startDate, '', dateFormat)} to ${formatDateDisplay(leave.endDate, '', dateFormat)} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;

    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.LEAVE,
    });

    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'LEAVE_DECISION',
      {
        employeeName: employee.name,
        decision: dto.decision,
        startDate: formatDateDisplay(leave.startDate, '', dateFormat),
        endDate: formatDateDisplay(leave.endDate, '', dateFormat),
        comments: dto.comments ?? '',
      },
      { subject: title, html: message },
    );
    // Fire-and-forget — the decision has already committed, so the
    // approver's click shouldn't wait on an SMTP/API round trip.
    void this.emailService.send({
      organizationId,
      to: employee.email,
      subject: rendered.subject,
      html: rendered.html,
    });
  }

  async cancel(id: string, actor: Actor, organizationId: string) {
    const leave = await this.findByIdOrThrow(id, organizationId);
    const isSelf = leave.employeeId === actor.id;
    const isOverride = CANCEL_OVERRIDE_ROLES.includes(actor.role);
    if (!isSelf && !isOverride) {
      throw new ForbiddenException(
        "You cannot cancel another employee's leave request.",
      );
    }
    const cancellableStatuses: LeaveStatus[] = [
      LeaveStatus.PENDING,
      LeaveStatus.RETURNED,
      LeaveStatus.APPROVED,
    ];
    if (!cancellableStatuses.includes(leave.status)) {
      throw new BadRequestException(
        'Only pending, returned, or approved leave requests can be cancelled.',
      );
    }

    // An APPROVED leave has already been folded into attendance (and
    // possibly a since-locked/paid payroll run's LOP calculation) —
    // cancelling it out from under an already-LOCKED/PAID run would
    // silently invalidate that run's basis with no record of why net pay
    // no longer matches. The flow instead is: an Admin unlocks the
    // relevant payroll run first (which also reverses whatever that run
    // charged — see PayrollService.undoAfterLock), then this cancellation
    // can proceed, then payroll gets recalculated with the leave gone.
    if (leave.status === LeaveStatus.APPROVED) {
      const months = monthsInRange(leave.startDate, leave.endDate);
      const lockedRun = await this.scopedPrisma.payrollRun.findFirst({
        where: {
          organizationId,
          employeeId: leave.employeeId,
          status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
          OR: months,
        },
      });
      if (lockedRun) {
        throw new BadRequestException(
          `This leave falls within the ${lockedRun.month}/${lockedRun.year} payroll period, which is already ${lockedRun.status.toLowerCase()}. Ask an Admin to unlock that payroll run before cancelling this leave.`,
        );
      }
    }

    await this.scopedPrisma.$transaction(async (tx) => {
      // Guarded update runs FIRST and re-asserts the still-cancellable
      // status — only the caller that actually wins this compare-and-swap
      // proceeds to releaseHold() below. Without this, two concurrent
      // cancel() calls on the same APPROVED leave (double-click, or a
      // retried request) would both pass the pre-transaction check above
      // and both call releaseHold(), each reverting attendance and
      // decrementing `availed`/comp-off a second time for a single
      // cancellation.
      const { count } = await tx.leave.updateMany({
        where: { id, organizationId, status: { in: cancellableStatuses } },
        data: { status: LeaveStatus.CANCELLED },
      });
      if (count === 0) {
        throw new ConflictException(
          'This leave request was already cancelled or reviewed.',
        );
      }
      // `leave` is the pre-transaction snapshot — releaseHold only needs
      // its *original* status (APPROVED vs PENDING/RETURNED) to know what
      // to reverse, which the guarded update above just confirmed is
      // still accurate (no other caller could have changed it first).
      await this.releaseHold(tx, leave, organizationId);
    });

    return this.findByIdOrThrow(id, organizationId);
  }

  // Reverses whatever balance/comp-off effect the leave's current status
  // implies — called from both update() (editing a pending request) and
  // cancel() (which can also reverse an already-approved one).
  private async releaseHold(
    tx: Prisma.TransactionClient,
    leave: Leave,
    organizationId: string,
  ) {
    if (leave.status === LeaveStatus.APPROVED) {
      await this.attendanceService.revertAttendanceForLeave(
        tx,
        leave,
        organizationId,
      );
    }

    const leaveType = await tx.leaveType.findFirstOrThrow({
      where: { id: leave.leaveTypeId, organizationId },
    });

    if (isCompOffType(leaveType)) {
      if (leave.status === LeaveStatus.APPROVED) {
        await this.compOffService.releaseForLeave(
          tx,
          leave.employeeId,
          leave.totalDays,
          organizationId,
        );
      }
      return;
    }
    if (isUnbalancedType(leaveType)) return;

    const year = deriveLeaveYear(leave.startDate);
    const row = await this.leaveBalanceService.ensureBalanceRow(
      tx,
      leave.employeeId,
      leave.leaveTypeId,
      year,
      organizationId,
    );

    // Atomic decrement — see the comment on the apply() pending update
    // above for why `row.field - delta` here would lose an update under
    // concurrent cancellations/reversals.
    //
    // Only PENDING still holds a `pending` reservation. review() already
    // releases it when it sets REJECTED/RETURNED, so decrementing again
    // here for those statuses double-releases: a RETURNED leave that the
    // employee then cancels (a legal transition — see cancel()'s
    // cancellableStatuses) drove `pending` negative, and since
    // checkAffordability computes available as `... - pending`, that
    // *inflated* the employee's usable balance by the leave's length,
    // repeatably and invisibly (LeaveBalance.closing ignores `pending`).
    const data: Prisma.LeaveBalanceUpdateManyMutationInput = {};
    if (leave.status === LeaveStatus.APPROVED) {
      data.availed = { decrement: leave.totalDays };
    } else if (leave.status === LeaveStatus.PENDING) {
      data.pending = { decrement: leave.totalDays };
    } else {
      // REJECTED/RETURNED — hold already released by review(); nothing to
      // reverse, and recalculate() below would only re-derive the same row.
      return;
    }
    await tx.leaveBalance.updateMany({
      where: { id: row.id, organizationId },
      data,
    });
    await this.leaveBalanceService.recalculate(tx, row.id, organizationId);
  }

  private async createLeaveInternal(
    dto: ApplyLeaveDto,
    actor: Actor,
    organizationId: string,
    editedFromLeaveId?: string,
  ) {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: dto.leaveType, organizationId, isActive: true },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    // The applicableDepartments/applicableEmployeeTypes/applicableGenders/
    // service-tenure rules that drive GET /leave-types/eligible/me and the
    // balance list must also gate application itself — otherwise an
    // ineligible employee (e.g. wrong gender/department, or below
    // minServiceMonths) could apply directly by leaveType id and the
    // request would silently proceed.
    if (!isEligible(leaveType, actor)) {
      throw new ForbiddenException('You are not eligible for this leave type.');
    }

    // No new leave once notice period has started — derived entirely from
    // this employee's own real OffboardingCase.lastWorkingDay (never a
    // fixed day count), so it can never drift out of sync with whatever
    // last working day HR actually agreed with the employee. Any leave
    // that would start on or before that date is blocked; a request that
    // starts after it isn't reachable anyway since the account is
    // deactivated once offboarding completes.
    const openOffboarding = await this.scopedPrisma.offboardingCase.findFirst({
      where: {
        organizationId,
        employeeId: actor.id,
        status: {
          in: [OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS],
        },
      },
    });
    if (openOffboarding && dto.startDate <= openOffboarding.lastWorkingDay) {
      throw new BadRequestException(
        `You're serving notice with a last working day of ${openOffboarding.lastWorkingDay} — new leave can't be applied for during the notice period.`,
      );
    }

    const [holidays, priorLeaveOfType, otherLeaves, employeeDept, org] =
      await Promise.all([
        this.scopedPrisma.holiday.findMany({
          where: { organizationId, isActive: true },
          select: { date: true },
        }),
        this.scopedPrisma.leave.findFirst({
          where: {
            organizationId,
            employeeId: actor.id,
            leaveTypeId: leaveType.id,
            status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
            endDate: { lt: dto.startDate },
          },
          orderBy: { endDate: 'desc' },
        }),
        this.scopedPrisma.leave.findMany({
          where: {
            organizationId,
            employeeId: actor.id,
            status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
          },
          select: { startDate: true, endDate: true },
        }),
        actor.departmentId
          ? this.scopedPrisma.department.findFirst({
              where: { id: actor.departmentId, organizationId },
            })
          : Promise.resolve(null),
        this.scopedPrisma.organization.findFirst({
          where: { id: organizationId },
        }),
      ]);

    // Resolves the employee's actual weekly-off days (department shift
    // config, falling back to the org default) — same source AttendanceService
    // itself reads — instead of assuming every org's weekend is plain Sunday
    // (see the sandwich-leave gap check in leave-rules.ts).
    const { weeklyOffs } = resolveShiftConfig(
      employeeDept,
      org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null,
    );
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');

    const baseRules = leaveType.rules as unknown as LeaveRules;
    // Event-based leave drops the rules that do not apply to it and, in calendar days, charges every date in the range
    // (weekends/holidays included) - see effectiveLeaveRules.
    const rules = effectiveLeaveRules(baseRules, leaveType);
    const ruleResult = checkLeaveRules(
      rules,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        isHalfDay: dto.isHalfDay ?? false,
        hasAttachment: !!dto.attachmentUrl,
      },
      {
        today,
        holidayDates: new Set(holidays.map((h) => h.date)),
        weeklyOffs,
        priorLeaveEndDate: priorLeaveOfType?.endDate ?? null,
        existingRanges: otherLeaves.map((l) => ({
          start: l.startDate,
          end: l.endDate,
        })),
        ...applicationDocumentRule(leaveType),
      },
    );
    if (!ruleResult.ok) {
      throw new BadRequestException(ruleResult.errors.join(' '));
    }
    const totalDays = ruleResult.totalDays;

    const created = await this.scopedPrisma.$transaction(async (tx) => {
      // Row-lock the applicant's own User row so two concurrent apply()
      // calls for the same employee serialize instead of both reading the
      // same pre-transaction `otherLeaves` snapshot and both passing the
      // overlap check above — reproduced live: firing the identical leave
      // request twice at once created two separate PENDING rows for the
      // same date range. Re-checking overlap here, after the lock, against
      // a freshly re-fetched range list closes that window; the second
      // concurrent caller waits for the first to commit, then sees its
      // just-inserted row and is correctly rejected.
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${actor.id} FOR UPDATE`;
      const freshOtherLeaves = await tx.leave.findMany({
        where: {
          organizationId,
          employeeId: actor.id,
          status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        },
        select: { startDate: true, endDate: true },
      });
      const stillOverlaps = freshOtherLeaves.some((range) =>
        rangesOverlap(
          { start: range.startDate, end: range.endDate },
          { start: dto.startDate, end: dto.endDate },
        ),
      );
      if (stillOverlaps) {
        throw new BadRequestException(
          'This leave request overlaps with an existing pending or approved leave.',
        );
      }

      // Comp-off leave: as many days as the employee has earned (and are still valid on the leave's start date) can be
      // taken, counting what other pending comp-off requests already hold. Checked here, after the row lock above, so
      // two requests submitted together cannot both be granted the same comp-off.
      if (isCompOffType(leaveType)) {
        const [validBalance, pendingHolds] = await Promise.all([
          this.compOffService.availableOn(
            actor.id,
            organizationId,
            dto.startDate,
          ),
          tx.leave.findMany({
            where: {
              organizationId,
              employeeId: actor.id,
              leaveTypeId: leaveType.id,
              status: LeaveStatus.PENDING,
            },
            select: { totalDays: true },
          }),
        ]);
        const held = pendingHolds.reduce((sum, l) => sum + l.totalDays, 0);
        const free = Math.round((validBalance - held) * 100) / 100;
        if (free + 0.001 < totalDays) {
          throw new ForbiddenException(
            `Insufficient comp-off balance: ${Math.max(0, free)} day(s) available${held > 0 ? ` (${held} day(s) are held by your pending comp-off requests)` : ''}.`,
          );
        }
      }

      if (!isCompOffType(leaveType) && !isUnbalancedType(leaveType)) {
        const year = deriveLeaveYear(dto.startDate);
        // Leave never goes negative: once the quota is used up the employee applies Leave Without Pay for the extra
        // days (pay is deducted for those). Any Allow Negative Balance setting on the leave type is ignored.
        const negativeBalance: NegativeBalanceRule = {
          allowed: false,
          maxNegativeDays: 0,
        };
        const row = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          actor.id,
          leaveType.id,
          year,
          organizationId,
        );
        // Cheap fail-fast against the pre-hold snapshot — good enough to
        // reject an obviously-unaffordable request without touching the
        // row, but NOT the authoritative check: two concurrent apply()
        // calls for the same employee+leaveType+year can both read this
        // same snapshot before either commits its hold below, so both
        // would pass here even if only one can actually be afforded.
        const forfeited = (
          await this.leaveBalanceService.forfeitedCarryIn(
            tx,
            [row],
            organizationId,
            today,
          )
        ).get(row.id);
        const preflight = checkAffordability(
          row,
          negativeBalance,
          totalDays,
          today,
          forfeited ?? 0,
        );
        if (!preflight.ok) {
          throw new ForbiddenException(
            leaveType.allocationType === AllocationType.EVENT_BASED
              ? NO_GRANT_MESSAGE
              : INSUFFICIENT_BALANCE_MESSAGE,
          );
        }
        // Atomic increment, not `row.pending + totalDays` — the latter is a
        // read-modify-write against the JS-side value captured before this
        // statement runs, so two concurrent apply() calls for the same
        // employee+leaveType+year (each starting from the same stale read)
        // would each overwrite rather than accumulate, losing one of the
        // two pending holds. Prisma's `increment` compiles to `SET pending
        // = pending + $1`, which Postgres applies against the row's
        // current value under the row lock the UPDATE itself takes, so the
        // second concurrent writer serializes behind the first instead of
        // clobbering it.
        await tx.leaveBalance.updateMany({
          where: { id: row.id, organizationId },
          data: { pending: { increment: totalDays } },
        });
        // The authoritative check, re-read AFTER the hold above — by the
        // time this runs, a concurrent apply() that got here first has
        // already committed its own increment (this UPDATE serialized
        // behind its row lock), so `rowAfterHold.pending` reflects BOTH
        // holds, not the stale pre-hold snapshot the preflight check saw.
        // Passing requestedDays=0 here checks "is the balance still
        // affordable now that this request's own days are already held,"
        // which is the exact same inequality as the preflight check
        // against the pre-hold row (pending appears on both sides of the
        // formula either way) — just evaluated against current data
        // instead of a snapshot two writers could share.
        const rowAfterHold = await tx.leaveBalance.findFirstOrThrow({
          where: { id: row.id, organizationId },
        });
        const affordability = checkAffordability(
          rowAfterHold,
          negativeBalance,
          0,
          today,
          forfeited ?? 0,
        );
        if (!affordability.ok) {
          throw new ForbiddenException(INSUFFICIENT_BALANCE_MESSAGE);
        }
      }

      return tx.leave.create({
        data: {
          organizationId,
          employeeId: actor.id,
          // Point-in-time snapshot — see the schema comment on
          // Leave.departmentId. Set once, here, and never touched again
          // even if the employee is later transferred.
          departmentId: actor.departmentId,
          leaveTypeId: leaveType.id,
          startDate: dto.startDate,
          endDate: dto.endDate,
          isHalfDay: dto.isHalfDay ?? false,
          halfDaySession: dto.halfDaySession,
          totalDays,
          remarks: dto.remarks ?? '',
          attachmentUrl: dto.attachmentUrl,
          editedFromLeaveId: editedFromLeaveId ?? null,
        },
      });
    });

    await this.notifyNewLeaveApplication(created, actor, organizationId);
    return created;
  }

  // Old system notifies the employee's department head, or (if there is
  // none, or the applicant IS the department head) all HR — ported here
  // against reportingManagerId rather than Department.departmentHeadId,
  // since that's the field the review() approval check actually uses in
  // this system.
  private async notifyNewLeaveApplication(
    leave: Leave,
    actor: Actor,
    organizationId: string,
  ) {
    const { dateFormat } = await resolveOrgDateTimeFormat(
      this.scopedPrisma,
      organizationId,
    );
    const title = 'New Leave Application';
    const message = `${actor.name} applied for leave from ${formatDateDisplay(leave.startDate, '', dateFormat)} to ${formatDateDisplay(leave.endDate, '', dateFormat)}.`;

    if (actor.reportingManagerId && actor.reportingManagerId !== actor.id) {
      await this.notificationsService.create({
        organizationId,
        userId: actor.reportingManagerId,
        title,
        message,
        category: NotificationCategory.LEAVE,
        pushKind: 'APPROVAL',
      });
      return;
    }

    const hrUsers = await this.scopedPrisma.user.findMany({
      where: { organizationId, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    await this.notificationsService.createMany(
      hrUsers.map((u) => ({
        organizationId,
        userId: u.id,
        title,
        message,
        category: NotificationCategory.LEAVE,
        pushKind: 'APPROVAL',
      })),
    );
  }

  private async resolveViewTarget(
    employeeIdParam: string | undefined,
    actor: Actor,
    organizationId: string,
  ): Promise<string> {
    if (!employeeIdParam || employeeIdParam === actor.id) return actor.id;
    if (!APPROVE_ROLES.includes(actor.role)) {
      throw new ForbiddenException(
        "You cannot view another employee's leave balance.",
      );
    }
    await assertManagerDeptScope(
      this.scopedPrisma,
      actor,
      organizationId,
      employeeIdParam,
    );
    return employeeIdParam;
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<Leave> {
    const leave = await this.scopedPrisma.leave.findFirst({
      where: { id, organizationId },
    });
    if (!leave) throw new NotFoundException('Leave request not found.');
    return leave;
  }
}
