// Purpose: Lets an employee request encashment of unused leave for cash, and lets a reviewer approve/reject it.
// Responsibilities: Owns request-time eligibility/limit checks against the leave type's `encashment` rule
// and rate calculation (current BASIC monthly value via EmployeeSalaryComponentsService, converted with
// dailyRateFromMonthly); delegates the actual balance debit to LeaveBalanceService.
// Important: request() reserves a hold in LeaveBalance.pending (same mechanism leave application uses via
// checkAffordability) so two different pending encashment requests can no longer jointly overdraw the same
// balance. review() converts that hold into an actual `encashed` deduction on APPROVED; it guards against
// being replayed (a compare-and-swap status check inside the transaction) so a double-click or retried
// request can't double-deduct.
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
  LeaveEncashmentStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { EmployeeSalaryComponentsService } from '../employee-salary-components/employee-salary-components.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { localDateStr } from '../employee-salary-components/salary-structure-math';
import { RequestLeaveEncashmentDto } from './dto/request-leave-encashment.dto';
import { ReviewLeaveEncashmentDto } from './dto/review-leave-encashment.dto';
import { QueryLeaveEncashmentDto } from './dto/query-leave-encashment.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import { dailyRateFromMonthly } from '../payroll/payroll-date-math';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { getOrgLeaveSwitches } from '../organizations/org-leave-switches';

type Actor = Omit<User, 'password'>;

interface EncashmentRule {
  allowed?: boolean;
  maxDaysPerYear?: number;
  minBalanceToRetain?: number;
}

