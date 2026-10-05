// Purpose: Morning nudge to employees who punched in yesterday but never punched out, so they regularize it before
// payroll silently shortchanges the day.
// Responsibilities: for each org's own "yesterday", finds attendance rows with a punch-in, no punch-out and no
// regularization already requested, and notifies the employee in-app and by the MISSED_PUNCH_OUT template.
// Important: at most one nudge per employee per date (notification title carries the date). Runs after the 01:00
// absence job and the 09:00 digests, at 10:00, when people are at their desks.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { yesterdayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';

@Injectable()
export class MissedPunchOutService {
  private readonly logger = new Logger(MissedPunchOutService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('0 10 * * *')
  async sendDailyReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    const now = new Date();
    for (const org of organizations) {
      try {
        await this.remindForOrg(
          org.id,
          yesterdayInOrgTz(org.timezone, now),
          org.timezone,
        );
      } catch (err) {
        this.logger.error(
          `Missed punch-out reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(
    organizationId: string,
    date: string,
    timezone: string,
  ): Promise<number> {
    const rows = await this.scopedPrisma.attendance.findMany({
      where: {
        organizationId,
        date,
        inTime: { not: null },
        outTime: null,
        NOT: { regularization: { path: ['status'], equals: 'pending' } },
        employee: { isActive: true },
      },
      select: {
        inTime: true,
        employee: {
          select: {
            id: true,
            name: true,
            email: true,
            notificationPreferences: true,
          },
        },
      },
    });
    const displayDate = formatDateDisplay(date, '');
    let sent = 0;
    for (const row of rows) {
      const inTime = row.inTime!.toLocaleTimeString('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
      });
      const delivered = await this.notifier.send({
        organizationId,
        user: row.employee,
        occasionKey: 'MISSED_PUNCH_OUT',
        variables: {
          employeeName: row.employee.name,
          date: displayDate,
          inTime,
          reviewUrl: `${frontendUrl()}/attendance`,
        },
        title: `You did not punch out on ${displayDate}`,
        message: `No punch-out was recorded for ${displayDate}. Request a regularization so your hours are correct.`,
        category: NotificationCategory.ATTENDANCE,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}
