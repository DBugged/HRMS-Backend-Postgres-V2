// Purpose: tells the Admins when former employees' profile data is past the retention period they configured.
// Responsibilities: every Monday 09:30, for each organisation with an employee-profile retention rule that has a period,
//   counts inactive (separated) employees whose record has not changed for that many months and tells each active Admin
//   once a month to review them under Data Privacy.
// Important: this only REMINDS - nothing is deleted or anonymised here (retention is always a human decision, see
//   privacy-defaults.ts). The once-a-month limit is read from the Admins' own notifications, so no new column is needed.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PrivacyService } from './privacy.service';
import type { RetentionRule } from './privacy-defaults';

const TITLE = 'Retention review due for former employees';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class RetentionReminderService {
  private readonly logger = new Logger(RetentionReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly privacyService: PrivacyService,
  ) {}

  @Cron('30 9 * * 1')
  async weekly() {
    const orgs = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of orgs) {
      try {
        await this.remindForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `Retention reminder failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Returns how many former employees were found past retention (0 when nothing was sent).
  async remindForOrg(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const settings = await this.privacyService.ensureSettings(organizationId);
    const rule = (
      (settings.retentionRules as unknown as RetentionRule[]) ?? []
    ).find((r) => r.dataType === 'employee_profile');
    if (!rule?.periodMonths) return 0;

    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - rule.periodMonths);
    const due = await this.scopedPrisma.user.count({
      where: { organizationId, isActive: false, updatedAt: { lt: cutoff } },
    });
    if (due === 0) return 0;

    const admins = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: Role.ADMIN },
      select: { id: true },
    });
    if (admins.length === 0) return 0;

    // Once a month: skip if the Admins were already told within the last 30 days.
    const recent = await this.scopedPrisma.notification.findFirst({
      where: {
        organizationId,
        title: TITLE,
        createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
      },
      select: { id: true },
    });
    if (recent) return due;

    await this.notificationsService.createMany(
      admins.map((a) => ({
        organizationId,
        userId: a.id,
        title: TITLE,
        message: `${due} former employee${due === 1 ? ' is' : 's are'} past the ${rule.periodMonths}-month retention period for employee profile data. Review them under Data Privacy > Retention and archive or anonymise as your policy says. Nothing is deleted automatically.`,
        category: NotificationCategory.GENERAL,
      })),
    );
    return due;
  }
}
