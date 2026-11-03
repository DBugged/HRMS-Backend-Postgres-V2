// Purpose: the Super Admin's smoke test - one click that checks the whole product is up: the backend, the Control Panel, the web app,
//   the mobile app's server side and the sign-in rules every role depends on.
// Responsibilities: runs read-only checks (a database ping, migration state, a handful of GETs against this API with the caller's own
//   panel token, a fetch of the web app's pages, and "does this route refuse a bad token" probes for what the web and mobile apps call)
//   and returns pass / fail per check, grouped by area.
// Important: nothing is written and no one is signed in as anybody. The probes use an invalid token on purpose; a route that answers
//   anything but 401 for it is reported, because that means its guard is missing or the route has moved.
import { Inject, Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { frontendUrl } from '../common/frontend-url';

export interface SmokeCheck { name: string; ok: boolean; detail: string; ms: number }
export interface SmokeSection { key: 'backend' | 'control-panel' | 'web' | 'mobile' | 'access'; title: string; checks: SmokeCheck[] }
export interface SmokeResult { startedAt: string; durationMs: number; passed: number; failed: number; sections: SmokeSection[] }

// What the web and mobile apps call after sign-in. Each must refuse a bad token with 401 (not 404 = moved, not 500 = broken).
const WEB_ROUTES = ['/employees', '/leaves', '/attendance', '/payroll', '/notifications', '/organizations/me', '/reports/statutory-tracker', '/audit-logs', '/org-health'];
const MOBILE_ROUTES = ['/notifications', '/leaves', '/attendance', '/payroll', '/employees/profile-scores', '/overtime', '/comp-offs', '/loans', '/reimbursements', '/tax-declarations'];

const TIMEOUT_MS = 8000;

async function timed(name: string, run: () => Promise<string>): Promise<SmokeCheck> {
  const t0 = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, detail, ms: Date.now() - t0 };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : 'Failed', ms: Date.now() - t0 };
  }
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
}

@Injectable()
export class CcSmokeService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async run(authorization: string | undefined): Promise<SmokeResult> {
    const t0 = Date.now();
    const self = `http://127.0.0.1:${process.env.PORT ?? 4000}`;
    const web = frontendUrl().replace(/\/$/, '');

    const expect401 = (base: string, path: string) => timed(`${path} refuses a bad token`, async () => {
      const res = await get(`${base}${path}`, { Authorization: 'Bearer smoke-test-invalid' });
      if (res.status !== 401) throw new Error(`answered ${res.status}, expected 401`);
      return '401';
    });

    const [backend, panel, webChecks, mobile, access] = await Promise.all([
      Promise.all([
        timed('Database answers', async () => { await this.prisma.$queryRaw`SELECT 1`; return 'ok'; }),
        timed('All migrations applied', async () => {
          const rows = await this.prisma.$queryRaw<{ pending: bigint }[]>`SELECT COUNT(*)::bigint AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
          const pending = Number(rows[0]?.pending ?? 0);
          if (pending > 0) throw new Error(`${pending} migration(s) started but not finished`);
          return 'none pending';
        }),
        timed('Secrets configured', async () => {
          const missing = ['JWT_ACCESS_SECRET', 'DATABASE_URL'].filter((k) => !process.env[k]);
          if (!process.env.FILE_TOKEN_SECRET && !process.env.JWT_ACCESS_SECRET) missing.push('FILE_TOKEN_SECRET');
          if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
          return 'present';
        }),
        timed('Scheduled jobs registered', async () => {
          const n = this.scheduler.getCronJobs().size;
          if (n === 0) throw new Error('no scheduled jobs are running');
          return `${n} jobs`;
        }),
        timed('Health route answers', async () => {
          const res = await get(`${self}/health`);
          if (res.status !== 200) throw new Error(`answered ${res.status}`);
          return '200';
        }),
      ]),
      Promise.all(['/api/v1/plans', '/api/v1/organizations', '/api/v1/reports/revenue?months=1', '/api/v1/reports/ageing'].map((path) => timed(`Panel ${path.split('?')[0]}`, async () => {
        const res = await get(`${self}${path}`, authorization ? { Authorization: authorization } : {});
        if (res.status !== 200) throw new Error(`answered ${res.status}`);
        return '200';
      }))),
      Promise.all(['/login', '/'].map((path) => timed(`Web ${path} loads`, async () => {
        const res = await get(`${web}${path}`);
        if (res.status >= 400) throw new Error(`answered ${res.status}`);
        return String(res.status);
      }))),
      Promise.all([
        ...MOBILE_ROUTES.map((p) => expect401(self, p)),
        timed('Sign-in route rejects an empty request', async () => {
          const res = await fetch(`${self}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (![400, 401, 422].includes(res.status)) throw new Error(`answered ${res.status}`);
          return String(res.status);
        }),
      ]),
      Promise.all(WEB_ROUTES.map((p) => expect401(self, p))),
    ]);

    const sections: SmokeSection[] = [
      { key: 'backend', title: 'Backend', checks: backend },
      { key: 'control-panel', title: 'Control Panel', checks: panel },
      { key: 'web', title: 'Web app', checks: webChecks },
      { key: 'mobile', title: 'Mobile app (Android and iOS)', checks: mobile },
      { key: 'access', title: 'Roles and access (Admin, HR, Manager, Employee)', checks: access },
    ];
    const all = sections.flatMap((s) => s.checks);
    return {
      startedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      passed: all.filter((c) => c.ok).length,
      failed: all.filter((c) => !c.ok).length,
      sections,
    };
  }
}
