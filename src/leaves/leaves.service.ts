// Purpose: End-to-end leave lifecycle — apply, edit, single/two-level review, cancel — and its balance and
// attendance side effects.
// Responsibilities: Owns rule validation (via leave-rules/leave-balance-check), the pending/availed balance
// hold-and-release dance (createLeaveInternal/releaseHold), and orchestrates AttendanceService
// (write/revert attendance for approved leave), CompOffService (consume/release for COMPOFF-type leave),
// and ApprovalDelegationService (stand-in reviewer support) — none of those own their own side of this flow.
// Important: review() implements a two-level workflow where a MANAGER's approval on a 2-level leave type
// only records level-1 sign-off (status stays PENDING); only ADMIN/HR can give final approval. releaseHold()
// is the single place that reverses whatever a leave's current status implied, shared by update() and cancel().
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AllocationType,
  Leave,
  LeaveStatus,
  LeaveType,
  NotificationCategory,
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
import { checkLeaveRules, LeaveRules } from './leave-rules';
import {
  resolveShiftConfig,
  OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import { checkAffordability, NegativeBalanceRule } from './leave-balance-check';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  assertNotSelfApproval,
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

type Actor = Omit<User, 'password'>;

// The only two actions LeaveTypesService.runAccrual/runCarryForward ever
// write — same fixed list the old system's getCreditHistory filtered on.
const CREDIT_HISTORY_ACTIONS = ['LEAVE_ACCRUAL_RUN', 'LEAVE_CARRYFORWARD_RUN'];

// Old system's LEAVE_APPROVE_ROLES / LEAVE_VIEW_ROLES both collapse to this
// set — see the Batch 4b plan's role-mapping note.
const APPROVE_ROLES: Role[] = [Role.ADMIN, Role.HR, Role.MANAGER];
// Old system's LEAVE_CONFIG_ROLES — HR override for cancellation.
const CANCEL_OVERRIDE_ROLES: Role[] = [Role.ADMIN, Role.HR];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveLeaveYear(startDate: string): number {
  return Number(startDate.slice(0, 4));
}

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
            leaveType: { select: { id: true, name: true, code: true } },
          },
          orderBy: { createdAt: 'desc' },
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
        leaveType: { id: string; name: string; code: string };
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
          },
        });
      }
      return rows;
    });

    const compOffAvailable = await this.compOffService.available(
      targetEmployeeId,
      organizationId,
    );

    return { balances, compOffAvailable };
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
      orderBy: { startDate: 'asc' },
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

    assertNotSelfApproval(actor, leave.employeeId);

    if (actor.role === Role.MANAGER) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: leave.employeeId, organizationId },
      });
      const managerId = employee?.reportingManagerId ?? null;
      const isDirectManager = managerId === actor.id;
      // An active ApprovalDelegation lets a stand-in reviewer act in the
      // employee's actual manager's place for a date range (e.g. the
      // manager themself is on leave) — ported from the old system's
      // identical inline check in leaveController.js.
      const isDelegate =
        !isDirectManager &&
        managerId !== null &&
        (await this.delegationService.isActiveDelegate(
          managerId,
          actor.id,
          organizationId,
          todayStr(),
        ));
      if (!isDirectManager && !isDelegate) {
        throw new ForbiddenException(
          'You can only review leave requests from employees who report to you (or whose manager has delegated to you).',
        );
      }
    }

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

    await this.scopedPrisma.$transaction(async (tx) => {
      // status: PENDING re-asserted here (not just in the pre-transaction
      // check above) so a second concurrent review() call — double-click,
      // or a retried request — can't slip past the earlier check (which
      // ran outside any lock) and re-apply the balance/attendance/comp-off
      // side effects below a second time. count === 0 means another
      // review already won the race; bail out instead of double-crediting
      // or double-debiting.
      const { count } = await tx.leave.updateMany({
        where: { id, organizationId, status: LeaveStatus.PENDING },
        data: {
          status: dto.decision,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewComments: dto.comments ?? '',
        },
      });
      if (count === 0) {
        throw new ConflictException('This leave request was already reviewed.');
      }

      if (dto.decision === 'APPROVED') {
        await this.attendanceService.writeAttendanceForApprovedLeave(
          tx,
          leave,
          organizationId,
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

    await this.notifyLeaveDecision(leave, dto, organizationId);
    return this.findByIdOrThrow(id, organizationId);
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
    await this.emailService.send({
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
    const data: Prisma.LeaveBalanceUpdateManyMutationInput = {};
    if (leave.status === LeaveStatus.APPROVED) {
      data.availed = { decrement: leave.totalDays };
    } else {
      data.pending = { decrement: leave.totalDays };
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

    const rules = leaveType.rules as unknown as LeaveRules;
    const ruleResult = checkLeaveRules(
      rules,
      {
        startDate: dto.startDate,
        endDate: dto.endDate,
        isHalfDay: dto.isHalfDay ?? false,
        hasAttachment: !!dto.attachmentUrl,
      },
      {
        today: todayStr(),
        holidayDates: new Set(holidays.map((h) => h.date)),
        weeklyOffs,
        priorLeaveEndDate: priorLeaveOfType?.endDate ?? null,
        existingRanges: otherLeaves.map((l) => ({
          start: l.startDate,
          end: l.endDate,
        })),
        documentsRequired: leaveType.documentsRequired,
        documentRequiredAfterDays: leaveType.documentRequiredAfterDays,
      },
    );
    if (!ruleResult.ok) {
      throw new BadRequestException(ruleResult.errors.join(' '));
    }
    const totalDays = ruleResult.totalDays;

    if (isCompOffType(leaveType)) {
      const available = await this.compOffService.available(
        actor.id,
        organizationId,
      );
      if (available < totalDays) {
        throw new ForbiddenException('Insufficient comp-off balance.');
      }
    }

    const created = await this.scopedPrisma.$transaction(async (tx) => {
      if (!isCompOffType(leaveType) && !isUnbalancedType(leaveType)) {
        const year = deriveLeaveYear(dto.startDate);
        const negativeBalance =
          leaveType.negativeBalance as unknown as NegativeBalanceRule;
        const row = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          actor.id,
          leaveType.id,
          year,
          organizationId,
        );
        const affordability = checkAffordability(
          row,
          negativeBalance,
          totalDays,
          todayStr(),
        );
        if (!affordability.ok) {
          throw new ForbiddenException('Insufficient leave balance.');
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
      }

      return tx.leave.create({
        data: {
          organizationId,
          employeeId: actor.id,
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
