// Purpose: what a Company Admin sees and may ask for under Account Management: their subscription, invoices and payments, plan and
//   modules, usage against limits, and requests to the Super Admin.
// Important: every query is filtered by the organisation of the SIGNED-IN user (never a client-supplied id); the cc_* billing tables
//   are not covered by the automatic tenant guard, so each one carries an explicit organizationId. Read-only except createRequest.
//   Nothing here can change a plan, a price, a payment or a subscription status: a request only records the ask for the Super Admin.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, Prisma, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { ModuleAccessService } from '../module-access/module-access.service';
import { MODULE_LABELS } from '../module-access/module-routes';
import { AuditLogService } from '../audit-log/audit-log.service';
import { storageBytes } from '../control-center/cc-storage';
import { buildInvoicePdf } from './account-invoice-pdf';
import { ACTIVITY_LABELS, REQUEST_TYPES, accountNotices, headcountTrend, deriveSubscriptionStatus, endDateOf, limitLevel, type RequestType } from './account-logic';

type Caller = Omit<User, 'password'>;
const num = (v: unknown) => Number(v ?? 0);

@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly moduleAccess: ModuleAccessService,
    private readonly auditLog: AuditLogService,
  ) {}

  private latestSubscription(organizationId: string) {
    return this.prisma.ccSubscription.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, include: { plan: true } });
  }

  // ---------- Subscription & Billing ----------
  async overview(organizationId: string) {
    const [org, sub, latestInvoice, openInvoices] = await Promise.all([
      this.prisma.organization.findFirst({ where: { id: organizationId }, select: { name: true, companyName: true, platformStatus: true } }),
      this.latestSubscription(organizationId),
      this.prisma.ccInvoice.findFirst({ where: { organizationId, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.ccInvoice.findMany({ where: { organizationId, status: 'OPEN' }, select: { number: true, total: true, currency: true, dueDate: true } }),
    ]);
    if (!org) throw new NotFoundException('Organization not found.');
    const status = deriveSubscriptionStatus(sub, org.platformStatus);
    const now = new Date();
    const overdue = openInvoices.filter((i) => i.dueDate && i.dueDate < now).map((i) => ({ number: i.number, total: num(i.total), currency: i.currency }));
    // Amount still to be paid: invoices that are open (sent, not yet paid).
    const outstanding = { amount: openInvoices.reduce((a, i) => a + num(i.total), 0), currency: openInvoices[0]?.currency ?? latestInvoice?.currency ?? 'INR', count: openInvoices.length, overdueCount: overdue.length };
    const modules = await this.modules(organizationId);
    return {
      organizationName: org.companyName || org.name,
      subscription: sub
        ? {
            planName: sub.plan.name,
            planCode: sub.plan.code,
            status,
            startDate: sub.createdAt.toISOString(),
            trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
            renewalDate: sub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            billingCycle: sub.term,
            // The amount on the latest invoice (a real record); the plan's rates are the Super Admin's to set and quote.
            amount: latestInvoice ? { total: num(latestInvoice.total), currency: latestInvoice.currency } : null,
            employeeLimit: sub.maxEmployees,
            storageLimitMb: sub.maxStorageMb,
            // What the plan includes, in the Super Admin's own words (plain text lines only).
            features: (Array.isArray(sub.plan.features) ? sub.plan.features : []).filter((f): f is string => typeof f === 'string'),
          }
        : null,
      outstanding,
      notices: accountNotices(status, endDateOf(sub), sub?.cancelAtPeriodEnd ?? false, overdue, now),
      paymentStatus: latestInvoice
        ? latestInvoice.status === 'OPEN' && latestInvoice.dueDate && latestInvoice.dueDate < new Date() ? 'OVERDUE' : latestInvoice.status
        : null,
      enabledModules: modules.filter((m) => m.enabled).map((m) => m.name),
    };
  }

  async invoices(organizationId: string) {
    const rows = await this.prisma.ccInvoice.findMany({ where: { organizationId, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((i) => ({
      id: i.id,
      number: i.number,
      date: i.createdAt.toISOString(),
      dueDate: i.dueDate?.toISOString() ?? null,
      subtotal: num(i.subtotal),
      discount: num(i.discount),
      tax: num(i.tax),
      amount: num(i.total),
      currency: i.currency,
      status: i.status,
      paidAt: i.paidAt?.toISOString() ?? null,
    }));
  }

  async invoicePdf(organizationId: string, id: string) {
    // Both the id AND the caller's organisation must match: another company's invoice id is a plain 404.
    const [invoice, org] = await Promise.all([
      this.prisma.ccInvoice.findFirst({ where: { id, organizationId, status: { not: 'DRAFT' } } }),
      this.prisma.organization.findFirst({ where: { id: organizationId }, select: { name: true, companyName: true, registeredAddress: true, corporateAddress: true } }),
    ]);
    if (!invoice || !org) throw new NotFoundException('Invoice not found.');
    const buffer = await buildInvoicePdf({
      number: invoice.number,
      date: invoice.createdAt,
      dueDate: invoice.dueDate,
      status: invoice.status,
      currency: invoice.currency,
      subtotal: num(invoice.subtotal),
      discount: num(invoice.discount),
      tax: num(invoice.tax),
      total: num(invoice.total),
      paidAt: invoice.paidAt,
      paymentRef: invoice.paymentRef,
      lineItems: Array.isArray(invoice.lineItems) ? (invoice.lineItems as { description?: string; quantity?: number; unitAmount?: number }[]) : [],
      billedTo: { name: org.companyName || org.name, address: org.registeredAddress ?? org.corporateAddress ?? null },
    });
    return { buffer, filename: `Invoice-${invoice.number}.pdf` };
  }

  async payments(organizationId: string) {
    const rows = await this.prisma.ccPayment.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 200, include: { invoice: { select: { number: true } } } });
    return rows.map((p) => ({
      id: p.id,
      reference: p.providerRef,
      invoiceNumber: p.invoice.number,
      date: p.createdAt.toISOString(),
      amount: num(p.amount),
      currency: p.currency,
      // The method as recorded (provider, and the card's last four when there is one).
      method: p.last4 ? `${p.provider} ending ${p.last4}` : p.provider,
      status: p.status,
    }));
  }

  /** The details printed on invoices. They are read straight from Organization Settings (Company profile) and nowhere else, so they are changed there. */
  async billingDetails(organizationId: string) {
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId }, select: { name: true, companyName: true, gstin: true, pan: true, contactEmail: true, registeredAddress: true, corporateAddress: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    return { companyName: org.companyName || org.name, gstin: org.gstin, pan: org.pan, billingEmail: org.contactEmail, address: org.registeredAddress || org.corporateAddress || null };
  }

  // ---------- My Plan & Modules ----------
  /** Active plans the admin may ask to move to (name and billing terms only; the Super Admin sets and quotes prices). */
  async availablePlans(_organizationId: string) {
    const plans = await this.prisma.ccPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    return plans.map((p) => ({ code: p.code, name: p.name }));
  }

  async modules(organizationId: string) {
    const [flags, disabled, inPlan] = await Promise.all([
      this.prisma.ccFeatureFlag.findMany({ where: { key: { in: Object.keys(MODULE_LABELS) } } }),
      this.moduleAccess.disabledFor(organizationId),
      this.moduleAccess.planModulesFor(organizationId),
    ]);
    const description = new Map(flags.map((f) => [f.key, f.description]));
    return Object.entries(MODULE_LABELS).map(([key, name]) => ({
      key,
      name,
      description: description.get(key) ?? '',
      includedInPlan: inPlan ? inPlan.has(key) : true,
      enabled: !disabled.has(key),
    }));
  }

  // ---------- Usage & Limits ----------
  async usage(organizationId: string) {
    const [sub, active, inactive, storedBytes] = await Promise.all([
      this.latestSubscription(organizationId),
      this.prisma.user.count({ where: { organizationId, isActive: true } }),
      this.prisma.user.count({ where: { organizationId, isActive: false } }),
      storageBytes(organizationId),
    ]);
    const limit = sub?.maxEmployees ?? null;
    const storageLimitBytes = sub?.maxStorageMb != null ? sub.maxStorageMb * 1024 * 1024 : null;
    return {
      employees: {
        limit,
        active,
        inactive,
        available: limit == null ? null : Math.max(0, limit - active),
        utilisationPercent: limit ? Math.min(100, Math.round((active / limit) * 1000) / 10) : null,
        level: limitLevel(active, limit),
      },
      storage: {
        limitBytes: storageLimitBytes,
        usedBytes: storedBytes,
        availableBytes: storageLimitBytes != null && storedBytes != null ? Math.max(0, storageLimitBytes - storedBytes) : null,
        utilisationPercent: storageLimitBytes && storedBytes != null ? Math.min(100, Math.round((storedBytes / storageLimitBytes) * 1000) / 10) : null,
        level: storedBytes != null ? limitLevel(storedBytes, storageLimitBytes) : 'NO_LIMIT',
      },
    };
  }

  // ---------- Requests to the Super Admin ----------
  async listRequests(organizationId: string, types?: readonly RequestType[]) {
    const rows = await this.prisma.ccRequest.findMany({
      where: { organizationId, ...(types ? { type: { in: [...types] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      message: r.message,
      payload: r.payload,
      requestedByName: r.requestedByName,
      createdAt: r.createdAt.toISOString(),
      resolutionNote: r.resolutionNote,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    }));
  }

  async createRequest(
    caller: Caller,
    allowed: readonly RequestType[],
    dto: { type: string; message?: string; payload?: Record<string, unknown> },
  ) {
    const type = dto.type as RequestType;
    if (!REQUEST_TYPES.includes(type) || !allowed.includes(type)) throw new BadRequestException('That request type is not available here.');
    const message = (dto.message ?? '').trim().slice(0, 2000);
    if (!message) throw new BadRequestException('Please add a note explaining your request.');
    const payload = this.validatePayload(type, dto.payload ?? {});
    if (type === 'PLAN_UPGRADE') {
      const plan = await this.prisma.ccPlan.findFirst({ where: { code: String(payload.planCode), status: 'ACTIVE' }, select: { code: true } });
      if (!plan) throw new BadRequestException('That plan is not available.');
    }
    // One open request per kind at a time: it is processed by a person, so a second copy only adds noise.
    const open = await this.prisma.ccRequest.findFirst({
      where: { organizationId: caller.organizationId, type, status: 'PENDING' },
      select: { id: true },
    });
    if (open) throw new ConflictException('You already have a pending request of this kind. The Super Admin will update it once processed.');
    const created = await this.prisma.ccRequest.create({
      data: {
        organizationId: caller.organizationId,
        type,
        message,
        payload: payload as Prisma.InputJsonValue,
        requestedById: caller.id,
        requestedByName: caller.name,
      },
    });
    // Shown in the Control Center's alerts, and on the company's own audit trail.
    await this.prisma.ccAlert
      .create({ data: { kind: 'REQUEST', title: `Account request: ${type.replace(/_/g, ' ').toLowerCase()}`, body: message.slice(0, 300), organizationId: caller.organizationId, dedupeKey: `request:${created.id}` } })
      .catch(() => undefined);
    await this.auditLog.log({
      actorId: caller.id,
      action: 'ACCOUNT_REQUEST_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId: caller.organizationId,
      targetId: created.id,
      details: { type },
    });
    return { id: created.id, type, status: created.status };
  }

  /** Takes back a request that has not been decided yet. Any Admin of the company may do it. */
  async withdrawRequest(caller: Caller, id: string, allowed: readonly RequestType[]) {
    const r = await this.prisma.ccRequest.findFirst({ where: { id, organizationId: caller.organizationId, type: { in: [...allowed] } } });
    if (!r) throw new NotFoundException('Request not found.');
    if (r.status !== 'PENDING') throw new ConflictException('Only a request that has not been decided yet can be withdrawn.');
    // updateMany with the status in the filter, so a Super Admin decision made a moment ago is never overwritten.
    const { count } = await this.prisma.ccRequest.updateMany({ where: { id, organizationId: caller.organizationId, status: 'PENDING' }, data: { status: 'WITHDRAWN', resolutionNote: `Withdrawn by ${caller.name}`, resolvedAt: new Date() } });
    if (!count) throw new ConflictException('This request was just decided and can no longer be withdrawn.');
    await this.prisma.ccAlert.deleteMany({ where: { dedupeKey: `request:${id}` } }).catch(() => undefined);
    await this.auditLog.log({ actorId: caller.id, action: 'ACCOUNT_REQUEST_WITHDRAWN', module: AuditModule.ORGANIZATION, organizationId: caller.organizationId, targetId: id, details: { type: r.type } });
    return { ok: true };
  }

  // ---------- Usage trend ----------
  async usageTrend(organizationId: string) {
    const people = await this.prisma.user.findMany({ where: { organizationId }, select: { joiningDate: true, isActive: true, exitDate: true, updatedAt: true }, take: 50_000 });
    return { months: headcountTrend(people, 6), approximate: true };
  }

  // ---------- Account activity ----------
  /** What has happened on the account: the admins' own actions (from the audit trail) and the Super Admin's decisions on their requests. */
  async activity(organizationId: string) {
    const [audit, decided] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { organizationId, module: AuditModule.ORGANIZATION, action: { in: Object.keys(ACTIVITY_LABELS) } }, orderBy: { createdAt: 'desc' }, take: 200, include: { actor: { select: { name: true } } } }),
      this.prisma.ccRequest.findMany({ where: { organizationId, status: { in: ['APPROVED', 'REJECTED', 'PROCESSED'] }, resolvedAt: { not: null } }, orderBy: { resolvedAt: 'desc' }, take: 100 }),
    ]);
    const nice = (s: unknown) => String(s ?? '').replace(/_/g, ' ').toLowerCase();
    const events = [
      ...audit.map((a) => {
        const d = (a.details ?? {}) as { type?: string; category?: string };
        const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
        const what = d.type ? cap(nice(d.type)) : d.category ? cap(nice(d.category)) : '';
        return { id: a.id, at: a.createdAt.toISOString(), by: a.actor?.name ?? 'Admin', source: 'YOU' as const, text: ACTIVITY_LABELS[a.action] ?? a.action, detail: what, failed: a.outcome === 'FAILURE' };
      }),
      ...decided.map((r) => ({ id: `req-${r.id}`, at: r.resolvedAt!.toISOString(), by: 'Super Admin', source: 'SUPER_ADMIN' as const, text: `${nice(r.type).replace(/^\w/, (c) => c.toUpperCase())} request ${r.status.toLowerCase()}`, detail: r.resolutionNote ?? '', failed: false })),
    ];
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  }

  private validatePayload(type: RequestType, payload: Record<string, unknown>): Record<string, unknown> {
    switch (type) {
      case 'PLAN_UPGRADE':
        if (typeof payload.planCode !== 'string' || !payload.planCode) throw new BadRequestException('Choose the plan you want.');
        return { planCode: payload.planCode.slice(0, 40) };
      case 'EXTRA_LICENCES': {
        const n = Number(payload.quantity);
        if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new BadRequestException('Enter how many extra employee licences you need (1 or more).');
        return { quantity: n };
      }
      case 'ADD_ON':
        if (typeof payload.addOn !== 'string' || !payload.addOn.trim()) throw new BadRequestException('Say which add-on you want.');
        return { addOn: payload.addOn.trim().slice(0, 120) };
      case 'MODULE_UPGRADE':
        if (typeof payload.module !== 'string' || !(payload.module in MODULE_LABELS)) throw new BadRequestException('Choose a module from the list.');
        return { module: payload.module };
      default:
        return {};
    }
  }
}
