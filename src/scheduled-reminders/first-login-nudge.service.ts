// Purpose: chases a new joiner who has not signed in since the invite, then tells HR - so nobody sits unnoticed with an unused account.
// Responsibilities: every day 10:15, for active employees who never signed in: an email nudge at 2 days and again at 5 days after the
//   account was created, and (from day 5) one summary to HR/Admin listing who is still stuck, repeated at most every 6 days.
//   Stops after 14 days so an account that is simply unused is not chased forever.
// Important: the manual "Resend credentials" button stays - it sends a fresh password, this only reminds. The email reuses the
//   Onboarding reminder template; in-app notices would be useless here because the person has never opened the app.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { frontendUrl } from '../common/frontend-url';
import { ReminderNotifier } from './reminder-notifier.service';

const DAY = 24 * 3600_000;

@Injectable()
export class FirstLoginNudgeService {
  private readonly logger = new Logger(FirstLoginNudgeService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('15 10 * * *')
  async sendDailyNudges() {
    const orgs = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true } });
    for (const org of orgs) {
      try {
        await this.nudgeForOrg(org.id, new Date());
      } catch (err) {
        this.logger.error(`First-login nudges failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  async nudgeForOrg(organizationId: string, now: Date): Promise<number> {
    const stuck = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, lastLoginAt: null, createdAt: { gte: new Date(now.getTime() - 14 * DAY), lte: new Date(now.getTime() - 2 * DAY) } },
      select: { id: true, name: true, createdAt: true },
    });
    if (stuck.length === 0) return 0;
    const users = await this.notifier.activeUsers(organizationId);
    const byId = new Map(users.map((u) => [u.id, u]));
    let sent = 0;
    const stillStuck: string[] = [];
    for (const s of stuck) {
      const user = byId.get(s.id);
      if (!user) continue;
      const ageDays = Math.floor((now.getTime() - s.createdAt.getTime()) / DAY);
      const second = ageDays >= 5;
      if (second) stillStuck.push(s.name);
      const delivered = await this.notifier.send({
        organizationId,
        user,
        occasionKey: 'ONBOARDING_REMINDER',
        variables: {
          employeeName: user.name,
          pendingItems: second
            ? "You have not signed in yet. Use the link in your welcome email, or ask HR to resend your login details."
            : 'Sign in for the first time with the details in your welcome email, then finish your profile.',
          profileUrl: `${frontendUrl()}/login`,
        },
        title: second ? "Reminder: you haven't signed in yet" : 'Sign in to get started',
        message: 'Sign in with the details in your welcome email to finish your profile.',
        category: NotificationCategory.GENERAL,
        dedupeWithinHours: 24 * 4,
      });
      if (delivered) sent++;
    }
    if (stillStuck.length > 0) {
      for (const hr of users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN)) {
        const delivered = await this.notifier.send({
          organizationId,
          user: hr,
          occasionKey: 'ONBOARDING_REMINDER',
          variables: {},
          inAppOnly: true,
          dedupeWithinHours: 24 * 6,
          title: 'New joiners who have not signed in',
          message: `${stillStuck.length} new joiner${stillStuck.length === 1 ? ' has' : 's have'} not signed in 5 days after the invite: ${stillStuck.slice(0, 5).join(', ')}${stillStuck.length > 5 ? ` and ${stillStuck.length - 5} more` : ''}. Use Resend credentials on their profile.`,
          category: NotificationCategory.GENERAL,
        });
        if (delivered) sent++;
      }
    }
    return sent;
  }
}
