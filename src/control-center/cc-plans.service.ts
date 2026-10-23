// Purpose: plans and subscriptions for the Control Panel.
// Important: a plan that has subscriptions cannot be deleted (mark it DEPRECATED instead), so billing history stays readable.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CcPlan, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { addMonths, num, orgSlug, paging, TERM_MONTHS, type PageQuery } from './cc-util';

const PLAN_FIELDS = ['name', 'code', 'billingModel', 'currency', 'trialDays', 'perEmployeeRate', 'termMonths', 'basePrice', 'includedEmployees', 'perExtraEmployeeRate', 'seatLimit', 'gstApplicable', 'whiteLabelEligible', 'features', 'limits', 'isPublic', 'status'] as const;

export const planOut = (p: CcPlan) => ({
  ...p,
  perEmployeeRate: num(p.perEmployeeRate),
  basePrice: num(p.basePrice),
  perExtraEmployeeRate: num(p.perExtraEmployeeRate),
  createdAt: p.createdAt.toISOString(),
});

@Injectable()
export class CcPlansService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  async listPlans(q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcPlanWhereInput = q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }] } : {};
    const [rows, total] = await Promise.all([
      this.prisma.ccPlan.findMany({ where, orderBy: [{ perEmployeeRate: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }], skip, take }),
      this.prisma.ccPlan.count({ where }),
    ]);
    return { data: rows.map(planOut), page, pageSize, total };
  }

  async getPlan(id: string) {
    const p = await this.prisma.ccPlan.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Plan not found.');
    return planOut(p);
  }

  private pick(body: Record<string, unknown>) {
    const data: Record<string, unknown> = {};
    for (const k of PLAN_FIELDS) if (k in body) data[k] = body[k];
    return data as Prisma.CcPlanUncheckedCreateInput;
  }

  async createPlan(body: Record<string, unknown>) {
    const data = this.pick(body);
    if (!data.name || !data.code) throw new BadRequestException('Name and code are required.');
    try {
      return planOut(await this.prisma.ccPlan.create({ data }));
    } catch {
      throw new ConflictException('A plan with this code already exists.');
    }
  }

  async updatePlan(id: string, body: Record<string, unknown>) {
    await this.getPlan(id);
    return planOut(await this.prisma.ccPlan.update({ where: { id }, data: this.pick(body) }));
  }

  async removePlan(id: string) {
    await this.getPlan(id);
    if (await this.prisma.ccSubscription.count({ where: { planId: id } }))
      throw new ConflictException('This plan has subscriptions. Mark it Deprecated instead of deleting it.');
    await this.prisma.ccPlan.delete({ where: { id } });
  }

  // ---- subscriptions ----
  private subOut(s: Prisma.CcSubscriptionGetPayload<{ include: { plan: true; organization: true } }>) {
    const org = s.organization;
    return {
      id: s.id, organizationId: s.organizationId,
      organization: { id: org.id, name: org.companyName || org.name, slug: orgSlug(org.companyName || org.name, org.id) },
      planId: s.planId, plan: planOut(s.plan), term: s.term, termMonths: s.termMonths,
      includedEmployeesSnap: s.includedEmployeesSnap, customPerEmployeeRate: num(s.customPerEmployeeRate), maxEmployees: s.maxEmployees, status: s.status,
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null, currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd, createdAt: s.createdAt.toISOString(),
    };
  }
  private readonly incl = { plan: true, organization: true } as const;

  async listSubscriptions(q: PageQuery & { status?: string; organizationId?: string }) {
    const { page, pageSize, skip, take } = paging(q);
    const where: Prisma.CcSubscriptionWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.organizationId ? { organizationId: q.organizationId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.ccSubscription.findMany({ where, include: this.incl, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.ccSubscription.count({ where }),
    ]);
    return { data: rows.map((r) => this.subOut(r)), page, pageSize, total };
  }

  async getSubscription(id: string) {
    const s = await this.prisma.ccSubscription.findUnique({ where: { id }, include: this.incl });
    if (!s) throw new NotFoundException('Subscription not found.');
    return this.subOut(s);
  }

  /** The terms a plan offers (Starter: monthly/yearly, Professional: yearly, Business: 5 years). Defaults to the first. */
  private pickTerm(plan: CcPlan, wanted?: string) {
    const terms = (plan.limits as { allowedTerms?: string[] })?.allowedTerms ?? ['MONTHLY'];
    if (wanted && !terms.includes(wanted)) throw new BadRequestException(`${plan.name} is only offered as: ${terms.join(', ')}.`);
    const term = wanted ?? terms[0];
    return { term, termMonths: TERM_MONTHS[term] ?? 1 };
  }
  /** A plan with no per-employee rate (Enterprise) needs a negotiated one before it can be billed. */
  /** A hard employee limit must be a whole number of at least 1 (null clears it). */
  private pickMax(v?: number | null) {
    if (v == null) return null;
    if (!Number.isInteger(Number(v)) || Number(v) < 1) throw new BadRequestException('The employee limit must be a whole number of at least 1.');
    return Number(v);
  }
  private pickRate(plan: CcPlan, rate?: number | null) {
    if (rate != null && !(Number(rate) > 0)) throw new BadRequestException('The rate must be more than zero.');
    if (rate == null && plan.perEmployeeRate == null) throw new BadRequestException(`${plan.name} has custom pricing: enter the agreed per-employee rate.`);
    return rate ?? null;
  }

  async createSubscription(b: { organizationId: string; planId: string; trialDaysOverride?: number; term?: string; customPerEmployeeRate?: number | null; maxEmployees?: number | null }) {
    const [org, plan] = await Promise.all([this.prisma.organization.findFirst({ where: { id: b.organizationId } }), this.prisma.ccPlan.findUnique({ where: { id: b.planId } })]);
    if (!org) throw new NotFoundException('Organization not found.');
    if (!plan) throw new NotFoundException('Plan not found.');
    if (await this.prisma.ccSubscription.count({ where: { organizationId: org.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } }))
      throw new ConflictException('This organization already has a live subscription. Change its plan instead.');
    const { term, termMonths } = this.pickTerm(plan, b.term);
    const customRate = this.pickRate(plan, b.customPerEmployeeRate);
    const trialDays = b.trialDaysOverride ?? plan.trialDays;
    const now = new Date();
    const trialEndsAt = trialDays > 0 ? new Date(now.getTime() + trialDays * 86400000) : null;
    const s = await this.prisma.ccSubscription.create({
      data: { organizationId: org.id, planId: plan.id, term, termMonths, customPerEmployeeRate: customRate, maxEmployees: this.pickMax(b.maxEmployees), includedEmployeesSnap: plan.includedEmployees, status: trialEndsAt ? 'TRIALING' : 'ACTIVE', trialEndsAt, currentPeriodEnd: trialEndsAt ?? addMonths(now, termMonths) },
      include: this.incl,
    });
    return this.subOut(s);
  }

  async changePlan(id: string, b: { planId: string; prorate?: boolean; term?: string; customPerEmployeeRate?: number | null; maxEmployees?: number | null }) {
    const plan = await this.prisma.ccPlan.findUnique({ where: { id: b.planId } });
    if (!plan) throw new NotFoundException('Plan not found.');
    await this.getSubscription(id);
    const { term, termMonths } = this.pickTerm(plan, b.term);
    const customRate = this.pickRate(plan, b.customPerEmployeeRate);
    return this.subOut(await this.prisma.ccSubscription.update({ where: { id }, data: { planId: plan.id, term, termMonths, customPerEmployeeRate: customRate, ...('maxEmployees' in b ? { maxEmployees: this.pickMax(b.maxEmployees) } : {}), includedEmployeesSnap: plan.includedEmployees }, include: this.incl }));
  }

  /** Change only the billing term or the agreed rate on the current plan. */
  async updateSubscription(id: string, b: { term?: string; customPerEmployeeRate?: number | null; maxEmployees?: number | null }) {
    const s = await this.prisma.ccSubscription.findUnique({ where: { id }, include: { plan: true } });
    if (!s) throw new NotFoundException('Subscription not found.');
    const data: Prisma.CcSubscriptionUpdateInput = {};
    if (b.term) { const t = this.pickTerm(s.plan, b.term); data.term = t.term; data.termMonths = t.termMonths; }
    if ('customPerEmployeeRate' in b) data.customPerEmployeeRate = this.pickRate(s.plan, b.customPerEmployeeRate);
    if ('maxEmployees' in b) data.maxEmployees = this.pickMax(b.maxEmployees);
    return this.subOut(await this.prisma.ccSubscription.update({ where: { id }, data, include: this.incl }));
  }

  async cancel(id: string, atPeriodEnd: boolean) {
    await this.getSubscription(id);
    return this.subOut(await this.prisma.ccSubscription.update({ where: { id }, data: atPeriodEnd ? { cancelAtPeriodEnd: true } : { status: 'CANCELED', cancelAtPeriodEnd: false }, include: this.incl }));
  }

  async resume(id: string) {
    const s = await this.getSubscription(id);
    const status = s.status === 'CANCELED' || s.status === 'EXPIRED' ? 'ACTIVE' : s.status;
    return this.subOut(await this.prisma.ccSubscription.update({ where: { id }, data: { cancelAtPeriodEnd: false, status }, include: this.incl }));
  }
}
