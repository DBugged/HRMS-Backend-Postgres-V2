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

describe('Payroll - payment tracking, bank file and journal (e2e)', () => {
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
      organizationName: 'Payment E2E Org',
      name: 'Founder',
      email: 'pay-trk-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'pay-trk-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'pay-trk-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await post('/employees', adminToken).send({
      name: 'Hr Person',
      email: 'pay-trk-hr@example.test',
      joiningDate: '2025-01-01',
      role: 'HR',
    });
    hrId = (hrCreate.body as EmployeeCreateBody).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-trk-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await post('/employees', adminToken).send({
      name: 'Plain Employee',
      email: 'pay-trk-emp@example.test',
      joiningDate: '2025-01-01',
    });
    employeeId = (empCreate.body as EmployeeCreateBody).employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-trk-emp@example.test',
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

  let runId: string;
  let payslipNumber: string;

  it('pay the month, then record the bank reference on the paid payslip', async () => {
    await post('/payroll/calculate', adminToken)
      .send({ month: 6, year: YEAR, employeeId })
      .expect(201);
    const run = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: 6, year: YEAR },
    });
    runId = run.id;
    payslipNumber = run.payslipNumber as string;
    // Not paid yet: refused.
    await request(app.getHttpServer())
      .patch(`/payroll/${runId}/payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentReference: 'UTR123456', paymentMode: 'NEFT' })
      .expect(400);
    for (const step of ['verify', 'approve', 'lock', 'pay']) {
      await post(`/payroll/${runId}/${step}`, adminToken).expect(201);
    }
    const res = await request(app.getHttpServer())
      .patch(`/payroll/${runId}/payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentReference: 'UTR123456', paymentMode: 'NEFT' })
      .expect(200);
    const body = res.body as {
      paymentReference: string;
      paymentMode: string;
      paymentDate: string;
    };
    expect(body.paymentReference).toBe('UTR123456');
    expect(body.paymentMode).toBe('NEFT');
    expect(body.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Bad reference / future date rejected.
    await request(app.getHttpServer())
      .patch(`/payroll/${runId}/payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentReference: 'bad ref!' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/payroll/${runId}/payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentReference: 'UTR123456', paymentDate: '2099-01-01' })
      .expect(400);
  });

  it('import reconciles by payslip number, rejecting an amount mismatch and unknown numbers', async () => {
    const run = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const res = await post('/payroll/payments/import', adminToken)
      .send({
        rows: [
          {
            payslipNumber,
            paymentReference: 'BATCH-77',
            amount: run.netPay + 5,
          },
          { payslipNumber: 'NOPE-1', paymentReference: 'BATCH-77' },
          {
            payslipNumber,
            paymentReference: 'BATCH-77',
            paymentMode: 'IMPS',
            amount: run.netPay,
          },
        ],
      })
      .expect(201);
    const body = res.body as {
      updated: number;
      failed: { row: number; error: string }[];
    };
    expect(body.updated).toBe(1);
    expect(body.failed.map((f) => f.row)).toEqual([1, 2]);
    expect(body.failed[0].error).toContain('does not match');
    const after = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(after.paymentReference).toBe('BATCH-77');
    expect(after.paymentMode).toBe('IMPS');
  });

  it('the bulk bank file carries payslip number as the reference and flags missing bank details', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/payroll/bank-transfer')
      .query({ month: 6, year: YEAR, format: 'csv', layout: 'bulk' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const text = res.text;
    expect(text).toContain('Beneficiary Account Number');
    expect(text).toContain(payslipNumber);
    expect(text).toContain('MISSING BANK DETAILS');
    expect(text).toContain('Salary Jun-2026');
  });

  it('the journal balances and posts net pay to Net Salary Payable', async () => {
    const run = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const res = await request(app.getHttpServer())
      .get('/reports/payroll/journal')
      .query({ month: 6, year: YEAR, format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.text).toContain('TOTAL (balanced)');
    expect(res.text).toContain('Net Salary Payable');
    expect(res.text).toContain(String(run.netPay));
    await request(app.getHttpServer())
      .get('/reports/payroll/journal')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('EMPLOYEE gets 403 on payment endpoints', async () => {
    await request(app.getHttpServer())
      .patch(`/payroll/${runId}/payment`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ paymentReference: 'UTR999' })
      .expect(403);
    await post('/payroll/payments/import', employeeToken)
      .send({ rows: [{ payslipNumber, paymentReference: 'UTR999' }] })
      .expect(403);
  });
});
