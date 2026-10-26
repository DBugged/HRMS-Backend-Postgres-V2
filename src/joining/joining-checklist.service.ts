// Purpose: the joining checklist for new joiners - who sets up the laptop, work email and ID card, who introduces them to the team,
//   and by when - created and chased by the system so HR no longer keeps it in a spreadsheet.
// Responsibilities:
//   - ensureForOrg: gives everyone who joined in the last 30 days or joins in the next 30 a checklist, with default owners and dates;
//   - overview / mine: the checklist for HR (everyone), a manager (their own team, and steps they own) and one person's own open tasks;
//   - updateItem: tick a step, change its owner or due date (HR/Admin anything; an owner can tick the steps they own);
//   - a daily job (09:40) reminds each owner of open steps that are due, once a day.
// Important: steps the system can see (assets allocated, mandatory documents uploaded, profile completed) are ticked on read and need
//   no owner. Nothing here touches pay or access. A failure on one joiner never stops the others.
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetStatus, NotificationCategory, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { todayInOrgTz } from '../common/org-date';
import { managerIdsOf } from '../common/managers';
import { areMandatoryDocumentsUploaded } from '../employees/personal-data';
import { dmyText } from '../payroll/format-date';
import {
  JOINING_ITEM_KEYS,
  JOINING_ITEM_LABELS,
  defaultJoiningMeta,
  isJoiningOverdue,
  joiningDone,
  needsJoiningChecklist,
  type JoiningItemKey,
  type JoiningMeta,
} from './joining-checklist';
import { UpdateJoiningItemDto } from './dto/update-joining-item.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class JoiningChecklistService {
  private readonly logger = new Logger(JoiningChecklistService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async today(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
    return todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
  }

  /** Creates the missing checklists. Returns how many were created. */
  async ensureForOrg(organizationId: string, today: string): Promise<number> {
    const people = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, exitDate: null },
      select: { id: true, joiningDate: true, reportingManagerId: true },
    });
    const candidates = people.filter((p) => needsJoiningChecklist(p.joiningDate.toISOString().slice(0, 10), today));
    if (candidates.length === 0) return 0;
    const have = new Set(
      (await this.scopedPrisma.joiningChecklist.findMany({ where: { organizationId, employeeId: { in: candidates.map((c) => c.id) } }, select: { employeeId: true } })).map((c) => c.employeeId),
    );
    const missing = candidates.filter((c) => !have.has(c.id));
    if (missing.length === 0) return 0;
    const hr =
      (await this.scopedPrisma.user.findFirst({ where: { organizationId, isActive: true, role: Role.HR }, orderBy: { createdAt: 'asc' }, select: { id: true } })) ??
      (await this.scopedPrisma.user.findFirst({ where: { organizationId, isActive: true, role: Role.ADMIN }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
    let created = 0;
    for (const c of missing) {
      try {
        const meta = defaultJoiningMeta({
          hrId: hr?.id ?? null,
          managerId: c.reportingManagerId,
          joiningDate: c.joiningDate.toISOString().slice(0, 10),
          today,
        });
        await this.scopedPrisma.joiningChecklist.create({
          data: { organizationId, employeeId: c.id, items: meta as unknown as Prisma.InputJsonValue },
        });
        created++;
      } catch (err) {
        // A concurrent run may have created it first (unique on employee): that is fine.
        this.logger.warn(`Joining checklist for ${c.id} not created: ${(err as Error).message}`);
      }
    }
    return created;
  }

  /** What the system can see for each joiner: assets allocated, mandatory documents uploaded, profile completed. */
  private async factsFor(organizationId: string, people: { id: string; personalData: unknown }[]) {
    const ids = people.map((p) => p.id);
    const [requirements, documents, assets] = await Promise.all([
      this.scopedPrisma.documentRequirement.findMany({ where: { organizationId, isMandatory: true, isActive: true }, select: { name: true, isMandatory: true, isActive: true } }),
      this.scopedPrisma.employeeDocument.findMany({ where: { organizationId, employeeId: { in: ids }, category: 'DOCUMENT' }, select: { employeeId: true, docType: true, status: true } }),
      this.scopedPrisma.employeeAsset.findMany({ where: { organizationId, employeeId: { in: ids }, status: AssetStatus.ALLOCATED }, select: { employeeId: true } }),
    ]);
    const docsBy = new Map<string, { docType: string; status: string }[]>();
    for (const d of documents) docsBy.set(d.employeeId, [...(docsBy.get(d.employeeId) ?? []), d]);
    const withAsset = new Set(assets.map((a) => a.employeeId));
    return new Map(
      people.map((p) => [
        p.id,
        {
          hasAllocatedAsset: withAsset.has(p.id),
          documentsUploaded: areMandatoryDocumentsUploaded(requirements, docsBy.get(p.id) ?? []),
          profileCompleted: (p.personalData as { profileCompleted?: unknown } | null)?.profileCompleted === true,
        },
      ]),
    );
  }

  /** HR/Admin: every joiner. Manager: their own reports and the joiners where they own a step. Open ones first. */
  async overview(actor: Actor, organizationId: string) {
    const today = await this.today(organizationId);
    await this.ensureForOrg(organizationId, today);
    const rows = await this.scopedPrisma.joiningChecklist.findMany({
      where: { organizationId, employee: { isActive: true, exitDate: null } },
      include: {
        employee: { select: { id: true, name: true, employeeId: true, joiningDate: true, reportingManagerId: true, additionalReportingManagerIds: true, personalData: true } },
      },
    });
    const seeAll = actor.role === Role.ADMIN || actor.role === Role.HR;
    const visible = rows.filter((r) => {
      if (seeAll) return true;
      const meta = (r.items ?? {}) as JoiningMeta;
      return managerIdsOf(r.employee).includes(actor.id) || JOINING_ITEM_KEYS.some((k) => meta[k]?.ownerId === actor.id);
    });
    const facts = await this.factsFor(organizationId, visible.map((r) => r.employee));
    const ownerIds = [...new Set(visible.flatMap((r) => JOINING_ITEM_KEYS.map((k) => ((r.items ?? {}) as JoiningMeta)[k]?.ownerId).filter((x): x is string => !!x)))];
    const owners = ownerIds.length ? await this.scopedPrisma.user.findMany({ where: { id: { in: ownerIds }, organizationId }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(owners.map((o) => [o.id, o.name]));
    const dayNo = (ymd: string) => Math.round(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / 86400000);

    const cases = visible.map((r) => {
      const meta = (r.items ?? {}) as JoiningMeta;
      const done = joiningDone(meta, facts.get(r.employee.id)!);
      const items = JOINING_ITEM_KEYS.map((key) => ({
        key,
        label: JOINING_ITEM_LABELS[key],
        done: done[key],
        ownerId: meta[key]?.ownerId ?? null,
        ownerName: meta[key]?.ownerId ? (nameOf.get(meta[key]!.ownerId!) ?? null) : null,
        dueDate: meta[key]?.dueDate ?? null,
        overdue: isJoiningOverdue(meta[key]?.dueDate, today, done[key]),
      }));
      const joiningDate = r.employee.joiningDate.toISOString().slice(0, 10);
      return {
        employeeId: r.employee.id,
        name: r.employee.name,
        code: r.employee.employeeId,
        joiningDate,
        // Negative before the joining date.
        daysSinceJoining: dayNo(today) - dayNo(joiningDate),
        items,
        doneCount: items.filter((i) => i.done).length,
        total: items.length,
        overdueCount: items.filter((i) => i.overdue).length,
        complete: items.every((i) => i.done),
      };
    });
    cases.sort((a, b) => Number(a.complete) - Number(b.complete) || b.overdueCount - a.overdueCount || a.joiningDate.localeCompare(b.joiningDate));
    return {
      today,
      summary: {
        joiners: cases.length,
        open: cases.filter((c) => !c.complete).length,
        withOverdueSteps: cases.filter((c) => c.overdueCount > 0).length,
      },
      cases,
    };
  }

  /** The caller's own open steps across all joiners (for the phone). */
  async mine(actor: Actor, organizationId: string) {
    const { today, cases } = await this.overview({ ...actor, role: Role.ADMIN } as Actor, organizationId);
    const tasks = cases.flatMap((c) =>
      c.items
        .filter((i) => i.ownerId === actor.id && !i.done)
        .map((i) => ({ employeeId: c.employeeId, employeeName: c.name, code: c.code, joiningDate: c.joiningDate, key: i.key, label: i.label, dueDate: i.dueDate, overdue: i.overdue })),
    );
    tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    return { today, tasks };
  }

  async updateItem(employeeId: string, key: string, dto: UpdateJoiningItemDto, actor: Actor, organizationId: string) {
    if (!(JOINING_ITEM_KEYS as readonly string[]).includes(key)) throw new NotFoundException('Unknown checklist step.');
    const itemKey = key as JoiningItemKey;
    const checklist = await this.scopedPrisma.joiningChecklist.findFirst({ where: { organizationId, employeeId } });
    if (!checklist) throw new NotFoundException('Joining checklist not found.');
    const meta = { ...((checklist.items ?? {}) as JoiningMeta) };
    const current = meta[itemKey] ?? { ownerId: null, dueDate: null, doneAt: null, doneById: null };
    const isHr = actor.role === Role.ADMIN || actor.role === Role.HR;
    if (!isHr) {
      // An owner may tick the step they own, nothing else.
      if (current.ownerId !== actor.id) throw new ForbiddenException('Only HR or the owner of this step can change it.');
      if (dto.ownerId !== undefined || dto.dueDate !== undefined) throw new ForbiddenException('Only HR can change the owner or the due date.');
    }
    const next = { ...current };
    if (dto.ownerId !== undefined) {
      if (dto.ownerId !== null) {
        const owner = await this.scopedPrisma.user.findFirst({ where: { id: dto.ownerId, organizationId, isActive: true, role: { in: [Role.ADMIN, Role.HR, Role.MANAGER] } }, select: { id: true } });
        if (!owner) throw new BadRequestException('Pick an active Admin, HR or Manager as the owner.');
      }
      next.ownerId = dto.ownerId;
    }
    if (dto.dueDate !== undefined) next.dueDate = dto.dueDate;
    if (dto.done === true) {
      next.doneAt = new Date().toISOString();
      next.doneById = actor.id;
    } else if (dto.done === false) {
      next.doneAt = null;
      next.doneById = null;
    }
    meta[itemKey] = next;
    await this.scopedPrisma.joiningChecklist.updateMany({ where: { id: checklist.id, organizationId }, data: { items: meta as unknown as Prisma.InputJsonValue } });

    // The new owner is told, unless they gave it to themselves.
    if (dto.ownerId && dto.ownerId !== current.ownerId && dto.ownerId !== actor.id) {
      const joiner = await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { name: true } });
      await this.notificationsService.create({
        organizationId,
        userId: dto.ownerId,
        title: `Joining task assigned: ${JOINING_ITEM_LABELS[itemKey]} (${joiner?.name ?? 'new joiner'})`,
        message: `You now own "${JOINING_ITEM_LABELS[itemKey]}" for ${joiner?.name ?? 'a new joiner'}${next.dueDate ? `, due ${dmyText(next.dueDate)}` : ''}.`,
        category: NotificationCategory.GENERAL,
      });
    }
    return this.overview(actor, organizationId).then((o) => o.cases.find((c) => c.employeeId === employeeId) ?? null);
  }

  @Cron('40 9 * * *')
  async remindDaily() {
    const orgs = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    for (const org of orgs) {
      try {
        const today = todayInOrgTz(org.timezone);
        await this.ensureForOrg(org.id, today);
        await this.remindForOrg(org.id, today);
      } catch (err) {
        this.logger.error(`Joining checklist job failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  // One notice per owner per day, listing their open steps that are due today or overdue. Returns how many owners were told.
  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const { cases } = await this.overview({ role: Role.ADMIN, id: 'system' } as Actor, organizationId);
    const byOwner = new Map<string, string[]>();
    for (const c of cases) {
      for (const i of c.items) {
        if (i.done || !i.ownerId || !i.dueDate || i.dueDate > today) continue;
        byOwner.set(i.ownerId, [...(byOwner.get(i.ownerId) ?? []), `${i.label} - ${c.name}${i.overdue ? ' (overdue)' : ' (due today)'}`]);
      }
    }
    let told = 0;
    for (const [ownerId, lines] of byOwner) {
      const title = `${lines.length} joining task${lines.length === 1 ? '' : 's'} need${lines.length === 1 ? 's' : ''} you`;
      const recent = await this.scopedPrisma.notification.findFirst({
        where: { organizationId, userId: ownerId, title, createdAt: { gte: new Date(Date.now() - 20 * 60 * 60 * 1000) } },
        select: { id: true },
      });
      if (recent) continue;
      await this.notificationsService.create({ organizationId, userId: ownerId, title, message: lines.slice(0, 6).join('. ') + (lines.length > 6 ? `. And ${lines.length - 6} more.` : '.'), category: NotificationCategory.GENERAL });
      told++;
    }
    return told;
  }
}
