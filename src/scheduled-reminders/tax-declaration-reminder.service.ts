// Purpose: Reminds employees to submit their investment/tax declaration while there is still time to affect TDS.
// Responsibilities: on the day the declaration window opens (first day of the financial year) and every 7 days
// after it until the deadline (last day of the month three months before year-end — 31 January for an April
// start), notifies active employees whose declaration for the current financial year is missing or still a draft,
// via TAX_DECLARATION_REMINDER. See taxDeclarationWindow for the window rule.
// Important: nothing is sent for an org that switched tax declarations off (Organization Settings), and employees
// who already submitted (or were verified) are left alone. The window dates are a convention, not configurable yet.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, TaxDeclarationStatus } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { ReminderNotifier } from './reminder-notifier.service';
import {
  isTaxDeclarationReminderDay,
  taxDeclarationWindow,
} from './reminder-dates';

@Injectable()
export class TaxDeclarationReminderService {
  private readonly logger = new Logger(TaxDeclarationReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
    private readonly payrollSettings: PayrollSettingsService,
  ) {}

  @Cron('30 9 * * *')
  async sendReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(
          `Tax declaration reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const [settings, org] = await Promise.all([
      this.payrollSettings.getOrCreate(organizationId),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { attendancePayrollPrefs: true },
      }),
    ]);
    const prefs = (org?.attendancePayrollPrefs ?? {}) as {
      enableTaxDeclaration?: boolean;
    };
    if (prefs.enableTaxDeclaration === false) return 0;

    const window = taxDeclarationWindow(
      today,
      Number(settings.financialYearStartMonth) || 4,
    );
    if (!isTaxDeclarationReminderDay(today, window)) return 0;

    const [users, done] = await Promise.all([
      this.notifier.activeUsers(organizationId),
      this.scopedPrisma.employeeTaxDeclaration.findMany({
        where: {
          organizationId,
          financialYear: window.financialYear,
          status: {
            in: [TaxDeclarationStatus.SUBMITTED, TaxDeclarationStatus.VERIFIED],
          },
        },
        select: { employeeId: true },
      }),
    ]);
    const doneIds = new Set(done.map((d) => d.employeeId));
    const deadline = formatDateDisplay(window.deadline, '');
    const displayToday = formatDateDisplay(today, '');

    let sent = 0;
    for (const user of users) {
      if (doneIds.has(user.id)) continue;
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'TAX_DECLARATION_REMINDER',
        variables: {
          employeeName: user.name,
          financialYear: window.financialYear,
          deadline,
          reviewUrl: `${frontendUrl()}/tax-declaration`,
        },
        title: `Submit your tax declaration for FY ${window.financialYear} (${displayToday})`,
        message: `Your investment declaration for FY ${window.financialYear} is not submitted yet. Submit it by ${deadline} so your TDS reflects it.`,
        category: NotificationCategory.PAYROLL,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}
