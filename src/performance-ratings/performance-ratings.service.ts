// Purpose: Manages per-employee, per-financial-year PerformanceRating rows used to scale variable pay.
// Responsibilities: Owns the upsert-by-(employee, financialYear) rule, MANAGER-can-only-rate-own-department
// authorization, and the no-override rule that keeps ADMIN/HR from originating a rating for a managed
// employee; payoutPercentage set here is later read by PayrollService.calculatePayroll to scale non-monthly
// earning components. A MANAGER's write only ever reaches SUBMITTED — it stays invisible to the employee
// (no notification/email/timeline) until an ADMIN/HR approve()s it via publishRating(). ADMIN/HR can only
// write directly through upsert() (publishing instantly, status APPROVED) for an employee who has no
// reportingManagerId at all — once a manager is assigned, ADMIN/HR's role narrows to approve()/reject()
// only, no override.
import { deptScopedEmployeeIds, inReviewerScope, isScopedReviewer } from '../common/dept-scope';
import { payoutForRating } from './rating-payout';
import { markPayrollStaleForFinancialYear } from '../payroll/payroll-period-guard';
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
  NotificationCategory,
  PerformanceRating,
  PerformanceRatingStatus,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertPerformanceRatingDto } from './dto/upsert-performance-rating.dto';
import { QueryPerformanceRatingDto } from './dto/query-performance-rating.dto';
import { ApprovePerformanceRatingDto } from './dto/approve-performance-rating.dto';
import { RejectPerformanceRatingDto } from './dto/reject-performance-rating.dto';
import { paginate, skip } from '../common/pagination';
import { assertNotSelfApproval } from '../common/dept-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';

type Actor = Omit<User, 'password'>;

