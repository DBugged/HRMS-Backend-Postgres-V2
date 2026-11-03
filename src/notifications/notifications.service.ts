// Purpose: Writes/reads in-app Notification rows and handles HR/Admin broadcast to all/department/specific
// recipients.
// Responsibilities: Owns create()/createMany() as the shared write path every other module calls, and
// per-user preference storage (muted categories, email-enabled) read via readPreferences(); delegates
// actual email delivery to EmailService and broadcast auditing to AuditLogService.
// Important: sendBroadcast() always writes category=GENERAL (hardcoded, matching the original release exactly);
// the optional accompanying email is gated per-recipient by their own emailEnabled preference — the only
// place that flag is actually consulted.
import { reviewerScope } from '../common/dept-scope';
import { withLink } from './notification-link-rules';
import { managerIdsOf } from '../common/managers';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditModule,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import {
  channelAllowed,
  hiddenInAppCategories,
  mergeChannels,
  readPreferences,
  unknownChannelKeys,
  type NotificationPreferences,
} from './notification-preferences';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from './email.service';
import { PushService } from './push.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { paginate, skip } from '../common/pagination';
import { emailBody, wrapEmailShell } from '../email-templates/email-layout';
import { companyLogoImgTag } from '../email-templates/company-logo';

type Actor = Omit<User, 'password'>;


