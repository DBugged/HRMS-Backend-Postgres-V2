// Purpose: the daily billing and watch-over job for the Control Panel, plus the alerts it raises.
// Important: it only ever ACTS (creates invoices, switches a company off, emails a company) when the matching setting is on
//   (billing.auto_invoice, billing.auto_suspend_days, billing.email_customers); alerts to Super Admins are always raised.
//   Every alert has a dedupeKey, so running the job twice, or every day, raises each event once. Safe to run on demand.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmailService } from '../notifications/email.service';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CcBillingService } from './cc-billing.service';
import { CcSupportService } from './cc-support.service';
import { employeeLimit } from './cc-util';

const DAY = 86400000;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface AutomationReport {
  alerts: number; invoicesCreated: number; remindersSent: number; suspended: string[]; canceled: number; notes: string[];
}

@Injectable()
export class CcAutomationService {
  private readonly logger = new Logger(CcAutomationService.name);
  private running = false;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly billing: CcBillingService,
    private readonly support: CcSupportService,
    private readonly email: EmailService,
  ) {}

  @Cron('30 6 * * *')
  async daily() {
    try {
      const r = await this.run();
      this.logger.log(`Daily Control Center job: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`Daily Control Center job failed: ${(e as Error).message}`);
    }
  }

  private async setting<T>(key: string, fallback: T): Promise<T> {
    const s = await this.prisma.ccSetting.findUnique({ where: { key } });
    return (s?.value as T) ?? fallback;
  }

  /** Raises an alert once per dedupeKey. Returns true when it was new. */
  private async alert(kind: string, title: string, body: string, organizationId: string | null, dedupeKey: string, fresh: string[]): Promise<boolean> {
    if (await this.prisma.ccAlert.findUnique({ where: { dedupeKey } })) return false;
    await this.prisma.ccAlert.create({ data: { kind, title, body, organizationId, dedupeKey } });
    fresh.push(title);
    return true;
  }

  async run(): Promise<AutomationReport> {
    if (this.running) return { alerts: 0, invoicesCreated: 0, remindersSent: 0, suspended: [], canceled: 0, notes: ['Already running.'] };
    this.running = true;
    const report: AutomationReport = { alerts: 0, invoicesCreated: 0, remindersSent: 0, suspended: [], canceled: 0, notes: [] };
    const fresh: string[] = [];
    try {
      const now = new Date();
      const [autoInvoice, suspendDays, reminderDays, emailCustomers] = await Promise.all([
        this.setting<boolean>('billing.auto_invoice', false), this.setting<number>('billing.auto_suspend_days', 0),
        this.setting<number>('billing.reminder_days', 3), this.setting<boolean>('billing.email_customers', false),
      ]);
      const orgName = (o: { companyName: string | null; name: string }) => o.companyName || o.name;

      // 1. New sign-ups (last 3 days).
      for (const o of await this.prisma.organization.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 3 * DAY) } } }))
        await this.alert('SIGNUP', `New sign-up: ${orgName(o)}`, o.contactEmail ?? '', o.id, `signup:${o.id}`, fresh);

      // 2. Subscriptions: cancel at period end, pilots that ended, renewals coming up.
      const subs = await this.prisma.ccSubscription.findMany({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: true, organization: true } });
      for (const s of subs) {
        const name = orgName(s.organization);
        if (s.status === 'ACTIVE' && s.cancelAtPeriodEnd && s.currentPeriodEnd && s.currentPeriodEnd < now) {
          await this.prisma.ccSubscription.update({ where: { id: s.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: false } });
          report.canceled++;
          continue;
        }
        if (s.cancelAtPeriodEnd) continue;
        const open = await this.prisma.ccInvoice.count({ where: { subscriptionId: s.id, status: 'OPEN' } });
        const pilotOver = s.status === 'TRIALING' && s.trialEndsAt && s.trialEndsAt < now;
        const renewalSoon = s.status === 'ACTIVE' && s.currentPeriodEnd && s.currentPeriodEnd.getTime() - now.getTime() < 7 * DAY;
        if (pilotOver) await this.alert('PILOT_ENDED', `Pilot ended: ${name}`, `${s.plan.name} pilot finished ${s.trialEndsAt!.toLocaleDateString('en-IN')}. Invoice them to continue.`, s.organizationId, `pilot:${s.id}`, fresh);
        if (autoInvoice && (pilotOver || renewalSoon) && !open) {
          try {
            // A paid invoice for this period already extended the subscription, so a renewal never doubles up.
            const inv = await this.billing.generateInvoice(s.organizationId, 'AUTO');
            report.invoicesCreated++;
            if (emailCustomers && inv) await this.billing.sendInvoice(inv.id).catch((e) => report.notes.push(`Could not email ${inv.number}: ${(e as Error).message}`));
          } catch (e) {
            report.notes.push(`No invoice for ${name}: ${(e as Error).message}`);
          }
        }
        // 3. Plan limit.
        const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM users WHERE "organizationId" = ${s.organizationId} AND "isActive"`;
        const lim = employeeLimit(s.plan, Number(row?.n ?? 0), s.maxEmployees);
        if (lim && lim.overBy > 0)
          await this.alert('OVER_LIMIT', `Over plan limit: ${name}`, `${lim.used} employees on ${s.plan.name} (includes ${lim.included}). ${lim.hasOverageRate ? 'Extra employees are billed at the plan’s extra rate.' : 'No extra rate is set: bill the difference or move them to a bigger plan.'}`, s.organizationId, `overlimit:${s.organizationId}:${s.planId}:${now.toISOString().slice(0, 7)}`, fresh);
      }

      // 4. Overdue invoices: flag, optionally switch the company off, and remind.
      const overdue = await this.prisma.ccInvoice.findMany({ where: { status: 'OPEN', dueDate: { lt: now } }, include: { organization: true } });
      for (const inv of overdue) {
        const name = orgName(inv.organization);
        const days = Math.floor((now.getTime() - inv.dueDate!.getTime()) / DAY);
        await this.alert('OVERDUE', `Overdue: ${inv.number} (${name})`, `${inv.currency} ${Number(inv.total).toFixed(2)}, ${days} day${days === 1 ? '' : 's'} late.`, inv.organizationId, `overdue:${inv.id}`, fresh);
        if (inv.subscriptionId) await this.prisma.ccSubscription.updateMany({ where: { id: inv.subscriptionId, status: { in: ['ACTIVE', 'TRIALING'] } }, data: { status: 'PAST_DUE' } });
        if (suspendDays > 0 && days >= suspendDays && inv.organization.platformStatus === 'ACTIVE') {
          await this.prisma.organization.updateMany({ where: { id: inv.organizationId }, data: { platformStatus: 'SUSPENDED', isActive: false } });
          report.suspended.push(name);
          await this.alert('AUTO_SUSPENDED', `Switched off for non-payment: ${name}`, `${inv.number} was ${days} days overdue.`, inv.organizationId, `autosuspend:${inv.organizationId}:${inv.id}`, fresh);
          this.logger.warn(`Organization ${inv.organizationId} (${name}) switched off automatically: ${inv.number} ${days} days overdue`);
        }
      }

      // 5. Reminders to the company (only when emailing customers is on).
      if (emailCustomers && reminderDays > 0) {
        const due = await this.prisma.ccInvoice.findMany({ where: { status: 'OPEN', dueDate: { lt: new Date(now.getTime() + reminderDays * DAY) } }, include: { organization: true } });
        for (const inv of due) {
          if (inv.lastReminderAt && now.getTime() - inv.lastReminderAt.getTime() < 3 * DAY) continue;
          const to = inv.organization.contactEmail;
          if (!to) continue;
          const late = inv.dueDate! < now;
          await this.email.send({
            to, subject: `${late ? 'Overdue' : 'Upcoming'} payment: invoice ${inv.number}`,
            html: `<p>Hello,</p><p>Invoice <b>${esc(inv.number)}</b> for <b>${inv.currency} ${Number(inv.total).toFixed(2)}</b> ${late ? 'was due' : 'is due'} on ${inv.dueDate!.toLocaleDateString('en-IN')}.</p><p>Please arrange payment, or reply if you have already paid.</p><p>D'Bugged Programmers</p>`,
          }).then(() => { report.remindersSent++; }).catch(() => undefined);
          await this.prisma.ccInvoice.update({ where: { id: inv.id }, data: { lastReminderAt: now } });
        }
      }

      // 6. Tell the Super Admins about anything new.
      report.alerts = fresh.length;
      if (fresh.length && (await this.setting<boolean>('platform.email_alerts', true))) {
        const admins = await this.prisma.superAdmin.findMany({ where: { status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } }, select: { email: true } });
        const html = `<p>New items in the Control Panel:</p><ul>${fresh.slice(0, 30).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
        for (const a of admins) await this.email.send({ to: a.email, subject: `Control Panel: ${fresh.length} new alert${fresh.length === 1 ? '' : 's'}`, html }).catch(() => undefined);
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  // ---------------- alerts API ----------------
  async listAlerts(q: { unread?: string; page?: string | number; pageSize?: string | number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
    const where = q.unread === 'true' ? { readAt: null } : {};
    const [rows, total, unread] = await Promise.all([
      this.prisma.ccAlert.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.ccAlert.count({ where }),
      this.prisma.ccAlert.count({ where: { readAt: null } }),
    ]);
    return { data: rows.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, organizationId: a.organizationId, read: !!a.readAt, createdAt: a.createdAt.toISOString() })), page, pageSize, total, unread };
  }
  async markRead(id?: string) {
    await this.prisma.ccAlert.updateMany({ where: { readAt: null, ...(id ? { id } : {}) }, data: { readAt: new Date() } });
  }
}
