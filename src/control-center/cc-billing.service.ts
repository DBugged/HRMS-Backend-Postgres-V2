// Purpose: invoices, payments, coupons and feature flags for the Control Panel.
// Important: money is stored as Decimal(12,2) and returned as numbers; GST is 18% (India) on the taxable amount. Marking an
//   invoice paid records a payment too, so Payments always matches Billing. Nothing here talks to a payment gateway yet:
//   payments are recorded by hand (UPI/bank/cheque reference).
import PDFDocument from 'pdfkit';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { forgetOrganizationStatus } from '../common/org-status';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CcSupportService } from './cc-support.service';
import { ModuleAccessService } from '../module-access/module-access.service';
import { EmailService } from '../notifications/email.service';
import { validateCouponInput, validateInvoiceInput, validatePaymentInput, validateRefundInput } from './cc-validation';
import { addMonths, monthlyCharge, nextInvoiceNumber, num, paging, type PageQuery } from './cc-util';

const r2 = (n: number) => Math.round(n * 100) / 100;
type Line = { description: string; quantity: number; unitAmount: number };

@Injectable()
export class CcBillingService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient, private readonly settings: CcSupportService, private readonly modules: ModuleAccessService, private readonly email: EmailService) {}

  // ---------------- invoices ----------------
  private async invOut(i: Prisma.CcInvoiceGetPayload<{ include: { organization: true } }>) {
    return {
      id: i.id, number: i.number, organizationId: i.organizationId, organizationName: i.organization.companyName || i.organization.name,
      status: i.status, subtotal: num(i.subtotal), discount: num(i.discount), tax: num(i.tax), total: num(i.total), currency: i.currency,
      dueDate: i.dueDate?.toISOString() ?? null, lineItems: i.lineItems, couponCode: i.couponCode, createdAt: i.createdAt.toISOString(),
    };
  }

  async listInvoices(q: PageQuery & { status?: string; organizationId?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcInvoiceWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.organizationId ? { organizationId: q.organizationId } : {}), ...(q.q ? { number: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.ccInvoice.findMany({ where, include: { organization: true }, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.ccInvoice.count({ where }),
    ]);
    return { data: await Promise.all(rows.map((r) => this.invOut(r))), page, pageSize, total };
  }

  async getInvoice(id: string) {
    const i = await this.prisma.ccInvoice.findUnique({ where: { id }, include: { organization: true } });
    if (!i) throw new NotFoundException('Invoice not found.');
    return this.invOut(i);
  }

  private async nextNumber() {
    const d = new Date();
    const prefix = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
    // One more than the highest number used this month - a row count breaks once any invoice has been deleted.
    const last = await this.prisma.ccInvoice.findFirst({ where: { number: { startsWith: prefix } }, orderBy: { number: 'desc' }, select: { number: true } });
    return nextInvoiceNumber(prefix, last?.number);
  }

  async createInvoice(b: { organizationId: string; lineItems: Line[]; dueDate?: string; couponCode?: string }, extra: { subscriptionId?: string; periodMonths?: number; source?: string } = {}) {
    const org = await this.prisma.organization.findFirst({ where: { id: b.organizationId } });
    if (!org) throw new NotFoundException('Organization not found.');
    validateInvoiceInput(b);
    const subtotal = r2(b.lineItems.reduce((s, l) => s + Number(l.quantity) * Number(l.unitAmount), 0));
    let discount = 0;
    let couponCode: string | null = null;
    if (b.couponCode) {
      const c = await this.checkCoupon(b.couponCode, org.id, subtotal);
      if (!c.valid) throw new BadRequestException(c.reason ?? 'Coupon is not valid.');
      discount = Number(c.discountPreview);
      couponCode = b.couponCode.toUpperCase();
    }
    // GST rate and payment terms come from Platform Settings (billing.gst_rate, billing.invoice_due_days).
    const gst = (await this.settings.numberSetting('billing.gst_rate', 18)) / 100;
    const dueDays = await this.settings.numberSetting('billing.invoice_due_days', 7);
    const tax = r2((subtotal - discount) * gst);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const inv = await this.prisma.$transaction(async (tx) => {
          if (couponCode) await tx.ccCoupon.update({ where: { code: couponCode }, data: { redeemedCount: { increment: 1 } } });
          return tx.ccInvoice.create({
            data: { number: await this.nextNumber(), organizationId: org.id, status: 'OPEN', subtotal, discount, tax, total: r2(subtotal - discount + tax), dueDate: b.dueDate ? new Date(b.dueDate) : new Date(Date.now() + dueDays * 86400000), lineItems: b.lineItems as never, couponCode, subscriptionId: extra.subscriptionId ?? null, periodMonths: extra.periodMonths ?? null, source: extra.source ?? 'MANUAL' },
            include: { organization: true },
          });
        });
        return this.invOut(inv);
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
  }

  /** One-click invoice from the live subscription: active employees x plan rate for the term, GST extra. */
  async generateInvoice(organizationId: string, source: 'GENERATED' | 'AUTO' = 'GENERATED') {
    const sub = await this.prisma.ccSubscription.findFirst({ where: { organizationId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: true }, orderBy: { createdAt: 'desc' } });
    if (!sub) throw new BadRequestException('This organization has no live subscription. Subscribe it to a plan first.');
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM users WHERE "organizationId" = ${organizationId} AND "isActive"`;
    const employees = Number(row?.n ?? 0);
    const monthly = monthlyCharge(sub.plan, sub.term, employees, sub.customPerEmployeeRate);
    if (monthly == null) throw new BadRequestException('This plan has custom pricing and no agreed rate yet. Set the per-employee rate on the subscription.');
    const months = sub.termMonths || 1;
    return this.createInvoice({ organizationId, lineItems: [{ description: `${sub.plan.name} - ${employees} active employees, ${months} month${months > 1 ? 's' : ''}`, quantity: months, unitAmount: monthly }] }, { subscriptionId: sub.id, periodMonths: months, source });
  }

  /** A one-page A4 invoice, built on demand from the stored invoice. */
  async invoicePdf(id: string): Promise<Buffer> {
    const inv = await this.getInvoice(id);
    const org = await this.prisma.organization.findFirst({ where: { id: inv.organizationId } });
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const money = (n: number | null) => `${inv.currency} ${(n ?? 0).toFixed(2)}`;
    const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

    doc.fontSize(20).text("D'Core HR", { continued: true }).fontSize(10).text('   by D\'Bugged Programmers');
    doc.moveDown(0.5).fontSize(16).text(`Invoice ${inv.number}`, { align: 'right' });
    doc.fontSize(10).text(`Status: ${inv.status}`, { align: 'right' }).text(`Date: ${fmt(inv.createdAt)}`, { align: 'right' }).text(`Due: ${fmt(inv.dueDate)}`, { align: 'right' });
    doc.moveDown().fontSize(11).text('Bill to', { underline: true }).fontSize(10).text(inv.organizationName ?? '');
    if (org?.gstin) doc.text(`GSTIN: ${org.gstin}`);
    if (org?.contactEmail) doc.text(org.contactEmail);

    doc.moveDown(1.5);
    const y0 = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').text('Description', 50, y0).text('Qty', 340, y0, { width: 40, align: 'right' }).text('Rate', 390, y0, { width: 70, align: 'right' }).text('Amount', 470, y0, { width: 75, align: 'right' }).font('Helvetica');
    doc.moveTo(50, y0 + 15).lineTo(545, y0 + 15).stroke();
    let y = y0 + 22;
    for (const l of inv.lineItems as Line[]) {
      doc.text(l.description, 50, y, { width: 280 }).text(String(l.quantity), 340, y, { width: 40, align: 'right' }).text(Number(l.unitAmount).toFixed(2), 390, y, { width: 70, align: 'right' }).text((l.quantity * l.unitAmount).toFixed(2), 470, y, { width: 75, align: 'right' });
      y = Math.max(doc.y, y + 16) + 4;
    }
    doc.moveTo(50, y).lineTo(545, y).stroke();
    y += 8;
    const row = (label: string, v: string, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 340, y, { width: 120, align: 'right' }).text(v, 470, y, { width: 75, align: 'right' }); y += 16; };
    row('Subtotal', money(inv.subtotal));
    if (inv.discount) row(`Discount${inv.couponCode ? ` (${inv.couponCode})` : ''}`, `-${money(inv.discount)}`);
    row('GST', money(inv.tax));
    row('Total', money(inv.total), true);
    doc.font('Helvetica').fontSize(9).text('Thank you for choosing D\'Core HR.', 50, 760, { align: 'center', width: 495 });
    doc.end();
    return done;
  }

  /**
   * An invoice that pays for a subscription period starts or extends that period: a pilot becomes ACTIVE, an active
   * subscription runs on from its current end. A company this system switched off for non-payment comes back once
   * nothing is overdue any more (one a Super Admin switched off by hand stays off).
   */
  async applyPaid(invoiceId: string) {
    const inv = await this.prisma.ccInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.status !== 'PAID') return;
    if (inv.subscriptionId && inv.periodMonths) {
      const sub = await this.prisma.ccSubscription.findUnique({ where: { id: inv.subscriptionId } });
      if (sub && !['CANCELED', 'EXPIRED'].includes(sub.status)) {
        const from = sub.status === 'ACTIVE' && sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
        await this.prisma.ccSubscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', currentPeriodEnd: addMonths(from, inv.periodMonths) } });
      }
    }
    const org = await this.prisma.organization.findFirst({ where: { id: inv.organizationId } });
    if (org?.platformStatus === 'SUSPENDED') {
      // Only a suspension the system made itself is lifted. A manual suspend/archive/reactivate by a Super Admin marks the
      // automatic one as ended (AUTO_SUSPENDED_ENDED), so an old alert can never switch a company back on.
      const [overdue, auto] = await Promise.all([
        this.prisma.ccInvoice.count({ where: { organizationId: org.id, status: 'OPEN', dueDate: { lt: new Date() } } }),
        this.prisma.ccAlert.count({ where: { organizationId: org.id, kind: 'AUTO_SUSPENDED' } }),
      ]);
      if (!overdue && auto) {
        await this.prisma.organization.updateMany({ where: { id: org.id }, data: { platformStatus: 'ACTIVE', isActive: true } });
        await this.prisma.ccAlert.updateMany({ where: { organizationId: org.id, kind: 'AUTO_SUSPENDED' }, data: { kind: 'AUTO_SUSPENDED_ENDED' } });
        forgetOrganizationStatus(org.id);
      }
    }
  }

  /** Email an invoice (PDF attached) to the company's billing email. */
  async sendInvoice(id: string, to?: string) {
    const inv = await this.getInvoice(id);
    const org = await this.prisma.organization.findFirst({ where: { id: inv.organizationId } });
    const address = (to ?? org?.contactEmail ?? '').trim();
    if (!address) throw new BadRequestException('This company has no billing email. Add one on its profile first.');
    const pdf = await this.invoicePdf(id);
    await this.email.send({
      to: address,
      subject: `Invoice ${inv.number} from D'Core HR`,
      html: `<p>Hello,</p><p>Please find invoice <b>${inv.number}</b> attached: <b>${inv.currency} ${(inv.total ?? 0).toFixed(2)}</b>${inv.dueDate ? `, due ${new Date(inv.dueDate).toLocaleDateString('en-IN')}` : ''}.</p><p>Reply to this email if you have any questions.</p><p>D'Bugged Programmers</p>`,
      attachments: [{ filename: `${inv.number}.pdf`, content: pdf }],
    });
    await this.prisma.ccInvoice.update({ where: { id }, data: { lastReminderAt: new Date() } });
    return { sent: true, to: address };
  }

  async voidInvoice(id: string) {
    const inv = await this.getInvoice(id);
    if (!['DRAFT', 'OPEN'].includes(inv.status)) throw new ConflictException('Only an unpaid invoice can be voided.');
    // Only the request that actually voids it gives the coupon redemption back.
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.ccInvoice.updateMany({ where: { id, status: { in: ['DRAFT', 'OPEN'] } }, data: { status: 'VOID' } });
      if (count > 0 && inv.couponCode) await tx.ccCoupon.updateMany({ where: { code: inv.couponCode, redeemedCount: { gt: 0 } }, data: { redeemedCount: { decrement: 1 } } });
    });
    return this.getInvoice(id);
  }

  async markPaid(id: string, paymentRef: string) {
    const inv = await this.getInvoice(id);
    if (inv.status === 'PAID') return inv;
    if (!['OPEN', 'DRAFT'].includes(inv.status)) throw new ConflictException('This invoice cannot be marked paid.');
    // The status flip is the lock: only the request that actually moves the invoice from unpaid to paid records the payment and
    // extends the subscription, so a double click or two admins cannot do either twice.
    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.ccInvoice.updateMany({ where: { id, status: { in: ['OPEN', 'DRAFT'] } }, data: { status: 'PAID', paidAt: new Date(), paymentRef } });
      if (count === 0) return false;
      await tx.ccPayment.create({ data: { invoiceId: id, organizationId: inv.organizationId, amount: inv.total!, currency: inv.currency, provider: 'MANUAL', providerRef: paymentRef || 'manual', status: 'SUCCEEDED' } });
      return true;
    });
    if (won) await this.applyPaid(id);
    return this.getInvoice(id);
  }

  // ---------------- payments ----------------
  private payOut(p: Prisma.CcPaymentGetPayload<Record<string, never>>) {
    return { id: p.id, invoiceId: p.invoiceId, organizationId: p.organizationId, amount: num(p.amount), currency: p.currency, provider: p.provider, providerRef: p.providerRef, last4: p.last4, status: p.status, refundedAmount: num(p.refundedAmount), createdAt: p.createdAt.toISOString() };
  }

  async listPayments(q: PageQuery & { status?: string; organizationId?: string; invoiceId?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcPaymentWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.organizationId ? { organizationId: q.organizationId } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}) };
    const [rows, total] = await Promise.all([this.prisma.ccPayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.ccPayment.count({ where })]);
    return { data: rows.map((p) => this.payOut(p)), page, pageSize, total };
  }

  async getPayment(id: string) {
    const p = await this.prisma.ccPayment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Payment not found.');
    return this.payOut(p);
  }

  async createPayment(b: { invoiceId: string; amount: number; currency?: string; provider: string; providerRef: string; last4?: string }) {
    validatePaymentInput(b);
    const inv = await this.prisma.ccInvoice.findUnique({ where: { id: b.invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found.');
    const provider = b.provider.trim();
    const providerRef = b.providerRef.trim();
    const p = await this.prisma.$transaction(async (tx) => {
      // One payment at a time per invoice: the checks below and the write must not interleave with another payment.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cc-pay:${inv.id}`}))`;
      const fresh = await tx.ccInvoice.findUnique({ where: { id: inv.id } });
      if (!fresh || !['OPEN', 'DRAFT'].includes(fresh.status)) throw new ConflictException(`This invoice is ${fresh?.status.toLowerCase() ?? 'not available'}, so a payment cannot be recorded against it.`);
      if ((b.currency ?? fresh.currency) !== fresh.currency) throw new BadRequestException(`This invoice is in ${fresh.currency}; the payment currency must match.`);
      if (await tx.ccPayment.findFirst({ where: { provider, providerRef }, select: { id: true } })) throw new ConflictException('A payment with this provider and reference is already recorded.');
      const paid = await tx.ccPayment.aggregate({ where: { invoiceId: fresh.id, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] } }, _sum: { amount: true } });
      const already = Number(paid._sum.amount ?? 0);
      if (already + b.amount > Number(fresh.total) + 0.005) throw new BadRequestException(`This would pay more than the invoice total (${Number(fresh.total).toFixed(2)}; ${already.toFixed(2)} already received).`);
      const created = await tx.ccPayment.create({ data: { invoiceId: fresh.id, organizationId: fresh.organizationId, amount: b.amount, currency: fresh.currency, provider, providerRef, last4: b.last4 ?? null, status: 'SUCCEEDED' } });
      if (already + b.amount >= Number(fresh.total) - 0.005) await tx.ccInvoice.updateMany({ where: { id: fresh.id, status: { in: ['OPEN', 'DRAFT'] } }, data: { status: 'PAID', paidAt: new Date(), paymentRef: providerRef } });
      return created;
    });
    await this.applyPaid(inv.id);
    return this.payOut(p);
  }

  async refund(id: string, b: { amount: number; reason: string }) {
    validateRefundInput(b);
    const p = await this.prisma.ccPayment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Payment not found.');
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(p.status)) throw new ConflictException(`A ${p.status.toLowerCase()} payment cannot be refunded.`);
    const left = Number(p.amount) - Number(p.refundedAmount);
    if (b.amount > left + 0.005) throw new BadRequestException(`You can refund at most ${left.toFixed(2)}.`);
    const total = Math.round((Number(p.refundedAmount) + b.amount) * 100) / 100;
    // Compare-and-swap on the amount already refunded: two simultaneous refunds cannot both be applied on the same figure.
    const { count } = await this.prisma.ccPayment.updateMany({ where: { id, refundedAmount: p.refundedAmount }, data: { refundedAmount: total, status: total >= Number(p.amount) - 0.005 ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    if (count === 0) throw new ConflictException('This payment was just changed. Reload it and try again.');
    return this.payOut(await this.prisma.ccPayment.findUniqueOrThrow({ where: { id } }));
  }

  // ---------------- coupons ----------------
  private couponOut(c: Prisma.CcCouponGetPayload<Record<string, never>>) {
    const expired = c.status === 'ACTIVE' && c.validUntil && c.validUntil < new Date();
    return { id: c.id, code: c.code, type: c.type, value: num(c.value), currency: c.currency, maxRedemptions: c.maxRedemptions, redeemedCount: c.redeemedCount, perOrgLimit: c.perOrgLimit, validFrom: c.validFrom?.toISOString() ?? null, validUntil: c.validUntil?.toISOString() ?? null, appliesToPlanIds: c.appliesToPlanIds, status: expired ? 'EXPIRED' : c.status, createdAt: c.createdAt.toISOString() };
  }
  private couponData(b: Record<string, unknown>) {
    const d: Record<string, unknown> = {};
    for (const k of ['type', 'value', 'currency', 'maxRedemptions', 'perOrgLimit', 'appliesToPlanIds', 'status']) if (k in b) d[k] = b[k];
    if (typeof b.code === 'string') d.code = b.code.trim().toUpperCase();
    if ('validFrom' in b) d.validFrom = b.validFrom ? new Date(b.validFrom as string) : null;
    if ('validUntil' in b) d.validUntil = b.validUntil ? new Date(b.validUntil as string) : null;
    return d as Prisma.CcCouponUncheckedCreateInput;
  }

  async listCoupons(q: PageQuery & { status?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcCouponWhereInput = { ...(q.status && q.status !== 'EXPIRED' ? { status: q.status } : {}), ...(q.q ? { code: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [rows, total] = await Promise.all([this.prisma.ccCoupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.ccCoupon.count({ where })]);
    return { data: rows.map((c) => this.couponOut(c)), page, pageSize, total };
  }
  async getCoupon(id: string) {
    const c = await this.prisma.ccCoupon.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Coupon not found.');
    return this.couponOut(c);
  }
  async createCoupon(b: Record<string, unknown>) {
    const d = this.couponData(b);
    if (!d.code || !d.type || d.value == null) throw new BadRequestException('Code, type and value are required.');
    validateCouponInput(d as unknown as Record<string, unknown>);
    try { return this.couponOut(await this.prisma.ccCoupon.create({ data: d })); } catch { throw new ConflictException('A coupon with this code already exists.'); }
  }
  async updateCoupon(id: string, b: Record<string, unknown>) {
    const existing = await this.getCoupon(id);
    const data = this.couponData(b);
    // A changed value is judged against the coupon's type (the new one, else the current one).
    validateCouponInput({ ...(data as unknown as Record<string, unknown>), ...('value' in data ? { type: (data as { type?: string }).type ?? existing.type } : {}) });
    return this.couponOut(await this.prisma.ccCoupon.update({ where: { id }, data }));
  }
  async removeCoupon(id: string) {
    await this.getCoupon(id);
    await this.prisma.ccCoupon.delete({ where: { id } });
  }

  /** Is this coupon usable now, and how much would it take off `base`? */
  async checkCoupon(code: string, organizationId: string, base: number, planId?: string): Promise<{ valid: boolean; discountPreview: string; reason?: string }> {
    const c = await this.prisma.ccCoupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    const no = (reason: string) => ({ valid: false, discountPreview: '0.00', reason });
    const now = new Date();
    if (!c) return no('No such coupon.');
    if (c.status !== 'ACTIVE') return no('This coupon is not active.');
    if (c.validFrom && c.validFrom > now) return no('This coupon is not valid yet.');
    if (c.validUntil && c.validUntil < now) return no('This coupon has expired.');
    if (c.maxRedemptions != null && c.redeemedCount >= c.maxRedemptions) return no('This coupon has been fully redeemed.');
    const plans = (c.appliesToPlanIds as string[]) ?? [];
    if (planId && plans.length && !plans.includes(planId)) return no('This coupon does not apply to that plan.');
    if (c.perOrgLimit != null && (await this.prisma.ccInvoice.count({ where: { organizationId, couponCode: c.code, status: { not: 'VOID' } } })) >= c.perOrgLimit) return no('This organization has already used this coupon.');
    const off = c.type === 'PERCENT' ? (base * Number(c.value)) / 100 : Number(c.value);
    return { valid: true, discountPreview: Math.min(base, r2(off)).toFixed(2) };
  }

  async validateCoupon(b: { code: string; organizationId: string; planId: string }) {
    const plan = await this.prisma.ccPlan.findUnique({ where: { id: b.planId } });
    const base = plan ? num(plan.basePrice) ?? (num(plan.perEmployeeRate) ?? 0) * (plan.includedEmployees ?? 0) : 0;
    return this.checkCoupon(b.code, b.organizationId, base, b.planId);
  }

  // ---------------- feature flags ----------------
  private flagOut(f: Prisma.CcFeatureFlagGetPayload<Record<string, never>>) {
    return { key: f.key, description: f.description, defaultValue: f.defaultValue, status: f.status, updatedAt: f.updatedAt.toISOString() };
  }
  async listFlags(q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcFeatureFlagWhereInput = q.q ? { OR: [{ key: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {};
    const [rows, total] = await Promise.all([this.prisma.ccFeatureFlag.findMany({ where, orderBy: { key: 'asc' }, skip, take }), this.prisma.ccFeatureFlag.count({ where })]);
    return { data: rows.map((f) => this.flagOut(f)), page, pageSize, total };
  }
  async createFlag(b: { key: string; description?: string; defaultValue?: unknown }) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(b.key ?? '')) throw new BadRequestException('Key must be lowercase letters, numbers, dots, dashes or underscores.');
    try { return this.flagOut(await this.prisma.ccFeatureFlag.create({ data: { key: b.key, description: b.description ?? '', defaultValue: (b.defaultValue ?? false) as never } })); } catch { throw new ConflictException('A flag with this key already exists.'); }
  }
  async updateFlag(key: string, b: { description?: string; defaultValue?: unknown; status?: string }) {
    if (!(await this.prisma.ccFeatureFlag.findUnique({ where: { key } }))) throw new NotFoundException('Flag not found.');
    const f = await this.prisma.ccFeatureFlag.update({ where: { key }, data: { ...(b.description !== undefined ? { description: b.description } : {}), ...(b.defaultValue !== undefined ? { defaultValue: b.defaultValue as never } : {}), ...(b.status ? { status: b.status } : {}) } });
    this.modules.clear();
    return this.flagOut(f);
  }
  async listOverrides(key: string) {
    const rows = await this.prisma.ccFlagOverride.findMany({ where: { flagKey: key }, include: { organization: true }, orderBy: { updatedAt: 'desc' } });
    return rows.map((o) => ({ organizationId: o.organizationId, organizationName: o.organization.companyName || o.organization.name, value: o.value, updatedAt: o.updatedAt.toISOString() }));
  }
  async setOverride(key: string, organizationId: string, value: unknown) {
    if (!(await this.prisma.ccFeatureFlag.findUnique({ where: { key } }))) throw new NotFoundException('Flag not found.');
    const org = await this.prisma.organization.findFirst({ where: { id: organizationId }, select: { id: true, companyLogoUrl: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    // White label needs the company's own logo, so the app is never left with no name or logo at all.
    if (key === 'feature.white_label' && value === true && !org.companyLogoUrl) {
      throw new BadRequestException('This company has not uploaded its logo yet. Ask them to add it under Organization > Branding, then turn white label on.');
    }
    const o = await this.prisma.ccFlagOverride.upsert({ where: { flagKey_organizationId: { flagKey: key, organizationId } }, create: { flagKey: key, organizationId, value: value as never }, update: { value: value as never }, include: { organization: true } });
    this.modules.clear();
    return { organizationId, organizationName: o.organization.companyName || o.organization.name, value: o.value, updatedAt: o.updatedAt.toISOString() };
  }
  async removeOverride(key: string, organizationId: string) {
    await this.prisma.ccFlagOverride.deleteMany({ where: { flagKey: key, organizationId } });
    this.modules.clear();
  }
}
