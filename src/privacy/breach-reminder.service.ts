// Purpose: reminds the Admins that a breach incident's report to the Data Protection Board is due (72 hours from detection).
// Responsibilities: hourly, for every open incident whose Board report is still owed, tells each active Admin once when 24 hours
//   or less are left and once when the deadline has passed.
// Important: each reminder is stamped on the incident (dueSoonRemindedAt / overdueRemindedAt) so it goes at most once; an
//   incident detected long ago gets only the overdue one. Nothing else is changed.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BreachNotificationStatus,
  BreachStatus,
  NotificationCategory,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import {
  formatDateTimeDisplay,
  resolveOrgDateTimeFormat,
} from '../payroll/format-date';
import {
  BOARD_REPORT_HOURS,
  DUE_SOON_HOURS,
  boardReportDueAt,
} from './breach-deadline';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class BreachReminderService {
  private readonly logger = new Logger(BreachReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    const orgs = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of orgs) {
      try {
        await this.remindForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `Breach deadline reminder failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Returns how many incidents a reminder went out for.
  async remindForOrg(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const owed = await this.scopedPrisma.breachIncident.findMany({
      where: {
        organizationId,
        status: BreachStatus.OPEN,
        notificationStatus: { not: BreachNotificationStatus.NOT_REQUIRED },
        boardReportedAt: null,
        overdueRemindedAt: null,
        detectedAt: {
          lte: new Date(
            now.getTime() - (BOARD_REPORT_HOURS - DUE_SOON_HOURS) * HOUR_MS,
          ),
        },
      },
      select: {
        id: true,
        incidentNo: true,
        title: true,
        detectedAt: true,
        dueSoonRemindedAt: true,
      },
    });
    if (owed.length === 0) return 0;
    const [admins, fmt] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, role: Role.ADMIN },
        select: { id: true },
      }),
      resolveOrgDateTimeFormat(this.scopedPrisma, organizationId),
    ]);
    const at = (d: Date) =>
      formatDateTimeDisplay(
        d,
        '',
        fmt.dateFormat,
        fmt.timeFormat,
        fmt.timeZone,
      );
    let sent = 0;
    for (const b of owed) {
      const due = boardReportDueAt(b.detectedAt);
      const overdue = due.getTime() < now.getTime();
      if (!overdue && b.dueSoonRemindedAt) continue;
      const name = `${b.incidentNo}${b.title ? ` (${b.title})` : ''}`;
      const title = overdue
        ? `Breach report to the Board is overdue: ${b.incidentNo}`
        : `Breach report to the Board due soon: ${b.incidentNo}`;
      const message = overdue
        ? `The detailed report on ${name} to the Data Protection Board was due by ${at(due)}. Send it, then record the date under Data Privacy > Breaches - or mark the incident Not required if it does not need reporting.`
        : `The detailed report on ${name} to the Data Protection Board is due by ${at(due)}. Record the date under Data Privacy > Breaches once it is sent.`;
      await this.notificationsService.createMany(
        admins.map((a) => ({
          organizationId,
          userId: a.id,
          title,
          message,
          category: NotificationCategory.GENERAL,
        })),
      );
      await this.scopedPrisma.breachIncident.updateMany({
        where: { id: b.id, organizationId },
        data: overdue
          ? {
              overdueRemindedAt: now,
              dueSoonRemindedAt: b.dueSoonRemindedAt ?? now,
            }
          : { dueSoonRemindedAt: now },
      });
      sent++;
    }
    return sent;
  }
}
