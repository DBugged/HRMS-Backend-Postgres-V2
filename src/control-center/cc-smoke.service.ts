// Purpose: the Super Admin's smoke test - one click that checks the whole product is up: the backend, the Control Panel, the web app,
//   the mobile app's server side and the sign-in rules every role depends on.
// Responsibilities: runs read-only checks (a database ping, migration state, a handful of GETs against this API with the caller's own
//   panel token, a fetch of the web app's pages, and "does this route refuse a bad token" probes for what the web and mobile apps call)
//   and returns pass / fail per check, grouped by area.
// Important: nothing is written and no one is signed in as anybody. The probes use an invalid token on purpose; a route that answers
//   anything but 401 for it is reported, because that means its guard is missing or the route has moved.
import { Inject, Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { frontendUrl } from '../common/frontend-url';

export interface SmokeCheck { name: string; ok: boolean; detail: string; ms: number; /** Not a failure: the thing could not be reached from here, which is not the same as being broken. */ warn?: boolean }
export interface SmokeSection { key: 'backend' | 'control-panel' | 'web' | 'mobile' | 'routes' | 'access'; title: string; checks: SmokeCheck[] }
export interface SmokeResult { startedAt: string; durationMs: number; passed: number; failed: number; warnings: number; sections: SmokeSection[] }

// What the web and mobile apps call after sign-in. Each must refuse a bad token with 401 (not 404 = moved, not 500 = broken).
const WEB_ROUTES = ['/employees', '/leaves', '/attendance', '/payroll', '/notifications', '/organizations/me', '/reports/statutory-tracker', '/audit-logs', '/org-health'];
const MOBILE_ROUTES = ['/notifications', '/leaves', '/attendance', '/payroll', '/employees/profile-scores', '/overtime', '/comp-offs', '/loans', '/reimbursements', '/tax-declarations'];

// Pages of the web app that must load (the shell answers 200 even for pages behind sign-in), and files other things depend on.
const WEB_PAGES = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/terms', '/privacy-policy', '/setup-wizard'];
const WEB_APP_PAGES = [
  '/', '/employees', '/attendance', '/leaves', '/payroll', '/loans', '/reimbursements', '/overtime-approvals', '/comp-offs', '/approvals', '/documents', '/departments',
  '/holidays', '/reports', '/statutory-compliance', '/tax-declaration', '/audit-logs', '/organization-settings', '/notifications', '/profile', '/my', '/team', '/ask-hr',
  '/onboarding-checklist', '/offboarding', '/performance-reviews', '/account-plan', '/account-billing', '/help',
];
const WEB_FILES = ['/favicon.ico', '/brand-mark.png', '/apple-touch-icon.png'];

const TIMEOUT_MS = 8000;
const PROBE_ID = '00000000-0000-0000-0000-000000000000';

interface RouteInfo { controller: string; method: string; path: string; isPublic: boolean }

/** Runs `fn` over `items` with at most `limit` in flight, so probing hundreds of routes does not flood the server. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function timed(name: string, run: () => Promise<string>, opts: { unreachableIsWarning?: boolean } = {}): Promise<SmokeCheck> {
  const t0 = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, detail, ms: Date.now() - t0 };
  } catch (err) {
    // A refused connection or timeout ("fetch failed") means we could not reach it, not that it answered wrongly.
    if (opts.unreachableIsWarning && err instanceof Error && (err.message === 'fetch failed' || err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { name, ok: true, warn: true, detail: 'not reachable from the server (is the web app running and the address set?)', ms: Date.now() - t0 };
    }
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
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** Every route the HRMS API serves (web, mobile and everything else), read from the running app rather than a hand-kept list. */
  private discoverRoutes(): RouteInfo[] {
    const routes: RouteInfo[] = [];
    const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;
      const cls = instance.constructor;
      const base = first(Reflect.getMetadata(PATH_METADATA, cls));
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as (...a: unknown[]) => unknown;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verb === undefined) continue;
        const sub = first(Reflect.getMetadata(PATH_METADATA, handler));
        if (sub.includes('*')) continue;
        const path = ('/' + [base, sub].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        routes.push({
          controller: cls.name.replace(/Controller$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
          method: RequestMethod[verb],
          path,
          isPublic: !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, cls]),
        });
      }
    }
    return routes;
  }

  /**
   * One check per area of the API. Every read route must refuse a bad token with 401 (404 = it moved, 500 = it broke). Write routes
   * are not called (that could change data); they are checked to sit behind the global sign-in guard.
   */
  private async routeChecks(self: string): Promise<SmokeCheck[]> {
    const routes = this.discoverRoutes();
    const groups = new Map<string, RouteInfo[]>();
    for (const r of routes) groups.set(r.controller, [...(groups.get(r.controller) ?? []), r]);
    const checks: SmokeCheck[] = [];
    const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const results = await pool(entries, 4, async ([name, rs]) => {
      const t0 = Date.now();
      const guarded = rs.filter((r) => !r.isPublic);
      const reads = guarded.filter((r) => r.method === 'GET');
      const writes = guarded.filter((r) => r.method !== 'GET');
      const publicCount = rs.length - guarded.length;
      if (guarded.length === 0) return { name, ok: true, detail: `${publicCount} public route${publicCount === 1 ? '' : 's'}`, ms: Date.now() - t0 } as SmokeCheck;
      const bad: string[] = [];
      await pool(reads, 6, async (r) => {
        try {
          const res = await get(`${self}${r.path.replace(/:[A-Za-z0-9_]+/g, PROBE_ID)}`, { Authorization: 'Bearer smoke-test-invalid' });
          if (res.status !== 401) bad.push(`${r.path} answered ${res.status}`);
        } catch (err) {
          bad.push(`${r.path}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      });
      const parts = [`${reads.length} read`, `${writes.length} write`, ...(publicCount ? [`${publicCount} public`] : [])].join(' · ');
      if (bad.length) return { name, ok: false, detail: `${bad.length} of ${reads.length} read routes wrong: ${bad.slice(0, 2).join('; ')}${bad.length > 2 ? '…' : ''}`, ms: Date.now() - t0 } as SmokeCheck;
      return { name, ok: true, detail: parts, ms: Date.now() - t0 } as SmokeCheck;
    });
    checks.push(...results);
    return checks;
  }

  /** Pages and files of the web app. If the app cannot be reached at all that is one warning, not dozens. */
  private async webChecks(web: string): Promise<SmokeCheck[]> {
    const first = await timed('Web /login loads', async () => {
      const res = await get(`${web}/login`);
      if (res.status >= 400) throw new Error(`answered ${res.status}`);
      return String(res.status);
    }, { unreachableIsWarning: true });
    if (first.warn) return [first];
    const page = (path: string, label: string) => timed(`${label} ${path}`, async () => {
      const res = await get(`${web}${path}`);
      if (res.status >= 400) throw new Error(`answered ${res.status}`);
      return String(res.status);
    });
    const rest = await pool(
      [...WEB_PAGES.filter((p) => p !== '/login').map((p) => ['Page', p]), ...WEB_APP_PAGES.map((p) => ['App page', p]), ...WEB_FILES.map((p) => ['File', p])],
      6,
      ([label, path]) => page(path, label),
    );
    return [first, ...rest];
  }

  async run(authorization: string | undefined): Promise<SmokeResult> {
    const t0 = Date.now();
    const self = `http://127.0.0.1:${process.env.PORT ?? 4000}`;
    const web = frontendUrl().replace(/\/$/, '');

    const expect401 = (base: string, path: string) => timed(`${path} refuses a bad token`, async () => {
      const res = await get(`${base}${path}`, { Authorization: 'Bearer smoke-test-invalid' });
      if (res.status !== 401) throw new Error(`answered ${res.status}, expected 401`);
      return '401';
    });

    const [backend, panel, webChecks, mobile, access, routeChecks] = await Promise.all([
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
      this.webChecks(web),
      Promise.all([
        ...MOBILE_ROUTES.map((p) => expect401(self, p)),
        timed('Sign-in route rejects an empty request', async () => {
          const res = await fetch(`${self}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (![400, 401, 422].includes(res.status)) throw new Error(`answered ${res.status}`);
          return String(res.status);
        }),
      ]),
      Promise.all(WEB_ROUTES.map((p) => expect401(self, p))),
      this.routeChecks(self),
    ]);

    const sections: SmokeSection[] = [
      { key: 'backend', title: 'Backend', checks: backend },
      { key: 'control-panel', title: 'Control Panel', checks: panel },
      { key: 'web', title: 'Web app', checks: webChecks },
      { key: 'mobile', title: 'Mobile app (Android and iOS)', checks: mobile },
      { key: 'routes', title: 'Every API route (web, mobile and the rest)', checks: routeChecks },
      { key: 'access', title: 'Roles and access (Admin, HR, Manager, Employee)', checks: access },
    ];
    const all = sections.flatMap((s) => s.checks);
    return {
      startedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      passed: all.filter((c) => c.ok && !c.warn).length,
      failed: all.filter((c) => !c.ok).length,
      warnings: all.filter((c) => c.warn).length,
      sections,
    };
  }
}
