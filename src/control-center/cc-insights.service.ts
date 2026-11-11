// Purpose: read-only views of a customer for support and billing: how far its HRMS setup is, and how much it is really
//   using the product. Counts come straight from the HRMS tables; nothing is changed.
// Important: User and most tables are tenant-scoped, so these use raw SQL filtered by organizationId (the tenant guard only
//   inspects model calls). Table names are fixed in this file, never built from input.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { storageBytes } from './cc-storage';

const SETUP_AREAS: { key: string; label: string; table: string }[] = [
  { key: 'locations', label: 'Work locations', table: 'work_locations' },
  { key: 'departments', label: 'Departments', table: 'departments' },
  { key: 'schedules', label: 'Work schedules', table: 'work_schedules' },
  { key: 'leaveTypes', label: 'Leave types', table: 'leave_types' },
  { key: 'holidays', label: 'Holidays', table: 'holidays' },
  { key: 'salaryComponents', label: 'Salary components', table: 'salary_components' },
  { key: 'payrollSettings', label: 'Payroll settings', table: 'payroll_settings' },
  { key: 'statutory', label: 'Statutory configuration', table: 'statutory_config_versions' },
  { key: 'emailTemplates', label: 'Email templates', table: 'email_templates' },
];

@Injectable()
export class CcInsightsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  private async count(table: string, organizationId: string, since?: Date): Promise<number> {
    const q = since
      ? `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "organizationId" = $1 AND "createdAt" >= $2`
      : `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "organizationId" = $1`;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(q, ...(since ? [organizationId, since] : [organizationId]));
      return rows[0]?.n ?? 0;
    } catch {
      return 0; // a table this version of HRMS does not have yet counts as empty rather than failing the page
    }
  }

  private async org(id: string) {
    const o = await this.prisma.organization.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Organization not found.');
    return o;
  }

  /** The company's setup wizard and the master data it has filled in. */
  async setup(organizationId: string) {
    const o = await this.org(organizationId);
    const areas = await Promise.all(SETUP_AREAS.map(async (a) => ({ key: a.key, label: a.label, count: await this.count(a.table, organizationId) })));
    const done = areas.filter((a) => a.count > 0).length;
    return { wizardComplete: o.isInitialized, wizardStep: o.setupStep, areas: areas.map((a) => ({ ...a, done: a.count > 0 })), doneCount: done, total: areas.length };
  }

  /** What the company actually does in the product (last 7/30/90 days). */
  async activity(organizationId: string) {
    await this.org(organizationId);
    const d = (n: number) => new Date(Date.now() - n * 86400000);
    const [users] = await this.prisma.$queryRaw<{ active: number; created: number; l7: number; l30: number; last: Date | null }[]>`
      SELECT COUNT(*) FILTER (WHERE "isActive")::int AS active, COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE "lastLoginAt" >= ${d(7)})::int AS l7, COUNT(*) FILTER (WHERE "lastLoginAt" >= ${d(30)})::int AS l30,
             MAX("lastLoginAt") AS last
      FROM users WHERE "organizationId" = ${organizationId}`;
    const [attendance30, leaves90, payroll90, payrollTotal, assets, storage] = await Promise.all([
      this.count('attendances', organizationId, d(30)), this.count('leaves', organizationId, d(90)),
      this.count('payroll_runs', organizationId, d(90)), this.count('payroll_runs', organizationId), this.count('assets', organizationId), storageBytes(organizationId),
    ]);
    return {
      employees: { active: users?.active ?? 0, created: users?.created ?? 0 },
      logins: { last7Days: users?.l7 ?? 0, last30Days: users?.l30 ?? 0, lastAt: users?.last?.toISOString() ?? null },
      attendanceRecords30Days: attendance30, leaveRequests90Days: leaves90, payrollRuns90Days: payroll90, payrollRunsTotal: payrollTotal, assets,
      storageBytes: storage,
    };
  }

  /** The same activity numbers for every company at once (grouped queries, not one round of queries per company), plus platform totals. */
  async activityAll() {
    const d = (n: number) => new Date(Date.now() - n * 86400000);
    const orgs = await this.prisma.organization.findMany({ where: { platformStatus: { not: 'ARCHIVED' } }, select: { id: true, name: true, companyName: true, platformStatus: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 });
    const users = await this.prisma.$queryRaw<{ org: string; active: number; created: number; l7: number; l30: number; last: Date | null }[]>`
      SELECT "organizationId" AS org, COUNT(*) FILTER (WHERE "isActive")::int AS active, COUNT(*)::int AS created,
             COUNT(*) FILTER (WHERE "lastLoginAt" >= ${d(7)})::int AS l7, COUNT(*) FILTER (WHERE "lastLoginAt" >= ${d(30)})::int AS l30, MAX("lastLoginAt") AS last
      FROM users GROUP BY "organizationId"`;
    const grouped = async (table: string, since?: Date) => {
      try {
        const rows = since
          ? await this.prisma.$queryRawUnsafe<{ org: string; n: number }[]>(`SELECT "organizationId" AS org, COUNT(*)::int AS n FROM "${table}" WHERE "createdAt" >= $1 GROUP BY "organizationId"`, since)
          : await this.prisma.$queryRawUnsafe<{ org: string; n: number }[]>(`SELECT "organizationId" AS org, COUNT(*)::int AS n FROM "${table}" GROUP BY "organizationId"`);
        return new Map(rows.map((r) => [r.org, r.n]));
      } catch {
        return new Map<string, number>();
      }
    };
    const [att, leaves, payroll] = await Promise.all([grouped('attendances', d(30)), grouped('leaves', d(90)), grouped('payroll_runs', d(90))]);
    const byOrg = new Map(users.map((u) => [u.org, u]));
    const companies = orgs.map((o) => {
      const u = byOrg.get(o.id);
      return {
        id: o.id, name: o.companyName || o.name, status: o.platformStatus,
        employees: { active: u?.active ?? 0, created: u?.created ?? 0 },
        logins: { last7Days: u?.l7 ?? 0, last30Days: u?.l30 ?? 0, lastAt: u?.last?.toISOString() ?? null },
        attendanceRecords30Days: att.get(o.id) ?? 0, leaveRequests90Days: leaves.get(o.id) ?? 0, payrollRuns90Days: payroll.get(o.id) ?? 0,
      };
    });
    const sum = (f: (c: (typeof companies)[number]) => number) => companies.reduce((t, c) => t + f(c), 0);
    return {
      companies,
      totals: {
        companies: companies.length, activeEmployees: sum((c) => c.employees.active), signedIn30Days: sum((c) => c.logins.last30Days), signedIn7Days: sum((c) => c.logins.last7Days),
        attendanceRecords30Days: sum((c) => c.attendanceRecords30Days), leaveRequests90Days: sum((c) => c.leaveRequests90Days), payrollRuns90Days: sum((c) => c.payrollRuns90Days),
        inactiveCompanies: companies.filter((c) => c.status === 'ACTIVE' && c.logins.last30Days === 0).length,
      },
    };
  }
}
