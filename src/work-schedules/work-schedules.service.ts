// Purpose: Named shift templates (Organization Structure > Work Configuration > Work Schedules) and
//   assigning one to a set of departments.
// Responsibilities: CRUD for WorkSchedule; assign() copies startTime/endTime/workingDays/
//   alternateWeeklyOffs/breakMinutes onto each selected department's own shiftStartTime/shiftEndTime/
//   weeklyOffs/breakMinutes (what AttendanceService actually reads — see attendance-shift-config.ts) and
//   sets Department.workScheduleId for traceability, replace semantics (exact target set).
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { WeeklyOffEntry } from '../attendance/attendance-shift-config';
import {
  CreateWorkScheduleDto,
  AlternateWeeklyOffDto,
} from './dto/create-work-schedule.dto';
import { UpdateWorkScheduleDto } from './dto/update-work-schedule.dto';
import { AssignWorkScheduleDto } from './dto/assign-work-schedule.dto';
import { wrapAll } from '../common/pagination';

type Actor = { id: string };

// A day off every week (not in workingDays, and not one of the alternate
// days) is a plain number entry; an alternate day becomes the richer
// { day, occurrences } entry instead of "off every week" — see
// attendance-shift-config.ts's WeeklyOffEntry.
export function computeWeeklyOffs(
  workingDays: number[],
  alternateWeeklyOffs: AlternateWeeklyOffDto[],
): WeeklyOffEntry[] {
  const alternateDays = new Set(alternateWeeklyOffs.map((a) => a.day));
  const plainOffs = [0, 1, 2, 3, 4, 5, 6].filter(
    (day) => !workingDays.includes(day) && !alternateDays.has(day),
  );
  return [...plainOffs, ...alternateWeeklyOffs];
}

// A day can't simultaneously be "always worked" (in workingDays) and
// "alternately off" (in alternateWeeklyOffs) — that's a direct
// contradiction, so reject it rather than silently picking a winner.
function validateNoOverlap(
  workingDays: number[],
  alternateWeeklyOffs: AlternateWeeklyOffDto[],
) {
  const overlap = alternateWeeklyOffs.find((a) => workingDays.includes(a.day));
  if (overlap) {
    throw new BadRequestException(
      `Day ${overlap.day} can't be both a working day and an alternate off day.`,
    );
  }
}

@Injectable()
export class WorkSchedulesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.workSchedule.findMany({
      where: { organizationId },
      include: {
        departments: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  private async findOrThrow(id: string, organizationId: string) {
    const schedule = await this.scopedPrisma.workSchedule.findFirst({
      where: { id, organizationId },
    });
    if (!schedule) throw new NotFoundException('Work schedule not found.');
    return schedule;
  }

  async create(
    dto: CreateWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const alternateWeeklyOffs = dto.alternateWeeklyOffs ?? [];
    validateNoOverlap(dto.workingDays, alternateWeeklyOffs);

    const schedule = await this.scopedPrisma.workSchedule.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        workingDays: dto.workingDays,
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? 60,
        alternateWeeklyOffs:
          alternateWeeklyOffs as unknown as Prisma.InputJsonValue,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: schedule.id,
      details: { name: schedule.name },
    });

    return schedule;
  }

  async update(
    id: string,
    dto: UpdateWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const existing = await this.findOrThrow(id, organizationId);

    // Validate against the *final* merged shape (existing fields the
    // caller didn't touch, layered under whatever they did send) — a
    // partial update that only changes workingDays still needs to be
    // checked against the schedule's current alternateWeeklyOffs, and
    // vice versa.
    const workingDays = dto.workingDays ?? (existing.workingDays as number[]);
    const alternateWeeklyOffs =
      dto.alternateWeeklyOffs ??
      (existing.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[]);
    validateNoOverlap(workingDays, alternateWeeklyOffs);

    await this.scopedPrisma.workSchedule.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.workingDays !== undefined && { workingDays: dto.workingDays }),
        ...(dto.startTime !== undefined && { startTime: dto.startTime }),
        ...(dto.endTime !== undefined && { endTime: dto.endTime }),
        ...(dto.breakMinutes !== undefined && {
          breakMinutes: dto.breakMinutes,
        }),
        ...(dto.alternateWeeklyOffs !== undefined && {
          alternateWeeklyOffs:
            dto.alternateWeeklyOffs as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    // Departments already assigned this schedule keep following it — if
    // the shift times/working days/alternate pattern changed, re-propagate
    // so they don't silently drift from what the schedule now says.
    const updated = await this.findOrThrow(id, organizationId);
    if (
      dto.startTime !== undefined ||
      dto.endTime !== undefined ||
      dto.workingDays !== undefined ||
      dto.alternateWeeklyOffs !== undefined ||
      dto.breakMinutes !== undefined
    ) {
      await this.scopedPrisma.department.updateMany({
        where: { organizationId, workScheduleId: id },
        data: {
          shiftStartTime: updated.startTime,
          shiftEndTime: updated.endTime,
          weeklyOffs: computeWeeklyOffs(
            updated.workingDays as number[],
            updated.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
          ),
          breakMinutes: updated.breakMinutes,
        },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: updated.name },
    });

    return updated;
  }

  async delete(id: string, organizationId: string, actor: Actor) {
    const schedule = await this.findOrThrow(id, organizationId);

    // Unlink first — departments keep whatever shift fields they currently
    // have (already copied over at assign time), they just stop being
    // traceable to this schedule, same "delete doesn't ripple into other
    // records' live data" choice as OrgListItem/DocumentRequirement deletes.
    await this.scopedPrisma.department.updateMany({
      where: { organizationId, workScheduleId: id },
      data: { workScheduleId: null },
    });
    await this.scopedPrisma.workSchedule.deleteMany({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: schedule.name },
    });

    return { success: true, message: 'Work schedule deleted' };
  }

  async assign(
    id: string,
    dto: AssignWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const schedule = await this.findOrThrow(id, organizationId);

    if (dto.departmentIds.length > 0) {
      const found = await this.scopedPrisma.department.count({
        where: { id: { in: dto.departmentIds }, organizationId },
      });
      if (found !== dto.departmentIds.length) {
        throw new BadRequestException(
          'One or more departments were not found.',
        );
      }
    }

    const weeklyOffs = computeWeeklyOffs(
      schedule.workingDays as number[],
      schedule.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
    );

    // Replace semantics: unassign every department currently on this
    // schedule that isn't in the new list, then assign (+ propagate shift
    // fields to) every department in the new list — a single call always
    // leaves exactly dto.departmentIds assigned, regardless of prior state.
    await this.scopedPrisma.department.updateMany({
      where: {
        organizationId,
        workScheduleId: id,
        id: { notIn: dto.departmentIds },
      },
      data: { workScheduleId: null },
    });

    if (dto.departmentIds.length > 0) {
      await this.scopedPrisma.department.updateMany({
        where: { organizationId, id: { in: dto.departmentIds } },
        data: {
          workScheduleId: id,
          shiftStartTime: schedule.startTime,
          shiftEndTime: schedule.endTime,
          weeklyOffs: weeklyOffs,
          breakMinutes: schedule.breakMinutes,
        },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_ASSIGNED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: {
        name: schedule.name,
        departmentCount: dto.departmentIds.length,
      },
    });

    return this.findOrThrow(id, organizationId);
  }
}
