// Purpose: nudges the people who handle a resignation while it is still waiting for a decision.
// Responsibilities: daily, for every PENDING resignation whose age is 2 days, then every 2 days (2, 4, 6 ...), the reporting
//   manager(s) and HR get a reminder (in-app and email, honouring each person's preference and the company's template switch).
//   An Admin is reminded only when the employee is HR/Admin (whom only an Admin decides) or the company has no HR user.
// Important: the age is derived from when it was submitted, so no marker is stored; the title carries the number of days, so a
//   re-run on the same day never reminds twice. Separate from ApprovalEscalationService, which escalates the same request to
//   Admin every 3 days: this one goes to the people who first received it. A decided or withdrawn resignation is never reminded.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, ResignationStatus, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { keepModuleEnabled } from '../module-access/module-gate';
import { frontendUrl } from '../common/frontend-url';
import { formatDateDisplay } from '../payroll/format-date';
import { findResignationApprovers } from '../resignations/resignation-approvers';
import { ReminderNotifier } from './reminder-notifier.service';
import { isResignationReminderDue } from './reminder-dates';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ResignationReminderService {
  private readonly logger = new Logger(ResignationReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('35 9 * * *')
  async remindDaily() {
    const all = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true } });
    // Skip companies whose Super Admin switched the exit module off.
    const orgs = await keepModuleEnabled(all, 'module.offboarding');
    const now = new Date();
    for (const org of orgs) {
      try {
        await this.remindForOrg(org.id, now);
      } catch (err) {
        this.logger.error(`Resignation reminders failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  async remindForOrg(organizationId: string, now: Date = new Date()): Promise<number> {
    const pending = await this.scopedPrisma.resignation.findMany({
      where: { organizationId, status: ResignationStatus.PENDING },
      include: {
        employee: { select: { id: true, name: true, role: true, reportingManagerId: true, additionalReportingManagerIds: true, isActive: true } },
      },
    });
    let sent = 0;
    for (const r of pending) {
      const ageDays = Math.floor((now.getTime() - r.createdAt.getTime()) / DAY_MS);
      if (!r.employee.isActive || !isResignationReminderDue(ageDays)) continue;
      let people = await findResignationApprovers(this.scopedPrisma, organizationId, r.employee);
      // Admins get the 3-day escalation for an ordinary employee, so they are left out here unless nobody else can decide.
      const plain = r.employee.role !== Role.HR && r.employee.role !== Role.ADMIN;
      if (plain && people.some((p) => p.role === Role.HR)) people = people.filter((p) => p.role !== Role.ADMIN);
      for (const user of people) {
        const delivered = await this.notifier.send({
          organizationId,
          user,
          occasionKey: 'RESIGNATION_PENDING_REMINDER',
          variables: {
            employeeName: user.name,
            subjectName: r.employee.name,
            requestedLwd: formatDateDisplay(r.requestedLwd),
            daysWaiting: String(ageDays),
            reviewUrl: `${frontendUrl()}/resignations`,
          },
          title: `Resignation waiting ${ageDays} days: ${r.employee.name}`,
          message: `${r.employee.name}'s resignation (requested last working day ${formatDateDisplay(r.requestedLwd)}) has been waiting ${ageDays} days for a decision.`,
          category: NotificationCategory.GENERAL,
          dedupeWithinHours: 20,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
