// Purpose: tells HR when an asset's warranty is about to end, while a claim or renewal can still be made.
// Responsibilities: every day at 09:20, for each organisation with the Assets module on, finds assets still in use (not lost,
//   retired or disposed) whose warranty ends within 30 days, and notifies every active HR/Admin once at the 30-day mark and
//   once more when 7 days or fewer are left.
// Important: reminder only - nothing about the asset changes. Each reminder is sent once per asset per mark; that is read from
//   the HR users' own notifications (the title carries the asset code and the mark), so no new column is needed.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AssetInventoryStatus, NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { keepModuleEnabled } from '../module-access/module-gate';
import { todayInOrgTz } from '../common/org-date';
import { dmyText } from '../payroll/format-date';

export const WARRANTY_REMINDER_DAYS = [30, 7] as const;

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);

/** Days from `today` to the warranty end (negative once it has ended). */
export const warrantyDaysLeft = (today: string, endDate: string): number => dayNumber(endDate) - dayNumber(today);

/** The tightest reminder mark an asset is inside (7 or 30), or null when it is further out than 30 days or already ended. */
export function warrantyMark(daysLeft: number): 7 | 30 | null {
  if (daysLeft < 0 || daysLeft > 30) return null;
  return daysLeft <= 7 ? 7 : 30;
}

export const warrantyReminderTitle = (assetCode: string, mark: 7 | 30) =>
  mark === 7 ? `Warranty ends this week: ${assetCode}` : `Warranty ending soon: ${assetCode}`;

@Injectable()
export class AssetWarrantyReminderService {
  private readonly logger = new Logger(AssetWarrantyReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron('20 9 * * *')
  async daily() {
    const all = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    const orgs = await keepModuleEnabled(all, 'module.assets');
    for (const org of orgs) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(`Warranty reminder failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  // Returns how many assets a reminder went out for.
  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const horizon = new Date(`${today}T00:00:00.000Z`);
    horizon.setUTCDate(horizon.getUTCDate() + 30);
    const assets = await this.scopedPrisma.asset.findMany({
      where: {
        organizationId,
        isActive: true,
        status: { notIn: [AssetInventoryStatus.LOST, AssetInventoryStatus.RETIRED, AssetInventoryStatus.DISPOSED] },
        warrantyEndDate: { gte: new Date(`${today}T00:00:00.000Z`), lte: horizon },
      },
      select: { id: true, assetCode: true, assetName: true, warrantyEndDate: true },
    });
    if (assets.length === 0) return 0;
    const recipients = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    if (recipients.length === 0) return 0;
    let sent = 0;
    for (const a of assets) {
      const end = (a.warrantyEndDate as Date).toISOString().slice(0, 10);
      const mark = warrantyMark(warrantyDaysLeft(today, end));
      if (!mark) continue;
      const title = warrantyReminderTitle(a.assetCode, mark);
      const already = await this.scopedPrisma.notification.findFirst({ where: { organizationId, title }, select: { id: true } });
      if (already) continue;
      await this.notificationsService.createMany(
        recipients.map((r) => ({
          organizationId,
          userId: r.id,
          title,
          message: `The warranty on ${a.assetName} (${a.assetCode}) ends on ${dmyText(end)}. Raise any claim or renewal before then.`,
          category: NotificationCategory.GENERAL,
        })),
      );
      sent += 1;
    }
    return sent;
  }
}
