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
interface LeaveTypeBody {
  id: string;
  name: string;
  code: string;
  allocationType: string;
  annualQuota: number;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Leave Types (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let employeeToken: string;
  let employeeId: string;

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

    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Leave Types E2E Org',
      name: 'Founder',
      email: 'leavetypes-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'leavetypes-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'leavetypes-e2e-emp@example.test',
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leavetypes-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "leave_balances", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let annualLeaveId: string;

  it('ADMIN creates a FIXED_ANNUAL leave type', async () => {
    const res = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
      })
      .expect(201);
    const body = res.body as LeaveTypeBody;
    expect(body.allocationType).toBe('FIXED_ANNUAL');
    annualLeaveId = body.id;
  });

  it('rejects a duplicate name/code', async () => {
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Earned Leave', code: 'EL2' })
      .expect(409);
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Something Else', code: 'EL' })
      .expect(409);
  });

  it('EMPLOYEE gets 403 creating a leave type', async () => {
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ name: 'Should Fail', code: 'SF' })
      .expect(403);
  });

  it('any authenticated caller can list and fetch leave types', async () => {
    const list = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(list.body as LeaveTypeBody[]).toHaveLength(1);

    await request(app.getHttpServer())
      .get(`/leave-types/${annualLeaveId}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
  });

  it('GET /leave-types/eligible/me returns eligible types for the caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/leave-types/eligible/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as LeaveTypeBody[];
    expect(body.map((t) => t.id)).toContain(annualLeaveId);
  });

  it('eligible/me excludes types the employee is filtered out of by applicableDepartments', async () => {
    const restricted = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Sales-Only Leave',
        code: 'SOL',
        applicableDepartments: ['dept-does-not-exist'],
      })
      .expect(201);
    const restrictedId = (restricted.body as LeaveTypeBody).id;

    const res = await request(app.getHttpServer())
      .get('/leave-types/eligible/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as LeaveTypeBody[];
    expect(body.map((t) => t.id)).not.toContain(restrictedId);

    await request(app.getHttpServer())
      .delete(`/leave-types/${restrictedId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('ADMIN updates a leave type', async () => {
    const res = await request(app.getHttpServer())
      .put(`/leave-types/${annualLeaveId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Standard annual leave', annualQuota: 30 })
      .expect(200);
    const body = res.body as LeaveTypeBody & { description: string };
    expect(body.annualQuota).toBe(30);
    expect(body.description).toBe('Standard annual leave');
  });

  it('run-accrual credits the current-year balance row for an EARNED_MONTHLY type', async () => {
    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Casual Leave',
        code: 'CL',
        allocationType: 'EARNED_MONTHLY',
        accrualAmountPerCycle: 1.5,
      })
      .expect(201);
    const casualLeaveId = (created.body as LeaveTypeBody).id;

    const accrualRes = await request(app.getHttpServer())
      .post(`/leave-types/${casualLeaveId}/run-accrual`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((accrualRes.body as { matched: number }).matched).toBeGreaterThan(0);

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: casualLeaveId, year },
    });
    expect(row).not.toBeNull();
    expect(row?.credited).toBe(1.5);
    expect(row?.closing).toBe(1.5);

    // Running it again double-credits — ported as-is from the old system,
    // no idempotency guard exists there either.
    await request(app.getHttpServer())
      .post(`/leave-types/${casualLeaveId}/run-accrual`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const rowAfterSecondRun = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: casualLeaveId, year },
    });
    expect(rowAfterSecondRun?.credited).toBe(3);
  });

  it('run-carry-forward rolls closing into next year opening and stamps expiry', async () => {
    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Carry Forward Leave',
        code: 'CFL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 10,
        prorateOnJoining: false,
        carryForward: { allowed: true, maxDays: 5, expiryMonths: 6 },
      })
      .expect(201);
    const cflId = (created.body as LeaveTypeBody).id;

    const thisYear = new Date().getFullYear();
    // No endpoint in this batch creates a FIXED_ANNUAL balance row on its
    // own (that happens via the future Leave-requests module applying
    // against it) — seed one directly via Prisma with a known closing
    // value to isolate this test to the carry-forward math itself.
    await prisma.leaveBalance.create({
      data: {
        organizationId: (
          await prisma.leaveType.findFirstOrThrow({ where: { id: cflId } })
        ).organizationId,
        employeeId,
        leaveTypeId: cflId,
        year: thisYear,
        opening: 0,
        credited: 10,
        availed: 3,
        closing: 7,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/leave-types/run-carry-forward')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ year: thisYear })
      .expect(201);
    expect((res.body as { processed: number }).processed).toBeGreaterThan(0);

    const closingRow = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: cflId, year: thisYear },
    });
    expect(closingRow?.carriedForwardOut).toBe(5); // clamped to maxDays=5, not the full closing=7

    const nextRow = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: cflId, year: thisYear + 1 },
    });
    expect(nextRow?.opening).toBe(5);
    expect(nextRow?.carriedInExpiresOn).toBe(`${thisYear + 1}-07-01`);
  });

  it('ADMIN deletes a leave type', async () => {
    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Deletable', code: 'DEL' })
      .expect(201);
    const id = (created.body as LeaveTypeBody).id;

    await request(app.getHttpServer())
      .delete(`/leave-types/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/leave-types/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
