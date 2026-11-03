// Purpose: Daily reminder to HR/Admin ahead of statutory payment and filing due dates (PF/ESI/PT/LWF payments,
// salary TDS deposit, Form 24Q).
// Responsibilities: 5 days and 1 day before each due date (see upcomingStatutoryDues), notifies every active HR and
// Admin — in-app and by the STATUTORY_DUE_REMINDER email template.
// Important: payment reminders (PF/ESI/PT/LWF) are sent only for statutory modules the org has switched on; TDS
// always applies once payroll runs. The dates are the standard ones — the message asks HR to verify them.
import { keepModuleEnabled } from '../module-access/module-gate';
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
    const allOrganizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(allOrganizations, 'module.statutory');
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
    // Reminders before the due date (5 and 1 days) and, for anything still not marked filed, a chase 1 and 7 days after it.
    const filedKeys = new Set(
      (await this.scopedPrisma.statutoryFiling.findMany({ where: { organizationId }, select: { key: true, dueDate: true } })).map((f) => `${f.key}|${f.dueDate}`),
    );
    const dues = upcomingStatutoryDues(
      today,
      new Set(versions.map((v) => v.module)),
      [5, 1, -1, -7],
    ).filter((d) => !filedKeys.has(`${d.key}|${d.dueDate}`));
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
          title: due.daysLeft < 0
            ? `${due.label} was due on ${dueDate} (${-due.daysLeft} day${due.daysLeft === -1 ? '' : 's'} ago)`
            : `${due.label} due on ${dueDate} (${due.daysLeft} day${due.daysLeft === 1 ? '' : 's'} to go)`,
          message: due.daysLeft < 0
            ? `${due.label} for ${due.period} is not marked filed. File it, then mark it filed in Statutory Compliance so the reminders stop.`
            : `${due.label} for ${due.period} is due on ${dueDate}. Download the file from Statutory Compliance, file it, then mark it filed.`,
          category: NotificationCategory.PAYROLL,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
