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
import { AttendanceStatus } from '@prisma/client';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface RunBody {
  id: string;
  status: string;
  runSequence: number;
  runLabel: string | null;
  grossSalary: number;
  totalDeductions: number;
  netPay: number;
  earnings: { code: string; name: string; amount: number }[];
  deductions: { code: string; amount: number }[];
}

const PASSWORD = 'TestPass123!';
// A month well in the past, in FY 2026-27 (new regime: 0-4L nil, 4-8L 5%, 8-12L 10%, 12-16L 15%; SD 75,000; 87A to 12L).
const MONTH = 6;
const YEAR = 2026;

describe('Payroll - interrupted lock (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let hrId: string;
  let employeeToken: string;
  let employeeId: string;
  let organizationId: string;

  const post = (url: string, token: string) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${token}`);
  const supp = (
    token: string,
    over: Record<string, unknown> = {},
  ): request.Test =>
    post('/payroll/supplementary', token).send({
      employeeId,
      month: MONTH,
      year: YEAR,
      label: 'Diwali bonus',
      reason: 'Festival bonus approved by management',
      earnings: [{ name: 'Festival bonus', amount: 1000000 }],
      ...over,
    });

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
      organizationName: 'Lock E2E Org',
      name: 'Founder',
      email: 'lock-fx-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'lock-fx-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'lock-fx-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await post('/employees', adminToken).send({
      name: 'Hr Person',
      email: 'lock-fx-hr@example.test',
      joiningDate: '2025-01-01',
      role: 'HR',
    });
    hrId = (hrCreate.body as EmployeeCreateBody).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lock-fx-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await post('/employees', adminToken).send({
      name: 'Plain Employee',
      email: 'lock-fx-emp@example.test',
      joiningDate: '2025-01-01',
    });
    employeeId = (empCreate.body as EmployeeCreateBody).employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lock-fx-emp@example.test',
        password: (empCreate.body as EmployeeCreateBody).generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    await post(`/employee-salary/${employeeId}/structure`, adminToken)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-01-01',
      })
      .expect(201);
    await prisma.user.updateMany({
      where: { organizationId },
      data: { joiningDate: new Date('2020-01-01T00:00:00.000Z') },
    });
    for (const [m, days] of [[3, 31]]) {
      await prisma.attendance.createMany({
        data: Array.from({ length: days }, (_, i) => ({
          organizationId,
          employeeId,
          date: `${YEAR}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
          status: AttendanceStatus.PRESENT,
          source: 'FACE_API' as const,
        })),
      });
    }
    // Registration seeds slabs for the current financial year only; make sure FY 2026-27 NEW exists.
    const slab = await prisma.taxSlabConfig.findFirst({
      where: { organizationId, financialYear: '2026-27', regime: 'NEW' },
    });
    if (!slab) {
      await post('/tax-slabs', adminToken)
        .send({ financialYear: '2026-27', regime: 'NEW' })
        .expect(201);
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "attendances", "employee_salary_components", "salary_components", "tax_slab_configs", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let runId: string;

  beforeAll(async () => {
    // March 2026 is FY 2025-26, which registration does not seed.
    await post('/tax-slabs', adminToken)
      .send({ financialYear: '2025-26', regime: 'NEW' })
      .expect(201);
  });

  it('a normal lock records that its effects were applied', async () => {
    await post('/payroll/calculate', adminToken)
      .send({ month: 3, year: YEAR, employeeId })
      .expect(201);
    const run = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: 3, year: YEAR },
    });
    runId = run.id;
    for (const step of ['verify', 'approve', 'lock']) {
      await post(`/payroll/${runId}/${step}`, adminToken).expect(201);
    }
    const locked = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(locked.lockEffectsAppliedAt).not.toBeNull();
    const list = await request(app.getHttpServer())
      .get('/payroll/integrity/lock-effects')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((list.body as { count: number }).count).toBe(0);
  });

  it('a lock that died before its effects is listed, cannot be paid, and can be repaired', async () => {
    // Simulate the process dying between the status change and the side effects.
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { lockEffectsAppliedAt: null },
    });
    const list = await request(app.getHttpServer())
      .get('/payroll/integrity/lock-effects')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (list.body as { runs: { id: string }[] }).runs.map((r) => r.id),
    ).toEqual([runId]);
    const pay = await post(`/payroll/${runId}/pay`, adminToken).expect(400);
    expect(JSON.stringify(pay.body)).toContain('Re-apply lock effects');

    await post(`/payroll/${runId}/reapply-lock-effects`, adminToken).expect(
      201,
    );
    await post(`/payroll/${runId}/pay`, adminToken).expect(201);
    const done = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(done.status).toBe('PAID');
    expect(done.lockEffectsAppliedAt).not.toBeNull();
  });

  it('unlocking clears the marker so the next lock records its own', async () => {
    await post(`/payroll/${runId}/unlock`, adminToken)
      .send({ reason: 'correction needed' })
      .expect(201);
    const row = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(row.status).toBe('CALCULATED');
    expect(row.lockEffectsAppliedAt).toBeNull();
  });

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/payroll/integrity/lock-effects')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
    await post(`/payroll/${runId}/reapply-lock-effects`, employeeToken).expect(
      403,
    );
  });
});
