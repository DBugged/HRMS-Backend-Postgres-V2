// Purpose: Manages per-employee, per-financial-year PerformanceRating rows used to scale variable pay.
// Responsibilities: Owns the upsert-by-(employee, financialYear) rule and MANAGER-can-only-rate-own-department
// authorization; payoutPercentage set here is later read by PayrollService.calculatePayroll to scale
// non-monthly earning components.
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  NotificationCategory,
  PerformanceRating,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertPerformanceRatingDto } from './dto/upsert-performance-rating.dto';
import { QueryPerformanceRatingDto } from './dto/query-performance-rating.dto';
import { paginate, skip } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
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

    return paginate(
      () =>
        this.scopedPrisma.performanceRating.findMany({
          where,
          orderBy: { financialYear: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.performanceRating.count({ where }),
      query.page,
      query.limit,
    );
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

    const data = {
      rating: dto.rating,
      payoutPercentage: dto.payoutPercentage ?? 100,
      notes: dto.notes ?? '',
      ratedById: actor.id,
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
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: dto.employeeId,
      eventKey: 'PERFORMANCE_REVIEW',
      performedById: actor.id,
      description: `Performance rating for FY ${dto.financialYear} recorded: ${dto.rating}.`,
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (employee) {
      const title = 'Performance Rating Published';
      const message = `Your performance rating for FY ${dto.financialYear} has been published: ${dto.rating}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return rating;
  }
}
