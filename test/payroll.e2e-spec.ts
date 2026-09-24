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
  month: number = MONTH,
) {
  const rows = Array.from({ length: DAYS_IN_MONTH }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      organizationId,
      employeeId,
      date: `${YEAR}-${String(month).padStart(2, '0')}-${day}`,
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
  let managerId: string;
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
    managerId = (managerCreate.body as EmployeeCreateBody).employee.id;

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

    // BASIC (FIXED, opt-in) + HRA (PERCENTAGE of BASIC, auto-applies) are
    // both auto-seeded on every new org already (see LeaveTypesService/
    // SalaryComponentsService.seedDefaults) with this exact shape — only
    // the per-employee override on BASIC is needed.
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
    // otherEmployeeId also needs a BASIC override — HRA (seeded, PERCENTAGE
    // of BASIC) auto-applies to every employee and its formula fails to
    // resolve if BASIC itself was never opted into for them.
    await request(app.getHttpServer())
      .post(`/employee-salary/${otherEmployeeId}/structure`)
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

  // Regression: totalDeductions excluded includeInNet:false components but
  // the persisted `deductions` array listed them anyway. The payslip PDF
  // prints that array against run.totalDeductions, so the deductions column
  // did not add up to its own printed total.
  it('the deduction lines on a run always sum to its printed totalDeductions', async () => {
    // FORMULA, not FIXED: a non-statutory FIXED component only applies to
    // an employee who has an explicit EmployeeSalaryComponent row for it
    // (see isApplicable), so a constant formula is the light way to get a
    // deduction line onto this run.
    const realDeduction = await prisma.salaryComponent.create({
      data: {
        organizationId,
        name: 'Canteen',
        code: 'CANTEEN_TEST',
        type: 'DEDUCTION',
        calcType: 'FORMULA',
        formula: '300',
      },
    });
    const informational = await prisma.salaryComponent.create({
      data: {
        organizationId,
        name: 'Informational Only',
        code: 'INFO_ONLY',
        type: 'DEDUCTION',
        calcType: 'FORMULA',
        formula: '500',
        includeInNet: false,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const run = (res.body as CalculateResponseBody).payrolls[0];

    const sum = run.deductions.reduce((total, d) => total + d.amount, 0);
    expect(run.deductions.find((d) => d.code === 'CANTEEN_TEST')?.amount).toBe(
      300,
    );
    expect(sum).toBe(run.totalDeductions);
    // The excluded line is left out of the listing, not silently added to
    // the total.
    expect(run.deductions.find((d) => d.code === 'INFO_ONLY')).toBeUndefined();
    expect(run.netPay).toBe(run.grossSalary - run.totalDeductions);

    await prisma.salaryComponent.delete({ where: { id: informational.id } });
    await prisma.salaryComponent.delete({ where: { id: realDeduction.id } });
  });

  // Changed with the P6 fix: with income tax enabled and no slab config for the FY, the employee used to be
  // calculated with NO income-tax line (TDS silently 0, then paid). It now fails that employee with a message
  // naming the FY, and nothing is saved over the existing run.
  it('with income tax enabled, a missing TaxSlabConfig fails the employee instead of paying zero TDS', async () => {
    // INCOME_TAX is auto-seeded on every new org already (see
    // LeaveTypesService/SalaryComponentsService.seedDefaults). Registration also seeds both regimes' slabs
    // for the CURRENT financial year, so clear any FY 2026-27 NEW-regime config first to test the
    // "no config" case regardless of when the suite runs.
    const existingSlabs = await request(app.getHttpServer())
      .get('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    for (const slab of (
      existingSlabs.body as {
        data: { id: string; financialYear: string; regime: string }[];
      }
    ).data.filter((t) => t.financialYear === '2026-27' && t.regime === 'NEW')) {
      await request(app.getHttpServer())
        .delete(`/tax-slabs/${slab.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
    const before = await prisma.payrollRun.findFirstOrThrow({
      where: { employeeId, month: MONTH, year: YEAR },
    });
    const withoutSlab = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    const bodyWithout = withoutSlab.body as CalculateResponseBody;
    expect(bodyWithout.payrolls).toHaveLength(0);
    expect(bodyWithout.failures).toHaveLength(1);
    expect(bodyWithout.failures[0].employeeId).toBe(employeeId);
    // Regime-specific wording while the seeded OLD-regime config for 2026-27 still exists (i.e. when the suite
    // runs in FY 2026-27); with none at all for the FY the message is the plain FY one.
    expect(bodyWithout.failures[0].message).toMatch(
      /^No income tax slabs configured for (the NEW regime for )?FY 2026-27 — add them under Statutory Compliance before running payroll$/,
    );
    const oldRegime = await prisma.taxSlabConfig.findMany({
      where: { organizationId, financialYear: '2026-27' },
    });
    await prisma.taxSlabConfig.updateMany({
      where: { id: { in: oldRegime.map((t) => t.id) } },
      data: { isActive: false },
    });
    const noneAtAll = await request(app.getHttpServer())
      .post('/payroll/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ month: MONTH, year: YEAR, employeeId })
      .expect(201);
    expect((noneAtAll.body as CalculateResponseBody).failures[0].message).toBe(
      'No income tax slabs configured for FY 2026-27 — add them under Statutory Compliance before running payroll',
    );
    await prisma.taxSlabConfig.updateMany({
      where: { id: { in: oldRegime.map((t) => t.id) } },
      data: { isActive: true },
    });
    // The failed recalculation left the previously calculated run untouched.
    const after = await prisma.payrollRun.findFirstOrThrow({
      where: { id: before.id },
    });
    expect(after.netPay).toBe(before.netPay);
    expect(after.calculatedAt).toEqual(before.calculatedAt);

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

    it("MANAGER gets 403 on a direct report's payslip, its PDF and the payroll history", async () => {
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: MONTH, year: YEAR },
      });
      const server = app.getHttpServer();
      await request(server)
        .get(`/payroll/${run.id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
      await request(server)
        .get(`/payroll/${run.id}/pdf`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
      await request(server)
        .get('/payroll/history')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(403);
    });

    it("MANAGER's list contains only their own payslips and keeps access to their own", async () => {
      await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: MONTH, year: YEAR, employeeId: managerId })
        .expect(201);
      const res = await request(app.getHttpServer())
        .get('/payroll')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      const runs = (res.body as { data: PayrollRunBody[] }).data;
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.employeeId === managerId)).toBe(true);
      await request(app.getHttpServer())
        .get(`/payroll/${runs[0].id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
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

    // Regression: afterLock() used to mark EVERY approved encashment
    // PROCESSED against the run being locked, re-reading live state instead
    // of the frozen payslip. An encashment approved after this run was
    // calculated is not on its payslip, so marking it paid meant the
    // employee never received the money.
    it('lock moves APPROVED -> LOCKED and leaves an encashment approved after calculate alone', async () => {
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

      const untouched = await prisma.leaveEncashment.findFirstOrThrow({
        where: { id: encashment.id },
      });
      expect(untouched.status).toBe('APPROVED');
      expect(untouched.payrollRunId).toBeNull();
      expect(untouched.processedAt).toBeNull();

      await prisma.leaveEncashment.delete({ where: { id: encashment.id } });
      await prisma.leaveType.delete({ where: { id: leaveType.id } });
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

  describe('Loan/advance EMI deduction', () => {
    const LOAN_MONTH = 11;

    beforeAll(async () => {
      await markFullMonthPresent(
        prisma,
        organizationId,
        employeeId,
        LOAN_MONTH,
      );
    });

    it("calculate shows an ACTIVE loan's EMI as a deduction line (preview, nothing persisted yet)", async () => {
      const loan = await prisma.loan.create({
        data: {
          organizationId,
          employeeId,
          loanType: 'LOAN',
          principal: 12000,
          interestRate: 0,
          tenureMonths: 4,
          emiAmount: 3000,
          startMonth: LOAN_MONTH,
          startYear: YEAR,
          outstandingBalance: 12000,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: LOAN_MONTH, year: YEAR, employeeId })
        .expect(201);
      const run = (res.body as CalculateResponseBody).payrolls[0];
      const emiLine = run.deductions.find((d) => d.code === 'LOAN_EMI');
      expect(emiLine?.amount).toBe(3000);
      expect(run.totalDeductions).toBeGreaterThanOrEqual(3000);

      // Preview only — calculate() never touches the loan itself.
      const untouched = await prisma.loan.findFirstOrThrow({
        where: { id: loan.id },
      });
      expect(untouched.outstandingBalance).toBe(12000);
      const repaymentCount = await prisma.loanRepayment.count({
        where: { loanId: loan.id },
      });
      expect(repaymentCount).toBe(0);
    });

    it('a loan starting after this run is not deducted yet', async () => {
      await prisma.loan.create({
        data: {
          organizationId,
          employeeId,
          loanType: 'ADVANCE',
          principal: 5000,
          interestRate: 0,
          tenureMonths: 1,
          emiAmount: 5000,
          startMonth: LOAN_MONTH + 1,
          startYear: YEAR,
          outstandingBalance: 5000,
          status: 'ACTIVE',
        },
      });
      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: LOAN_MONTH, year: YEAR, employeeId })
        .expect(201);
      const run = (res.body as CalculateResponseBody).payrolls[0];
      expect(run.deductions.filter((d) => d.code === 'LOAN_EMI')).toHaveLength(
        1,
      ); // only the already-started loan
    });

    it('lock actually deducts the EMI, decrements the balance, and stamps payrollRunId', async () => {
      const loan = await prisma.loan.findFirstOrThrow({
        where: { organizationId, employeeId, loanType: 'LOAN' },
      });
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: LOAN_MONTH, year: YEAR },
      });
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/lock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      const updatedLoan = await prisma.loan.findFirstOrThrow({
        where: { id: loan.id },
      });
      expect(updatedLoan.outstandingBalance).toBe(9000); // 12000 - 3000
      expect(updatedLoan.status).toBe('ACTIVE'); // not paid off yet

      const repayment = await prisma.loanRepayment.findFirstOrThrow({
        where: { loanId: loan.id },
      });
      expect(repayment.amount).toBe(3000);
      expect(repayment.payrollRunId).toBe(run.id);
      expect(repayment.balanceAfter).toBe(9000);
    });

    it("locking a later run's EMI that pays off the remaining balance closes the loan", async () => {
      const loan = await prisma.loan.findFirstOrThrow({
        where: { organizationId, employeeId, loanType: 'LOAN' },
      });
      // Fast-forward straight to the loan's last installment so this one
      // run's EMI (capped at whatever's left) fully closes it out.
      await prisma.loan.update({
        where: { id: loan.id },
        data: { outstandingBalance: 1500 }, // less than the 3000 EMI
      });

      // Must stay >= LOAN_MONTH (the loan's own startMonth) for
      // getDueLoanEmis' "period has started" check, and >= 12 was never
      // actually calculate()'d anywhere else in this file (only used as
      // the OTHER loan's startMonth above, never as a run's own month).
      const finalMonth = 12;
      await markFullMonthPresent(
        prisma,
        organizationId,
        employeeId,
        finalMonth,
      );
      await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: finalMonth, year: YEAR, employeeId })
        .expect(201);
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month: finalMonth, year: YEAR },
      });
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/lock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      const closedLoan = await prisma.loan.findFirstOrThrow({
        where: { id: loan.id },
      });
      expect(closedLoan.outstandingBalance).toBe(0);
      expect(closedLoan.status).toBe('CLOSED');

      const repayment = await prisma.loanRepayment.findFirstOrThrow({
        where: { loanId: loan.id, month: finalMonth },
      });
      expect(repayment.amount).toBe(1500); // capped at what was left, not the full 3000 EMI
    });
  });

  // afterLock() settles what the LOCKED payslip contains, not whatever is
  // live at lock time. Both halves of that used to re-query.
  describe('Lock settles exactly what the payslip contains', () => {
    const EMI_GAP_MONTH = 10;
    const ENCASHMENT_MONTH = 9;

    const runThroughLock = async (month: number) => {
      const run = await prisma.payrollRun.findFirstOrThrow({
        where: { employeeId, month, year: YEAR },
      });
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${run.id}/lock`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      return run;
    };

    it('does not charge a loan that only became due after the run was calculated', async () => {
      await markFullMonthPresent(
        prisma,
        organizationId,
        employeeId,
        EMI_GAP_MONTH,
      );
      // The PDF suite above forces this period's run to APPROVED, and
      // calculate() now skips APPROVED runs — reset it so it recalculates.
      await prisma.payrollRun.updateMany({
        where: { employeeId, month: EMI_GAP_MONTH, year: YEAR },
        data: { status: PayrollRunStatus.CALCULATED },
      });
      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: EMI_GAP_MONTH, year: YEAR, employeeId })
        .expect(201);
      expect(
        (res.body as CalculateResponseBody).payrolls[0].deductions.filter(
          (d) => d.code === 'LOAN_EMI',
        ),
      ).toHaveLength(0);

      // Approved and made due only now — after the payslip was frozen.
      const lateLoan = await prisma.loan.create({
        data: {
          organizationId,
          employeeId,
          loanType: 'LOAN',
          principal: 8000,
          interestRate: 0,
          tenureMonths: 4,
          emiAmount: 2000,
          startMonth: EMI_GAP_MONTH,
          startYear: YEAR,
          outstandingBalance: 8000,
          status: 'ACTIVE',
        },
      });

      const run = await runThroughLock(EMI_GAP_MONTH);

      // The employee's payslip has no EMI line, so nothing may be taken.
      const untouched = await prisma.loan.findFirstOrThrow({
        where: { id: lateLoan.id },
      });
      expect(untouched.outstandingBalance).toBe(8000);
      expect(
        await prisma.loanRepayment.count({
          where: { loanId: lateLoan.id, payrollRunId: run.id },
        }),
      ).toBe(0);

      await prisma.loan.delete({ where: { id: lateLoan.id } });
    });

    it('still processes an encashment that WAS on the payslip at calculate time', async () => {
      await markFullMonthPresent(
        prisma,
        organizationId,
        employeeId,
        ENCASHMENT_MONTH,
      );
      const leaveType = await prisma.leaveType.create({
        data: {
          organizationId,
          name: 'Encashment Lock Leave',
          code: 'ENCL',
          allocationType: 'UNLIMITED',
        },
      });
      const encashment = await prisma.leaveEncashment.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId: leaveType.id,
          days: 3,
          ratePerDay: 1000,
          amount: 3000,
          financialYear: '2026-27',
          status: 'APPROVED',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: ENCASHMENT_MONTH, year: YEAR, employeeId })
        .expect(201);
      const calculated = (res.body as CalculateResponseBody).payrolls[0];
      expect(
        calculated.earnings.find((e) => e.code === 'LEAVE_ENCASHMENT')?.amount,
      ).toBe(3000);

      const run = await runThroughLock(ENCASHMENT_MONTH);

      const processed = await prisma.leaveEncashment.findFirstOrThrow({
        where: { id: encashment.id },
      });
      expect(processed.status).toBe('PROCESSED');
      expect(processed.payrollRunId).toBe(run.id);
      expect(processed.processedAt).not.toBeNull();

      await prisma.leaveEncashment.update({
        where: { id: encashment.id },
        data: { payrollRunId: null },
      });
      await prisma.leaveEncashment.delete({ where: { id: encashment.id } });
      await prisma.leaveType.delete({ where: { id: leaveType.id } });
    });
  });

  describe('Variable pay is only scaled by an APPROVED PerformanceRating', () => {
    // VARIABLE_PAY (seeded, MANUAL calcType) is YEARLY — only payable in
    // the last month of the FY. Default financialYearStartMonth is 4
    // (April), so month 3 (March) is the payable month, landing in FY
    // "2025-26" for calendar YEAR (2026).
    const VAR_PAY_MONTH = 3;
    let varPayEmployeeId: string;

    beforeAll(async () => {
      const create = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Var Pay Employee',
          email: 'pay-e2e-varpay@example.test',
        });
      varPayEmployeeId = (create.body as EmployeeCreateBody).employee.id;

      await request(app.getHttpServer())
        .post(`/employee-salary/${varPayEmployeeId}/structure`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: 10000,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/employee-salary/${varPayEmployeeId}/structure`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          componentCode: 'VARIABLE_PAY',
          fixedAmount: 4000,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);

      await markFullMonthPresent(
        prisma,
        organizationId,
        varPayEmployeeId,
        VAR_PAY_MONTH,
      );

      // March 2026 is FY 2025-26, which registration doesn't seed slabs for — and with income tax enabled a
      // missing slab config now fails the employee rather than silently skipping TDS.
      await request(app.getHttpServer())
        .post('/tax-slabs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ financialYear: '2025-26', regime: 'NEW' })
        .expect(201);

      await prisma.performanceRating.create({
        data: {
          organizationId,
          employeeId: varPayEmployeeId,
          financialYear: '2025-26',
          rating: 5,
          payoutPercentage: 50,
          status: 'SUBMITTED',
        },
      });
    });

    it('a SUBMITTED (not approved) rating does not scale VARIABLE_PAY — falls back to factor 1', async () => {
      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          month: VAR_PAY_MONTH,
          year: YEAR,
          employeeId: varPayEmployeeId,
        })
        .expect(201);
      const run = (res.body as CalculateResponseBody).payrolls[0];
      const line = run.earnings.find((e) => e.code === 'VARIABLE_PAY');
      expect(line?.amount).toBe(4000);
    });

    it('an APPROVED rating scales VARIABLE_PAY by payoutPercentage', async () => {
      const rating = await prisma.performanceRating.findFirstOrThrow({
        where: { employeeId: varPayEmployeeId, financialYear: '2025-26' },
      });
      await prisma.performanceRating.update({
        where: { id: rating.id },
        data: { status: 'APPROVED' },
      });

      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          month: VAR_PAY_MONTH,
          year: YEAR,
          employeeId: varPayEmployeeId,
        })
        .expect(201);
      const run = (res.body as CalculateResponseBody).payrolls[0];
      const line = run.earnings.find((e) => e.code === 'VARIABLE_PAY');
      expect(line?.amount).toBe(2000); // 4000 * 50%
    });
  });

  describe('GET /payroll/attendance-gaps', () => {
    // Reuses MONTH (June 2026, 30 days) — markFullMonthPresent's row
    // count is hardcoded to DAYS_IN_MONTH (30), so a month with a
    // different length would leave this fresh employee's last day(s)
    // still unmarked even after "marking the full month present". A
    // different employeeId than the rest of the file's MONTH/YEAR tests
    // use, so there's no cross-test interference.
    const GAPS_MONTH = MONTH;
    let gapsEmployeeId: string;

    beforeAll(async () => {
      const create = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Gaps Employee', email: 'pay-e2e-gaps@example.test' });
      gapsEmployeeId = (create.body as EmployeeCreateBody).employee.id;
    });

    it('EMPLOYEE gets 403', async () => {
      await request(app.getHttpServer())
        .get('/payroll/attendance-gaps')
        .query({ month: GAPS_MONTH, year: YEAR })
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
    });

    it('an employee with zero attendance rows shows the full month as unmarked', async () => {
      const res = await request(app.getHttpServer())
        .get('/payroll/attendance-gaps')
        .query({ month: GAPS_MONTH, year: YEAR })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const rows = res.body as {
        employeeId: string;
        unmarkedDays: number;
        totalDaysInMonth: number;
      }[];
      const row = rows.find((r) => r.employeeId === gapsEmployeeId);
      expect(row).toBeTruthy();
      expect(row?.unmarkedDays).toBe(row?.totalDaysInMonth);
    });

    it('marking the full month present drops the employee out of the gaps list', async () => {
      await markFullMonthPresent(
        prisma,
        organizationId,
        gapsEmployeeId,
        GAPS_MONTH,
      );

      const res = await request(app.getHttpServer())
        .get('/payroll/attendance-gaps')
        .query({ month: GAPS_MONTH, year: YEAR })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const rows = res.body as { employeeId: string }[];
      expect(rows.some((r) => r.employeeId === gapsEmployeeId)).toBe(false);
    });
  });

  describe('Payroll correctness regressions', () => {
    interface TaxedRunBody extends PayrollRunBody {
      employerContributions: { code: string; amount: number }[];
      taxDetails: { grossAnnualIncome: number } | null;
    }

    async function createEmployee(
      name: string,
      email: string,
      structure: {
        componentCode: string;
        fixedAmount: number;
        effectiveFrom: string;
      }[],
    ): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, email });
      const id = (res.body as EmployeeCreateBody).employee.id;
      for (const line of structure) {
        await request(app.getHttpServer())
          .post(`/employee-salary/${id}/structure`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(line)
          .expect(201);
      }
      return id;
    }

    async function calculate(
      empId: string,
      month: number,
      year: number = YEAR,
    ): Promise<CalculateResponseBody> {
      const res = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month, year, employeeId: empId })
        .expect(201);
      return res.body as CalculateResponseBody;
    }

    async function calculateOne(
      empId: string,
      month: number,
    ): Promise<TaxedRunBody> {
      const body = await calculate(empId, month);
      expect(body.failures).toEqual([]);
      return body.payrolls[0] as TaxedRunBody;
    }

    async function verifyAndApprove(runId: string) {
      await request(app.getHttpServer())
        .post(`/payroll/${runId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/payroll/${runId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
    }

    const amountOf = (
      lines: { code: string; amount: number }[],
      code: string,
    ) => lines.find((l) => l.code === code)?.amount;

    // P1 — a formula that evaluates to NaN/Infinity used to be saved on the payslip and could be paid.
    describe('non-finite amounts are never saved or paid', () => {
      const NF_MONTH = 5;

      it('a component formula that cannot produce a finite amount fails the employee; nothing is saved', async () => {
        // Inserted directly — the salary-components API now rejects this formula at save time; this is the
        // legacy-data case the run-time guard exists for.
        const broken = await prisma.salaryComponent.create({
          data: {
            organizationId,
            name: 'Broken Allowance',
            code: 'BROKEN_ALLOWANCE',
            type: 'EARNING',
            calcType: 'FORMULA',
            formula: 'MIN()',
          },
        });
        try {
          const body = await calculate(otherEmployeeId, NF_MONTH);
          expect(body.payrolls).toHaveLength(0);
          expect(body.failures).toHaveLength(1);
          expect(body.failures[0].message).toMatch(/Broken Allowance/);
          expect(body.failures[0].message).toMatch(/MIN\(\) expects/);
          expect(
            await prisma.payrollRun.count({
              where: {
                employeeId: otherEmployeeId,
                month: NF_MONTH,
                year: YEAR,
              },
            }),
          ).toBe(0);
        } finally {
          await prisma.salaryComponent.delete({ where: { id: broken.id } });
        }
      });

      it('a stored run with a non-numeric amount cannot be verified, singly or in bulk', async () => {
        // A NaN line amount is stored as null in the JSON column — this is what such a payslip looks like.
        const run = await prisma.payrollRun.create({
          data: {
            organizationId,
            employeeId: otherEmployeeId,
            month: NF_MONTH,
            year: YEAR,
            status: PayrollRunStatus.CALCULATED,
            earnings: [{ code: 'BASIC', name: 'Basic', amount: null }],
          },
        });
        try {
          const single = await request(app.getHttpServer())
            .post(`/payroll/${run.id}/verify`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(400);
          expect((single.body as { message: string }).message).toMatch(
            /non-numeric amount/,
          );
          const bulk = await request(app.getHttpServer())
            .post('/payroll/bulk-transition')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ ids: [run.id], action: 'verify' })
            .expect(201);
          const bulkBody = bulk.body as {
            updatedCount: number;
            skipped: { id: string; status: string }[];
          };
          expect(bulkBody.updatedCount).toBe(0);
          expect(bulkBody.skipped[0]).toMatchObject({
            id: run.id,
            status: 'non_finite_amount',
          });
          const unchanged = await prisma.payrollRun.findFirstOrThrow({
            where: { id: run.id },
          });
          expect(unchanged.status).toBe(PayrollRunStatus.CALCULATED);
        } finally {
          await prisma.payrollRun.delete({ where: { id: run.id } });
        }
      });
    });

    // P2 — EMIs used to be previewed off the live balance in every open month, so two unlocked months
    // together deducted more than the loan's outstanding balance.
    describe('loan EMI across several open months', () => {
      let loanEmpId: string;

      beforeAll(async () => {
        loanEmpId = await createEmployee(
          'Loan Months Employee',
          'pay-e2e-loanmonths@example.test',
          [
            {
              componentCode: 'BASIC',
              fixedAmount: 30000,
              effectiveFrom: '2026-01-01',
            },
          ],
        );
        for (const m of [4, 5, 6]) {
          await markFullMonthPresent(prisma, organizationId, loanEmpId, m);
        }
      });

      it("a second open month previews only what is left after the first open month's EMI", async () => {
        const loan = await prisma.loan.create({
          data: {
            organizationId,
            employeeId: loanEmpId,
            loanType: 'ADVANCE',
            principal: 1500,
            interestRate: 0,
            tenureMonths: 2,
            emiAmount: 1000,
            startMonth: 4,
            startYear: YEAR,
            outstandingBalance: 1500,
            status: 'ACTIVE',
          },
        });

        const april = await calculateOne(loanEmpId, 4);
        expect(amountOf(april.deductions, 'LOAN_EMI')).toBe(1000);
        const may = await calculateOne(loanEmpId, 5);
        expect(amountOf(may.deductions, 'LOAN_EMI')).toBe(500); // not another 1000
        // Recalculating April still sees May's pending 500 and keeps its own 1000.
        const aprilAgain = await calculateOne(loanEmpId, 4);
        expect(amountOf(aprilAgain.deductions, 'LOAN_EMI')).toBe(1000);

        for (const run of [april, may]) {
          await verifyAndApprove(run.id);
          await request(app.getHttpServer())
            .post(`/payroll/${run.id}/lock`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(201);
        }
        const settled = await prisma.loan.findFirstOrThrow({
          where: { id: loan.id },
        });
        expect(settled.outstandingBalance).toBe(0);
        expect(settled.status).toBe('CLOSED');
        const repaid = await prisma.loanRepayment.aggregate({
          where: { loanId: loan.id },
          _sum: { amount: true },
        });
        expect(repaid._sum.amount).toBe(1500);
      });

      it('locking a run whose EMI is for a loan closed since calculate is refused and sent back for recalculation', async () => {
        const loan = await prisma.loan.create({
          data: {
            organizationId,
            employeeId: loanEmpId,
            loanType: 'ADVANCE',
            principal: 2000,
            interestRate: 0,
            tenureMonths: 1,
            emiAmount: 2000,
            startMonth: 6,
            startYear: YEAR,
            outstandingBalance: 2000,
            status: 'ACTIVE',
          },
        });
        const june = await calculateOne(loanEmpId, 6);
        expect(amountOf(june.deductions, 'LOAN_EMI')).toBe(2000);
        await verifyAndApprove(june.id);

        // Closed after the payslip was calculated (e.g. repaid in cash).
        await prisma.loan.update({
          where: { id: loan.id },
          data: { status: 'CLOSED', closureReason: 'Repaid in cash' },
        });

        const res = await request(app.getHttpServer())
          .post(`/payroll/${june.id}/lock`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(400);
        expect((res.body as { message: string }).message).toMatch(
          /no longer active.*recalculate/,
        );
        const run = await prisma.payrollRun.findFirstOrThrow({
          where: { id: june.id },
        });
        expect(run.status).toBe(PayrollRunStatus.CALCULATED);
        expect(
          await prisma.loanRepayment.count({ where: { loanId: loan.id } }),
        ).toBe(0);

        const recalculated = await calculateOne(loanEmpId, 6);
        expect(amountOf(recalculated.deductions, 'LOAN_EMI')).toBeUndefined();
      });

      // P11 — a revision dated into a month already locked/paid used to be accepted and silently never
      // reached that payslip.
      it('a salary revision effective in (or before) a locked month is rejected', async () => {
        for (const effectiveFrom of ['2026-05-10', '2026-03-01']) {
          const res = await request(app.getHttpServer())
            .post(`/employee-salary/${loanEmpId}/structure`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ componentCode: 'BASIC', fixedAmount: 35000, effectiveFrom })
            .expect(400);
          // May 2026 for the first date, April 2026 for the second (both locked above).
          expect((res.body as { message: string }).message).toMatch(
            effectiveFrom === '2026-05-10'
              ? /5\/2026 payroll is already locked/
              : /4\/2026 payroll is already locked/,
          );
        }
        // After the last locked month (June is only calculated) it's fine.
        await request(app.getHttpServer())
          .post(`/employee-salary/${loanEmpId}/structure`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            componentCode: 'BASIC',
            fixedAmount: 35000,
            effectiveFrom: '2026-07-01',
          })
          .expect(201);
      });
    });

    it('P11: a statutory config version effective in a month with locked/paid payroll is rejected', async () => {
      const nextYear = new Date().getFullYear() + 1;
      const locked = await prisma.payrollRun.create({
        data: {
          organizationId,
          employeeId: otherEmployeeId,
          month: 12,
          year: nextYear,
          status: PayrollRunStatus.LOCKED,
        },
      });
      try {
        const res = await request(app.getHttpServer())
          .post('/statutory-config/pf')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            isEnabled: false,
            effectiveFrom: `${nextYear}-06-01`,
            config: { employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
          })
          .expect(400);
        expect((res.body as { message: string }).message).toMatch(
          new RegExp(`12/${nextYear} is already locked or paid`),
        );
      } finally {
        await prisma.payrollRun.delete({ where: { id: locked.id } });
      }
    });

    // P7 — a revision effective mid-month used to pay the whole month at the new rate.
    describe('mid-month salary revision', () => {
      it('pays each part of the month at the rate in force for it', async () => {
        const revEmpId = await createEmployee(
          'Revision Employee',
          'pay-e2e-revision@example.test',
          [
            {
              componentCode: 'BASIC',
              fixedAmount: 30000,
              effectiveFrom: '2026-01-01',
            },
            {
              componentCode: 'BASIC',
              fixedAmount: 60000,
              effectiveFrom: '2026-06-16',
            },
          ],
        );
        await markFullMonthPresent(prisma, organizationId, revEmpId, MONTH);
        const run = await calculateOne(revEmpId, MONTH);
        // June has 30 days: 15 at 30,000 + 15 at 60,000.
        expect(amountOf(run.earnings, 'BASIC')).toBe(45000);
        expect(amountOf(run.earnings, 'HRA')).toBe(18000); // 40% of each part
        expect(run.grossSalary).toBe(63000);
      });

      it('a mid-month joiner is not prorated twice (days before joining already carry no attendance)', async () => {
        const joinerId = await createEmployee(
          'Joiner Employee',
          'pay-e2e-joiner@example.test',
          [
            {
              componentCode: 'BASIC',
              fixedAmount: 30000,
              effectiveFrom: '2026-06-16',
            },
          ],
        );
        await prisma.attendance.createMany({
          data: Array.from({ length: 15 }, (_, i) => ({
            organizationId,
            employeeId: joinerId,
            date: `2026-06-${String(16 + i).padStart(2, '0')}`,
            status: AttendanceStatus.PRESENT,
            source: 'FACE_API' as const,
          })),
        });
        const run = await calculateOne(joinerId, MONTH);
        expect(amountOf(run.earnings, 'BASIC')).toBe(15000); // 30,000 × 15/30, same as before the fix
      });
    });

    // P8 — YTD taxable income used to sum each earlier month's grossSalary, including non-taxable pay.
    it('YTD taxable income counts only taxable earnings of earlier months', async () => {
      await request(app.getHttpServer())
        .post('/salary-components')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Meal Card Test',
          code: 'MEAL_CARD_TEST',
          type: 'EARNING',
          isTaxable: false,
        })
        .expect(201);
      const ytdEmpId = await createEmployee(
        'YTD Employee',
        'pay-e2e-ytd@example.test',
        [
          {
            componentCode: 'BASIC',
            fixedAmount: 100000,
            effectiveFrom: '2026-01-01',
          },
          {
            componentCode: 'MEAL_CARD_TEST',
            fixedAmount: 50000,
            effectiveFrom: '2026-01-01',
          },
        ],
      );
      for (const m of [4, 6]) {
        await markFullMonthPresent(prisma, organizationId, ytdEmpId, m);
      }
      const april = await calculateOne(ytdEmpId, 4);
      expect(april.grossSalary).toBe(190000); // 100,000 + 40,000 HRA + 50,000 meal card
      const stored = await prisma.payrollRun.findFirstOrThrow({
        where: { id: april.id },
      });
      expect(stored.taxableGross).toBe(140000);

      const june = await calculateOne(ytdEmpId, 6);
      // YTD (April, taxable only) + June + 9 more months of the 140,000 taxable structure.
      expect(june.taxDetails?.grossAnnualIncome).toBe(140000 * 11);
    });

    // P9 + P10 — overtime is paid at its rateMultiplier, and a one-off OT month is not projected ×12 for TDS.
    it('holiday overtime is paid at 2x and counted once in the annual tax projection', async () => {
      const otEmpId = await createEmployee(
        'Overtime Tax Employee',
        'pay-e2e-ot@example.test',
        [
          {
            componentCode: 'BASIC',
            fixedAmount: 100000,
            effectiveFrom: '2026-01-01',
          },
        ],
      );
      await markFullMonthPresent(prisma, organizationId, otEmpId, 4);
      await prisma.overtimeRecord.create({
        data: {
          organizationId,
          employeeId: otEmpId,
          date: '2026-04-14',
          hours: 40,
          type: 'HOLIDAY',
          rateMultiplier: 2,
          status: 'APPROVED',
        },
      });
      const april = await calculateOne(otEmpId, 4);
      // ROUND(OT_WEIGHTED_HOURS * BASIC / 200) = 80 weighted hours × 500 — it was 40 × 500 before.
      expect(amountOf(april.earnings, 'OVERTIME_PAY')).toBe(40000);
      // This month's 180,000 once + 11 months of the regular 140,000 (not 180,000 × 12).
      expect(april.taxDetails?.grossAnnualIncome).toBe(180000 + 140000 * 11);
    });

    // P13 — PF used the unrounded prorated Basic, so it could be ₹1 off 12% of the Basic on the payslip.
    it('PF is computed from the Basic as printed on the payslip', async () => {
      const pfEmpId = await createEmployee(
        'PF Rounding Employee',
        'pay-e2e-pfround@example.test',
        [
          {
            componentCode: 'BASIC',
            fixedAmount: 12008,
            effectiveFrom: '2026-01-01',
          },
        ],
      );
      // 30 of July's 31 days present: Basic = 12,008 × 30/31 = 11,620.65 -> printed 11,621.
      await markFullMonthPresent(prisma, organizationId, pfEmpId, 7);
      await request(app.getHttpServer())
        .put('/payroll-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ pfEnabled: true })
        .expect(200);
      try {
        const july = await calculateOne(pfEmpId, 7);
        expect(amountOf(july.earnings, 'BASIC')).toBe(11621);
        // 12% of 11,621 = 1,394.52 -> 1,395 (12% of the raw 11,620.65 rounded to 1,394).
        expect(amountOf(july.deductions, 'PF')).toBe(1395);
        expect(amountOf(july.employerContributions, 'PF_EMPLOYER')).toBe(1395);
      } finally {
        await request(app.getHttpServer())
          .put('/payroll-settings')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ pfEnabled: false })
          .expect(200);
      }
    });
  });
});
