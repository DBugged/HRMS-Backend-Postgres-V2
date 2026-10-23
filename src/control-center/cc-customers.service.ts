// Purpose: Read-only customer data for the Control Panel, taken from the HRMS tables (organizations, users).
// Important: User is a tenant-scoped model, so cross-organization counts use raw SQL (the tenant guard only inspects
//   model calls). Nothing here writes. Fields the HRMS tables do not have yet (slug, region, subscription) are derived
//   or empty until plans/billing are built.
import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuthService } from '../auth/auth.service';
import type { RegisterDto } from '../auth/dto/register.dto';
import { CcPlansService } from './cc-plans.service';
import { monthlyCharge } from './cc-util';
import { planOut } from './cc-plans.service';

export interface UsageSnapshot {
  active_users: number;
  seats_used: number;
  storage_bytes: number;
  api_calls: number;
  last_active_at: string | null;
}

type OrgRow = Prisma.OrganizationGetPayload<Record<string, never>>;
type SubRow = Prisma.CcSubscriptionGetPayload<{ include: { plan: true } }>;

const SORTABLE: Record<string, string> = { name: 'name', region: 'country', status: 'platformStatus', createdAt: 'createdAt' };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';

@Injectable()
export class CcCustomersService {
  private readonly logger = new Logger(CcCustomersService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly auth: AuthService,
    private readonly plans: CcPlansService,
  ) {}

