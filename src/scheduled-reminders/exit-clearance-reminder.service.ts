// Purpose: Keeps an exit on track as the last working day approaches — the leaver returns assets and hands over,
// and HR/the manager can see what clearance is still open.
// Responsibilities: daily, for every offboarding case still INITIATED/IN_PROGRESS, 14, 7, 3 and 1 days before the
// last working day and on the day itself:
//   - the leaver gets EXIT_HANDOVER_REMINDER (return assets, hand over work, exit interview if pending);
//   - the reporting manager and every active HR/Admin get EXIT_CLEARANCE_REMINDER listing what is still open
//     (assets not returned, exit interview, F&F settlement, system access) — only when something is open.
// Important: the date in each title keeps one reminder per milestone per person; a cancelled or completed case is
// never reminded.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AssetStatus,
  NotificationCategory,
  OffboardingStatus,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { ReminderNotifier } from './reminder-notifier.service';
import { EXIT_REMINDER_DAYS, daysBetween } from './reminder-dates';

@Injectable()
export class ExitClearanceReminderService {
  private readonly logger = new Logger(ExitClearanceReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('45 9 * * *')
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
          `Exit clearance reminders failed for org ${org.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    const cases = (
      await this.scopedPrisma.offboardingCase.findMany({
        where: {
          organizationId,
          status: {
            in: [OffboardingStatus.INITIATED, OffboardingStatus.IN_PROGRESS],
          },
        },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeId: true,
              reportingManagerId: true,
            },
          },
        },
      })
    )
      .map((c) => ({ ...c, daysLeft: daysBetween(today, c.lastWorkingDay) }))
      .filter((c) => EXIT_REMINDER_DAYS.includes(c.daysLeft));
    if (cases.length === 0) return 0;

    const users = await this.notifier.activeUsers(organizationId);
    const byId = new Map(users.map((u) => [u.id, u]));
    const hr = users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN);
    const allocated = await this.scopedPrisma.employeeAsset.findMany({
      where: {
        organizationId,
        employeeId: { in: cases.map((c) => c.employeeId) },
        status: AssetStatus.ALLOCATED,
        isActive: true,
      },
      select: { employeeId: true, assetName: true },
    });
    const assetsByEmployee = new Map<string, string[]>();
    for (const a of allocated) {
      const list = assetsByEmployee.get(a.employeeId) ?? [];
      list.push(a.assetName);
      assetsByEmployee.set(a.employeeId, list);
    }

    let sent = 0;
    for (const c of cases) {
      const lwd = formatDateDisplay(c.lastWorkingDay, '');
      const when =
        c.daysLeft === 0
          ? 'today'
          : `in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`;
      const label = `${c.employee.name} (${c.employee.employeeId})`;
      const assets = assetsByEmployee.get(c.employeeId) ?? [];

      const open: string[] = [];
      if (assets.length > 0 || !c.assetsReturned)
        open.push(
          assets.length > 0
            ? `Assets to return: ${assets.join(', ')}`
            : 'Asset return not confirmed',
        );
      if (!c.exitInterviewDone) open.push('Exit interview pending');
      if (!c.settlementId) open.push('Full & final settlement not started');
      if (!c.accessRevoked) open.push('System access not yet revoked');

      // The leaver.
      const leaver = byId.get(c.employeeId);
      if (leaver) {
        const tasks = [
          assets.length > 0
            ? `return ${assets.join(', ')}`
            : 'confirm all company assets are returned',
          'hand over your work and pending tasks',
          ...(c.exitInterviewDone ? [] : ['complete your exit interview']),
        ];
        const delivered = await this.notifier.send({
          organizationId,
          user: leaver,
          occasionKey: 'EXIT_HANDOVER_REMINDER',
          variables: {
            employeeName: leaver.name,
            lastWorkingDay: lwd,
            when,
            tasks: tasks.join('; '),
            reviewUrl: frontendUrl(),
          },
          title: `Your last working day is ${lwd} (${when})`,
          message: `Before you leave: ${tasks.join('; ')}.`,
          category: NotificationCategory.GENERAL,
        });
        if (delivered) sent++;
      }

      // HR/Admin and the manager, only while clearance is still open.
      if (open.length === 0) continue;
      const recipients = new Map(hr.map((u) => [u.id, u]));
      const manager = c.employee.reportingManagerId
        ? byId.get(c.employee.reportingManagerId)
        : undefined;
      if (manager) recipients.set(manager.id, manager);
      recipients.delete(c.employeeId);
      for (const user of recipients.values()) {
        const delivered = await this.notifier.send({
          organizationId,
          user,
          occasionKey: 'EXIT_CLEARANCE_REMINDER',
          variables: {
            employeeName: user.name,
            subjectName: label,
            lastWorkingDay: lwd,
            when,
            openItems: open.join('; '),
            reviewUrl: `${frontendUrl()}/offboarding`,
          },
          title: `Exit clearance open for ${label}: last day ${lwd} (${when})`,
          message: open.join('; '),
          category: NotificationCategory.GENERAL,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
