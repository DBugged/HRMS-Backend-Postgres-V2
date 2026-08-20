import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  AuditModule,
  NotificationCategory,
  Prisma,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from './email.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { paginate, skip } from '../common/pagination';

type Actor = Omit<User, 'password'>;

export interface NotificationPreferences {
  mutedCategories: NotificationCategory[];
  emailEnabled: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  mutedCategories: [],
  emailEnabled: true,
};

// Every other module in the app calls this to create a Notification row —
// the closest backend-v2 equivalent to the old system's inline
// `Notification.create(...)` calls (there was no shared helper old-side
// either; this is a small improvement, not a behavior change).
export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  title: string;
  message: string;
  category: NotificationCategory;
}

function readPreferences(raw: unknown): NotificationPreferences {
  const prefs = raw as Partial<NotificationPreferences> | null | undefined;
  return {
    mutedCategories:
      prefs?.mutedCategories ?? DEFAULT_PREFERENCES.mutedCategories,
    emailEnabled: prefs?.emailEnabled ?? DEFAULT_PREFERENCES.emailEnabled,
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
  ) {}

  // Called by other modules' trigger sites — fire-and-forget-ish (errors
  // propagate to the caller like any other DB write, but this is never
  // expected to be the reason a business action itself fails since it's
  // always called after the primary write already succeeded).
  async create(input: CreateNotificationInput) {
    return this.scopedPrisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        title: input.title,
        message: input.message,
        category: input.category,
      },
    });
  }

  async createMany(inputs: CreateNotificationInput[]) {
    if (inputs.length === 0) return;
    await this.scopedPrisma.notification.createMany({
      data: inputs.map((input) => ({
        organizationId: input.organizationId,
        userId: input.userId,
        title: input.title,
        message: input.message,
        category: input.category,
      })),
    });
  }

  async findMine(
    query: QueryNotificationsDto,
    actor: Actor,
    organizationId: string,
  ) {
    const prefs = readPreferences(actor.notificationPreferences);
    const where: Prisma.NotificationWhereInput = {
      organizationId,
      userId: actor.id,
      ...(prefs.mutedCategories.length > 0 && {
        category: { notIn: prefs.mutedCategories },
      }),
    };

    const [result, unreadCount] = await Promise.all([
      paginate(
        () =>
          this.scopedPrisma.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: skip(query.page, query.limit),
            take: query.limit,
          }),
        () => this.scopedPrisma.notification.count({ where }),
        query.page,
        query.limit,
      ),
      this.scopedPrisma.notification.count({
        where: { ...where, isRead: false },
      }),
    ]);

    return { ...result, unreadCount };
  }

  getPreferences(actor: Actor) {
    return readPreferences(actor.notificationPreferences);
  }

  async updatePreferences(
    dto: UpdateNotificationPreferencesDto,
    actor: Actor,
    organizationId: string,
  ) {
    const current = readPreferences(actor.notificationPreferences);
    const merged: NotificationPreferences = {
      mutedCategories: dto.mutedCategories ?? current.mutedCategories,
      emailEnabled: dto.emailEnabled ?? current.emailEnabled,
    };

    await this.scopedPrisma.user.updateMany({
      where: { id: actor.id, organizationId },
      data: {
        notificationPreferences: merged as unknown as Prisma.InputJsonValue,
      },
    });

    return merged;
  }

  async markAsRead(id: string, actor: Actor, organizationId: string) {
    await this.scopedPrisma.notification.updateMany({
      where: { id, userId: actor.id, organizationId },
      data: { isRead: true },
    });
  }

  async markAllAsRead(actor: Actor, organizationId: string) {
    await this.scopedPrisma.notification.updateMany({
      where: { userId: actor.id, organizationId, isRead: false },
      data: { isRead: true },
    });
  }

  // HR/Admin broadcast — always category=GENERAL (hardcoded, matching the
  // old system exactly), optionally emailed too (gated per-recipient by
  // their own emailEnabled preference — the only place that flag is
  // actually consulted).
  async sendBroadcast(
    dto: SendNotificationDto,
    actor: Actor,
    organizationId: string,
  ) {
    let recipients: Pick<User, 'id' | 'email' | 'notificationPreferences'>[];

    if (dto.recipientType === 'all') {
      recipients = await this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, email: true, notificationPreferences: true },
      });
    } else if (dto.recipientType === 'department') {
      if (!dto.department) {
        throw new BadRequestException(
          'department is required when recipientType is "department".',
        );
      }
      recipients = await this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, departmentId: dto.department },
        select: { id: true, email: true, notificationPreferences: true },
      });
    } else {
      if (!dto.userIds || dto.userIds.length === 0) {
        throw new BadRequestException(
          'userIds is required when recipientType is "specific".',
        );
      }
      recipients = await this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true, id: { in: dto.userIds } },
        select: { id: true, email: true, notificationPreferences: true },
      });
    }

    await this.createMany(
      recipients.map((r) => ({
        organizationId,
        userId: r.id,
        title: dto.title,
        message: dto.message,
        category: NotificationCategory.GENERAL,
      })),
    );

    if (dto.sendEmailToo) {
      await Promise.all(
        recipients
          .filter(
            (r) => readPreferences(r.notificationPreferences).emailEnabled,
          )
          .map((r) =>
            this.emailService.send({
              to: r.email,
              subject: dto.title,
              html: dto.message,
            }),
          ),
      );
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'NOTIFICATION_BROADCAST',
      module: AuditModule.NOTIFICATION,
      organizationId,
      details: {
        recipientType: dto.recipientType,
        recipientCount: recipients.length,
        sendEmailToo: !!dto.sendEmailToo,
      },
    });

    return { success: true, recipientCount: recipients.length };
  }
}
