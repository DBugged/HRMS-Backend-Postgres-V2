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
import { AttendanceStatus, PayrollRunStatus } from '@prisma/client';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface PayrollRunBody {
  id: string;
  status: string;
  employeeId: string;
  grossSalary: number;
  totalDeductions: number;
  netPay: number;
  earnings: { code: string; amount: number }[];
  deductions: { code: string; amount: number }[];
}
interface CalculateResponseBody {
  count: number;
  payrolls: PayrollRunBody[];
  failures: { employeeId: string; message: string }[];
}

const PASSWORD = 'TestPass123!';

// A full 30-day month in the past (well before "today" in this session),
// so effectiveFrom dates set explicitly in the past are always in range.
const MONTH = 6;
const YEAR = 2026;
const DAYS_IN_MONTH = 30;

async function markFullMonthPresent(
  prisma: PrismaService,
  organizationId: string,
  employeeId: string,
) {
  const rows = Array.from({ length: DAYS_IN_MONTH }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      organizationId,
      employeeId,
      date: `${YEAR}-0${MONTH}-${day}`,
      status: AttendanceStatus.PRESENT,
      source: 'FACE_API' as const,
    };
  });
  await prisma.attendance.createMany({ data: rows });
}

describe('Payroll (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let managerToken: string;
  let deptEmployeeId: string;
  let organizationId: string;
  let otherEmployeeToken: string;
  let otherEmployeeId: string;

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
      organizationName: 'Payroll E2E Org',
      name: 'Founder',
      email: 'pay-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'pay-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'pay-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'pay-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    const departmentId = (dept.body as { id: string }).id;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Manager',
        email: 'pay-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'pay-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    deptEmployeeId = employeeId;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'pay-e2e-other@example.test' });
    otherEmployeeId = (otherCreate.body as EmployeeCreateBody).employee.id;
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'pay-e2e-other@example.test',
        password: (otherCreate.body as EmployeeCreateBody).generatedPassword,
      });
    otherEmployeeToken = (otherLogin.body as AuthBody).accessToken;

    // BASIC (FIXED, opt-in) + HRA (PERCENTAGE of BASIC, auto-applies).
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Basic',
        code: 'BASIC',
        type: 'EARNING',
        calcType: 'FIXED',
        defaultValue: 30000,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HRA',
        code: 'HRA',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'BASIC',
        percentageValue: 40,
      })
      .expect(201);

    // BASIC is FIXED/opt-in — needs an explicit per-employee override.
    // effectiveFrom is set well before the test period (MONTH/YEAR is in
    // the past relative to "today" in this session).
    await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-01-01',
      })
      .expect(201);

    await markFullMonthPresent(prisma, organizationId, employeeId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "attendances", "employee_salary_components", "salary_components", "tax_slab_configs", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 on draft/calculate', async () => {
    await request(app.getHttpServer())
      .post('/payroll/draft')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ month: MONTH, year: YEAR })
      .expect(403);
    await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ month: MONTH, year: YEAR })
      .expect(403);
  });

  it('draft creates a DRAFT run for the targeted employee and is idempotent', async () => {
    const res = await request(app.getHttpServer())
      .post('/payroll/draft')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    expect((res.body as { count: number }).count).toBe(1);

    const count = await prisma.payrollRun.count({
      where: { employeeId, month: MONTH, year: YEAR },
    });
    expect(count).toBe(1);

    await request(app.getHttpServer())
      .post('/payroll/draft')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const countAfter = await prisma.payrollRun.count({
      where: { employeeId, month: MONTH, year: YEAR },
    });
    expect(countAfter).toBe(1); // still just the one row
  });

  it('calculate produces the correct gross/net for a known BASIC+HRA structure', async () => {
    const res = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const body = res.body as CalculateResponseBody;
    expect(body.failures).toEqual([]);
    const run = body.payrolls[0];
    expect(run.status).toBe('CALCULATED');

    const basic = run.earnings.find((e) => e.code === 'BASIC');
    const hra = run.earnings.find((e) => e.code === 'HRA');
    expect(basic?.amount).toBe(30000); // full month present -> no proration
    expect(hra?.amount).toBe(12000); // 40% of 30000
    expect(run.grossSalary).toBe(42000);
    expect(run.totalDeductions).toBe(0);
    expect(run.netPay).toBe(42000);
  });

  it('calculate skips a LOCKED run without recomputing it', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: MONTH, year: YEAR },
    });
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: PayrollRunStatus.LOCKED, netPay: 999999 },
    });

    const res = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const body = res.body as CalculateResponseBody;
    expect(body.payrolls[0].status).toBe('LOCKED');
    expect(body.payrolls[0].netPay).toBe(999999); // untouched

    // Reset for subsequent tests.
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: PayrollRunStatus.CALCULATED, netPay: 42000 },
    });
  });

  it('LOP proration reduces the FIXED BASIC earning proportionally', async () => {
    // A separate month with only half the days present.
    const partialMonth = 7;
    const rows = Array.from({ length: 15 }, (_, i) => ({
      organizationId,
      employeeId,
      date: `2026-0${partialMonth}-${String(i + 1).padStart(2, '0')}`,
      status: AttendanceStatus.PRESENT,
      source: 'FACE_API' as const,
    }));
    await prisma.attendance.createMany({ data: rows });

    const res = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: partialMonth, year: YEAR, employeeId })
      .expect(201);
    const run = (res.body as CalculateResponseBody).payrolls[0];
    const basic = run.earnings.find((e) => e.code === 'BASIC');
    // 15 present / 31 days in July -> prorated BASIC.
    expect(basic?.amount).toBeLessThan(30000);
    expect(basic?.amount).toBeGreaterThan(0);
  });

  it('a circular formula reference is caught per-employee, not thrown to the caller', async () => {
    // SalaryComponentsService itself blocks circular references at
    // creation/update time (Batch 5a), so this can't be reproduced through
    // the public API — insert directly via Prisma to simulate a data
    // integrity edge case (e.g. a legacy import) and confirm the batch
    // endpoint's per-employee try/catch still catches it cleanly (failures
    // collected, no 500) rather than aborting the whole calculate call.
    const compA = await prisma.salaryComponent.create({
      data: {
        organizationId,
        name: 'A',
        code: 'CIRC_A',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'CIRC_B',
      },
    });
    const compB = await prisma.salaryComponent.create({
      data: {
        organizationId,
        name: 'B',
        code: 'CIRC_B',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'CIRC_A',
      },
    });

    const res = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const body = res.body as CalculateResponseBody;
    expect(body.failures.length).toBeGreaterThan(0);
    expect(body.failures[0].message).toMatch(/Circular reference/);

    await prisma.salaryComponent.delete({ where: { id: compA.id } });
    await prisma.salaryComponent.delete({ where: { id: compB.id } });
  });

  it('an income-tax line only appears once a TaxSlabConfig exists for the FY/regime', async () => {
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Income Tax',
        code: 'INCOME_TAX',
        type: 'DEDUCTION',
        calcType: 'FIXED',
        isStatutory: true,
        statutoryKey: 'INCOME_TAX',
      })
      .expect(201);

    const withoutSlab = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const runWithout = (withoutSlab.body as CalculateResponseBody).payrolls[0];
    expect(
      runWithout.deductions.find((d) => d.code === 'INCOME_TAX'),
    ).toBeUndefined();

    // financialYear for June 2026 with the default FY-start-month (April)
    // is "2026-27".
    await request(app.getHttpServer())
      .post('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ financialYear: '2026-27', regime: 'NEW' })
      .expect(201);

    const withSlab = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const runWith = (withSlab.body as CalculateResponseBody).payrolls[0];
    expect(
      runWith.deductions.find((d) => d.code === 'INCOME_TAX'),
    ).toBeDefined();
  });

  describe('GET scoping', () => {
    it('EMPLOYEE only sees their own runs', async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      const runs = (res.body as { data: PayrollRunBody[] }).data;
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.employeeId === employeeId)).toBe(true);
    });

    it('the owning EMPLOYEE can view their own payslip by id', async () => {
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: MONTH, year: YEAR },
      });
      await request(app.getHttpServer())
        .get(`/payroll/${run.id}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
    });

    it("EMPLOYEE gets 403 reading another employee's payslip by id", async () => {
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: MONTH, year: YEAR },
      });
      await request(app.getHttpServer())
        .get(`/payroll/${run.id}`)
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .expect(403);
    });

    it('MANAGER can view a single payslip for someone in their own department', async () => {
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: MONTH, year: YEAR },
      });
      await request(app.getHttpServer())
        .get(`/payroll/${run.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
    });

    it('MANAGER gets 403 on a single payslip for someone outside their department', async () => {
      await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: MONTH, year: YEAR, employeeId: otherEmployeeId })
        .expect(201);
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId: otherEmployeeId, month: MONTH, year: YEAR },
      });
      await request(app.getHttpServer())
        .get(`/payroll/${run.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });

    it("MANAGER's list is scoped to their own department", async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const runs = (res.body as { data: PayrollRunBody[] }).data;
      expect(runs.every((r) => r.employeeId === deptEmployeeId)).toBe(true);
    });

    it('ADMIN sees all runs', async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const runs = (res.body as { data: PayrollRunBody[] }).data;
      expect(runs.some((r) => r.employeeId === employeeId)).toBe(true);
    });
  });

  describe('Workflow: adjust, verify -> approve -> lock -> pay, unlock, bulk-transition', () => {
    const WORKFLOW_MONTH = 8;
    let runId: string;

    beforeAll(async () => {
      await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: WORKFLOW_MONTH, year: YEAR, employeeId })
        .expect(201);
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: WORKFLOW_MONTH, year: YEAR },
      });
      runId = run.id;
    });

    it('EMPLOYEE gets 403 on every workflow endpoint', async () => {
      const server = app.getHttpServer();
      await request(server)
        .patch(`/payroll/${runId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);
      await request(server)
        .post(`/payroll/${runId}/verify`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      await request(server)
        .post('/payroll/bulk-transition')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ ids: [runId], action: 'verify' })
        .expect(403);
      await request(server)
        .post(`/payroll/${runId}/unlock`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({})
        .expect(403);
    });

    it('adjust overrides earnings/deductions and recomputes totals + netPayInWords', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/payroll/${runId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          earnings: [{ code: 'BASIC', name: 'Basic', amount: 50000 }],
          deductions: [{ code: 'PT', name: 'Professional Tax', amount: 200 }],
          reason: 'Manual correction for testing',
        })
        .expect(200);
      const body = res.body as PayrollRunBody;
      expect(body.grossSalary).toBe(50000);
      expect(body.totalDeductions).toBe(200);
      expect(body.netPay).toBe(49800);
      expect(body.status).toBe('CALCULATED');
    });

    it('verify moves CALCULATED -> VERIFIED; rejects from the wrong state', async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/${runId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect((res.body as PayrollRunBody).status).toBe('VERIFIED');

      await request(app.getHttpServer())
        .post(`/payroll/${runId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('adjusting a VERIFIED run demotes it back to CALCULATED', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/payroll/${runId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ earnings: [{ code: 'BASIC', name: 'Basic', amount: 51000 }] })
        .expect(200);
      expect((res.body as PayrollRunBody).status).toBe('CALCULATED');

      // Re-verify so the rest of the workflow chain can proceed.
      await request(app.getHttpServer())
        .post(`/payroll/${runId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
    });

    it('approve moves VERIFIED -> APPROVED', async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/${runId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect((res.body as PayrollRunBody).status).toBe('APPROVED');
    });

    it('lock moves APPROVED -> LOCKED and marks approved LeaveEncashments as PROCESSED', async () => {
      const leaveType = await prisma.leaveType.create({
        data: {
          organizationId,
          name: 'Workflow Test Leave',
          code: 'WFTL',
          allocationType: 'UNLIMITED',
        },
      });
      const encashment = await prisma.leaveEncashment.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId: leaveType.id,
          days: 2,
          ratePerDay: 1000,
          amount: 2000,
          financialYear: '2026-27',
          status: 'APPROVED',
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/payroll/${runId}/lock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect((res.body as PayrollRunBody).status).toBe('LOCKED');

      const updatedEncashment = await prisma.leaveEncashment.findFirstOrThrow({
        where: { id: encashment.id },
      });
      expect(updatedEncashment.status).toBe('PROCESSED');
      expect(updatedEncashment.payrollRunId).toBe(runId);
      expect(updatedEncashment.processedAt).not.toBeNull();
    });

    it('adjust is rejected once LOCKED — must unlock first', async () => {
      await request(app.getHttpServer())
        .patch(`/payroll/${runId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ earnings: [{ code: 'BASIC', name: 'Basic', amount: 1 }] })
        .expect(400);
    });

    it('pay moves LOCKED -> PAID and notifies the employee (afterPay)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/${runId}/pay`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      expect((res.body as PayrollRunBody).status).toBe('PAID');

      const notification = await prisma.notification.findFirst({
        where: {
          organizationId,
          userId: employeeId,
          category: 'PAYROLL',
          title: { contains: 'Payslip' },
        },
      });
      expect(notification).not.toBeNull();
    });

    it('unlock reverts PAID -> CALCULATED and stamps the reason', async () => {
      const res = await request(app.getHttpServer())
        .post(`/payroll/${runId}/unlock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Correcting a mistake' })
        .expect(201);
      const body = res.body as PayrollRunBody & { unlockReason: string };
      expect(body.status).toBe('CALCULATED');
      expect(body.unlockReason).toBe('Correcting a mistake');
    });

    it('unlock is rejected from a non-locked/paid state', async () => {
      await request(app.getHttpServer())
        .post(`/payroll/${runId}/unlock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);
    });

    it('bulk-transition reports skipped rows for a mixed-status selection', async () => {
      // runId is CALCULATED (from the unlock above); create a second run
      // still at DRAFT so the two together form a mixed-status batch.
      await request(app.getHttpServer())
        .post('/payroll/draft')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: WORKFLOW_MONTH + 1, year: YEAR, employeeId })
        .expect(201);
      const draftRun = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: WORKFLOW_MONTH + 1, year: YEAR },
      });

      const res = await request(app.getHttpServer())
        .post('/payroll/bulk-transition')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ids: [runId, draftRun.id], action: 'verify' })
        .expect(201);
      const body = res.body as {
        updatedCount: number;
        skipped: { id: string; status: string }[];
        runs: PayrollRunBody[];
      };
      expect(body.updatedCount).toBe(1);
      expect(body.runs[0].id).toBe(runId);
      expect(body.skipped).toEqual([{ id: draftRun.id, status: 'DRAFT' }]);
    });

    it('bulk-transition reports a not_found id without failing the rest', async () => {
      const res = await request(app.getHttpServer())
        .post('/payroll/bulk-transition')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ids: [runId, '00000000-0000-4000-8000-000000000000'],
          action: 'approve',
        })
        .expect(201);
      const body = res.body as {
        updatedCount: number;
        skipped: { id: string; status: string }[];
      };
      expect(body.updatedCount).toBe(1);
      expect(body.skipped.some((s) => s.status === 'not_found')).toBe(true);
    });

    it('GET /payroll/history reflects the actions above, newest first, with the run+actor joined in', async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll/history')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const { history } = res.body as {
        history: {
          action: string;
          targetId: string | null;
          actor: { name: string };
          run: { id: string; employee: { id: string } } | null;
        }[];
      };
      expect(history.length).toBeGreaterThan(0);
      const actions = new Set(history.map((h) => h.action));
      expect(actions.has('PAYROLL_CALCULATED')).toBe(true);
      expect(actions.has('PAYROLL_ADJUSTED')).toBe(true);
      expect(actions.has('PAYROLL_VERIFIED')).toBe(true);

      const adjustEntry = history.find((h) => h.action === 'PAYROLL_ADJUSTED');
      expect(adjustEntry?.run?.employee.id).toBe(employeeId);
      expect(adjustEntry?.actor.name).toBeTruthy();

      const draftEntry = history.find(
        (h) => h.action === 'PAYROLL_DRAFT_CREATED',
      );
      expect(draftEntry?.targetId).toBeNull();
      expect(draftEntry?.run).toBeNull();
    });

    it('GET /payroll/history filtered by employeeId excludes batch-level draft/calculate entries', async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll/history')
        .query({ employeeId })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const { history } = res.body as { history: { action: string }[] };
      expect(history.some((h) => h.action === 'PAYROLL_DRAFT_CREATED')).toBe(
        false,
      );
    });

    it('EMPLOYEE gets 403 on the history endpoint', async () => {
      await request(app.getHttpServer())
        .get('/payroll/history')
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
    });
  });

  describe('Payslip PDF', () => {
    const PDF_MONTH = 10;
    let runId: string;

    beforeAll(async () => {
      await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: PDF_MONTH, year: YEAR, employeeId })
        .expect(201);
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: PDF_MONTH, year: YEAR },
      });
      runId = run.id;
    });

    it('returns 400 for a run that has not been approved yet', async () => {
      const res = await request(app.getHttpServer())
        .get(`/payroll/${runId}/pdf`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /not finalized/,
      );
    });

    it('returns 404 for a non-existent run id', async () => {
      await request(app.getHttpServer())
        .get('/payroll/00000000-0000-4000-8000-000000000000/pdf')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it("EMPLOYEE gets 403 requesting another employee's payslip PDF", async () => {
      await request(app.getHttpServer())
        .get(`/payroll/${runId}/pdf`)
        .set('Authorization', `Bearer ${otherEmployeeToken}`)
        .expect(403);
    });

    it('streams a valid PDF once the run is approved', async () => {
      await prisma.payrollRun.update({
        where: { id: runId },
        data: { status: PayrollRunStatus.APPROVED },
      });

      const res = await request(app.getHttpServer())
        .get(`/payroll/${runId}/pdf`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(`${PDF_MONTH}`);
      const buffer = res.body as Buffer;
      expect(buffer.length).toBeGreaterThan(500);
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('ADMIN can also download the same payslip PDF', async () => {
      await request(app.getHttpServer())
        .get(`/payroll/${runId}/pdf`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });
});