@Injectable()
export class PerformanceRatingsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async findAll(
    query: QueryPerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.PerformanceRatingWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      // Self-only, and only ever a published (APPROVED) rating — a
      // SUBMITTED-but-not-yet-approved rating is exactly what the no-
      // override rule keeps hidden from the employee until HR/Admin
      // approves it; publishRating() is what actually notifies them.
      // Force-overridden regardless of what the caller passed, same
      // "never trust the query for self-scoping" convention as every
      // other self-service list endpoint in this codebase.
      where.employeeId = actor.id;
      where.status = PerformanceRatingStatus.APPROVED;
    } else if (await isScopedReviewer(this.scopedPrisma, actor, organizationId)) {
      // The departments they head and their reporting line (see reviewerScope).
      const deptEmployeeIds = new Set(
        await deptScopedEmployeeIds(this.scopedPrisma, actor, organizationId),
      );
      where.employeeId =
        query.employeeId && deptEmployeeIds.has(query.employeeId)
          ? query.employeeId
          : { in: [...deptEmployeeIds] };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.financialYear) where.financialYear = query.financialYear;
    // EMPLOYEE's status is force-set above and must never be widened back
    // to SUBMITTED/REJECTED by a query param.
    if (query.status && actor.role !== Role.EMPLOYEE)
      where.status = query.status;

    return paginate(
      () =>
        this.scopedPrisma.performanceRating.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            // Who gave the rating, so a self-rating (an Admin may rate themselves) is visible as such.
            ratedBy: { select: { id: true, name: true } },
          },
          orderBy: [...EMPLOYEE_RELATION_ORDER_BY, { financialYear: 'desc' }],
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.performanceRating.count({ where }),
      query.page,
      query.limit,
    );
  }

  // Runs the notification + email + timeline entry that makes a rating
  // visible to the employee — shared by upsert()-as-HR/Admin (instant
  // publish) and approve() (publish of a manager-submitted rating).
  private async publishRating(
    rating: PerformanceRating,
    organizationId: string,
    actorId: string,
    actionLabel:
      | 'PERFORMANCE_RATING_CREATED'
      | 'PERFORMANCE_RATING_UPDATED'
      | 'PERFORMANCE_RATING_APPROVED',
  ): Promise<void> {
    // The published payout percentage scales this employee's variable pay: their calculated payrolls for the year are out of date.
    await markPayrollStaleForFinancialYear(this.scopedPrisma, organizationId, rating.financialYear, { employeeId: rating.employeeId });
    await this.auditLogService.log({
      actorId,
      action: actionLabel,
      module: 'EMPLOYEE',
      organizationId,
      targetId: rating.id,
      details: {
        employeeId: rating.employeeId,
        financialYear: rating.financialYear,
        rating: rating.rating,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: rating.employeeId,
      eventKey: 'PERFORMANCE_REVIEW',
      performedById: actorId,
      description: `Performance rating for FY ${rating.financialYear} recorded: ${rating.rating}.`,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: rating.employeeId, organizationId },
    });
    if (employee) {
      const title = 'Performance Rating Published';
      const message = `Your performance rating for FY ${rating.financialYear} has been published: ${rating.rating}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'PERFORMANCE_RATING_PUBLISHED',
        {
          employeeName: employee.name,
          financialYear: rating.financialYear,
          rating: String(rating.rating),
        },
        { subject: title, html: message },
      );
      // Fire-and-forget — the approve()/reject()/direct-upsert has already
      // committed, so the actor's click shouldn't wait on an SMTP/API round
      // trip to feel instant.
      void this.emailService.send({
        organizationId,
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    }
  }

  async upsert(
    dto: UpsertPerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
      include: { reportingManager: { select: { role: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    // A rating is for a financial year that has started: not a future one.
    const settings = await this.scopedPrisma.payrollSettings.findFirst({
      where: { organizationId },
      select: { financialYearStartMonth: true },
    });
    const now = new Date();
    const currentFy = getFinancialYear(
      now.getUTCMonth() + 1,
      now.getUTCFullYear(),
      settings?.financialYearStartMonth ?? 4,
    );
    if (dto.financialYear > currentFy) {
      throw new BadRequestException(
        `A rating cannot be given for FY ${dto.financialYear} - that financial year has not started yet (current: ${currentFy}).`,
      );
    }

    if (actor.role === Role.MANAGER) {
      if (employee.id === actor.id) {
        throw new ForbiddenException('You cannot rate yourself.');
      }
      if (!(await inReviewerScope(this.scopedPrisma, actor, organizationId, employee.id))) {
        throw new ForbiddenException(
          'You may only rate employees who report to you.',
        );
      }
    } else if (employee.id === actor.id && actor.role !== Role.ADMIN) {
      // HR rating themselves would publish the rating (and its variable-pay percentage) with nobody else involved; the
      // same rule as approving your own request. An Admin has nobody above them, so may.
      throw new ForbiddenException('You cannot rate yourself. Ask an Admin or another HR user.');
    } else if (
      actor.role === Role.HR &&
      !(await inReviewerScope(this.scopedPrisma, actor, organizationId, employee.id))
    ) {
      throw new ForbiddenException(
        'You may only rate employees who report to you.',
      );
    }
    // ADMIN and HR may rate, and may change a rating, for any employee in their scope, including one whose reporting manager is a MANAGER: the
    // manager submits a rating for review, and Admin/HR can approve it, reject it, or change it (see the "reviewer change" below). (An earlier rule
    // stopped Admin/HR from rating anyone who has a manager; with no screen for the manager to submit it, nobody could rate those employees at all.)

    const existing = await this.scopedPrisma.performanceRating.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        financialYear: dto.financialYear,
      },
    });

    // A reviewer (Admin/HR) changing a rating that already exists - still waiting on review, or already decided - is a deliberate change that is
    // published and audited with the old and new values (below); it is not a silent overwrite. A MANAGER can only correct their own submission.
    const reviewerChange = actor.role !== Role.MANAGER && !!existing;

    // A MANAGER's write only ever reaches SUBMITTED — it stays invisible to
    // the employee until ADMIN/HR approve()s it. ADMIN/HR writing directly
    // (only reachable for an employee with no manager assigned, per the
    // check above) publishes instantly (status APPROVED), same as before
    // this feature.
    const status =
      actor.role === Role.MANAGER
        ? PerformanceRatingStatus.SUBMITTED
        : PerformanceRatingStatus.APPROVED;

    const data = {
      ...(reviewerChange
        ? { approvedById: actor.id, approvedAt: new Date() }
        : {}),
      rating: dto.rating,
      // Follows the rating (rating-payout.ts); a payout sent with it is not used.
      payoutPercentage: payoutForRating(dto.rating),
      notes: dto.notes ?? '',
      // On a reviewer's change the original rater (for example the manager) stays on the record; the reviewer is recorded as approver.
      ratedById: reviewerChange ? (existing?.ratedById ?? actor.id) : actor.id,
      status,
    };

    let rating: PerformanceRating;
    if (existing) {
      await this.scopedPrisma.performanceRating.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      rating = await this.scopedPrisma.performanceRating.findFirstOrThrow({
        where: { id: existing.id, organizationId },
      });
    } else {
      rating = await this.scopedPrisma.performanceRating.create({
        data: {
          organizationId,
          employeeId: dto.employeeId,
          financialYear: dto.financialYear,
          ...data,
        },
      });
    }

    if (status === PerformanceRatingStatus.APPROVED) {
      await this.publishRating(
        rating,
        organizationId,
        actor.id,
        existing ? 'PERFORMANCE_RATING_UPDATED' : 'PERFORMANCE_RATING_CREATED',
      );
      if (reviewerChange && existing) {
        await this.auditLogService.log({
          actorId: actor.id,
          action: 'PERFORMANCE_RATING_CHANGED_BY_REVIEWER',
          module: 'EMPLOYEE',
          organizationId,
          targetId: rating.id,
          details: {
            employeeId: dto.employeeId,
            financialYear: dto.financialYear,
            previousRating: existing.rating,
            previousStatus: existing.status,
            newRating: rating.rating,
          },
        });
      }
    } else {
      // SUBMITTED by a manager — not yet visible to the employee, so only
      // an audit trail entry is recorded, no notification/email/timeline.
      await this.auditLogService.log({
        actorId: actor.id,
        action: existing
          ? 'PERFORMANCE_RATING_UPDATED'
          : 'PERFORMANCE_RATING_CREATED',
        module: 'EMPLOYEE',
        organizationId,
        targetId: rating.id,
        details: {
          employeeId: dto.employeeId,
          financialYear: dto.financialYear,
          rating: dto.rating,
          status,
        },
      });
    }

    return rating;
  }

  async approve(
    id: string,
    dto: ApprovePerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const existing = await this.scopedPrisma.performanceRating.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Performance rating not found.');
    if (existing.status !== PerformanceRatingStatus.SUBMITTED) {
      throw new BadRequestException('Only a submitted rating can be approved.');
    }
    assertNotSelfApproval(actor, existing.employeeId);

    // Guarded compare-and-swap — see LoansService.approve()'s comment for
    // the general reasoning.
    const { count } = await this.scopedPrisma.performanceRating.updateMany({
      where: {
        id,
        organizationId,
        status: PerformanceRatingStatus.SUBMITTED,
      },
      data: {
        rating: dto.rating ?? existing.rating,
        payoutPercentage: payoutForRating(dto.rating ?? existing.rating),
        status: PerformanceRatingStatus.APPROVED,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This rating was already reviewed — please refresh and try again.',
      );
    }
    const rating = await this.scopedPrisma.performanceRating.findFirstOrThrow({
      where: { id, organizationId },
    });

    await this.publishRating(
      rating,
      organizationId,
      actor.id,
      'PERFORMANCE_RATING_APPROVED',
    );

    return rating;
  }

  async reject(
    id: string,
    dto: RejectPerformanceRatingDto,
    actor: Actor,
    organizationId: string,
  ) {
    const existing = await this.scopedPrisma.performanceRating.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Performance rating not found.');
    if (existing.status !== PerformanceRatingStatus.SUBMITTED) {
      throw new BadRequestException('Only a submitted rating can be rejected.');
    }
    assertNotSelfApproval(actor, existing.employeeId);

    // Guarded compare-and-swap — see LoansService.approve()'s comment for
    // the general reasoning.
    const { count } = await this.scopedPrisma.performanceRating.updateMany({
      where: {
        id,
        organizationId,
        status: PerformanceRatingStatus.SUBMITTED,
      },
      data: {
        status: PerformanceRatingStatus.REJECTED,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new ConflictException(
        'This rating was already reviewed — please refresh and try again.',
      );
    }
    const rating = await this.scopedPrisma.performanceRating.findFirstOrThrow({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'PERFORMANCE_RATING_REJECTED',
      module: 'EMPLOYEE',
      organizationId,
      targetId: rating.id,
      details: {
        employeeId: rating.employeeId,
        financialYear: rating.financialYear,
        reason: dto.reason ?? '',
      },
    });

    return rating;
  }
}