// Every other module in the app calls this to create a Notification row —
// the closest backend-v2 equivalent to the original release's inline
// `Notification.create(...)` calls (there was no shared helper old-side
// either; this is a small improvement, not a behavior change).
export interface CreateNotificationInput {
  organizationId: string;
  userId: string;
  title: string;
  message: string;
  category: NotificationCategory;
  // Marks a notification that asks the recipient to decide on something (see push-messages.ts).
  pushKind?: 'APPROVAL';
  // A page inside the web app (starting with "/") that opening the notification goes to, when its kind alone does not say
  // where (e.g. one person's Documents tab). Stored on the notification; the web app follows it.
  link?: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly pushService: PushService,
  ) {}

  // Called by other modules' trigger sites — fire-and-forget-ish (errors
  // propagate to the caller like any other DB write, but this is never
  // expected to be the reason a business action itself fails since it's
  // always called after the primary write already succeeded).
  async create(input: CreateNotificationInput) {
    const row = await this.scopedPrisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        title: input.title,
        message: input.message,
        category: input.category,
        ...(input.link ? { link: input.link } : {}),
      },
    });
    // The same event also goes to the user's phone(s); never allowed to fail the caller.
    this.pushService.notify([{ ...input, notificationId: row.id }]);
    return row;
  }

  // Tells whoever has to decide on a request that it is waiting. Only the people assigned to the requester hear of it:
  // - managerFirst: the requester's reporting managers and the head of their department (Organization > Departments).
  // - otherwise (an HR/Admin queue), or when there is nobody for managerFirst: the HR users who look after the requester
  //   (they head the requester's department, or the requester is in their reporting line). Only when no HR user is
  //   assigned does it go to every Admin and every HR user who heads no department.
  // An Admin's request goes to the other Admins only. Never the requester. Used for request types that otherwise reach
  // no one until a reviewer happens to open the pending list (overtime, comp-off, leave encashment, reimbursement).
  // Best-effort — a notification problem must never fail the request itself.
  async notifyReviewers(input: {
    organizationId: string;
    requester: Pick<User, 'id' | 'reportingManagerId'> & { additionalReportingManagerIds?: string[] | null };
    title: string;
    message: string;
    category: NotificationCategory;
    managerFirst?: boolean;
  }) {
    try {
      const { organizationId, requester, title, message, category } = input;
      const recipients = await this.reviewersFor(organizationId, requester, !!input.managerFirst);
      await this.createMany(
        recipients.map((userId) => ({ organizationId, userId, title, message, category, pushKind: 'APPROVAL' as const })),
      );
    } catch {
      // Intentionally swallowed — see above.
    }
  }

  // The user ids notifyReviewers tells (see there). Exposed so other "please decide" messages can follow the same rule.
  async reviewersFor(
    organizationId: string,
    requester: Pick<User, 'id' | 'reportingManagerId'> & { additionalReportingManagerIds?: string[] | null },
    managerFirst: boolean,
  ): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    // Only people who still work here: a request must not be addressed to someone whose account is closed or whose
    // last working day has passed (it would reach nobody).
    const working = { isActive: true, OR: [{ exitDate: null }, { exitDate: { gte: today } }] };
    const requesterRow = await this.scopedPrisma.user.findFirst({
      where: { id: requester.id, organizationId },
      select: { role: true, departmentId: true, department: { select: { departmentHeadId: true } } },
    });
    if (requesterRow?.role === Role.ADMIN) {
      const admins = await this.scopedPrisma.user.findMany({
        where: { organizationId, ...working, id: { not: requester.id }, role: Role.ADMIN },
        select: { id: true },
      });
      return admins.map((u) => u.id);
    }
    if (managerFirst) {
      const headId = requesterRow?.department?.departmentHeadId;
      const candidates = [...new Set([...managerIdsOf(requester), ...(headId ? [headId] : [])])].filter(
        (m) => m !== requester.id,
      );
      const managers = candidates.length
        ? await this.scopedPrisma.user.findMany({
            where: { organizationId, ...working, id: { in: candidates } },
            select: { id: true },
          })
        : [];
      if (managers.length > 0) return managers.map((m) => m.id);
    }
    const hrAndAdmins = await this.scopedPrisma.user.findMany({
      where: { organizationId, ...working, id: { not: requester.id }, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true, role: true },
    });
    const assignedHr: string[] = [];
    const unassignedHr: string[] = [];
    for (const u of hrAndAdmins.filter((x) => x.role === Role.HR)) {
      const scope = await reviewerScope(this.scopedPrisma, u, organizationId);
      if (scope === null) unassignedHr.push(u.id);
      else if (scope.includes(requester.id)) assignedHr.push(u.id);
    }
    if (assignedHr.length > 0) return assignedHr;
    return [...hrAndAdmins.filter((x) => x.role === Role.ADMIN).map((u) => u.id), ...unassignedHr];
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
        ...(input.link ? { link: input.link } : {}),
      })),
    });
    this.pushService.notify(inputs);
  }

  async findMine(
    query: QueryNotificationsDto,
    actor: Actor,
    organizationId: string,
  ) {
    // Kinds the person muted, or has the in-app channel switched off for, stay out of their inbox.
    const hidden = hiddenInAppCategories(actor.notificationPreferences);
    const where: Prisma.NotificationWhereInput = {
      organizationId,
      userId: actor.id,
      ...(hidden.length > 0 && { category: { notIn: hidden } }),
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

    // Each row carries the page it opens: the one the sender set, else the one its title implies.
    return { ...result, data: result.data.map((n: any) => withLink(n)), unreadCount };
  }

  // Lightweight badge count — same muted-category filtering as findMine's
  // unreadCount, without loading/paginating the list.
  async unreadCount(actor: Actor, organizationId: string) {
    const hidden = hiddenInAppCategories(actor.notificationPreferences);
    const unreadCount = await this.scopedPrisma.notification.count({
      where: {
        organizationId,
        userId: actor.id,
        isRead: false,
        ...(hidden.length > 0 && { category: { notIn: hidden } }),
      },
    });
    return { unreadCount };
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
    if (dto.channels) {
      const bad = unknownChannelKeys(dto.channels);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Unknown notification setting: ${bad.join(', ')}.`,
        );
      }
    }
    const merged: NotificationPreferences = {
      mutedCategories: dto.mutedCategories ?? current.mutedCategories,
      emailEnabled: dto.emailEnabled ?? current.emailEnabled,
      pushEnabled: dto.pushEnabled ?? current.pushEnabled,
      channels: dto.channels
        ? mergeChannels(current.channels, dto.channels)
        : current.channels,
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
    const { count } = await this.scopedPrisma.notification.updateMany({
      where: { id, userId: actor.id, organizationId },
      data: { isRead: true },
    });
    if (count === 0) throw new NotFoundException('Notification not found.');
  }

  // The reverse of markAsRead: puts a notification the user has already read back to unread (so it counts in the
  // unread badge again). Scoped to the caller's own notifications like markAsRead; an id that isn't theirs is 404.
  async markAsUnread(id: string, actor: Actor, organizationId: string) {
    const { count } = await this.scopedPrisma.notification.updateMany({
      where: { id, userId: actor.id, organizationId },
      data: { isRead: false },
    });
    if (count === 0) throw new NotFoundException('Notification not found.');
  }

  async markAllAsRead(actor: Actor, organizationId: string) {
    await this.scopedPrisma.notification.updateMany({
      where: { userId: actor.id, organizationId, isRead: false },
      data: { isRead: true },
    });
  }

  // HR/Admin broadcast — always category=GENERAL (hardcoded, matching the
  // original release exactly), optionally emailed too (gated per-recipient by
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
      const org = await this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          name: true,
          companyName: true,
          phone: true,
          website: true,
          contactEmail: true,
          registeredAddress: true,
          emailLogoUrl: true,
          companyLogoUrl: true,
        },
      });
      // Same branded shell as every template email; the admin's own title/message stay the content.
      const broadcastHtml = wrapEmailShell(
        emailBody({
          category: 'General',
          title: dto.title,
          blocks: [
            `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#232733;word-break:break-word;">${dto.message}</div>`,
          ],
        }),
        {
          branding: {
            companyName: org?.companyName || org?.name,
            phone: org?.phone,
            website: org?.website,
            contactEmail: org?.contactEmail,
            registeredAddress: org?.registeredAddress,
            logoImgTag: companyLogoImgTag(
              organizationId,
              org?.emailLogoUrl || org?.companyLogoUrl,
            ),
          },
        },
      );
      await Promise.all(
        recipients
          .filter((r) =>
            channelAllowed(
              r.notificationPreferences,
              NotificationCategory.GENERAL,
              'email',
            ),
          )
          .map((r) =>
            this.emailService.send({
              organizationId,
              to: r.email,
              subject: dto.title,
              html: broadcastHtml,
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

    // Of the recipients, how many have the app installed with push on — so the sender can tell whether the
    // broadcast will also appear on phones, not just in the in-app list.
    const pushReachableCount = await this.pushService
      .countReachable(
        organizationId,
        recipients.map((r) => r.id),
      )
      .catch(() => 0);

    return {
      success: true,
      recipientCount: recipients.length,
      pushReachableCount,
    };
  }
}
