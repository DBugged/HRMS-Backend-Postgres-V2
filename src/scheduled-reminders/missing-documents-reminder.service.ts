// Purpose: Weekly nudge for employees who still owe mandatory onboarding documents, plus a summary for HR.
// Responsibilities: every Monday 09:00, for each org's active mandatory DocumentRequirements, finds active employees
// with no uploaded document of that type that isn't REJECTED (same rule that gates profile completion — see
// areMandatoryDocumentsUploaded) and notifies each employee of what is missing (MISSING_DOCUMENTS_REMINDER) and
// every active HR/Admin of how many employees are outstanding (MISSING_DOCUMENTS_SUMMARY).
// Important: documents carry no expiry date in the data model, so expiry reminders are not possible yet; this job
// covers missing and rejected documents only. Founder/Admin accounts are included like anyone else.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  EmployeeDocumentCategory,
  NotificationCategory,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';

@Injectable()
export class MissingDocumentsReminderService {
  private readonly logger = new Logger(MissingDocumentsReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('0 9 * * 1')
  async sendWeeklyReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(
          `Missing-documents reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const requirements = await this.scopedPrisma.documentRequirement.findMany({
      where: { organizationId, isMandatory: true, isActive: true },
      select: { name: true },
    });
    if (requirements.length === 0) return 0;

    const [users, documents] = await Promise.all([
      this.notifier.activeUsers(organizationId),
      this.scopedPrisma.employeeDocument.findMany({
        where: {
          organizationId,
          category: EmployeeDocumentCategory.DOCUMENT,
          status: { not: 'REJECTED' },
        },
        select: { employeeId: true, docType: true },
      }),
    ]);
    const haveByEmployee = new Map<string, Set<string>>();
    for (const d of documents) {
      const set = haveByEmployee.get(d.employeeId) ?? new Set<string>();
      set.add(d.docType);
      haveByEmployee.set(d.employeeId, set);
    }

    const displayToday = formatDateDisplay(today, '');
    let sent = 0;
    let outstanding = 0;
    for (const user of users) {
      const have = haveByEmployee.get(user.id) ?? new Set<string>();
      const missing = requirements
        .map((r) => r.name)
        .filter((name) => !have.has(name));
      if (missing.length === 0) continue;
      outstanding++;
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'MISSING_DOCUMENTS_REMINDER',
        variables: {
          employeeName: user.name,
          missingCount: String(missing.length),
          missingDocuments: missing.join(', '),
          reviewUrl: `${frontendUrl()}/profile`,
        },
        title: `${missing.length} required document(s) still missing (${displayToday})`,
        message: `Please upload: ${missing.join(', ')}.`,
        category: NotificationCategory.GENERAL,
      });
      if (delivered) sent++;
    }

    if (outstanding > 0) {
      for (const hr of users.filter(
        (u) => u.role === Role.HR || u.role === Role.ADMIN,
      )) {
        const delivered = await this.notifier.send({
          organizationId,
          user: hr,
          occasionKey: 'MISSING_DOCUMENTS_SUMMARY',
          variables: {
            employeeName: hr.name,
            employeeCount: String(outstanding),
            reviewUrl: `${frontendUrl()}/pending-onboarding`,
          },
          title: `${outstanding} employee(s) have required documents missing (${displayToday})`,
          message: `${outstanding} employee(s) have not uploaded all mandatory documents.`,
          category: NotificationCategory.GENERAL,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
