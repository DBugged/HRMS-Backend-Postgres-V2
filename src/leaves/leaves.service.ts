import {
  BadRequestException,
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
import { CompOffService } from '../comp-offs/comp-off.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ApplyLeaveDto } from './dto/apply-leave.dto';
import { UpdateLeaveDto } from './dto/update-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { ListLeavesQueryDto } from './dto/list-leaves-query.dto';
import { TeamCalendarQueryDto } from './dto/team-calendar-query.dto';
import { checkLeaveRules, LeaveRules } from './leave-rules';
import { checkAffordability, NegativeBalanceRule } from './leave-balance-check';
import { paginate } from '../common/pagination';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { ApprovalDelegationService } from '../approval-delegation/approval-delegation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { AuditLogService } from '../audit-log/audit-log.service';

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
  return (
    leaveType.code === 'COMPOFF' ||
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
        this.scopedPrisma.leave.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            leaveType: { select: { id: true, name: true, code: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
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
        lt.code !== 'COMPOFF' &&
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
      await this.releaseHold(tx, existing, organizationId);
      await tx.leave.updateMany({
        where: { id, organizationId },
        data: { status: LeaveStatus.CANCELLED },
      });
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
      await tx.leave.updateMany({
        where: { id, organizationId },
        data: {
          status: dto.decision,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewComments: dto.comments ?? '',
        },
      });

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
        } else if (leaveType.allocationType !== AllocationType.UNLIMITED) {
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
            data: {
              pending: row.pending - leave.totalDays,
              availed: row.availed + leave.totalDays,
            },
          });
          await this.leaveBalanceService.recalculate(
            tx,
            row.id,
            organizationId,
          );
        }
      } else if (
        !isCompOffType(leaveType) &&
        leaveType.allocationType !== AllocationType.UNLIMITED
      ) {
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
          data: { pending: row.pending - leave.totalDays },
        });
        await this.leaveBalanceService.recalculate(tx, row.id, organizationId);
      }
    });

    await this.notifyLeaveDecision(leave, dto, organizationId);
    return this.findByIdOrThrow(id, organizationId);
  }

  private async notifyLevel1Approved(leave: Leave, organizationId: string) {
    const hrUsers = await this.scopedPrisma.user.findMany({
      where: { organizationId, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    await this.notificationsService.createMany(
      hrUsers.map((u) => ({
        organizationId,
        userId: u.id,
        title: 'Leave Application Pending Final Approval',
        message: `A leave request (${leave.startDate} to ${leave.endDate}) has been level-1 approved and needs your final decision.`,
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

    const title = `Leave Request ${dto.decision}`;
    const message = `Your leave request from ${leave.startDate} to ${leave.endDate} has been ${dto.decision.toLowerCase()}.${dto.comments ? ` Comments: ${dto.comments}` : ''}`;

    await this.notificationsService.create({
      organizationId,
      userId: employee.id,
      title,
      message,
      category: NotificationCategory.LEAVE,
    });

    await this.emailService.send({
      to: employee.email,
      subject: title,
      html: message,
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
      await this.releaseHold(tx, leave, organizationId);
      await tx.leave.updateMany({
        where: { id, organizationId },
        data: { status: LeaveStatus.CANCELLED },
      });
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
    if (leaveType.allocationType === AllocationType.UNLIMITED) return;

    const year = deriveLeaveYear(leave.startDate);
    const row = await this.leaveBalanceService.ensureBalanceRow(
      tx,
      leave.employeeId,
      leave.leaveTypeId,
      year,
      organizationId,
    );

    const data: Prisma.LeaveBalanceUpdateManyMutationInput = {};
    if (leave.status === LeaveStatus.APPROVED) {
      data.availed = row.availed - leave.totalDays;
    } else {
      data.pending = row.pending - leave.totalDays;
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

    const [holidays, priorLeaveOfType, otherLeaves] = await Promise.all([
      this.scopedPrisma.holiday.findMany({
        where: { organizationId },
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
    ]);

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
      if (
        !isCompOffType(leaveType) &&
        leaveType.allocationType !== AllocationType.UNLIMITED
      ) {
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
        await tx.leaveBalance.updateMany({
          where: { id: row.id, organizationId },
          data: { pending: row.pending + totalDays },
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
    const title = 'New Leave Application';
    const message = `${actor.name} applied for leave from ${leave.startDate} to ${leave.endDate}.`;

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
