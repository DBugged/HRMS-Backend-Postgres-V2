// Purpose: Gender-wise shift timings for an organisation (Work Schedules > Shift rules) and "what is my shift".
// Responsibilities: list / create / update / delete rules, validate the timing against the shift length limits and each
//   affected department's minimum hours, audit every change, and tell a person the shift that applies to them.
// Important: the timing is laid over the department shift at read time (see attendance/shift-rules.ts), so changing or
//   removing a rule changes what NEW calculations use; attendance already recorded is recalculated only when HR
//   recalculates it. Gender is the only condition for now.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  shiftConsistencyError,
  netWorkingHours,
} from '../attendance/shift-hours';
import { pickShiftRule } from '../attendance/shift-rules';
import { MAX_SHIFT_HOURS, shiftHours } from './work-schedules.service';
import { SaveShiftRuleDto } from './dto/shift-rule.dto';

type Actor = { id: string };

@Injectable()
export class ShiftRulesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditLogService,
  ) {}

  async list(organizationId: string) {
    const [rules, people] = await Promise.all([
      this.db.shiftRule.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.user.findMany({
        where: { organizationId, isActive: true },
        select: { gender: true, departmentId: true },
      }),
    ]);
    return rules.map((r) => ({
      ...r,
      peopleCovered: people.filter(
        (p) =>
          pickShiftRule(rules, p.gender, p.departmentId)?.gender === r.gender &&
          pickShiftRule(rules, p.gender, p.departmentId) === r,
      ).length,
    }));
  }

  private async validate(
    d: {
      startTime: string;
      endTime: string;
      breakMinutes: number | null;
      departmentIds: string[];
    },
    organizationId: string,
  ) {
    if (shiftHours(d.startTime, d.endTime) > MAX_SHIFT_HOURS) {
      throw new BadRequestException(
        `A shift can be at most ${MAX_SHIFT_HOURS} hours long (${d.startTime} to ${d.endTime} is longer).`,
      );
    }
    const departments = await this.db.department.findMany({
      where: {
        organizationId,
        ...(d.departmentIds.length ? { id: { in: d.departmentIds } } : {}),
      },
    });
    if (
      d.departmentIds.length &&
      departments.length !== d.departmentIds.length
    ) {
      throw new BadRequestException(
        'Some of the chosen departments are not in this company.',
      );
    }
    for (const dept of departments) {
      const breakMinutes = d.breakMinutes ?? dept.breakMinutes;
      const problem = shiftConsistencyError({
        startTime: d.startTime,
        endTime: d.endTime,
        breakMinutes,
      });
      if (problem) throw new BadRequestException(problem);
      const net = netWorkingHours(d.startTime, d.endTime, breakMinutes);
      if (net !== null && net + 1e-9 < dept.minHoursForPresent) {
        throw new BadRequestException(
          `${d.startTime} to ${d.endTime} leaves ${net}h of working time, but ${dept.name} needs ${dept.minHoursForPresent}h for a Present day. Lower the minimum hours in the department first, or lengthen the shift.`,
        );
      }
    }
  }

  async create(dto: SaveShiftRuleDto, organizationId: string, actor: Actor) {
    const name = dto.name?.trim();
    if (!name || !dto.gender || !dto.startTime || !dto.endTime) {
      throw new BadRequestException(
        'Name, gender, start time and end time are required.',
      );
    }
    const departmentIds = [...new Set(dto.departmentIds ?? [])];
    await this.validate(
      {
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? null,
        departmentIds,
      },
      organizationId,
    );
    if (
      await this.db.shiftRule.findFirst({ where: { organizationId, name } })
    ) {
      throw new ConflictException(
        `A shift rule named "${name}" already exists.`,
      );
    }
    const clash = await this.db.shiftRule.findFirst({
      where: {
        organizationId,
        gender: dto.gender,
        isActive: true,
        departmentIds: departmentIds.length
          ? { hasSome: departmentIds }
          : { isEmpty: true },
      },
    });
    if (clash && (dto.isActive ?? true)) {
      throw new ConflictException(
        `"${clash.name}" already sets the shift for the same people. Edit or turn that one off first.`,
      );
    }
    const created = await this.db.shiftRule.create({
      data: {
        organizationId,
        name,
        gender: dto.gender,
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? null,
        departmentIds,
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'SHIFT_RULE_CREATED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: created.id,
    });
    return created;
  }

  async update(
    id: string,
    dto: SaveShiftRuleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const cur = await this.db.shiftRule.findFirst({
      where: { id, organizationId },
    });
    if (!cur) throw new NotFoundException('Shift rule not found.');
    const next = {
      startTime: dto.startTime ?? cur.startTime,
      endTime: dto.endTime ?? cur.endTime,
      breakMinutes:
        dto.breakMinutes === undefined ? cur.breakMinutes : dto.breakMinutes,
      departmentIds: dto.departmentIds
        ? [...new Set(dto.departmentIds)]
        : cur.departmentIds,
    };
    await this.validate(next, organizationId);
    const name = dto.name?.trim();
    if (
      name &&
      name !== cur.name &&
      (await this.db.shiftRule.findFirst({ where: { organizationId, name } }))
    ) {
      throw new ConflictException(
        `A shift rule named "${name}" already exists.`,
      );
    }
    const gender = dto.gender ?? cur.gender;
    if (dto.isActive ?? cur.isActive) {
      const clash = await this.db.shiftRule.findFirst({
        where: {
          organizationId,
          gender,
          isActive: true,
          id: { not: id },
          departmentIds: next.departmentIds.length
            ? { hasSome: next.departmentIds }
            : { isEmpty: true },
        },
      });
      if (clash)
        throw new ConflictException(
          `"${clash.name}" already sets the shift for the same people. Edit or turn that one off first.`,
        );
    }
    const updated = await this.db.shiftRule.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        gender,
        ...next,
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'SHIFT_RULE_UPDATED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
    });
    return updated;
  }

  async remove(id: string, organizationId: string, actor: Actor) {
    const cur = await this.db.shiftRule.findFirst({
      where: { id, organizationId },
    });
    if (!cur) throw new NotFoundException('Shift rule not found.');
    await this.db.shiftRule.delete({ where: { id } });
    await this.audit.log({
      actorId: actor.id,
      action: 'SHIFT_RULE_DELETED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
    });
    return { deleted: true };
  }

  // The shift that applies to the caller: their department's, or a gender rule's timing laid over it.
  async mine(actorId: string, organizationId: string) {
    const me = await this.db.user.findFirst({
      where: { id: actorId, organizationId },
      select: {
        gender: true,
        departmentId: true,
        department: {
          select: {
            shiftStartTime: true,
            shiftEndTime: true,
            breakMinutes: true,
          },
        },
      },
    });
    const rules = await this.db.shiftRule.findMany({
      where: { organizationId, isActive: true },
    });
    const rule = pickShiftRule(rules, me?.gender, me?.departmentId);
    const org = await this.db.organization.findFirst({
      where: { id: organizationId },
      select: { attendancePayrollPrefs: true },
    });
    const prefs = (org?.attendancePayrollPrefs ?? {}) as {
      defaultShiftStartTime?: string;
      defaultShiftEndTime?: string;
      defaultBreakMinutes?: number;
    };
    const base = {
      startTime:
        me?.department?.shiftStartTime ??
        prefs.defaultShiftStartTime ??
        '09:30',
      endTime:
        me?.department?.shiftEndTime ?? prefs.defaultShiftEndTime ?? '18:30',
      breakMinutes:
        me?.department?.breakMinutes ?? prefs.defaultBreakMinutes ?? 0,
    };
    return rule
      ? {
          startTime: rule.startTime,
          endTime: rule.endTime,
          breakMinutes: rule.breakMinutes ?? base.breakMinutes,
          ruleName: rule.name,
        }
      : { ...base, ruleName: null };
  }
}
