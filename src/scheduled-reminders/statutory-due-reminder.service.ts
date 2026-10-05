// Purpose: Daily reminder to HR/Admin ahead of statutory payment and filing due dates (PF/ESI/PT/LWF payments,
// salary TDS deposit, Form 24Q).
// Responsibilities: 5 days and 1 day before each due date (see upcomingStatutoryDues), notifies every active HR and
// Admin — in-app and by the STATUTORY_DUE_REMINDER email template.
// Important: payment reminders (PF/ESI/PT/LWF) are sent only for statutory modules the org has switched on; TDS
// always applies once payroll runs. The dates are the standard ones — the message asks HR to verify them.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';
import { upcomingStatutoryDues } from './reminder-dates';

@Injectable()
export class StatutoryDueReminderService {
  private readonly logger = new Logger(StatutoryDueReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('0 9 * * *')
  async sendDailyReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(
          `Statutory due reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const versions = await this.scopedPrisma.statutoryConfigVersion.findMany({
      where: {
        organizationId,
        isEnabled: true,
        module: { in: ['PF', 'ESI', 'PT', 'LWF'] },
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      select: { module: true },
    });
    const dues = upcomingStatutoryDues(
      today,
      new Set(versions.map((v) => v.module)),
    );
    if (dues.length === 0) return 0;

    const recipients = (await this.notifier.activeUsers(organizationId)).filter(
      (u) => u.role === Role.HR || u.role === Role.ADMIN,
    );
    let sent = 0;
    for (const due of dues) {
      const dueDate = formatDateDisplay(due.dueDate, '');
      for (const user of recipients) {
        const delivered = await this.notifier.send({
          organizationId,
          user,
          occasionKey: 'STATUTORY_DUE_REMINDER',
          variables: {
            employeeName: user.name,
            dueLabel: due.label,
            dueDate,
            duePeriod: due.period,
            daysLeft: String(due.daysLeft),
            reviewUrl: `${frontendUrl()}/statutory-compliance`,
          },
          title: `${due.label} due on ${dueDate} (${due.daysLeft} day${due.daysLeft === 1 ? '' : 's'} to go)`,
          message: `${due.label} for ${due.period} is due on ${dueDate}. Please confirm the date for your registration category.`,
          category: NotificationCategory.PAYROLL,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
