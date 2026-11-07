import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ModuleAccessService } from '../src/module-access/module-access.service';

const PASSWORD = 'TestPass123!';
const RUN = Date.now(); // a fresh pair of companies each run, so leftovers from earlier runs never leak in
const KEYS = ['account_billing', 'account_plan', 'account_usage', 'account_export', 'account_support'].map((k) => `module.${k}`);
interface Body { accessToken: string; generatedPassword: string; employee: { id: string }; id: string }

describe('Account Management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let access: ModuleAccessService;
  const tok: Record<string, string> = {};
  const orgId: Record<string, string> = {};
  const invoiceId: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const get = (who: string, url: string) => http().get(url).set('Authorization', `Bearer ${tok[who]}`);
  const post = (who: string, url: string, body: object = {}) => http().post(url).set('Authorization', `Bearer ${tok[who]}`).send(body);

  const register = async (key: string, orgName: string) => {
    const email = `acct-${key}-admin-${RUN}@example.test`;
    await http().post('/auth/register').send({ organizationName: `${orgName} ${RUN}`, name: `${key} Admin`, email, password: PASSWORD });
    const login = await http().post('/auth/login').send({ email, password: PASSWORD });
    tok[`${key}Admin`] = (login.body as Body).accessToken;
    const me = await prisma.user.findFirst({ where: { email } });
    orgId[key] = me!.organizationId;
  };
  const addUser = async (key: string, role: string) => {
    const email = `acct-${key}-${role.toLowerCase()}-${RUN}@example.test`;
    const c = await http().post('/employees').set('Authorization', `Bearer ${tok[`${key}Admin`]}`).send({ name: `${role} person`, email, role, joiningDate: '2025-01-01' });
    const login = await http().post('/auth/login').send({ email, password: (c.body as Body).generatedPassword });
    tok[`${key}${role}`] = (login.body as Body).accessToken;
  };

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    access = app.get(ModuleAccessService);

    for (const key of KEYS) await prisma.ccFeatureFlag.upsert({ where: { key }, update: {}, create: { key, defaultValue: true, description: key } });
    await prisma.ccFeatureFlag.upsert({ where: { key: 'module.reports' }, update: {}, create: { key: 'module.reports', defaultValue: true, description: 'Reports' } });
    await register('a', 'Account Org A');
    await register('b', 'Account Org B');
    for (const r of ['HR', 'MANAGER', 'EMPLOYEE']) await addUser('a', r);
    const plan = await prisma.ccPlan.create({ data: { name: 'Pro E2E', code: `pro-e2e-${Date.now()}`, limits: { modules: ['module.attendance', 'module.leave', 'module.payroll'] } } });
    const other = await prisma.ccPlan.create({ data: { name: 'Plain E2E', code: `plain-e2e-${Date.now()}` } });
    for (const [key, p, cap] of [['a', plan, 10], ['b', other, 99]] as const) {
      await prisma.ccSubscription.create({ data: { organizationId: orgId[key], planId: p.id, status: 'ACTIVE', maxEmployees: cap, currentPeriodEnd: new Date(Date.now() + 90 * 86400_000) } });
      const inv = await prisma.ccInvoice.create({ data: { number: `INV-E2E-${key}-${Date.now()}`, organizationId: orgId[key], status: 'OPEN', subtotal: 1000, total: 1180, tax: 180, lineItems: [{ description: 'Plan', quantity: 1, unitAmount: 1000 }] } });
      invoiceId[key] = inv.id;
    }
    access.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows each admin only their own subscription, invoices and PDF', async () => {
    const a = await get('aAdmin', '/account-billing/overview').expect(200);
    expect((a.body as { subscription: { planName: string } }).subscription.planName).toBe('Pro E2E');
    const b = await get('bAdmin', '/account-billing/overview').expect(200);
    expect((b.body as { subscription: { planName: string } }).subscription.planName).toBe('Plain E2E');
    const list = await get('aAdmin', '/account-billing/invoices').expect(200);
    expect((list.body as { id: string }[]).map((i) => i.id)).toEqual([invoiceId.a]);
    const pdf = await get('aAdmin', `/account-billing/invoices/${invoiceId.a}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    await get('aAdmin', `/account-billing/invoices/${invoiceId.b}/pdf`).expect(404);
  });

  it('allows only the Admin role on every tab', async () => {
    for (const who of ['aHR', 'aMANAGER', 'aEMPLOYEE']) {
      for (const url of ['/account-billing/overview', '/account-plan/modules', '/account-usage', '/account-export/history', '/account-support/tickets']) {
        await get(who, url).expect(403);
      }
    }
  });

  it('reports usage and plan modules from real data', async () => {
    const u = await get('aAdmin', '/account-usage').expect(200);
    const emp = (u.body as { employees: { limit: number; active: number } }).employees;
    expect(emp.limit).toBe(10);
    expect(emp.active).toBe(await prisma.user.count({ where: { organizationId: orgId.a, isActive: true } }));
    const m = (await get('aAdmin', '/account-plan/modules').expect(200)).body as { key: string; includedInPlan: boolean; enabled: boolean }[];
    expect(m.find((x) => x.key === 'module.reports')).toMatchObject({ includedInPlan: false, enabled: false });
    expect(m.find((x) => x.key === 'module.payroll')).toMatchObject({ includedInPlan: true, enabled: true });
    expect(m.some((x) => x.key.startsWith('module.account_'))).toBe(false);
    const mb = (await get('bAdmin', '/account-plan/modules').expect(200)).body as { key: string; enabled: boolean }[];
    expect(mb.find((x) => x.key === 'module.reports')?.enabled).toBe(true);
  });

  it('records requests for the Super Admin, rejects bad ones and duplicates, and never exposes another company', async () => {
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', payload: { quantity: 0 } }).expect(400);
    await post('aAdmin', '/account-plan/requests', { type: 'RENEWAL' }).expect(400); // not a plan-tab request
    const ok = await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', message: 'Hiring', payload: { quantity: 5 } }).expect(201);
    expect((ok.body as { status: string }).status).toBe('PENDING');
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', payload: { quantity: 2 } }).expect(409);
    await post('aAdmin', '/account-billing/requests', { type: 'RENEWAL' }).expect(201);
    expect(((await get('aAdmin', '/account-plan/requests')).body as unknown[]).length).toBe(1);
    expect(((await get('bAdmin', '/account-plan/requests')).body as unknown[]).length).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId.a, action: 'ACCOUNT_REQUEST_CREATED' } })).toBe(2);
  });

  it('exports own data, keeps history, blocks other tenants and expired links', async () => {
    await post('aAdmin', '/account-export', { category: 'NOPE' }).expect(400);
    const created = await post('aAdmin', '/account-export', { category: 'EMPLOYEES', format: 'CSV' }).expect(201);
    const id = (created.body as Body).id;
    const file = await get('aAdmin', `/account-export/${id}/download`).expect(200);
    const text = file.text ?? String(file.body);
    expect(text).toContain(`acct-a-admin-${RUN}@example.test`);
    expect(text).not.toContain(`acct-b-admin-${RUN}@example.test`);
    await get('bAdmin', `/account-export/${id}/download`).expect(404);
    expect(((await get('bAdmin', '/account-export/history')).body as unknown[]).length).toBe(0);
    await prisma.ccExport.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await get('aAdmin', `/account-export/${id}/download`).expect(404);
    const hist = (await get('aAdmin', '/account-export/history')).body as { id: string; status: string }[];
    expect(hist.find((h) => h.id === id)?.status).toBe('EXPIRED');
  });

  it('keeps tickets per company and hides internal notes', async () => {
    const c = await post('aAdmin', '/account-support/tickets', { subject: 'Login issue', body: 'Cannot sign in', category: 'TECHNICAL' }).expect(201);
    const id = (c.body as Body).id;
    await prisma.ccTicketComment.create({ data: { ticketId: id, organizationId: orgId.a, authorId: 'sa-1', authorName: 'Support', body: 'internal only', internal: true } });
    await prisma.ccTicketComment.create({ data: { ticketId: id, organizationId: orgId.a, authorId: 'sa-1', authorName: 'Support', body: 'We are looking', internal: false } });
    const t = (await get('aAdmin', `/account-support/tickets/${id}`).expect(200)).body as { comments: { body: string; fromSupport: boolean }[] };
    expect(t.comments.map((x) => x.body)).toEqual(['We are looking']);
    expect(t.comments[0].fromSupport).toBe(true);
    await get('bAdmin', `/account-support/tickets/${id}`).expect(404);
    await post('bAdmin', `/account-support/tickets/${id}/replies`, { body: 'hi' }).expect(404);
    await post('aAdmin', `/account-support/tickets/${id}/replies`, { body: 'More detail' }).expect(201);
    await post('aAdmin', `/account-support/tickets/${id}/close`).expect(201);
    await post('aAdmin', `/account-support/tickets/${id}/replies`, { body: 'again' }).expect(409);
    await post('aAdmin', `/account-support/tickets/${id}/reopen`).expect(201);
  });

  it('blocks a tab switched off for one company by API and URL, only for that company, and keeps its data', async () => {
    const before = await prisma.ccExport.count({ where: { organizationId: orgId.a } });
    await prisma.ccFlagOverride.create({ data: { flagKey: 'module.account_export', organizationId: orgId.a, value: false } });
    access.clear();
    await get('aAdmin', '/account-export/history').expect(403);
    await post('aAdmin', '/account-export', { category: 'EMPLOYEES' }).expect(403);
    await get('aAdmin', '/account-billing/overview').expect(200); // other tabs unaffected
    await get('bAdmin', '/account-export/history').expect(200); // other company unaffected
    expect(((await get('aAdmin', '/modules')).body as { disabled: string[] }).disabled).toContain('module.account_export');
    expect(await prisma.ccExport.count({ where: { organizationId: orgId.a } })).toBe(before); // data preserved
    await prisma.ccFlagOverride.deleteMany({ where: { organizationId: orgId.a, flagKey: 'module.account_export' } });
    access.clear();
    await get('aAdmin', '/account-export/history').expect(200);
  });
});
