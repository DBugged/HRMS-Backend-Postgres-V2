// Purpose: does the routine parts of an exit by itself, so HR only decides and confirms.
// Responsibilities: hourly, for every open offboarding case:
//   - brings it up to date (ticks "assets returned" once nothing is allocated, tells HR when the case becomes ready to complete);
//   - from the morning after the last working day, links the settlement already made for it, or prepares the final settlement
//     draft (when the company has "Prepare F&F automatically" on - the default) and tells HR to review it;
//   - reminds each checklist item's owner, once a day, while the item is open and due;
//   - when the company turned on "Complete exits automatically", closes a case that is ready.
// Important: the draft is recorded as calculated by nobody, so the person who reviews and processes it satisfies the
//   maker-checker rule. Nothing money-related is approved, processed or paid here, and a case is never completed unless the
//   settlement is PAID. A failure on one case is reported to HR and never stops the others. Every automatic step is audited and
//   shown on the employee's timeline as done by the system.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OffboardingStatus, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { SettlementsService } from '../settlements/settlements.service';
import { keepModuleEnabled } from '../module-access/module-gate';
import { todayInOrgTz } from '../common/org-date';
import { dmyText } from '../payroll/format-date';
import { OffboardingService } from './offboarding.service';
import { CHECKLIST_ITEM_KEYS, CHECKLIST_ITEM_LABELS, readExitAutomation, type ChecklistMeta } from './offboarding-checklist';

type Actor = Omit<User, 'password'>;

/** The local hour in a time zone (0-23). */
const hourIn = (timezone: string, at: Date): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));

@Injectable()
export class OffboardingAutomationService {
  private readonly logger = new Logger(OffboardingAutomationService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly offboarding: OffboardingService,
    private readonly settlements: SettlementsService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
  ) {}

