// Purpose: tells a company's admins about an Account Management event (a request decided, a support reply, a renewal coming up) in the
//   app's notification bell AND by email. One place so every sender behaves the same.
// Important: a failed email or bell entry never fails the action that triggered it. `onceKey` makes a notice go out once: it is stored
//   in the notification's link (as ?n=<key>), and a second call with the same key for the same company is skipped.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface AccountNotice {
  title: string;
  message: string;
  /** The page inside the web app that opening the notification goes to, for example '/account-support'. */
  link: string;
  /** Send this notice only once for the company (for example 'expiring-30:<subscription>:<period end>'). */
  onceKey?: string;
}

@Injectable()
export class AccountNotifier {
  private readonly logger = new Logger(AccountNotifier.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  /** To one person (the admin who made a request or opened a ticket). */
  async toUser(organizationId: string, userId: string, notice: AccountNotice): Promise<boolean> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId, isActive: true }, select: { id: true, name: true, email: true } });
    return user ? this.send(organizationId, [user], notice) : false;
  }

  /** To every active Admin of the company. */
  async toAdmins(organizationId: string, notice: AccountNotice): Promise<boolean> {
    const admins = await this.prisma.user.findMany({ where: { organizationId, role: 'ADMIN', isActive: true }, select: { id: true, name: true, email: true } });
    return this.send(organizationId, admins, notice);
  }

  private async send(organizationId: string, people: { id: string; name: string; email: string }[], n: AccountNotice): Promise<boolean> {
    if (!people.length) return false;
    const link = n.onceKey ? `${n.link}?n=${encodeURIComponent(n.onceKey)}` : n.link;
    if (n.onceKey && (await this.prisma.notification.count({ where: { organizationId, link } })) > 0) return false;
    for (const p of people) {
      await this.notifications.create({ organizationId, userId: p.id, title: n.title, message: n.message, category: 'GENERAL', link }).catch((e) => this.logger.warn(`Bell notice failed: ${(e as Error).message}`));
      await this.email
        .send({ to: p.email, organizationId, subject: n.title, html: `<p>Hello ${esc(p.name)},</p><p><b>${esc(n.title)}</b></p><p>${esc(n.message).replace(/\n/g, '<br>')}</p><p>You can see the details under Account Management in D'Rect HR.</p><p>D'Bugged Programmers</p>` })
        .catch((e) => this.logger.warn(`Notice email failed: ${(e as Error).message}`));
    }
    return true;
  }
}
