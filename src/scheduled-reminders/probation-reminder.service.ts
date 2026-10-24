// Purpose: Daily reminder that an employee's probation is about to end, so it is confirmed or extended on purpose
// instead of lapsing silently.
// Responsibilities: 15 and 7 days before User.probationEndDate (in the org's own timezone), notifies the employee's
// reporting manager and every active HR/Admin — in-app and by the PROBATION_ENDING email template.
// Important: only employees still on probation (status pending/extended/unset) are considered; an employee never
// receives the reminder about themselves; each recipient is told once per employee per milestone.
import { managerIdsOf } from '../common/managers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, ProbationStatus, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';
import {
  PROBATION_REMINDER_DAYS,
  daysBetween,
  isProbationEndOrOverdueReminderDay,
} from './reminder-dates';

@Injectable()
export class ProbationReminderService {
  private readonly logger = new Logger(ProbationReminderService.name);

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
          `Probation reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const onProbation = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        probationEndDate: { not: null },
        AND: [{ OR: [{ exitDate: null }, { exitDate: { gte: new Date().toISOString().slice(0, 10) } }] }],
        OR: [
          { probationStatus: null },
          {
            probationStatus: {
              in: [ProbationStatus.PENDING, ProbationStatus.EXTENDED],
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        employeeId: true,
        probationEndDate: true,
        reportingManagerId: true,
        additionalReportingManagerIds: true,
      },
    });
    const due = onProbation
      .map((e) => ({
        ...e,
        daysLeft: daysBetween(today, e.probationEndDate as string),
      }))
      .filter(
        (e) =>
          PROBATION_REMINDER_DAYS.includes(e.daysLeft) ||
          isProbationEndOrOverdueReminderDay(e.daysLeft),
      );
    if (due.length === 0) return 0;

    const users = await this.notifier.activeUsers(organizationId);
    const byId = new Map(users.map((u) => [u.id, u]));
    const hr = users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN);

    let sent = 0;
    for (const emp of due) {
      const recipients = new Map(hr.map((u) => [u.id, u]));
      // Every reporting manager (primary and additional) is told.
      for (const managerId of managerIdsOf(emp)) {
        const manager = byId.get(managerId);
        if (manager) recipients.set(manager.id, manager);
      }
      recipients.delete(emp.id); // never about themselves

      const endDisplay = formatDateDisplay(emp.probationEndDate, '');
      const label = `${emp.name} (${emp.employeeId})`;
      for (const user of recipients.values()) {
        // 15 and 7 days before: the "ending soon" email. On the end date and while it stays undecided afterwards: an
        // in-app notice only, since that email's wording ("ends in N days") does not fit.
        const early = PROBATION_REMINDER_DAYS.includes(emp.daysLeft);
        const title = early
          ? `Probation ending in ${emp.daysLeft} days: ${label}`
          : emp.daysLeft === 0
            ? `Probation ends today: ${label}`
            : `Probation overdue by ${-emp.daysLeft} day${emp.daysLeft === -1 ? '' : 's'}: ${label}`;
        const message = early
          ? `${label}'s probation ends on ${endDisplay}. Please confirm or extend it.`
          : emp.daysLeft === 0
            ? `${label}'s probation ends today (${endDisplay}). Please confirm or extend it.`
            : `${label}'s probation ended on ${endDisplay} and is still not confirmed or extended. Please decide it.`;
        const variables = {
          employeeName: user.name,
          subjectName: label,
          daysLeft: String(emp.daysLeft),
          probationEndDate: endDisplay,
          reviewUrl: `${frontendUrl()}/employees/${emp.id}/profile`,
        };
        const delivered = await this.notifier.send({
          organizationId,
          user,
          occasionKey: 'PROBATION_ENDING',
          variables: { ...variables },
          title,
          message,
          category: NotificationCategory.GENERAL,
          inAppOnly: !early,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
