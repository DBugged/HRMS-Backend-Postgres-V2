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
const RUN = Date.now();
interface Auth { accessToken: string; generatedPassword: string; employee: { id: string } }
interface Item { id: string; kind: string; sourceId: string; status: string; canCancel: boolean; waitingWith: string[]; timeline: { label: string }[]; waitingDays: number | null }

describe('My Requests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const tok: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const org: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const get = (w: string, u: string) => http().get(u).set('Authorization', `Bearer ${tok[w]}`);
  const post = (w: string, u: string) => http().post(u).set('Authorization', `Bearer ${tok[w]}`).send({});

  const register = async (k: string) => {
    const email = `mr-${k}-admin-${RUN}@example.test`;
    await http().post('/auth/register').send({ organizationName: `MyReq Org ${k} ${RUN}`, name: `Admin ${k}`, email, password: PASSWORD });
    tok[`${k}Admin`] = ((await http().post('/auth/login').send({ email, password: PASSWORD })).body as Auth).accessToken;
    const u = await prisma.user.findFirst({ where: { email } });
    org[k] = u!.organizationId;
    ids[`${k}Admin`] = u!.id;
  };
  const employee = async (k: string, name: string) => {
    const email = `mr-${k}-${name}-${RUN}@example.test`;
    const c = await http().post('/employees').set('Authorization', `Bearer ${tok[`${k}Admin`]}`).send({ name: `${name} person`, email, joiningDate: '2025-01-01' });
    tok[`${k}${name}`] = ((await http().post('/auth/login').send({ email, password: (c.body as Auth).generatedPassword })).body as Auth).accessToken;
    ids[`${k}${name}`] = (c.body as Auth).employee.id;
  };

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await register('a');
    await register('b');
    await employee('a', 'sam');
    await employee('a', 'kim');
    await employee('b', 'sam');
    const today = new Date().toISOString().slice(0, 10);
    for (const who of ['asam', 'akim', 'bsam']) {
      const k = who[0];
      await prisma.loan.create({ data: { organizationId: org[k], employeeId: ids[`${k}${who.slice(1)}`], loanType: 'LOAN', principal: 1000, tenureMonths: 5, emiAmount: 200, startMonth: 1, startYear: 2026, outstandingBalance: 1000, status: 'PENDING', reason: `${who} loan` } });
    }
    // Two pending Work From Home days sharing one request, and an approved one, for asam.
    await prisma.attendance.createMany({ data: [
      { organizationId: org.a, employeeId: ids.asam, date: today, workArrangement: 'WFH', workArrangementStatus: 'PENDING', wfhRequestId: `req-${RUN}` },
      { organizationId: org.a, employeeId: ids.asam, date: new Date(Date.now() + 86400_000).toISOString().slice(0, 10), workArrangement: 'WFH', workArrangementStatus: 'PENDING', wfhRequestId: `req-${RUN}` },
    ] });
  });
  afterAll(async () => { await app.close(); });

  it('lists only the caller\'s own requests, with who they wait for and a timeline', async () => {
    const r = (await get('asam', '/my-requests').expect(200)).body as { items: Item[]; summary: { pending: number; total: number } };
    expect(r.items.map((i) => i.kind).sort()).toEqual(['loan', 'wfh']);
    const loan = r.items.find((i) => i.kind === 'loan')!;
    expect(loan).toMatchObject({ status: 'PENDING', canCancel: true });
    expect(loan.waitingWith).toContain('Admin a'); // the company's admin decides a loan
    expect(loan.timeline.map((t) => t.label)[0]).toBe('Submitted');
    expect(loan.waitingDays).toBe(0);
    const wfh = r.items.find((i) => i.kind === 'wfh')!;
    expect(wfh.sourceId).toBe(`req-${RUN}`); // two days, one request
    expect(r.summary).toMatchObject({ pending: 2, total: 2 });
    // Other people, in this company and the other, see only their own.
    expect(((await get('akim', '/my-requests')).body as { items: Item[] }).items.map((i) => i.kind)).toEqual(['loan']);
    expect(((await get('bsam', '/my-requests')).body as { items: Item[] }).items.map((i) => i.kind)).toEqual(['loan']);
  });

  it('leaves out a kind whose module is switched off for the company', async () => {
    await prisma.ccFeatureFlag.upsert({ where: { key: 'module.attendance' }, update: {}, create: { key: 'module.attendance', defaultValue: true, description: 'Attendance' } });
    await prisma.ccFlagOverride.create({ data: { flagKey: 'module.attendance', organizationId: org.a, value: false } });
    app.get(ModuleAccessService).clear();
    expect(((await get('asam', '/my-requests')).body as { items: Item[] }).items.map((i) => i.kind)).toEqual(['loan']);
    await prisma.ccFlagOverride.deleteMany({ where: { flagKey: 'module.attendance', organizationId: org.a } });
    app.get(ModuleAccessService).clear();
  });

  it('withdraws a pending loan and a pending WFH request, but never someone else\'s or another kind', async () => {
    const mine = ((await get('asam', '/my-requests')).body as { items: Item[] }).items;
    const loanId = mine.find((i) => i.kind === 'loan')!.sourceId;
    const kimLoan = (await prisma.loan.findFirst({ where: { employeeId: ids.akim } }))!.id;
    await post('asam', `/my-requests/loan/${kimLoan}/cancel`).expect(409); // not asam's loan
    expect((await prisma.loan.findUnique({ where: { id: kimLoan } }))!.status).toBe('PENDING');
    await post('asam', `/my-requests/loan/${loanId}/cancel`).expect(201);
    await post('asam', `/my-requests/loan/${loanId}/cancel`).expect(409); // already withdrawn
    await post('asam', `/my-requests/wfh/req-${RUN}/cancel`).expect(201);
    expect(await prisma.attendance.count({ where: { employeeId: ids.asam, workArrangementStatus: 'PENDING' } })).toBe(0);
    await post('asam', `/my-requests/wfh/req-${RUN}/cancel`).expect(409);
    await post('asam', `/my-requests/reimbursement/${loanId}/cancel`).expect(400); // not withdrawable here
    const after = ((await get('asam', '/my-requests')).body as { items: Item[]; summary: { pending: number } });
    expect(after.summary.pending).toBe(0);
    expect(after.items.find((i) => i.kind === 'loan')!.status).toBe('CANCELLED');
    // The other company is untouched.
    expect((await prisma.loan.findFirst({ where: { employeeId: ids.bsam } }))!.status).toBe('PENDING');
  });
});
