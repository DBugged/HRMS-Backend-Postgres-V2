import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import ExcelJS from 'exceljs';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccountExportService } from '../src/account-management/account-export.service';
import { EmailService } from '../src/notifications/email.service';
import { CcBillingService } from '../src/control-center/cc-billing.service';
import { CcSupportService } from '../src/control-center/cc-support.service';
import { CcAutomationService } from '../src/control-center/cc-automation.service';
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

  // Exports are built in the background: wait until the row leaves "processing".
  const ready = async (who: string, id: string) => {
    for (let i = 0; i < 60; i++) {
      const row = ((await get(who, '/account-export/history')).body as { id: string; status: string }[]).find((h) => h.id === id);
      if (row && row.status !== 'PROCESSING') return row.status;
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'TIMEOUT';
  };

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
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', message: 'Hiring', payload: { quantity: 0 } }).expect(400);
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', payload: { quantity: 3 } }).expect(400); // a note is required
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', message: '   ', payload: { quantity: 3 } }).expect(400);
    await post('aAdmin', '/account-billing/requests', { type: 'RENEWAL' }).expect(400);
    await post('aAdmin', '/account-plan/requests', { type: 'RENEWAL' }).expect(400); // not a plan-tab request
    const ok = await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', message: 'Hiring', payload: { quantity: 5 } }).expect(201);
    expect((ok.body as { status: string }).status).toBe('PENDING');
    await post('aAdmin', '/account-plan/requests', { type: 'EXTRA_LICENCES', message: 'More', payload: { quantity: 2 } }).expect(409);
    await post('aAdmin', '/account-billing/requests', { type: 'RENEWAL', message: 'Renew for another year' }).expect(201);
    expect(((await get('aAdmin', '/account-plan/requests')).body as unknown[]).length).toBe(1);
    expect(((await get('bAdmin', '/account-plan/requests')).body as unknown[]).length).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId.a, action: 'ACCOUNT_REQUEST_CREATED' } })).toBe(2);
  });

  it('exports own data, keeps history, blocks other tenants and expired links', async () => {
    await post('aAdmin', '/account-export', { category: 'NOPE' }).expect(400);
    const created = await post('aAdmin', '/account-export', { category: 'EMPLOYEES', format: 'CSV' }).expect(201);
    const id = (created.body as Body).id;
    expect((created.body as { status: string }).status).toBe('PROCESSING'); // returns at once
    expect(await ready('aAdmin', id)).toBe('COMPLETED');
    // The bell notification follows the status change by a moment.
    let notified = 0;
    for (let i = 0; i < 20 && !notified; i++) {
      notified = await prisma.notification.count({ where: { organizationId: orgId.a, title: 'Your data export is ready' } });
      if (!notified) await new Promise((r) => setTimeout(r, 250));
    }
    expect(notified).toBeGreaterThanOrEqual(1);
    const file = await get('aAdmin', `/account-export/${id}/download`).expect(200);
    const text = file.text ?? String(file.body);
    expect(text).toContain(`acct-a-admin-${RUN}@example.test`);
    expect(text).not.toContain(`acct-b-admin-${RUN}@example.test`);
    await get('bAdmin', `/account-export/${id}/download`).expect(404);
    const all = await post('aAdmin', '/account-export', { category: 'ALL', format: 'CSV' }).expect(201);
    await ready('aAdmin', (all.body as Body).id);
    const hist0 = (await get('aAdmin', '/account-export/history')).body as { id: string; format: string; category: string; rowCount: number }[];
    expect(hist0.find((h) => h.id === (all.body as Body).id)).toMatchObject({ category: 'ALL', format: 'XLSX' });
    const allFile = await get('aAdmin', `/account-export/${(all.body as Body).id}/download`).expect(200);
    expect(allFile.headers['content-type']).toContain('spreadsheetml');
    expect(((await get('bAdmin', '/account-export/history')).body as unknown[]).length).toBe(0);
    await prisma.ccExport.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await get('aAdmin', `/account-export/${id}/download`).expect(404);
    const hist = (await get('aAdmin', '/account-export/history')).body as { id: string; status: string }[];
    expect(hist.find((h) => h.id === id)?.status).toBe('EXPIRED');
  });

  it('exports every category on its own and together, as separate sheets', async () => {
    const cats = (await get('aAdmin', '/account-export/categories').expect(200)).body as { key: string }[];
    expect(cats.length).toBeGreaterThanOrEqual(19);
    // Straight to the service for the per-category runs: the HTTP route is rate-limited to 10 a minute.
    const svc = app.get(AccountExportService);
    const admin = (await prisma.user.findFirst({ where: { organizationId: orgId.a, role: 'ADMIN' } }))!;
    for (const c of cats.filter((x) => x.key !== 'ALL')) await svc.create(admin, { category: c.key, format: 'CSV' }, { wait: true });
    const all = await post('aAdmin', '/account-export', { category: 'ALL' }).expect(201);
    expect(await ready('aAdmin', (all.body as Body).id)).toBe('COMPLETED');
    const file = await get('aAdmin', `/account-export/${(all.body as Body).id}/download`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Employees', 'Leave balances', 'Departments', 'Locations & branches', 'Holidays', 'Asset inventory', 'Asset allocations', 'Resignations', 'Final settlements', 'Overtime', 'Comp-offs']));
    expect(wb.worksheets.length).toBe(cats.length - 1);
    const failed = ((await get('aAdmin', '/account-export/history')).body as { status: string }[]).filter((h) => h.status === 'FAILED');
    expect(failed).toEqual([]);
  });

  it('shows outstanding amount, tax columns and warnings, and tells the admin when the Super Admin acts', async () => {
    const o = (await get('aAdmin', '/account-billing/overview').expect(200)).body as { outstanding: { amount: number; count: number }; notices: { code: string }[] };
    expect(o.outstanding).toMatchObject({ amount: 1180, count: 1 });
    const inv = ((await get('aAdmin', '/account-billing/invoices').expect(200)).body as { subtotal: number; tax: number; discount: number }[])[0];
    expect(inv).toMatchObject({ subtotal: 1000, tax: 180, discount: 0 });
    // An overdue invoice and a subscription ending in 5 days produce banners and one reminder each, only once.
    await prisma.ccInvoice.update({ where: { id: invoiceId.a }, data: { dueDate: new Date(Date.now() - 3 * 86400_000) } });
    await prisma.ccSubscription.updateMany({ where: { organizationId: orgId.a }, data: { currentPeriodEnd: new Date(Date.now() + 5 * 86400_000) } });
    const codes = ((await get('aAdmin', '/account-billing/overview')).body as { notices: { code: string }[] }).notices.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['EXPIRING', 'OVERDUE']));
    const auto = app.get(CcAutomationService);
    await auto.run();
    await auto.run();
    expect(await prisma.notification.count({ where: { organizationId: orgId.a, title: { startsWith: 'Your subscription ends in' } } })).toBe(1);
    expect(await prisma.notification.count({ where: { organizationId: orgId.a, title: { contains: 'is overdue' } } })).toBe(1);
    expect(await prisma.notification.count({ where: { organizationId: orgId.b, title: { contains: 'ends in' } } })).toBe(0);
    // A decision on a request reaches the admin who asked.
    const req = (await post('aAdmin', '/account-plan/requests', { type: 'ADD_ON', message: 'Need it', payload: { addOn: 'Biometric' } }).expect(201)).body as Body;
    await app.get(CcSupportService).resolveRequest(req.id, { action: 'REJECT', note: 'Not available yet' }, { id: 'sa-test', name: 'Super' } as never);
    const n = await prisma.notification.findFirst({ where: { organizationId: orgId.a, title: { contains: 'request was rejected' } } });
    expect(n?.message).toContain('Not available yet');
  });

  it('lets an admin withdraw a pending request, but not a decided one or another company\'s', async () => {
    const r = (await post('aAdmin', '/account-plan/requests', { type: 'MODULE_UPGRADE', message: 'Need reports', payload: { module: 'module.reports' } }).expect(201)).body as Body;
    await post('bAdmin', `/account-plan/requests/${r.id}/withdraw`).expect(404);
    await post('aAdmin', `/account-billing/requests/${r.id}/withdraw`).expect(404); // wrong tab
    await post('aAdmin', `/account-plan/requests/${r.id}/withdraw`).expect(201);
    await post('aAdmin', `/account-plan/requests/${r.id}/withdraw`).expect(409);
    const rows = (await get('aAdmin', '/account-plan/requests')).body as { id: string; status: string }[];
    expect(rows.find((x) => x.id === r.id)?.status).toBe('WITHDRAWN');
    // After a withdrawal the same kind of request can be sent again.
    await post('aAdmin', '/account-plan/requests', { type: 'MODULE_UPGRADE', message: 'Again', payload: { module: 'module.reports' } }).expect(201);
  });

  it('shows billing details read from Organization Settings, and takes no change request for them', async () => {
    await prisma.organization.update({ where: { id: orgId.a }, data: { gstin: '29ABCDE1234F1Z5', contactEmail: 'billing@acct-a.test', registeredAddress: '1 Test Street' } });
    const d = (await get('aAdmin', '/account-billing/details').expect(200)).body as { companyName: string; gstin: string; billingEmail: string; address: string };
    expect(d).toMatchObject({ gstin: '29ABCDE1234F1Z5', billingEmail: 'billing@acct-a.test', address: '1 Test Street' });
    expect(d.companyName).toContain('Account Org A');
    const b = (await get('bAdmin', '/account-billing/details').expect(200)).body as { gstin: string | null };
    expect(b.gstin).toBeNull(); // another company's settings never leak
    await post('aAdmin', '/account-billing/requests', { type: 'BILLING_DETAILS', message: 'x', payload: { gstin: '29ABCDE1234F1Z5' } }).expect(400);
  });

  it('returns six months of headcount', async () => {
    const t = (await get('aAdmin', '/account-usage/trend').expect(200)).body as { months: { month: string; headcount: number }[] };
    expect(t.months).toHaveLength(6);
    expect(t.months[5].headcount).toBe(await prisma.user.count({ where: { organizationId: orgId.a, isActive: true } }));
    await get('aEMPLOYEE', '/account-usage/trend').expect(403);
  });

  it('schedules a monthly export, mails only to the company\'s own Admin/HR users, and runs it', async () => {
    const recips = (await get('aAdmin', '/account-export/schedules/recipients').expect(200)).body as { email: string }[];
    expect(recips.map((x) => x.email)).toEqual(expect.arrayContaining([`acct-a-admin-${RUN}@example.test`, `acct-a-hr-${RUN}@example.test`]));
    expect(recips.some((x) => x.email.includes('acct-b-'))).toBe(false);
    expect(recips.some((x) => x.email.includes('-employee-'))).toBe(false);
    await post('aAdmin', '/account-export/schedules', { category: 'ALL', dayOfMonth: 32, recipients: [`acct-a-admin-${RUN}@example.test`] }).expect(400);
    await post('aAdmin', '/account-export/schedules', { category: 'ALL', dayOfMonth: 1, recipients: [] }).expect(400);
    await post('aAdmin', '/account-export/schedules', { category: 'ALL', dayOfMonth: 1, recipients: ['outsider@example.com'] }).expect(400);
    await post('aAdmin', '/account-export/schedules', { category: 'ALL', dayOfMonth: 1, recipients: [`acct-b-admin-${RUN}@example.test`] }).expect(400);
    await post('aAdmin', '/account-export/schedules', { category: 'ALL', dayOfMonth: 1, recipients: [`acct-a-admin-${RUN}@example.test`] }).expect(201);
    const list = (await get('aAdmin', '/account-export/schedules').expect(200)).body as { id: string; lastStatus: string | null }[];
    expect(list).toHaveLength(1);
    expect((await get('bAdmin', '/account-export/schedules')).body).toEqual([]);
    await post('bAdmin', `/account-export/schedules/${list[0].id}/run`).expect(404);
    await post('aAdmin', `/account-export/schedules/${list[0].id}/run`).expect(201);
    const after = (await get('aAdmin', '/account-export/schedules')).body as { lastStatus: string }[];
    expect(after[0].lastStatus).toBe('SENT');
  });

  it('adds outside email addresses to a schedule only after the address confirms by link', async () => {
    const sent: { to: string; html: string }[] = [];
    const spy = jest.spyOn(app.get(EmailService), 'send').mockImplementation(async (input) => { sent.push({ to: input.to, html: input.html }); return { dryRun: true }; });
    try {
      const base = { category: 'LOANS', dayOfMonth: 5, recipients: [] as string[] };
      await post('aAdmin', '/account-export/schedules', { ...base, extraEmails: ['not-an-email'] }).expect(400);
      await post('aAdmin', '/account-export/schedules', { ...base, extraEmails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'] }).expect(400);
      await post('aAdmin', '/account-export/schedules', { ...base, extraEmails: [] }).expect(400); // nobody at all
      const saved = (await post('aAdmin', '/account-export/schedules', { ...base, extraEmails: ['Accountant@Outside.test'] }).expect(201)).body as { id: string; confirmationsSent: number };
      expect(saved.confirmationsSent).toBe(1);
      const mail = sent.find((m) => m.to === 'accountant@outside.test')!;
      expect(mail.html).toContain('/public/account-export/confirm?token=');
      const list = (await get('aAdmin', '/account-export/schedules')).body as { id: string; extraRecipients: { email: string; confirmed: boolean }[] }[];
      expect(list.find((x) => x.id === saved.id)!.extraRecipients).toEqual([{ email: 'accountant@outside.test', confirmed: false }]);
      // Unconfirmed: nothing is sent to the outside address.
      sent.length = 0;
      await post('aAdmin', `/account-export/schedules/${saved.id}/run`).expect(201);
      expect(sent.some((m) => m.to === 'accountant@outside.test')).toBe(false);
      expect(((await get('aAdmin', '/account-export/schedules')).body as { id: string; lastStatus: string }[]).find((x) => x.id === saved.id)!.lastStatus).toBe('FAILED');
      // A wrong token does nothing; the real link confirms once.
      await http().get('/public/account-export/confirm?token=' + 'a'.repeat(48)).expect(400);
      const token = /token=([0-9a-f]{48})/.exec(mail.html)![1];
      await http().get(`/public/account-export/confirm?token=${token}`).expect(200);
      await http().get(`/public/account-export/confirm?token=${token}`).expect(400);
      sent.length = 0;
      await post('aAdmin', `/account-export/schedules/${saved.id}/run`).expect(201);
      expect(sent.find((m) => m.to === 'accountant@outside.test')).toBeTruthy();
      // Saving again keeps a confirmed address confirmed and sends no new link.
      sent.length = 0;
      const again = (await post('aAdmin', '/account-export/schedules', { ...base, extraEmails: ['accountant@outside.test'] }).expect(201)).body as { confirmationsSent: number };
      expect(again.confirmationsSent).toBe(0);
      await get('bAdmin', '/account-export/schedules').expect(200);
      expect(((await get('bAdmin', '/account-export/schedules')).body as unknown[]).length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('saves one schedule for each of several kinds of data in one go, with a single confirmation link', async () => {
    const sent: { to: string; html: string }[] = [];
    const spy = jest.spyOn(app.get(EmailService), 'send').mockImplementation(async (input) => { sent.push({ to: input.to, html: input.html }); return { dryRun: true }; });
    try {
      await post('aAdmin', '/account-export/schedules', { categories: [], dayOfMonth: 7, recipients: [`acct-a-admin-${RUN}@example.test`] }).expect(400);
      await post('aAdmin', '/account-export/schedules', { categories: ['PAYROLL', 'NOPE'], dayOfMonth: 7, recipients: [`acct-a-admin-${RUN}@example.test`] }).expect(400);
      const r = (await post('aAdmin', '/account-export/schedules', { categories: ['PAYROLL', 'HOLIDAYS', 'ASSETS'], dayOfMonth: 7, recipients: [`acct-a-admin-${RUN}@example.test`], extraEmails: ['cfo@outside.test'] }).expect(201)).body as { saved: number; confirmationsSent: number };
      expect(r).toMatchObject({ saved: 3, confirmationsSent: 1 });
      expect(sent.filter((m) => m.to === 'cfo@outside.test')).toHaveLength(1); // one email for three schedules
      const rows = (await get('aAdmin', '/account-export/schedules')).body as { category: string; dayOfMonth: number }[];
      expect(rows.filter((x) => ['PAYROLL', 'HOLIDAYS', 'ASSETS'].includes(x.category)).map((x) => x.dayOfMonth)).toEqual([7, 7, 7]);
      const token = /token=([0-9a-f]{48})/.exec(sent.find((m) => m.to === 'cfo@outside.test')!.html)![1];
      await http().get(`/public/account-export/confirm?token=${token}`).expect(200);
      const after = (await get('aAdmin', '/account-export/schedules')).body as { category: string; extraRecipients: { confirmed: boolean }[] }[];
      expect(after.filter((x) => ['PAYROLL', 'HOLIDAYS', 'ASSETS'].includes(x.category)).every((x) => x.extraRecipients[0].confirmed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('lists account activity from the audit trail and Super Admin decisions, per company', async () => {
    const a = (await get('aAdmin', '/account-activity').expect(200)).body as { text: string; source: string }[];
    const texts = a.map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(['Sent a request', 'Withdrew a request', 'Saved a scheduled export', 'Scheduled export emailed']));
    expect(a.some((e) => e.source === 'SUPER_ADMIN')).toBe(true);
    expect(((await get('bAdmin', '/account-activity')).body as unknown[]).length).toBe(0);
    await get('aHR', '/account-activity').expect(403);
  });

  it('emails and announces a new invoice to the company, once', async () => {
    const billing = app.get(CcBillingService);
    await prisma.organization.update({ where: { id: orgId.a }, data: { contactEmail: 'billing@acct-a.test' } });
    const inv = await billing.createInvoice({ organizationId: orgId.a, lineItems: [{ description: 'Extra seats', quantity: 1, unitAmount: 500 }] });
    let n = 0;
    for (let i = 0; i < 20 && !n; i++) {
      n = await prisma.notification.count({ where: { organizationId: orgId.a, title: `New invoice ${inv!.number}` } });
      if (!n) await new Promise((r) => setTimeout(r, 250));
    }
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { organizationId: orgId.b, title: { contains: inv!.number } } })).toBe(0);
  });

  it('keeps tickets per company and hides internal notes', async () => {
    const c = await post('aAdmin', '/account-support/tickets', { subject: 'Login issue', body: 'Cannot sign in', category: 'TECHNICAL', priority: 'HIGH' }).expect(201);
    await post('aAdmin', '/account-support/tickets', { subject: 'No category', body: 'x' }).expect(400);
    await post('aAdmin', '/account-support/tickets', { subject: 'No priority', body: 'x', category: 'GENERAL' }).expect(400);
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
