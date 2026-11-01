// Purpose: Three scheduled emails to employees - return your assets before you leave, your loan EMI this month, and finish your onboarding.
// Responsibilities: ASSET_RETURN_REMINDER daily (people whose last working day is within 7 days and who still hold allocated
//   assets), LOAN_EMI_DUE on the 1st of the month (active loans with a balance), ONBOARDING_REMINDER every Monday (people still
//   in onboarding). Each goes through ReminderNotifier, which respects preferences, the template's on/off switch and de-duplicates.
// Important: asset reminders are keyed to the exit date (assets carry no expected-return date of their own).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoanStatus, NotificationCategory } from '@prisma/client';
import { keepModuleEnabled } from '../module-access/module-gate';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class NewEmailRemindersService {
  private readonly logger = new Logger(NewEmailRemindersService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  private async eachOrg(moduleKey: string, label: string, run: (orgId: string, today: string) => Promise<number>) {
    const all = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    for (const org of await keepModuleEnabled(all, moduleKey)) {
      try {
        await run(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(`${label} failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  @Cron('15 9 * * *')
  async sendAssetReturnReminders() {
    await this.eachOrg('module.offboarding', 'Asset return reminders', (orgId, today) => this.assetReturnForOrg(orgId, today));
  }

  async assetReturnForOrg(organizationId: string, today: string): Promise<number> {
    const leaving = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, exitDate: { gte: today, lte: addDays(today, 7) } },
      select: { id: true, name: true, email: true, role: true, reportingManagerId: true, notificationPreferences: true, exitDate: true },
    });
    let sent = 0;
    for (const user of leaving) {
      const assets = await this.scopedPrisma.employeeAsset.findMany({
        where: { organizationId, employeeId: user.id, isActive: true, status: 'ALLOCATED' },
        select: { assetName: true, assetTag: true },
      });
      if (assets.length === 0) continue;
      const lwd = formatDateDisplay(user.exitDate as string, '');
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'ASSET_RETURN_REMINDER',
        variables: {
          employeeName: user.name,
          lastWorkingDay: lwd,
          assetCount: String(assets.length),
          assetList: assets.map((a) => (a.assetTag ? `${a.assetName} (${a.assetTag})` : a.assetName)).join(', '),
        },
        title: `Return your company assets before ${lwd}`,
        message: `You still hold ${assets.length} company asset(s). Please return them to HR before your last working day, ${lwd}.`,
        category: NotificationCategory.GENERAL,
        dedupeWithinHours: 24 * 3,
      });
      if (delivered) sent++;
    }
    return sent;
  }

  @Cron('0 9 1 * *')
  async sendLoanEmiReminders() {
    await this.eachOrg('module.payroll', 'Loan EMI reminders', (orgId, today) => this.loanEmiForOrg(orgId, today));
  }

  async loanEmiForOrg(organizationId: string, today: string): Promise<number> {
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const [loans, users] = await Promise.all([
      this.scopedPrisma.loan.findMany({
        where: { organizationId, status: LoanStatus.ACTIVE, outstandingBalance: { gt: 0 } },
        select: { id: true, employeeId: true, loanType: true, emiAmount: true, outstandingBalance: true, startMonth: true, startYear: true },
      }),
      this.notifier.activeUsers(organizationId),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    let sent = 0;
    for (const loan of loans) {
      const user = byId.get(loan.employeeId);
      if (!user || loan.startYear * 12 + loan.startMonth > year * 12 + month) continue;
      const label = `${MONTHS[month - 1]} ${year}`;
      const kind = String(loan.loanType).toLowerCase();
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'LOAN_EMI_DUE',
        variables: {
          employeeName: user.name,
          loanType: kind,
          month: label,
          emiAmount: `₹${Math.min(loan.emiAmount, loan.outstandingBalance)}`,
          outstanding: `₹${loan.outstandingBalance}`,
        },
        title: `Your ${kind} EMI for ${label}`,
        message: `₹${Math.min(loan.emiAmount, loan.outstandingBalance)} will be deducted from your ${label} salary for your ${kind}.`,
        category: NotificationCategory.PAYROLL,
        dedupeWithinHours: 24 * 20,
      });
      if (delivered) sent++;
    }
    return sent;
  }

  @Cron('30 9 * * 1')
  async sendOnboardingReminders() {
    await this.eachOrg('module.documents_letters', 'Onboarding reminders', (orgId) => this.onboardingForOrg(orgId));
  }

  async onboardingForOrg(organizationId: string): Promise<number> {
    const users = await this.notifier.activeUsers(organizationId);
    const onboarding = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, employmentStatus: 'ONBOARDING' },
      select: { id: true },
    });
    const ids = new Set(onboarding.map((u) => u.id));
    let sent = 0;
    for (const user of users) {
      if (!ids.has(user.id)) continue;
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'ONBOARDING_REMINDER',
        variables: {
          employeeName: user.name,
          pendingItems: 'Complete your profile details and upload your mandatory documents',
          profileUrl: `${frontendUrl()}/profile`,
        },
        title: 'Please complete your onboarding',
        message: 'Your profile is not complete yet. Finish your details and upload your mandatory documents.',
        category: NotificationCategory.GENERAL,
        dedupeWithinHours: 24 * 6,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}
