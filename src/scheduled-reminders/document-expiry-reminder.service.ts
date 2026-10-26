// Purpose: Daily reminder that an employee document (passport, visa, licence, certificate) is about to expire, so it is
//   renewed before it lapses.
// Responsibilities: 30, 15 and 7 days before EmployeeDocument.expiryDate, and on the day (in the org's own timezone), tells the
//   document's owner (in-app plus the DOCUMENT_EXPIRING email) and every active HR/Admin (in-app only, naming the person).
// Important: rejected documents and letters are skipped; each recipient is told once per document per milestone (the title
//   carries the document and the milestone, which the notifier dedupes on). An already-expired document is not repeated daily.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmployeeDocumentCategory, EmployeeDocumentStatus, NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { keepModuleEnabled } from '../module-access/module-gate';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';
import { daysBetween } from './reminder-dates';

/** Days before the expiry date a reminder goes out (0 = on the day). */
export const DOCUMENT_EXPIRY_REMINDER_DAYS = [30, 15, 7, 0];

/** "in 15 days" / "today" - the wording used in the reminder. */
export const expiryWhen = (daysLeft: number): string => (daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);

@Injectable()
export class DocumentExpiryReminderService {
  private readonly logger = new Logger(DocumentExpiryReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('20 9 * * *')
  async sendDailyReminders() {
    const all = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    // Skip companies whose Super Admin switched this module off.
    const organizations = await keepModuleEnabled(all, 'module.documents_letters');
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(`Document expiry reminders failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const documents = await this.scopedPrisma.employeeDocument.findMany({
      where: {
        organizationId,
        expiryDate: { not: null },
        category: EmployeeDocumentCategory.DOCUMENT,
        status: { not: EmployeeDocumentStatus.REJECTED },
      },
      select: { id: true, employeeId: true, docType: true, expiryDate: true },
    });
    const due = documents
      .map((d) => ({ ...d, daysLeft: daysBetween(today, d.expiryDate as string) }))
      .filter((d) => DOCUMENT_EXPIRY_REMINDER_DAYS.includes(d.daysLeft));
    if (due.length === 0) return 0;

    const users = await this.notifier.activeUsers(organizationId);
    const byId = new Map(users.map((u) => [u.id, u]));
    const hr = users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN);

    let sent = 0;
    for (const doc of due) {
      const owner = byId.get(doc.employeeId);
      // Someone who has left (not among the active users) is not reminded of anything.
      if (!owner) continue;
      const expiry = formatDateDisplay(doc.expiryDate, '');
      const when = expiryWhen(doc.daysLeft);
      const reviewUrl = `${frontendUrl()}/employees/${owner.id}/profile`;

      const ownerDelivered = await this.notifier.send({
        organizationId,
        user: owner,
        occasionKey: 'DOCUMENT_EXPIRING',
        variables: { employeeName: owner.name, documentName: doc.docType, expiryDate: expiry, when, reviewUrl },
        title: `Your ${doc.docType} expires ${when}`,
        message: `Your ${doc.docType} expires on ${expiry}. Please upload the renewed document.`,
        category: NotificationCategory.GENERAL,
      });
      if (ownerDelivered) sent++;

      for (const user of hr) {
        if (user.id === owner.id) continue;
        const delivered = await this.notifier.send({
          organizationId,
          user,
          occasionKey: 'DOCUMENT_EXPIRING',
          variables: {},
          title: `${doc.docType} of ${owner.name} expires ${when}`,
          message: `${owner.name}'s ${doc.docType} expires on ${expiry}. They have been reminded to upload the renewed document.`,
          category: NotificationCategory.GENERAL,
          inAppOnly: true,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