  @Cron('20 * * * *')
  async hourly() {
    const all = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    // Skip companies whose Super Admin switched this module off.
    const orgs = await keepModuleEnabled(all, 'module.offboarding');
    const now = new Date();
    for (const org of orgs) {
      try {
        await this.runForOrg(org.id, todayInOrgTz(org.timezone), hourIn(org.timezone, now));
      } catch (err) {
        this.logger.error(`Offboarding automation failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * One pass for one company. `localHour` gates the once-a-day work (settlement draft, reminders) to the working day, so a
   * company is never emailed at night; bringing a case up to date runs every hour.
   */
  async runForOrg(organizationId: string, today: string, localHour: number): Promise<{ prepared: number; completed: number }> {
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { policies: true } });
    const switches = readExitAutomation(org?.policies);
    const cases = await this.scopedPrisma.offboardingCase.findMany({
      where: { organizationId, status: { in: [OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS] } },
      include: { employee: { select: { id: true, name: true, employeeId: true } }, settlement: true },
    });
    let prepared = 0;
    let completed = 0;
    for (const c of cases) {
      try {
        const actor = (await this.scopedPrisma.user.findFirst({ where: { id: c.initiatedById, organizationId } })) as Actor | null;
        if (!actor) continue;
        const workingHours = localHour >= 7 && localHour <= 20;

        // 1. The final settlement: link the one made for this last working day, or prepare the draft.
        if (workingHours && c.lastWorkingDay < today && !c.settlementId) {
          if (await this.settleOrPrepare(c, actor, organizationId, switches.autoPrepareFnf)) prepared++;
        }

        // 2. Bring the case up to date, and say when it is ready.
        const { ready } = await this.offboarding.reconcile(c.id, organizationId);

        // 3. Complete it when the company asked for that and it is ready (the settlement is paid by definition of ready).
        if (ready && switches.autoCompleteExit) {
          try {
            await this.offboarding.complete(c.id, {}, actor, organizationId);
            await this.recordAutomatic(organizationId, actor, c.employeeId, c.id, 'EXIT_AUTO_COMPLETED', 'The exit was completed automatically: every item was done and the settlement was paid.');
            completed++;
            continue;
          } catch (err) {
            await this.offboarding.notifyHr(organizationId, [c.initiatedById], `Exit could not be completed automatically: ${c.employee.name}`, `${(err as Error).message}`);
          }
        }

        // 4. Remind the owners of items that are open and due.
        if (workingHours) await this.remindOwners(c, organizationId, today);
      } catch (err) {
        this.logger.error(`Offboarding case ${c.id} (org ${organizationId}): ${(err as Error).message}`);
      }
    }
    return { prepared, completed };
  }

  // True when a draft was prepared (a settlement already made for this last working day is just linked).
  private async settleOrPrepare(
    c: { id: string; employeeId: string; lastWorkingDay: string; initiatedById: string; employee: { name: string; employeeId: string } },
    actor: Actor,
    organizationId: string,
    autoPrepare: boolean,
  ): Promise<boolean> {
    const existing = await this.scopedPrisma.settlement.findFirst({
      where: { organizationId, employeeId: c.employeeId },
      orderBy: { createdAt: 'desc' },
    });
    if (existing && existing.lastWorkingDay.slice(0, 10) === c.lastWorkingDay.slice(0, 10)) {
      await this.scopedPrisma.offboardingCase.updateMany({ where: { id: c.id, organizationId }, data: { settlementId: existing.id } });
      return false;
    }
    if (!autoPrepare) return false;
    // One attempt a day: if it already failed today, HR has been told and is not told again every hour.
    const failTitle = `Final settlement could not be prepared: ${c.employee.name}`;
    const failedToday = await this.scopedPrisma.notification.findFirst({
      where: { organizationId, title: failTitle, createdAt: { gte: new Date(Date.now() - 20 * 60 * 60 * 1000) } },
      select: { id: true },
    });
    if (failedToday) return false;
    try {
      const draft = await this.settlements.calculate({ employeeId: c.employeeId, lastWorkingDay: c.lastWorkingDay } as never, actor, organizationId, { system: true });
      await this.scopedPrisma.offboardingCase.updateMany({ where: { id: c.id, organizationId }, data: { fnfPreparedAt: new Date(), settlementId: draft.id } });
      await this.recordAutomatic(organizationId, actor, c.employeeId, c.id, 'FNF_AUTO_PREPARED', `The final settlement draft for ${dmyText(c.lastWorkingDay)} was prepared automatically and linked to the exit. Review it, then process it.`);
      await this.offboarding.notifyHr(
        organizationId,
        [c.initiatedById],
        `Final settlement draft ready: ${c.employee.name}`,
        `The final settlement for ${c.employee.name} (${c.employee.employeeId}) was prepared automatically for ${dmyText(c.lastWorkingDay)} and linked to the exit. Open Settlements, review it (bonus, recoveries, notice pay), then process it.`,
      );
      return true;
    } catch (err) {
      await this.offboarding.notifyHr(
        organizationId,
        [c.initiatedById],
        failTitle,
        `${(err as Error).message} Fix it, then calculate the settlement from Payroll > Full & Final Settlement.`,
      );
      return false;
    }
  }

  private async remindOwners(c: { id: string; employeeId: string; lastWorkingDay: string; checklistMeta: unknown; employee: { name: string; employeeId: string } } & Record<string, unknown>, organizationId: string, today: string) {
    const meta = (c.checklistMeta ?? {}) as ChecklistMeta;
    const full = await this.offboarding.findOne(c.id, organizationId);
    const done = Object.fromEntries(full.checklist.map((i) => [i.key, i.done])) as Record<string, boolean>;
    for (const key of CHECKLIST_ITEM_KEYS) {
      const item = meta[key];
      if (!item?.ownerId || done[key]) continue;
      if (key === 'interview' && full.checklist.find((i) => i.key === 'interview')?.notNeeded) continue;
      if (!item.dueDate || item.dueDate > today) continue;
      const late = item.dueDate < today;
      await this.offboarding.notifyOnce(
        organizationId,
        [item.ownerId],
        `Exit task ${late ? 'overdue' : 'due today'}: ${CHECKLIST_ITEM_LABELS[key]} (${c.employee.name})`,
        `${c.employee.name} (${c.employee.employeeId}) leaves on ${dmyText(c.lastWorkingDay)}. "${CHECKLIST_ITEM_LABELS[key]}" was due ${dmyText(item.dueDate)} and is still open. Open Offboarding to finish it.`,
      );
    }
  }

  private async recordAutomatic(organizationId: string, actor: Actor, employeeId: string, caseId: string, action: string, description: string) {
    await this.auditLogService.log({
      actorId: actor.id,
      action,
      module: 'EMPLOYEE',
      organizationId,
      targetId: employeeId,
      details: { offboardingCaseId: caseId, automatic: true },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'EMPLOYEE_UPDATED',
      performedById: actor.id,
      description: `${description} (done automatically by the system)`,
    });
  }
}