@Injectable()
export class LeaveEncashmentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async findAll(
    query: QueryLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.LeaveEncashmentWhereInput = { organizationId };

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
        // "My Leave"'s encashment section) instead of the whole
        // department — never widens it: the requested id must already be
        // within the manager's own dept scope, same boundary the
        // unfiltered branch below enforces.
        if (!deptIds.includes(query.employeeId)) {
          throw new ForbiddenException(
            "Not authorized to view this employee's leave encashments.",
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
        this.scopedPrisma.leaveEncashment.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            leaveType: { select: { id: true, name: true, code: true } },
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { createdAt: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.leaveEncashment.count({ where }),
      query.page,
      query.limit,
    );
  }

  // Company-wide switch (Organization Settings → Policies) overrides every
  // leave type's own Encashment setting while it's off. Blocks new requests
  // and approvals; an already-approved request can still be marked
  // Processed (paid), and pending ones wait until it's switched back on.
  private async assertOrgAllowsEncashment(organizationId: string) {
    const { allowLeaveEncashment } = await getOrgLeaveSwitches(
      this.scopedPrisma,
      organizationId,
    );
    if (!allowLeaveEncashment) {
      throw new BadRequestException(
        'Leave encashment is turned off for the whole organization.',
      );
    }
  }

  async request(
    dto: RequestLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: dto.leaveType, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    await this.assertOrgAllowsEncashment(organizationId);
    const rule = (leaveType.encashment ?? {}) as EncashmentRule;
    if (!rule.allowed) {
      throw new BadRequestException(
        `${leaveType.name} does not allow encashment.`,
      );
    }
    if (rule.maxDaysPerYear && dto.days > rule.maxDaysPerYear) {
      throw new BadRequestException(
        `Cannot encash more than ${rule.maxDaysPerYear} day(s) per year for this leave type.`,
      );
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    return this.scopedPrisma
      .$transaction(async (tx) => {
        // Row-lock the requester's own User row so two concurrent request()
        // calls for the same employee serialize instead of both reading the
        // same pre-transaction balance snapshot — same pattern as
        // LeavesService.createLeaveInternal's apply() lock, for the same
        // reason: without it, two requests each affordable alone could both
        // pass the check below and jointly overdraw the balance.
        await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${actor.id} FOR UPDATE`;
        const balanceRow = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          actor.id,
          leaveType.id,
          year,
          organizationId,
        );
        const minRetain = rule.minBalanceToRetain ?? 0;
        // `pending` (this employee's other open encashment/leave holds on
        // this leave type) is subtracted here, same as leave application's
        // checkAffordability — closing alone ignores holds not yet decided.
        const available = balanceRow.closing - balanceRow.pending;
        if (!dto.days || dto.days > available - minRetain) {
          throw new BadRequestException(
            `Cannot encash more than ${Math.max(0, available - minRetain)} day(s) (must retain ${minRetain}).`,
          );
        }
        // Reserve the hold now, under the row lock above, so a second
        // concurrent request for this employee+leaveType sees it via
        // `pending` rather than the pre-hold snapshot.
        await tx.leaveBalance.updateMany({
          where: { id: balanceRow.id, organizationId },
          data: { pending: { increment: dto.days } },
        });

        const org = await tx.organization.findFirst({
          where: { id: organizationId },
          select: { timezone: true },
        });
        const currentBasic =
          await this.employeeSalaryComponentsService.getCurrentMonthlyValue(
            actor.id,
            SALARY_COMPONENT_CODES.BASIC,
            localDateStr(org?.timezone ?? 'Asia/Kolkata', now),
            organizationId,
          );
        const ratePerDay = dailyRateFromMonthly(currentBasic);
        const settings =
          await this.payrollSettingsService.getOrCreate(organizationId);
        const financialYear = getFinancialYear(
          month,
          year,
          settings.financialYearStartMonth,
        );

        return tx.leaveEncashment.create({
          data: {
            organizationId,
            employeeId: actor.id,
            leaveTypeId: leaveType.id,
            days: dto.days,
            ratePerDay,
            amount: Math.round(ratePerDay * dto.days),
            financialYear,
          },
        });
      })
      .then(async (encashment) => {
        await this.auditLogService.log({
          actorId: actor.id,
          action: 'LEAVE_ENCASHMENT_REQUESTED',
          module: 'LEAVE',
          organizationId,
          targetId: encashment.id,
          details: {
            employeeId: actor.id,
            days: dto.days,
            amount: encashment.amount,
          },
        });
        await this.timelineService.logEvent({
          organizationId,
          employeeId: actor.id,
          eventKey: 'LEAVE_ENCASHMENT_REQUESTED',
          performedById: actor.id,
          description: `Requested encashment of ${dto.days} day(s).`,
        });
        return encashment;
      });
  }

  // Single-level review, matching Overtime — no "already reviewed" guard,
  // ported as-is (the old controller allows re-targeting APPROVED<->PROCESSED
  // freely).
  async review(
    id: string,
    dto: ReviewLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const row = await this.scopedPrisma.leaveEncashment.findFirst({
      where: { id, organizationId },
    });
    if (!row)
      throw new NotFoundException('Leave encashment request not found.');
    await assertManagerDeptScope(
      this.scopedPrisma,
      actor,
      organizationId,
      row.employeeId,
    );

    // PENDING -> APPROVED -> PROCESSED — the only two legal transitions
    // this endpoint drives (see ReviewLeaveEncashmentDto). Required so the
    // guarded update below only matches a row that's actually eligible
    // for the requested transition.
    if (dto.status === LeaveEncashmentStatus.APPROVED) {
      await this.assertOrgAllowsEncashment(organizationId);
    }

    const requiredCurrentStatus: LeaveEncashmentStatus =
      dto.status === LeaveEncashmentStatus.APPROVED
        ? LeaveEncashmentStatus.PENDING
        : LeaveEncashmentStatus.APPROVED;

    const result = await this.scopedPrisma.$transaction(async (tx) => {
      // Re-asserts requiredCurrentStatus in the `where` (not just a
      // separate JS check beforehand) — a second concurrent review() call
      // (double-click Approve, or a retried request) would otherwise
      // still pass an outside-the-transaction status check and re-run the
      // balance deduction below a second time for one approval. count ===
      // 0 means another review already won the race.
      const { count } = await tx.leaveEncashment.updateMany({
        where: { id, organizationId, status: requiredCurrentStatus },
        data: { status: dto.status, approvedById: actor.id },
      });
      if (count === 0) {
        throw new ConflictException(
          'This leave encashment request was already reviewed.',
        );
      }

      // Converts request()'s hold into an actual deduction: releases the
      // `pending` reserved at request time and moves it into `encashed`.
      if (dto.status === LeaveEncashmentStatus.APPROVED && row.leaveTypeId) {
        const year = new Date().getFullYear();
        const balanceRow = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          row.employeeId,
          row.leaveTypeId,
          year,
          organizationId,
        );
        // Atomic increment/decrement (not JS-computed stale values) — see
        // the guarded updateMany above for why a second call can no longer
        // reach this point at all, but this still closes the gap against
        // any other concurrent writer of the same balance row (e.g. a
        // simultaneous accrual run).
        await tx.leaveBalance.updateMany({
          where: { id: balanceRow.id, organizationId },
          data: {
            encashed: { increment: row.days },
            pending: { decrement: row.days },
          },
        });
        await this.leaveBalanceService.recalculate(
          tx,
          balanceRow.id,
          organizationId,
        );
      }

      return tx.leaveEncashment.findFirstOrThrow({
        where: { id, organizationId },
      });
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LEAVE_ENCASHMENT_REVIEWED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: { employeeId: row.employeeId, status: dto.status },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: row.employeeId,
      eventKey: 'LEAVE_ENCASHMENT_REVIEWED',
      performedById: actor.id,
      description: `Leave encashment request ${dto.status.toLowerCase()}.`,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: row.employeeId, organizationId },
    });
    if (employee) {
      const title = `Leave Encashment Request ${dto.status}`;
      const message = `Your leave encashment request for ${row.days} day(s) (${row.amount}) has been ${dto.status.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.LEAVE,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'LEAVE_ENCASHMENT_STATUS',
        {
          employeeName: employee.name,
          days: String(row.days),
          amount: String(row.amount),
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

    return result;
  }
}
