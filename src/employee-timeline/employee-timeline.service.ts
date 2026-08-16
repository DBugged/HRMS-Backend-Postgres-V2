import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { EVENT_META } from './timeline-events';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { paginate } from '../common/pagination';

type Actor = Omit<User, 'password'>;

export interface LogTimelineEventInput {
  organizationId: string;
  employeeId: string;
  eventKey: string;
  title?: string;
  description?: string;
  performedById?: string | null;
  occurredAt?: Date;
  remarks?: string;
  relatedDocument?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class EmployeeTimelineService {
  private readonly logger = new Logger(EmployeeTimelineService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  // Fire-and-forget — a broken timeline write must never fail the action
  // it's documenting, same posture as AuditLogService.log().
  async logEvent(input: LogTimelineEventInput): Promise<void> {
    try {
      const meta = EVENT_META[input.eventKey] ?? {
        category: 'EMPLOYMENT' as const,
        title: input.eventKey,
      };
      await this.scopedPrisma.employeeTimeline.create({
        data: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          category: meta.category,
          eventKey: input.eventKey,
          title: input.title ?? meta.title,
          description: input.description ?? '',
          occurredAt: input.occurredAt ?? new Date(),
          performedById: input.performedById ?? null,
          remarks: input.remarks ?? '',
          relatedDocument: input.relatedDocument ?? '',
          status: input.status ?? '',
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write timeline event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Same view-scoping rule as EmployeesService.findOne: HR/ADMIN see
  // anyone, a MANAGER only their own department's employees, an EMPLOYEE
  // only themselves (the self-or-role check is already enforced at the
  // controller/guard level; this only needs the MANAGER dept check).
  private async assertCanView(
    employeeId: string,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (
      actor.role === Role.MANAGER &&
      (actor.departmentId === null ||
        actor.departmentId !== employee.departmentId)
    ) {
      throw new ForbiddenException('Not authorized to view this employee.');
    }
    return employee;
  }

  private buildWhere(
    employeeId: string,
    query: QueryTimelineDto,
    organizationId: string,
  ): Prisma.EmployeeTimelineWhereInput {
    const where: Prisma.EmployeeTimelineWhereInput = {
      organizationId,
      employeeId,
    };
    if (query.category) where.category = query.category;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { remarks: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async findAll(
    employeeId: string,
    query: QueryTimelineDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.assertCanView(employeeId, actor, organizationId);
    const where = this.buildWhere(employeeId, query, organizationId);
    return paginate(
      () =>
        this.scopedPrisma.employeeTimeline.findMany({
          where,
          include: {
            performedBy: {
              select: { id: true, name: true, employeeId: true },
            },
          },
          orderBy: { occurredAt: query.sort === 'asc' ? 'asc' : 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      () => this.scopedPrisma.employeeTimeline.count({ where }),
      query.page,
      query.limit,
    );
  }

  // Shared by the two export endpoints — resolves the target employee (for
  // the export filename) and the filtered event rows.
  async fetchForExport(
    employeeId: string,
    query: QueryTimelineDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employee = await this.assertCanView(
      employeeId,
      actor,
      organizationId,
    );
    const events = await this.scopedPrisma.employeeTimeline.findMany({
      where: this.buildWhere(employeeId, query, organizationId),
      include: {
        performedBy: { select: { id: true, name: true, employeeId: true } },
      },
      orderBy: { occurredAt: query.sort === 'asc' ? 'asc' : 'desc' },
    });
    return { employee, events };
  }
}
