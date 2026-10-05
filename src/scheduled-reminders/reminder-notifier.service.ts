// Purpose: Shared "tell this person" helper for the scheduled reminder jobs — an in-app notification plus an
// occasion-template email, both best-effort.
// Important: dedupes on (user, title) within a window so a job that runs again (restart, manual trigger) never
// double-notifies; respects the recipient's "email notifications" preference; and, unlike the generic fallback
// elsewhere, sends NO email when the org has switched the template off (the in-app notice still goes out).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

export interface ReminderUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  reportingManagerId: string | null;
  notificationPreferences: unknown;
}

export interface ReminderInput {
  organizationId: string;
  user: Pick<ReminderUser, 'id' | 'email' | 'notificationPreferences'>;
  occasionKey: string;
  variables: Record<string, string>;
  title: string;
  message: string;
  category: NotificationCategory;
  // Skip when this user already has a notification with the same title newer than this. Default: 60 days.
  dedupeWithinHours?: number;
}

const emailEnabled = (prefs: unknown): boolean =>
  (prefs as { emailEnabled?: boolean } | null)?.emailEnabled !== false;

@Injectable()
export class ReminderNotifier {
  private readonly logger = new Logger(ReminderNotifier.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  /** Every active user of the org, with just the fields reminders need. */
  activeUsers(organizationId: string): Promise<ReminderUser[]> {
    return this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        reportingManagerId: true,
        notificationPreferences: true,
      },
    });
  }

  /** True when the notice was sent, false when skipped as a duplicate. */
  async send(input: ReminderInput): Promise<boolean> {
    const { organizationId, user, occasionKey, variables } = input;
    const since = new Date(
      Date.now() - (input.dedupeWithinHours ?? 24 * 60) * 60 * 60 * 1000,
    );
    const existing = await this.scopedPrisma.notification.findFirst({
      where: {
        organizationId,
        userId: user.id,
        title: input.title,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (existing) return false;

    await this.notificationsService.create({
      organizationId,
      userId: user.id,
      title: input.title,
      message: input.message,
      category: input.category,
    });

    try {
      if (!emailEnabled(user.notificationPreferences)) return true;
      const template = await this.scopedPrisma.emailTemplate.findFirst({
        where: { organizationId, occasionKey },
        select: { isActive: true },
      });
      if (template && !template.isActive) return true;
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        occasionKey,
        variables,
        this.emailTemplatesService.defaultFor(occasionKey, variables),
      );
      await this.emailService.send({
        organizationId,
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    } catch (err) {
      this.logger.warn(
        `Reminder email ${occasionKey} to ${user.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return true;
  }
}