  /** Shape the panel's Organization type expects. The slug gets an id suffix so two companies with one name stay distinct. */
  private toOrganization(o: OrgRow, extra: { counts?: { active: number; total: number }; sub?: SubRow | null } = {}) {
    const sub = extra.sub ?? null;
    const active = extra.counts?.active ?? 0;
    const name = o.companyName || o.name;
    return {
      id: o.id,
      name,
      slug: `${slugify(name)}-${o.id.slice(0, 6)}`,
      status: o.platformStatus,
      region: o.country || 'India',
      billingEmail: o.contactEmail ?? '',
      phone: o.phone ?? o.mobile ?? null,
      city: o.city,
      state: o.state,
      country: o.country,
      gstin: o.gstin,
      setupComplete: o.isInitialized,
      externalHrmsOrgId: null,
      // Employees = HRMS users: "active" is what you bill on, "created" is every record ever made.
      employeeCount: active,
      employeesCreated: extra.counts?.total ?? 0,
      accessEnabled: o.isActive,
      estimatedMonthlyBill: sub ? monthlyCharge(sub.plan, sub.term, active) : null,
      currentSubscription: sub ? { id: sub.id, organizationId: o.id, planId: sub.planId, plan: planOut(sub.plan), term: sub.term, termMonths: sub.termMonths, includedEmployeesSnap: sub.includedEmployeesSnap, status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, createdAt: sub.createdAt.toISOString() } : null,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  }

  async list(q: { page?: number; pageSize?: number; q?: string; sort?: string; status?: string }) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const [field, dir] = (q.sort ?? 'createdAt:desc').split(':');
    const orderBy = { [SORTABLE[field] ?? 'createdAt']: dir === 'asc' ? 'asc' : 'desc' } as Prisma.OrganizationOrderByWithRelationInput;
    const where: Prisma.OrganizationWhereInput = {
      ...(q.status ? { platformStatus: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { companyName: { contains: q.q, mode: 'insensitive' } },
              { contactEmail: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.organization.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.organization.count({ where }),
    ]);
    const ctx = await this.context(rows.map((o) => o.id));
    return { data: rows.map((o) => this.toOrganization(o, { counts: ctx.counts.get(o.id), sub: ctx.subs.get(o.id) })), page, pageSize, total };
  }

  /** Employee counts and the live subscription for a set of organizations, in two queries. */
  private async context(ids: string[]) {
    const counts = new Map<string, { active: number; total: number }>();
    const subs = new Map<string, SubRow>();
    if (!ids.length) return { counts, subs };
    const rows = await this.prisma.$queryRaw<{ org: string; active: bigint; total: bigint }[]>`
      SELECT "organizationId" AS org, COUNT(*) FILTER (WHERE "isActive") AS active, COUNT(*) AS total
      FROM users WHERE "organizationId" = ANY(${ids}::text[]) GROUP BY 1`;
    for (const r of rows) counts.set(r.org, { active: Number(r.active), total: Number(r.total) });
    const live = await this.prisma.ccSubscription.findMany({ where: { organizationId: { in: ids }, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: true }, orderBy: { createdAt: 'desc' } });
    for (const s of live) if (!subs.has(s.organizationId)) subs.set(s.organizationId, s);
    return { counts, subs };
  }

  async get(id: string) {
    const org = await this.prisma.organization.findFirst({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found.');
    const ctx = await this.context([id]);
    return { ...this.toOrganization(org, { counts: ctx.counts.get(id), sub: ctx.subs.get(id) }), usageSnapshot: await this.usage(id), employeeLimit: null };
  }

  /** Users of one organization (or all when id is omitted). Storage and API calls are not tracked yet, so they read 0. */
  async usage(id?: string): Promise<UsageSnapshot> {
    const rows = await this.prisma.$queryRaw<{ active: bigint; last: Date | null }[]>`
      SELECT COUNT(*) FILTER (WHERE "isActive") AS active, MAX("lastLoginAt") AS last
      FROM users WHERE (${id ?? null}::text IS NULL OR "organizationId" = ${id ?? null})`;
    const active = Number(rows[0]?.active ?? 0);
    return { active_users: active, seats_used: active, storage_bytes: 0, api_calls: 0, last_active_at: rows[0]?.last?.toISOString() ?? null };
  }

  async orgUsage(id: string) {
    if (!(await this.prisma.organization.findFirst({ where: { id }, select: { id: true } }))) throw new NotFoundException('Organization not found.');
    return { organizationId: id, current: await this.usage(id), series: [] };
  }

  /** Everything the dashboard shows, from real data: customers, employees, monthly revenue, what needs attention. */
  async overview() {
    const now = new Date();
    const [orgs, totals, live, overdue, recent] = await Promise.all([
      this.prisma.organization.groupBy({ by: ['platformStatus'], _count: true }),
      this.usage(),
      this.prisma.ccSubscription.findMany({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: true, organization: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.ccInvoice.aggregate({ where: { status: 'OPEN', dueDate: { lt: now } }, _count: true, _sum: { total: true } }),
      this.prisma.organization.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
    ]);
    const ctx = await this.context([...new Set(live.map((s) => s.organizationId)), ...recent.map((o) => o.id)]);
    const byStatus = Object.fromEntries(orgs.map((g) => [g.platformStatus, g._count]));
    // One live subscription per organization (the newest); revenue = what each owes per month on its plan.
    const seen = new Set<string>();
    let mrr = 0;
    const trialsEnding: { organizationId: string; organizationName: string; planName: string; trialEndsAt: string; daysLeft: number }[] = [];
    for (const s of live) {
      if (seen.has(s.organizationId)) continue;
      seen.add(s.organizationId);
      const charge = monthlyCharge(s.plan, s.term, ctx.counts.get(s.organizationId)?.active ?? 0);
      if (s.status === 'ACTIVE' && charge) mrr += charge;
      if (s.status === 'TRIALING' && s.trialEndsAt) {
        const daysLeft = Math.ceil((s.trialEndsAt.getTime() - now.getTime()) / 86400000);
        if (daysLeft <= 14) trialsEnding.push({ organizationId: s.organizationId, organizationName: s.organization.companyName || s.organization.name, planName: s.plan.name, trialEndsAt: s.trialEndsAt.toISOString(), daysLeft });
      }
    }
    const total = orgs.reduce((n, g) => n + g._count, 0);
    return {
      totals, organizations: total, activeOrganizations: byStatus.ACTIVE ?? 0, suspendedOrganizations: byStatus.SUSPENDED ?? 0, archivedOrganizations: byStatus.ARCHIVED ?? 0,
      activeSubscriptions: live.filter((s) => s.status === 'ACTIVE').length, trialingSubscriptions: live.filter((s) => s.status === 'TRIALING').length,
      organizationsWithoutPlan: Math.max(0, (byStatus.ACTIVE ?? 0) - seen.size),
      estimatedMonthlyRevenue: Math.round(mrr * 100) / 100,
      openInvoices: await this.prisma.ccInvoice.count({ where: { status: 'OPEN' } }), overdueInvoices: overdue._count, overdueAmount: Number(overdue._sum.total ?? 0),
      openTickets: await this.prisma.ccTicket.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      trialsEnding: trialsEnding.sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5),
      recentSignups: recent.map((o) => this.toOrganization(o, { counts: ctx.counts.get(o.id) })),
      series: [],
    };
  }

  /** Onboard a customer: creates the organization with its first admin exactly like self-registration does, then emails the admin a link to set a password. */
  async create(b: { name: string; adminName: string; adminEmail: string; planId?: string }) {
    if (!b.name?.trim() || !b.adminName?.trim() || !b.adminEmail?.trim()) throw new BadRequestException('Company name, admin name and admin email are required.');
    const email = b.adminEmail.trim().toLowerCase();
    // The admin never sees this password: they set their own through the emailed link.
    const password = `${randomBytes(18).toString('base64url')}Aa1!`;
    await this.auth.register({ organizationName: b.name.trim(), name: b.adminName.trim(), email, password } as RegisterDto);
    const [founder] = await this.prisma.$queryRaw<{ id: string; org: string }[]>`SELECT id, "organizationId" AS org FROM users WHERE lower(email) = ${email} LIMIT 1`;
    if (!founder) throw new NotFoundException('The organization was created but its admin could not be found.');
    // Created by a Super Admin, so the address is trusted: no confirmation email step.
    await this.prisma.$executeRaw`UPDATE users SET "emailVerified" = true, "emailVerificationToken" = NULL, "emailVerificationExpires" = NULL WHERE id = ${founder.id}`;
    if (b.planId) await this.plans.createSubscription({ organizationId: founder.org, planId: b.planId });
    await this.auth.forgotPassword({ email } as never).catch((e) => this.logger.warn(`Could not email the set-password link to ${email}: ${e?.message}`));
    return this.get(founder.org);
  }

  /** Company profile fields a Super Admin may correct. */
  async update(id: string, b: { name?: string; billingEmail?: string; phone?: string; city?: string; state?: string; country?: string; gstin?: string }) {
    const org = await this.prisma.organization.findFirst({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found.');
    const data: Prisma.OrganizationUpdateInput = {
      ...(b.name?.trim() ? { name: b.name.trim(), companyName: b.name.trim() } : {}),
      ...(b.billingEmail !== undefined ? { contactEmail: b.billingEmail.trim() || null } : {}),
      ...(b.phone !== undefined ? { phone: b.phone.trim() || null } : {}),
      ...(b.city !== undefined ? { city: b.city.trim() || null } : {}),
      ...(b.state !== undefined ? { state: b.state.trim() || null } : {}),
      ...(b.country !== undefined ? { country: b.country.trim() || 'India' } : {}),
      ...(b.gstin !== undefined ? { gstin: b.gstin.trim().toUpperCase() || null } : {}),
    };
    await this.prisma.organization.updateMany({ where: { id }, data: data as never });
    return this.get(id);
  }

  /** Every feature flag with this organization's override (if any) and the value it ends up with. */
  async orgFlags(organizationId: string) {
    const [flags, overrides] = await Promise.all([this.prisma.ccFeatureFlag.findMany({ where: { status: 'ACTIVE' }, orderBy: { key: 'asc' } }), this.prisma.ccFlagOverride.findMany({ where: { organizationId } })]);
    const byKey = new Map(overrides.map((o) => [o.flagKey, o.value]));
    return flags.map((f) => ({ key: f.key, description: f.description, defaultValue: f.defaultValue, overridden: byKey.has(f.key), value: byKey.has(f.key) ? byKey.get(f.key) : f.defaultValue }));
  }

  /** Send a company admin a link to set a new password (support tool for a locked-out customer). */
  async sendAdminReset(organizationId: string, userId: string, actorEmail: string) {
    const [u] = await this.prisma.$queryRaw<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId} AND "organizationId" = ${organizationId} AND role = 'ADMIN' LIMIT 1`;
    if (!u) throw new NotFoundException('Admin not found in this organization.');
    await this.auth.forgotPassword({ email: u.email } as never);
    this.logger.warn(`Password reset link sent to ${u.email} (org ${organizationId}) by ${actorEmail}`);
    return { sent: true, email: u.email };
  }

  /** The people a Super Admin could act as in an organization: its active ADMIN users. */
  async admins(organizationId: string) {
    const rows = await this.prisma.$queryRaw<{ id: string; email: string; name: string }[]>`
      SELECT id, email, name FROM users WHERE "organizationId" = ${organizationId} AND role = 'ADMIN' AND "isActive" ORDER BY name`;
    return rows;
  }

  /**
   * Suspend / reactivate / archive. isActive is what the HRMS app enforces (nobody in the organisation can sign in or
   * use a session while it is false); platformStatus is what the panel shows. Nothing is deleted.
   */
  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED', actorEmail: string, reason?: string) {
    const org = await this.prisma.organization.findFirst({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found.');
    await this.prisma.organization.updateMany({ where: { id }, data: { platformStatus: status, isActive: status === 'ACTIVE' } });
    this.logger.warn(`Organization ${id} (${org.name}) ${org.platformStatus} -> ${status} by ${actorEmail}${reason ? `: ${reason}` : ''}`);
    return this.get(id);
  }

  /**
   * PERMANENT delete of an organization and everything it owns. The caller must type the organization's exact name.
   * Every tenant table carries organizationId, so rows are removed table by table; a table blocked by a foreign key
   * from another is retried on the next pass, and the whole thing is one transaction - any failure rolls back untouched.
   * Files already uploaded to storage are not removed here.
   */
  async remove(id: string, confirmName: string, actorEmail: string) {
    const org = await this.prisma.organization.findFirst({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found.');
    const expected = org.companyName || org.name;
    if ((confirmName ?? '').trim() !== expected) throw new BadRequestException('The name you typed does not match this organization.');
    return this.purge(org, actorEmail);
  }

  /**
   * Bulk archive / delete: each organization is handled on its own (its own transaction), so one failure never blocks
   * the rest. The panel gets the list that succeeded and, for the others, the reason.
   */
  async bulk(action: 'archive' | 'delete', ids: string[], actorEmail: string, reason?: string) {
    const unique = [...new Set(ids)];
    if (!unique.length) throw new BadRequestException('Select at least one organization.');
    if (unique.length > 50) throw new BadRequestException('You can act on at most 50 organizations at a time.');
    const done: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of unique) {
      try {
        if (action === 'archive') await this.setStatus(id, 'ARCHIVED', actorEmail, reason);
        else {
          const org = await this.prisma.organization.findFirst({ where: { id } });
          if (!org) throw new NotFoundException('Organization not found.');
          await this.purge(org, actorEmail);
        }
        done.push(id);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : 'Failed' });
      }
    }
    return { succeeded: done, failed };
  }

  private async purge(org: OrgRow, actorEmail: string) {
    const id = org.id;
    const tables = (
      await this.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organizationId' ORDER BY table_name`
    ).map((r) => r.table_name);

    await this.prisma.$transaction(
      async (tx) => {
        // organizations.initializedById points back at a user of the same organisation.
        await tx.$executeRaw`UPDATE organizations SET "initializedById" = NULL WHERE id = ${id}`;
        let pending = tables;
        for (let pass = 0; pass < 25 && pending.length; pass++) {
          const blocked: string[] = [];
          for (const t of pending) {
            await tx.$executeRawUnsafe('SAVEPOINT cc_del');
            try {
              await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "organizationId" = $1`, id);
              await tx.$executeRawUnsafe('RELEASE SAVEPOINT cc_del');
            } catch (e) {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cc_del');
              blocked.push(t);
            }
          }
          if (blocked.length === pending.length) {
            throw new ConflictException(`Could not delete: ${blocked.join(', ')} still reference other data.`);
          }
          pending = blocked;
        }
        if (pending.length) throw new ConflictException('Could not delete: tables are still linked after repeated attempts.');
        await tx.$executeRaw`DELETE FROM organizations WHERE id = ${id}`;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    this.logger.warn(`Organization ${id} (${org.name}) PERMANENTLY DELETED by ${actorEmail}`);
    return { deleted: true, id };
  }
}
