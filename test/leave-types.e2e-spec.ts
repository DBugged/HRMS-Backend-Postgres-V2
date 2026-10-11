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
        name: 'Test Annual Leave',
        code: 'TAL',
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
      .send({ name: 'Test Annual Leave', code: 'EL2' })
      .expect(409);
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Something Else', code: 'TAL' })
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
    // 14 auto-seeded defaults (see LeaveTypesService.seedDefaults) + the
    // 'Test Annual Leave' row created above.
    expect((list.body as { data: LeaveTypeBody[] }).data).toHaveLength(15);

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

  it('eligible/me excludes types the employee is filtered out of by applicableGenders', async () => {
    await prisma.user.update({
      where: { id: employeeId },
      data: { gender: 'FEMALE' },
    });

    // 'Paternity Leave'/'PTL' would collide with the auto-seeded default
    // (see LeaveTypesService.seedDefaults), so this uses a distinct
    // name/code.
    const restricted = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Paternity Leave',
        code: 'PTLT',
        applicableGenders: ['MALE'],
      })
      .expect(201);
    const restrictedId = (restricted.body as LeaveTypeBody).id;

    const excluded = await request(app.getHttpServer())
      .get('/leave-types/eligible/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((excluded.body as LeaveTypeBody[]).map((t) => t.id)).not.toContain(
      restrictedId,
    );

    await request(app.getHttpServer())
      .put(`/leave-types/${restrictedId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ applicableGenders: ['FEMALE'] })
      .expect(200);

    const included = await request(app.getHttpServer())
      .get('/leave-types/eligible/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((included.body as LeaveTypeBody[]).map((t) => t.id)).toContain(
      restrictedId,
    );

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

  it('a built-in (seeded) leave type cannot have its name or code changed, but other fields still can', async () => {
    const list = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const casual = (
      list.body as {
        data: (LeaveTypeBody & { code: string; isSystemDefault: boolean })[];
      }
    ).data.find((t) => t.code === 'CL');
    expect(casual).toBeDefined();
    expect(casual!.isSystemDefault).toBe(true);

    await request(app.getHttpServer())
      .put(`/leave-types/${casual!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Casual Leave' })
      .expect(409);
    await request(app.getHttpServer())
      .put(`/leave-types/${casual!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'CL2' })
      .expect(409);

    // Quota (and everything else non-identity) stays editable.
    const okRes = await request(app.getHttpServer())
      .put(`/leave-types/${casual!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ annualQuota: 15 })
      .expect(200);
    expect((okRes.body as LeaveTypeBody).annualQuota).toBe(15);
  });

  it('a built-in leave type cannot be deleted; a custom one with no history can', async () => {
    const list = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const casual = (
      list.body as {
        data: (LeaveTypeBody & { code: string; isSystemDefault: boolean })[];
      }
    ).data.find((t) => t.code === 'CL');
    await request(app.getHttpServer())
      .delete(`/leave-types/${casual!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Disposable Leave',
        code: 'DISP',
        allocationType: 'FIXED_ANNUAL',
      })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/leave-types/${(created.body as LeaveTypeBody).id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('a leave type with existing balances/requests cannot be deleted', async () => {
    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'In-Use Leave',
        code: 'INUSE',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 12,
      })
      .expect(201);
    const inUseId = (created.body as LeaveTypeBody).id;
    // A balance row is created the first time balances are read (quotas are granted upfront; there is no accrual run).
    await request(app.getHttpServer())
      .get('/leaves/balance')
      .query({ employeeId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // Untouched balance rows go with the type; one that has been used (leave taken) blocks the delete.
    await prisma.leaveBalance.updateMany({
      where: { leaveTypeId: inUseId },
      data: { availed: 1 },
    });

    await request(app.getHttpServer())
      .delete(`/leave-types/${inUseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('raising annualQuota reconciles existing current-year balance rows, idempotently', async () => {
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Quota Edit Leave',
        code: 'QED',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 10,
        prorateOnJoining: false,
      })
      .expect(201);
    const qed = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'QED', organization: { name: 'Leave Types E2E Org' } },
    });
    const year = new Date().getFullYear();
    const readRow = () =>
      prisma.leaveBalance.findFirst({
        where: { employeeId, leaveTypeId: qed.id, year },
      });

    // The balance row is created on first balance read, with the upfront quota (10) credited.
    await request(app.getHttpServer())
      .get('/leaves/balance')
      .query({ employeeId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((await readRow())?.credited).toBe(10);

    const put = (annualQuota: number) =>
      request(app.getHttpServer())
        .put(`/leave-types/${qed.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ annualQuota })
        .expect(200);

    await put(18);
    let row = await readRow();
    expect(row?.credited).toBe(18);
    expect(row?.closing).toBe(18);

    // Same quota again — no double credit.
    await put(18);
    row = await readRow();
    expect(row?.credited).toBe(18);
    expect(row?.closing).toBe(18);

    // Lowering it adjusts down too (set, not increment).
    await put(12);
    row = await readRow();
    expect(row?.credited).toBe(12);
    expect(row?.closing).toBe(12);
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
    // A new type already has a balance row for every eligible employee; set this one to a known closing value.
    await prisma.leaveBalance.updateMany({
      where: { employeeId, leaveTypeId: cflId, year: thisYear },
      data: { opening: 0, credited: 10, availed: 3, closing: 7 },
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

  it('GET /leave-types?activeOnly=true excludes deactivated types', async () => {
    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sabbatical', code: 'SAB' })
      .expect(201);
    const sabId = (created.body as LeaveTypeBody).id;
    await request(app.getHttpServer())
      .put(`/leave-types/${sabId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);

    const all = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (all.body as { data: LeaveTypeBody[] }).data.some(
        (lt) => lt.id === sabId,
      ),
    ).toBe(true);

    const activeOnly = await request(app.getHttpServer())
      .get('/leave-types')
      .query({ activeOnly: 'true' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (activeOnly.body as { data: LeaveTypeBody[] }).data.some(
        (lt) => lt.id === sabId,
      ),
    ).toBe(false);
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
