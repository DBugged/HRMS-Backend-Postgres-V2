import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}
interface GrantBody {
  id: string;
  days: number;
  status: string;
}

const PASSWORD = 'TestPass123!';

describe('Event-based leave grants (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let otherAdminToken: string;
  let employeeToken: string;
  let employeeId: string;
  let eventTypeId: string;
  let annualTypeId: string;
  const year = new Date().getFullYear();
  const day = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function registerAdmin(org: string, email: string) {
    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: org,
      name: 'Founder',
      email,
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return (login.body as AuthBody).accessToken;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    adminToken = await registerAdmin(
      'Grants E2E Org',
      'grants-e2e-admin@example.test',
    );
    otherAdminToken = await registerAdmin(
      'Grants E2E Other Org',
      'grants-e2e-other@example.test',
    );

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth(adminToken))
      .send({ name: 'Grant Employee', email: 'grants-e2e-emp@example.test' });
    const empBody = emp.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'grants-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const ev = await request(app.getHttpServer())
      .post('/leave-types')
      .set(auth(adminToken))
      .send({
        name: 'Grants Event Leave',
        code: 'GEL',
        allocationType: 'EVENT_BASED',
        annualQuota: 100,
        eventGrant: { unit: 'CALENDAR_DAYS', repeatPolicy: 'ONCE_PER_EVENT' },
      })
      .expect(201);
    eventTypeId = (ev.body as { id: string }).id;
    const an = await request(app.getHttpServer())
      .post('/leave-types')
      .set(auth(adminToken))
      .send({
        name: 'Grants Annual Leave',
        code: 'GAL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 12,
      })
      .expect(201);
    annualTypeId = (an.body as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "leave_grants", "leave_balances", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const grant = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/leave-grants')
      .set(auth(token))
      .send(body);

  it('a new event-based type is not credited to anyone automatically', async () => {
    const rows = await prisma.leaveBalance.findMany({
      where: { leaveTypeId: eventTypeId },
    });
    expect(rows.every((r) => r.credited === 0)).toBe(true);
  });

  it('a plain employee cannot grant', async () => {
    await grant(employeeToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 10,
      reason: 'self',
    }).expect(403);
  });

  it('rejects an annual leave type and a grant above the maximum', async () => {
    await grant(adminToken, {
      employeeId,
      leaveTypeId: annualTypeId,
      eventDate: day(3, 1),
      days: 5,
      reason: 'x',
    }).expect(400);
    await grant(adminToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 101,
      reason: 'x',
    }).expect(400);
  });

  let grantId: string;
  it('grants the days, credits the balance and records who granted', async () => {
    const res = await grant(adminToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 60,
      reason: 'Approved event',
      idempotencyKey: 'key-1',
    }).expect(201);
    const body = res.body as GrantBody;
    expect(body.days).toBe(60);
    grantId = body.id;
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: eventTypeId, year },
    });
    expect(row.credited).toBe(60);
    expect(row.closing).toBe(60);
  });

  it('a retried request with the same key returns the same grant without crediting twice', async () => {
    const res = await grant(adminToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 60,
      reason: 'Approved event',
      idempotencyKey: 'key-1',
    });
    expect([200, 201]).toContain(res.status);
    expect((res.body as GrantBody).id).toBe(grantId);
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: eventTypeId, year },
    });
    expect(row.credited).toBe(60);
  });

  it('refuses a second grant for the same event date', async () => {
    await grant(adminToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 10,
      reason: 'dup',
    }).expect(400);
  });

  it('concurrent grants for one new event create exactly one', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        grant(adminToken, {
          employeeId,
          leaveTypeId: eventTypeId,
          eventDate: day(6, 15),
          days: 20,
          reason: 'race',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const active = await prisma.leaveGrant.count({
      where: {
        employeeId,
        leaveTypeId: eventTypeId,
        eventDate: day(6, 15),
        status: 'ACTIVE',
      },
    });
    expect(active).toBe(1);
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: eventTypeId, year },
    });
    expect(row.credited).toBe(80);
  });

  it('another organization cannot see or reverse the grant', async () => {
    const list = await request(app.getHttpServer())
      .get('/leave-grants')
      .set(auth(otherAdminToken))
      .expect(200);
    expect(list.body).toEqual([]);
    await request(app.getHttpServer())
      .post(`/leave-grants/${grantId}/reverse`)
      .set(auth(otherAdminToken))
      .send({ reason: 'nope' })
      .expect(404);
  });

  it('an employee sees only their own grants', async () => {
    const res = await request(app.getHttpServer())
      .get('/leave-grants')
      .set(auth(employeeToken))
      .expect(200);
    expect((res.body as GrantBody[]).length).toBe(2);
  });

  it('reversal takes the days back, keeps the record, and frees the event for a corrected grant', async () => {
    const res = await request(app.getHttpServer())
      .post(`/leave-grants/${grantId}/reverse`)
      .set(auth(adminToken))
      .send({ reason: 'Entered wrongly' })
      .expect(201);
    expect((res.body as GrantBody).status).toBe('REVERSED');
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: eventTypeId, year },
    });
    expect(row.credited).toBe(20);
    await request(app.getHttpServer())
      .post(`/leave-grants/${grantId}/reverse`)
      .set(auth(adminToken))
      .send({ reason: 'again' })
      .expect(409);
    await grant(adminToken, {
      employeeId,
      leaveTypeId: eventTypeId,
      eventDate: day(3, 1),
      days: 45,
      reason: 'Corrected',
    }).expect(201);
    expect(
      await prisma.leaveGrant.count({
        where: { employeeId, leaveTypeId: eventTypeId },
      }),
    ).toBe(3);
  });
});
