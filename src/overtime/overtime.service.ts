import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
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
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;
    if (query.month && query.year) {
      const { from, to } = monthRange(query.month, query.year);
      where.date = { gte: from, lte: to };
    }

    return this.scopedPrisma.overtimeRecord.findMany({
      where,
      orderBy: { date: 'desc' },
    });
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
    if (record.status !== OvertimeStatus.PENDING) {
      throw new BadRequestException(
        'This overtime record has already been reviewed.',
      );
    }

    await this.scopedPrisma.overtimeRecord.updateMany({
      where: { id, organizationId },
      data: { status: dto.status, approvedById: actor.id },
    });

    return this.scopedPrisma.overtimeRecord.findFirstOrThrow({
      where: { id, organizationId },
    });
  }
}
