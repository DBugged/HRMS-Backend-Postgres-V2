// Purpose: Manages per-employee, per-financial-year PerformanceRating rows used to scale variable pay.
// Responsibilities: Owns the upsert-by-(employee, financialYear) rule and MANAGER-can-only-rate-own-department
// authorization; payoutPercentage set here is later read by PayrollService.calculatePayroll to scale
// non-monthly earning components. A MANAGER's write only ever reaches SUBMITTED — it stays invisible to the
// employee (no notification/email/timeline) until an ADMIN/HR approve()s it via publishRating(); ADMIN/HR
// writing directly through upsert() publishes instantly, same as Loans' HR-direct-create path.
import {
  BadRequestException,
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

    if (actor.role === Role.MANAGER) {
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
    }
    if (query.financialYear) where.financialYear = query.financialYear;
    if (query.status) where.status = query.status;

    return paginate(
      () =>
        this.scopedPrisma.performanceRating.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { financialYear: 'desc' },
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
      await this.emailService.send({
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
    if (actor.role === Role.MANAGER) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: dto.employeeId, organizationId },
      });
      if (!employee || employee.departmentId !== actor.departmentId) {
        throw new ForbiddenException(
          'You may only rate employees in your own department.',
        );
      }
    }

    const existing = await this.scopedPrisma.performanceRating.findFirst({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        financialYear: dto.financialYear,
      },
    });

    // A MANAGER's write only ever reaches SUBMITTED — it stays invisible to
    // the employee until ADMIN/HR approve()s it. ADMIN/HR writing directly
    // publishes instantly (status APPROVED), same as before this feature.
    const status =
      actor.role === Role.MANAGER
        ? PerformanceRatingStatus.SUBMITTED
        : PerformanceRatingStatus.APPROVED;

    const data = {
      rating: dto.rating,
      payoutPercentage: dto.payoutPercentage ?? 100,
      notes: dto.notes ?? '',
      ratedById: actor.id,
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

    await this.scopedPrisma.performanceRating.updateMany({
      where: { id, organizationId },
      data: {
        rating: dto.rating ?? existing.rating,
        payoutPercentage: dto.payoutPercentage ?? existing.payoutPercentage,
        status: PerformanceRatingStatus.APPROVED,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });
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

    await this.scopedPrisma.performanceRating.updateMany({
      where: { id, organizationId },
      data: {
        status: PerformanceRatingStatus.REJECTED,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });
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
