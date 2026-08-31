// Purpose: Standalone Shift reference catalog (Organization Structure > Work Configuration > Shifts).
// Responsibilities: CRUD only — this is deliberately NOT assigned to departments and has no effect on
//   attendance calculation, unlike WorkSchedule. Kept separate on purpose (see WorkSchedule's schema
//   comment) rather than risking two disagreeing sources of truth for a department's actual shift.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { wrapAll } from '../common/pagination';

type Actor = { id: string };

@Injectable()
export class ShiftsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.shift.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  private async findOrThrow(id: string, organizationId: string) {
    const shift = await this.scopedPrisma.shift.findFirst({
      where: { id, organizationId },
    });
    if (!shift) throw new NotFoundException('Shift not found.');
    return shift;
  }

  async create(dto: CreateShiftDto, organizationId: string, actor: Actor) {
    const shift = await this.scopedPrisma.shift.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        startTime: dto.startTime,
        endTime: dto.endTime,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'SHIFT_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: shift.id,
      details: { name: shift.name },
    });

    return shift;
  }

  async update(id: string, dto: UpdateShiftDto, organizationId: string, actor: Actor) {
    await this.findOrThrow(id, organizationId);

    await this.scopedPrisma.shift.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.startTime !== undefined && { startTime: dto.startTime }),
        ...(dto.endTime !== undefined && { endTime: dto.endTime }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    const updated = await this.findOrThrow(id, organizationId);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'SHIFT_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: updated.name },
    });

    return updated;
  }

  async delete(id: string, organizationId: string, actor: Actor) {
    const shift = await this.findOrThrow(id, organizationId);

    await this.scopedPrisma.shift.deleteMany({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'SHIFT_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: shift.name },
    });

    return { success: true, message: 'Shift deleted' };
  }
}
