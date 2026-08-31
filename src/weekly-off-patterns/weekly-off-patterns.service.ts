// Purpose: Standalone Weekly Off pattern reference catalog (Organization Structure > Work Configuration
//   > Weekly Offs).
// Responsibilities: CRUD only — deliberately NOT assigned to departments and has no effect on attendance
//   calculation. Department.weeklyOffs and WorkSchedule.workingDays remain the only fields that actually
//   drive attendance's weekly-off determination (see attendance-shift-config.ts's isWeeklyOff).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateWeeklyOffPatternDto } from './dto/create-weekly-off-pattern.dto';
import { UpdateWeeklyOffPatternDto } from './dto/update-weekly-off-pattern.dto';
import { wrapAll } from '../common/pagination';

type Actor = { id: string };

@Injectable()
export class WeeklyOffPatternsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.weeklyOffPattern.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  private async findOrThrow(id: string, organizationId: string) {
    const pattern = await this.scopedPrisma.weeklyOffPattern.findFirst({
      where: { id, organizationId },
    });
    if (!pattern) throw new NotFoundException('Weekly off pattern not found.');
    return pattern;
  }

  async create(dto: CreateWeeklyOffPatternDto, organizationId: string, actor: Actor) {
    const pattern = await this.scopedPrisma.weeklyOffPattern.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        daysOff: dto.daysOff,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WEEKLY_OFF_PATTERN_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: pattern.id,
      details: { name: pattern.name },
    });

    return pattern;
  }

  async update(
    id: string,
    dto: UpdateWeeklyOffPatternDto,
    organizationId: string,
    actor: Actor,
  ) {
    await this.findOrThrow(id, organizationId);

    await this.scopedPrisma.weeklyOffPattern.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.daysOff !== undefined && { daysOff: dto.daysOff }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    const updated = await this.findOrThrow(id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WEEKLY_OFF_PATTERN_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: updated.name },
    });

    return updated;
  }

  async delete(id: string, organizationId: string, actor: Actor) {
    const pattern = await this.findOrThrow(id, organizationId);

    await this.scopedPrisma.weeklyOffPattern.deleteMany({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WEEKLY_OFF_PATTERN_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: pattern.name },
    });

    return { success: true, message: 'Weekly off pattern deleted' };
  }
}
