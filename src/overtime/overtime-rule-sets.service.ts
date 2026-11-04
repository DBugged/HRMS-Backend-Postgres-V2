// Purpose: Lets an Admin/HR of an organisation keep their own named overtime rule sets and see what a person would get.
// Responsibilities: list / create / update / delete rule sets for the caller's organisation, check that everyone they are
//   assigned to belongs to it, audit every change, and preview the rules in force for one person on one date.
// Important: a set applies only from effectiveFrom, so editing rules never changes an earlier month. Deleting is allowed
//   because records keep the multiplier they were created with.
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
  getEffectiveOvertime,
  MIN_OVERTIME_MULTIPLIER,
} from './overtime.service';
import {
  pickRuleSet,
  sanitizeRuleSetPolicy,
  sanitizeRuleSetRates,
} from './overtime-rule-sets';
import { SaveOvertimeRuleSetDto } from './dto/overtime-rule-set.dto';

type Actor = { id: string };
const todayUtc = () => new Date().toISOString().slice(0, 10);
const uniq = (a?: string[]) => [...new Set((a ?? []).filter(Boolean))];

@Injectable()
export class OvertimeRuleSetsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: ExtendedPrismaClient,
    private readonly audit: AuditLogService,
  ) {}

  async list(organizationId: string) {
    const [sets, people] = await Promise.all([
      this.db.overtimeRuleSet.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.user.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          departmentId: true,
          employeeType: true,
          designation: true,
        },
      }),
    ]);
    // How many people each set reaches today (by the same precedence the engine uses).
    const reach = new Map<string, number>();
    const today = todayUtc();
    for (const p of people) {
      const hit = pickRuleSet(sets, p, today);
      if (hit) reach.set(hit.id, (reach.get(hit.id) ?? 0) + 1);
    }
    return sets.map((s) => ({ ...s, peopleCovered: reach.get(s.id) ?? 0 }));
  }

  private async checked(dto: SaveOvertimeRuleSetDto, organizationId: string) {
    const employeeIds = uniq(dto.employeeIds);
    const departmentIds = uniq(dto.departmentIds);
    if (employeeIds.length) {
      const n = await this.db.user.count({
        where: { organizationId, id: { in: employeeIds } },
      });
      if (n !== employeeIds.length)
        throw new BadRequestException(
          'Some of the chosen employees are not in this company.',
        );
    }
    if (departmentIds.length) {
      const n = await this.db.department.count({
        where: { organizationId, id: { in: departmentIds } },
      });
      if (n !== departmentIds.length)
        throw new BadRequestException(
          'Some of the chosen departments are not in this company.',
        );
    }
    return {
      employeeIds,
      departmentIds,
      employeeTypes: uniq(dto.employeeTypes),
      designations: uniq(dto.designations),
    };
  }

  async create(
    dto: SaveOvertimeRuleSetDto,
    organizationId: string,
    actor: Actor,
  ) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Give the rule set a name.');
    const targets = await this.checked(dto, organizationId);
    if (
      !targets.employeeIds.length &&
      !targets.departmentIds.length &&
      !targets.employeeTypes.length &&
      !targets.designations.length
    ) {
      throw new BadRequestException(
        'Choose who this applies to: departments, designations, employee types or specific people.',
      );
    }
    if (
      await this.db.overtimeRuleSet.findFirst({
        where: { organizationId, name },
      })
    ) {
      throw new ConflictException(`A rule set named "${name}" already exists.`);
    }
    const created = await this.db.overtimeRuleSet.create({
      data: {
        organizationId,
        name,
        description: dto.description?.trim() ?? '',
        policy: sanitizeRuleSetPolicy(dto.policy) as object,
        rates: (sanitizeRuleSetRates(dto.rates, MIN_OVERTIME_MULTIPLIER) ??
          undefined) as object | undefined,
        ...targets,
        effectiveFrom: dto.effectiveFrom ?? todayUtc(),
        isActive: dto.isActive ?? true,
        createdById: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'OVERTIME_RULE_SET_CREATED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: created.id,
    });
    return created;
  }

  async update(
    id: string,
    dto: SaveOvertimeRuleSetDto,
    organizationId: string,
    actor: Actor,
  ) {
    const current = await this.db.overtimeRuleSet.findFirst({
      where: { id, organizationId },
    });
    if (!current) throw new NotFoundException('Overtime rule set not found.');
    const name = dto.name?.trim();
    if (
      name &&
      name !== current.name &&
      (await this.db.overtimeRuleSet.findFirst({
        where: { organizationId, name },
      }))
    ) {
      throw new ConflictException(`A rule set named "${name}" already exists.`);
    }
    const touchesTargets =
      dto.employeeIds !== undefined ||
      dto.departmentIds !== undefined ||
      dto.employeeTypes !== undefined ||
      dto.designations !== undefined;
    const targets = touchesTargets
      ? await this.checked(
          {
            employeeIds: dto.employeeIds ?? current.employeeIds,
            departmentIds: dto.departmentIds ?? current.departmentIds,
            employeeTypes: dto.employeeTypes ?? current.employeeTypes,
            designations: dto.designations ?? current.designations,
          },
          organizationId,
        )
      : null;
    if (
      targets &&
      !targets.employeeIds.length &&
      !targets.departmentIds.length &&
      !targets.employeeTypes.length &&
      !targets.designations.length
    ) {
      throw new BadRequestException(
        'Choose who this applies to: departments, designations, employee types or specific people.',
      );
    }
    await this.db.overtimeRuleSet.updateMany({
      where: { id, organizationId },
      data: {
        ...(name ? { name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.policy !== undefined
          ? { policy: sanitizeRuleSetPolicy(dto.policy) as object }
          : {}),
        ...(dto.rates !== undefined
          ? {
              rates: (sanitizeRuleSetRates(
                dto.rates,
                MIN_OVERTIME_MULTIPLIER,
              ) ?? null) as object | null,
            }
          : {}),
        ...(targets ?? {}),
        ...(dto.effectiveFrom ? { effectiveFrom: dto.effectiveFrom } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      } as never,
    });
    const updated = await this.db.overtimeRuleSet.findFirstOrThrow({
      where: { id, organizationId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'OVERTIME_RULE_SET_UPDATED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
    });
    return updated;
  }

  async remove(id: string, organizationId: string, actor: Actor) {
    const found = await this.db.overtimeRuleSet.findFirst({
      where: { id, organizationId },
    });
    if (!found) throw new NotFoundException('Overtime rule set not found.');
    await this.db.overtimeRuleSet.deleteMany({ where: { id, organizationId } });
    await this.audit.log({
      actorId: actor.id,
      action: 'OVERTIME_RULE_SET_DELETED',
      module: 'ATTENDANCE',
      organizationId,
      targetId: id,
    });
    return { deleted: true };
  }

  // "What would this person get?" - the rule set in force and the resulting limits and rates, before anyone saves anything.
  async preview(
    employeeId: string,
    date: string | undefined,
    organizationId: string,
  ) {
    const person = await this.db.user.findFirst({
      where: { id: employeeId, organizationId },
      select: {
        id: true,
        name: true,
        departmentId: true,
        employeeType: true,
        designation: true,
      },
    });
    if (!person) throw new NotFoundException('Employee not found.');
    const on = date ?? todayUtc();
    const eff = await getEffectiveOvertime(this.db, organizationId, person, on);
    return { employee: { id: person.id, name: person.name }, date: on, ...eff };
  }
}
