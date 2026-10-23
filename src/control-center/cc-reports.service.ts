// Purpose: money and customer reports for the Control Panel (revenue by month, who owes what and for how long, GST) and
//   CSV exports of organizations and invoices.
// Important: invoices that are VOID or DRAFT never count. Amounts are in the invoice currency (INR today). Months are
//   calendar months in server time.
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CcCustomersService } from './cc-customers.service';

const DAY = 86400000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export const toCsv = (cols: string[], rows: Record<string, unknown>[]) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

@Injectable()
export class CcReportsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient, private readonly customers: CcCustomersService) {}

  private months(n: number) {
    const out: string[] = [];
    const d = new Date();
    d.setUTCDate(1);
    for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))));
    return out;
  }

  /** Invoiced, collected and new customers per month. */
  async revenue(monthsBack = 12) {
    const n = Math.min(36, Math.max(1, monthsBack));
    const keys = this.months(n);
    const from = new Date(`${keys[0]}-01T00:00:00Z`);
    const [invoices, payments, orgs] = await Promise.all([
      this.prisma.ccInvoice.findMany({ where: { createdAt: { gte: from }, status: { in: ['OPEN', 'PAID', 'UNCOLLECTIBLE'] } }, select: { createdAt: true, total: true } }),
      this.prisma.ccPayment.findMany({ where: { createdAt: { gte: from }, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, select: { createdAt: true, amount: true, refundedAmount: true } }),
      this.prisma.organization.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
    ]);
    const rows = keys.map((m) => ({ month: m, invoiced: 0, collected: 0, refunded: 0, newCustomers: 0 }));
    const at = new Map(rows.map((r) => [r.month, r]));
    for (const i of invoices) { const r = at.get(monthKey(i.createdAt)); if (r) r.invoiced += Number(i.total); }
    for (const p of payments) { const r = at.get(monthKey(p.createdAt)); if (r) { r.collected += Number(p.amount); r.refunded += Number(p.refundedAmount); } }
    for (const o of orgs) { const r = at.get(monthKey(o.createdAt)); if (r) r.newCustomers++; }
    rows.forEach((r) => { r.invoiced = r2(r.invoiced); r.collected = r2(r.collected); r.refunded = r2(r.refunded); });
    return { rows, totals: { invoiced: r2(rows.reduce((s, r) => s + r.invoiced, 0)), collected: r2(rows.reduce((s, r) => s + r.collected, 0)), newCustomers: rows.reduce((s, r) => s + r.newCustomers, 0) } };
  }

  /** Unpaid invoices grouped by how late they are. */
  async ageing() {
    const open = await this.prisma.ccInvoice.findMany({ where: { status: 'OPEN' }, include: { organization: true }, orderBy: { dueDate: 'asc' } });
    const buckets = [
      { key: 'current', label: 'Not due yet', count: 0, amount: 0 }, { key: 'd1_30', label: '1-30 days late', count: 0, amount: 0 },
      { key: 'd31_60', label: '31-60 days late', count: 0, amount: 0 }, { key: 'd61_90', label: '61-90 days late', count: 0, amount: 0 },
      { key: 'd90', label: 'Over 90 days late', count: 0, amount: 0 },
    ];
    const now = Date.now();
    const rows = open.map((i) => {
      const late = i.dueDate ? Math.floor((now - i.dueDate.getTime()) / DAY) : 0;
      const b = late <= 0 ? buckets[0] : late <= 30 ? buckets[1] : late <= 60 ? buckets[2] : late <= 90 ? buckets[3] : buckets[4];
      b.count++; b.amount += Number(i.total);
      return { id: i.id, number: i.number, organizationId: i.organizationId, organizationName: i.organization.companyName || i.organization.name, total: Number(i.total), dueDate: i.dueDate?.toISOString() ?? null, daysLate: Math.max(0, late) };
    });
    return { buckets: buckets.map((b) => ({ ...b, amount: r2(b.amount) })), rows: rows.sort((a, b) => b.daysLate - a.daysLate).slice(0, 100) };
  }

  /** GST collected per month on non-void invoices (for filing). */
  async gst(monthsBack = 12) {
    const keys = this.months(Math.min(36, Math.max(1, monthsBack)));
    const from = new Date(`${keys[0]}-01T00:00:00Z`);
    const inv = await this.prisma.ccInvoice.findMany({ where: { createdAt: { gte: from }, status: { in: ['OPEN', 'PAID'] } }, select: { createdAt: true, subtotal: true, discount: true, tax: true, total: true } });
    const rows = keys.map((m) => ({ month: m, invoices: 0, taxable: 0, gst: 0, total: 0 }));
    const at = new Map(rows.map((r) => [r.month, r]));
    for (const i of inv) { const r = at.get(monthKey(i.createdAt)); if (r) { r.invoices++; r.taxable += Number(i.subtotal) - Number(i.discount); r.gst += Number(i.tax); r.total += Number(i.total); } }
    rows.forEach((r) => { r.taxable = r2(r.taxable); r.gst = r2(r.gst); r.total = r2(r.total); });
    return { rows };
  }

  async exportOrganizations(): Promise<string> {
    const data: Awaited<ReturnType<CcCustomersService['list']>>['data'] = [];
    for (let page = 1; ; page++) {
      const r = await this.customers.list({ page, pageSize: 100 });
      data.push(...r.data);
      if (data.length >= r.total || !r.data.length) break;
    }
    const rows = data.map((o) => ({
      name: o.name, status: o.status, email: o.billingEmail, phone: o.phone, city: o.city, state: o.state, gstin: o.gstin, plan: o.currentSubscription?.plan?.name ?? '',
      subscription: o.currentSubscription?.status ?? '', employees: o.employeeCount, employeesCreated: o.employeesCreated, estimatedMonthlyBill: o.estimatedMonthlyBill ?? '', signedUp: o.createdAt,
    }));
    return toCsv(['name', 'status', 'email', 'phone', 'city', 'state', 'gstin', 'plan', 'subscription', 'employees', 'employeesCreated', 'estimatedMonthlyBill', 'signedUp'], rows);
  }

  async exportInvoices(organizationId?: string): Promise<string> {
    const inv = await this.prisma.ccInvoice.findMany({ where: organizationId ? { organizationId } : {}, include: { organization: true }, orderBy: { createdAt: 'desc' }, take: 10_000 });
    const rows = inv.map((i) => ({ number: i.number, organization: i.organization.companyName || i.organization.name, gstin: i.organization.gstin ?? '', status: i.status, subtotal: Number(i.subtotal), discount: Number(i.discount), gst: Number(i.tax), total: Number(i.total), currency: i.currency, created: i.createdAt.toISOString().slice(0, 10), due: i.dueDate?.toISOString().slice(0, 10) ?? '', paid: i.paidAt?.toISOString().slice(0, 10) ?? '', paymentRef: i.paymentRef ?? '' }));
    return toCsv(['number', 'organization', 'gstin', 'status', 'subtotal', 'discount', 'gst', 'total', 'currency', 'created', 'due', 'paid', 'paymentRef'], rows);
  }
}
