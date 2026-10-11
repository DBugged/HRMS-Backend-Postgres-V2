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

describe('Payroll - supplementary (off-cycle) runs (e2e)', () => {
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
      organizationName: 'Supplementary E2E Org',
      name: 'Founder',
      email: 'supp-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'supp-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'supp-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await post('/employees', adminToken).send({
      name: 'Hr Person',
      email: 'supp-e2e-hr@example.test',
      joiningDate: '2025-01-01',
      role: 'HR',
    });
    hrId = (hrCreate.body as EmployeeCreateBody).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'supp-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await post('/employees', adminToken).send({
      name: 'Plain Employee',
      email: 'supp-e2e-emp@example.test',
      joiningDate: '2025-01-01',
    });
    employeeId = (empCreate.body as EmployeeCreateBody).employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'supp-e2e-emp@example.test',
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
    await prisma.attendance.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        organizationId,
        employeeId,
        date: `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
        status: AttendanceStatus.PRESENT,
        source: 'FACE_API' as const,
      })),
    });
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

  let first: RunBody;

  it('EMPLOYEE gets 403', async () => {
    await supp(employeeToken).expect(403);
  });

  it('creates a supplementary run: gross as entered, TDS = tax the payment causes, net = gross - TDS', async () => {
    const res = await supp(adminToken).expect(201);
    first = res.body as RunBody;
    expect(first.runSequence).toBe(1);
    expect(first.runLabel).toBe('Diwali bonus');
    expect(first.status).toBe('CALCULATED');
    expect(first.grossSalary).toBe(1000000);
    // Regular pay 42,000 x 10 remaining months = 4,20,000 -> no tax. With the bonus: 14,20,000 - 75,000 = 13,45,000:
    // 20,000 + 40,000 + 15% of 1,45,000 = 81,750, + 4% cess = 85,020.
    expect(first.deductions).toEqual([
      expect.objectContaining({ code: 'INCOME_TAX', amount: 85020 }),
    ]);
    expect(first.totalDeductions).toBe(85020);
    expect(first.netPay).toBe(1000000 - 85020);
    // No PF/ESI/PT on a supplementary payment and no attendance proration.
    expect(first.earnings).toEqual([
      expect.objectContaining({ code: 'SUPPLEMENTARY', amount: 1000000 }),
    ]);
  });

  it('a second one in the same month sees the first in the year-to-date: only the extra tax is withheld', async () => {
    const res = await supp(adminToken, {
      label: 'Spot award',
      earnings: [{ name: 'Spot award', amount: 100000 }],
    }).expect(201);
    const second = res.body as RunBody;
    expect(second.runSequence).toBe(2);
    // Annual tax on 15,20,000 - 75,000 = 14,45,000 is 1,00,620; minus 85,020 already withheld = 15,600.
    expect(second.totalDeductions).toBe(15600);
  });

  it('does not disturb the regular run: both exist for the month and calculate only touches the regular one', async () => {
    const calc = await post('/payroll/calculate', adminToken)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const body = calc.body as { count: number; payrolls: RunBody[] };
    expect(body.count).toBe(1);
    expect(body.payrolls[0].runSequence).toBe(0);
    const runs = await prisma.payrollRun.findMany({
      where: { employeeId, month: MONTH, year: YEAR },
      orderBy: { runSequence: 'asc' },
    });
    expect(runs.map((r) => r.runSequence)).toEqual([0, 1, 2]);
    // The regular run's TDS already counts the supplementary income and tax: the month is not taxed twice.
    const regular = runs[0];
    const tds =
      (regular.deductions as { code: string; amount: number }[]).find(
        (d) => d.code === 'INCOME_TAX',
      )?.amount ?? 0;
    expect(tds).toBe(0);
  });

  it('goes through verify / approve / lock / pay, and its payslip PDF downloads', async () => {
    for (const step of ['verify', 'approve', 'lock', 'pay']) {
      await post(`/payroll/${first.id}/${step}`, adminToken).expect(201);
    }
    const row = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(row.status).toBe('PAID');
    const pdf = await request(app.getHttpServer())
      .get(`/payroll/${first.id}/pdf`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('a supplementary run cannot be adjusted; only unapproved ones can be deleted; a regular run cannot', async () => {
    const second = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: MONTH, year: YEAR, runSequence: 2 },
    });
    const adjust = await request(app.getHttpServer())
      .patch(`/payroll/${second.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lopDaysOverride: 1 })
      .expect(400);
    expect(JSON.stringify(adjust.body)).toContain('supplementary');
    // Paid one: refused.
    await request(app.getHttpServer())
      .delete(`/payroll/supplementary/${first.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    const regular = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: MONTH, year: YEAR, runSequence: 0 },
    });
    await request(app.getHttpServer())
      .delete(`/payroll/supplementary/${regular.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/payroll/supplementary/${second.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      await prisma.payrollRun.count({
        where: { employeeId, month: MONTH, year: YEAR },
      }),
    ).toBe(2);
  });

  it('rejects bad input: future month, unknown component, no earnings, zero amount, non-existent employee', async () => {
    await supp(adminToken, { month: 12, year: 2099 }).expect(400);
    await supp(adminToken, {
      earnings: [{ name: 'Bonus', amount: 100, componentCode: 'NOPE' }],
    }).expect(400);
    await supp(adminToken, { earnings: [] }).expect(400);
    await supp(adminToken, { earnings: [{ name: 'Bonus', amount: 0 }] }).expect(
      400,
    );
    await supp(adminToken, {
      employeeId: '00000000-0000-4000-8000-000000000000',
    }).expect(404);
  });

  it('HR cannot create one for their own payslip', async () => {
    await supp(hrToken, { employeeId: hrId }).expect(403);
  });

  it('a seeded earning component can carry the amount (BONUS) and a non-taxable line is not taxed', async () => {
    const res = await supp(adminToken, {
      label: 'Travel reimbursement',
      earnings: [
        { name: 'Annual bonus', amount: 50000, componentCode: 'BONUS' },
        { name: 'Reimbursement', amount: 5000, taxable: false },
      ],
    }).expect(201);
    const run = res.body as RunBody;
    expect(run.earnings.map((e) => e.code)).toEqual(['BONUS', 'SUPPLEMENTARY']);
    expect(run.grossSalary).toBe(55000);
    const row = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(row.taxableGross).toBe(50000);
  });
});
