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

describe('Payroll - arrears for a backdated salary revision (e2e)', () => {
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
      organizationName: 'Arrears E2E Org',
      name: 'Founder',
      email: 'arr-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'arr-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'arr-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await post('/employees', adminToken).send({
      name: 'Hr Person',
      email: 'arr-e2e-hr@example.test',
      joiningDate: '2025-01-01',
      role: 'HR',
    });
    hrId = (hrCreate.body as EmployeeCreateBody).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'arr-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await post('/employees', adminToken).send({
      name: 'Plain Employee',
      email: 'arr-e2e-emp@example.test',
      joiningDate: '2025-01-01',
    });
    employeeId = (empCreate.body as EmployeeCreateBody).employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'arr-e2e-emp@example.test',
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
    for (const [m, days] of [
      [5, 31],
      [6, 30],
    ]) {
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

  const period = {
    employeeId: '',
    fromMonth: 5,
    fromYear: YEAR,
    toMonth: 6,
    toYear: YEAR,
  };

  it('pay May and June, then a backdated revision is refused unless sent for arrears', async () => {
    for (const m of [5, 6]) {
      await post('/payroll/calculate', adminToken)
        .send({ month: m, year: YEAR, employeeId })
        .expect(201);
    }
    const runs = await prisma.payrollRun.findMany({ where: { employeeId } });
    for (const r of runs) {
      for (const step of ['verify', 'approve', 'lock']) {
        await post(`/payroll/${r.id}/${step}`, adminToken).expect(201);
      }
    }
    period.employeeId = employeeId;
    const body = {
      componentCode: 'BASIC',
      fixedAmount: 36000,
      effectiveFrom: '2026-05-01',
    };
    await post(`/employee-salary/${employeeId}/structure`, adminToken)
      .send(body)
      .expect(400);
    await post(`/employee-salary/${employeeId}/structure`, adminToken)
      .send({ ...body, backdateForArrears: true })
      .expect(201);
    // The locked payslips are untouched.
    const may = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: 5, year: YEAR },
    });
    expect(may.grossSalary).toBe(42000);
  });

  it('previews the difference per month: Basic +6,000 and HRA (40%) +2,400 = 8,400 for each of two months', async () => {
    const res = await post('/payroll/arrears/preview', adminToken)
      .send(period)
      .expect(201);
    const body = res.body as {
      total: number;
      months: { month: number; difference: number; arrears: number }[];
    };
    expect(body.months.map((m) => m.difference)).toEqual([8400, 8400]);
    expect(body.total).toBe(16800);
  });

  it('pays them as a supplementary run, and cannot pay the same arrears twice', async () => {
    const res = await post('/payroll/arrears', adminToken)
      .send({ ...period, reason: 'Revision effective 1 May' })
      .expect(201);
    const run = res.body as {
      runSequence: number;
      grossSalary: number;
      earnings: { code: string }[];
    };
    expect(run.runSequence).toBeGreaterThan(0);
    expect(run.grossSalary).toBe(16800);
    const again = await post('/payroll/arrears/preview', adminToken)
      .send(period)
      .expect(201);
    expect((again.body as { total: number }).total).toBe(0);
    await post('/payroll/arrears', adminToken)
      .send({ ...period, reason: 'Revision effective 1 May' })
      .expect(400);
  });

  it('EMPLOYEE gets 403', async () => {
    await post('/payroll/arrears/preview', employeeToken)
      .send(period)
      .expect(403);
  });
});
