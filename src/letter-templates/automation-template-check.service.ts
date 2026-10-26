// Purpose: tells HR when a letter or email the system sends by itself cannot go out, because its template is missing or
//   switched off - otherwise that automation would quietly do nothing.
// Responsibilities: check() returns the gaps for a company (the Letter Templates screen shows them); a weekly job (Monday 09:30)
//   notifies every active HR/Admin of a company that has any, once a week per gap list.
// Important: read-only apart from the notification. It never switches a template on or creates one - that is HR's call.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { keepModuleEnabled } from '../module-access/module-gate';
import { AUTOMATION_TEMPLATES, findTemplateGaps } from './automation-templates';

const WEEK_MS = 6 * 24 * 60 * 60 * 1000;

@Injectable()
export class AutomationTemplateCheckService {
  private readonly logger = new Logger(AutomationTemplateCheckService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  async check(organizationId: string) {
    const [letters, emails] = await Promise.all([
      this.scopedPrisma.letterTemplate.findMany({
        where: { organizationId, key: { in: AUTOMATION_TEMPLATES.filter((t) => t.kind === 'letter').map((t) => t.key) } },
        select: { key: true, isActive: true },
      }),
      this.scopedPrisma.emailTemplate.findMany({
        where: { organizationId, occasionKey: { in: AUTOMATION_TEMPLATES.filter((t) => t.kind === 'email').map((t) => t.key) } },
        select: { occasionKey: true, isActive: true },
      }),
    ]);
    return findTemplateGaps(letters, emails);
  }

  @Cron('30 9 * * 1')
  async weekly() {
    const all = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true } });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(all, 'module.documents_letters');
    for (const org of organizations) {
      try {
        await this.notifyForOrg(org.id);
      } catch (err) {
        this.logger.error(`Template check failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  // Returns how many people were told.
  async notifyForOrg(organizationId: string): Promise<number> {
    const gaps = await this.check(organizationId);
    if (gaps.length === 0) return 0;
    const title = `${gaps.length} automatic letter/email template${gaps.length === 1 ? ' needs' : 's need'} attention`;
    const message =
      gaps.map((g) => `${g.label} (${g.problem === 'MISSING' ? 'missing' : 'switched off'}): ${g.usedFor}`).join('. ') +
      '. Until fixed, these are not sent. Open Letter Templates or Email Templates to switch them on.';
    const people = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    const recent = await this.scopedPrisma.notification.findMany({
      where: { organizationId, title, createdAt: { gte: new Date(Date.now() - WEEK_MS) } },
      select: { userId: true },
    });
    const already = new Set(recent.map((n) => n.userId));
    const toTell = people.filter((p) => !already.has(p.id));
    await this.notificationsService.createMany(
      toTell.map((p) => ({ organizationId, userId: p.id, title, message, category: NotificationCategory.GENERAL })),
    );
    return toTell.length;
  }
}
