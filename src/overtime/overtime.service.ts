import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationCategory,
  OvertimeStatus,
  OvertimeType,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LogOvertimeDto } from './dto/log-overtime.dto';
import { ReviewOvertimeDto } from './dto/review-overtime.dto';
import { QueryOvertimeDto } from './dto/query-overtime.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

type Actor = Omit<User, 'password'>;

// Derived server-side from `type`, never client-supplied.
const RATE_MULTIPLIERS: Record<OvertimeType, number> = {
  [OvertimeType.REGULAR]: 1.5,
  [OvertimeType.HOLIDAY]: 2,
  [OvertimeType.WEEKEND]: 2,
  [OvertimeType.NIGHT]: 1.75,
};

function monthRange(month: number, year: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

@Injectable()
export class OvertimeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  async log(dto: LogOvertimeDto, actor: Actor, organizationId: string) {
    const type = dto.type ?? OvertimeType.REGULAR;
    return this.scopedPrisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: actor.id,
        date: dto.date,
        hours: dto.hours,
        type,
        rateMultiplier: RATE_MULTIPLIERS[type],
      },
    });
  }

  async findAll(query: QueryOvertimeDto, actor: Actor, organizationId: string) {
    const where: Prisma.OvertimeRecordWhereInput = { organizationId };

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
    if (query.month && query.year) {
      const { from, to } = monthRange(query.month, query.year);
      where.date = { gte: from, lte: to };
    }

    return paginate(
      () =>
        this.scopedPrisma.overtimeRecord.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { date: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.overtimeRecord.count({ where }),
      query.page,
      query.limit,
    );
  }

  async review(
    id: string,
    dto: ReviewOvertimeDto,
    actor: Actor,
    organizationId: string,
  ) {
    const record = await this.scopedPrisma.overtimeRecord.findFirst({
      where: { id, organizationId },
    });
    if (!record) throw new NotFoundException('Overtime record not found.');
    await assertManagerDeptScope(
      this.scopedPrisma,
      actor,
      organizationId,
      record.employeeId,
    );
    if (record.status !== OvertimeStatus.PENDING) {
      throw new BadRequestException(
        'This overtime record has already been reviewed.',
      );
    }

    await this.scopedPrisma.overtimeRecord.updateMany({
      where: { id, organizationId },
      data: { status: dto.status, approvedById: actor.id },
    });

    const updated = await this.scopedPrisma.overtimeRecord.findFirstOrThrow({
      where: { id, organizationId },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: record.employeeId, organizationId },
    });
    if (employee) {
      const title = `Overtime Request ${dto.status}`;
      const message = `Your overtime of ${record.hours} hour(s) on ${record.date} has been ${dto.status.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.ATTENDANCE,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return updated;
  }
}
