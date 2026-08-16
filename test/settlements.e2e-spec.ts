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
interface SettlementBody {
  id: string;
  status: string;
  employeeId: string;
  pendingSalaryAmount: number;
  leaveEncashmentAmount: number;
  bonusAmount: number;
  recoveriesAmount: number;
  loanBalanceRecovered: number;
  noticePeriodRecovery: number;
  gratuityAmount: number;
  netSettlementAmount: number;
  payrollRunId: string | null;
  employee?: { id: string; name: string; employeeId: string };
}
interface SettlementListBody {
  data: SettlementBody[];
  total: number;
  page: number;
  limit: number;
}
interface ProcessResultBody {
  settlement: SettlementBody;
  payrollRun: {
    id: string;
    status: string;
    isFinalSettlement: boolean;
    netPay: number;
  };
}

const PASSWORD = 'TestPass123!';
const MONTH = 6;
const YEAR = 2026;
const LAST_WORKING_DAY = `${YEAR}-0${MONTH}-15`;
const BASIC_MONTHLY = 30000;
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

describe('Settlements (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let organizationId: string;

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
      organizationName: 'Settlements E2E Org',
      name: 'Founder',
      email: 'settle-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'settle-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'settle-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'settle-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'settle-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    // Joined well over 5 years before lastWorkingDay -> gratuity eligible.
    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Departing Employee',
        email: 'settle-e2e-emp@example.test',
        joiningDate: '2020-01-01',
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'settle-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    // BASIC (FIXED, opt-in) at a known monthly value.
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Basic',
        code: 'BASIC',
        type: 'EARNING',
        calcType: 'FIXED',
        defaultValue: BASIC_MONTHLY,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: BASIC_MONTHLY,
        effectiveFrom: '2026-01-01',
      })
      .expect(201);
    await markFullMonthPresent(prisma, organizationId, employeeId);

    // Encashable leave type — annualQuota 24, no proration -> full 24 days
    // auto-credited by LeaveBalanceService.ensureBalanceRow for the year.
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
        encashment: { allowed: true },
      })
      .expect(201);

    // A non-encashable leave type — proves it's excluded from the payout.
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Sick Leave',
        code: 'SL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 12,
        prorateOnJoining: false,
      })
      .expect(201);

    // Gratuity requires the org toggle to be on.
    await request(app.getHttpServer())
      .put('/payroll-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gratuityEnabled: true })
      .expect(200);

    // An active, interest-free loan -> fully recovered on settlement.
    await request(app.getHttpServer())
      .post('/loans')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        principal: 5000,
        tenureMonths: 5,
        startMonth: 1,
        startYear: YEAR,
      })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "settlements", "payroll_runs", "loans", "leave_balances", "leave_types", "attendances", "employee_salary_components", "salary_components", "payroll_settings", "statutory_config_versions", "tax_slab_configs", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 calculating a settlement', async () => {
    await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ employeeId, lastWorkingDay: LAST_WORKING_DAY })
      .expect(403);
  });

  let settlementId: string;
  let expectedGratuity: number;
  let expectedNet: number;

  it('ADMIN computes a full breakdown as a DRAFT', async () => {
    const yearsOfService =
      (new Date(LAST_WORKING_DAY).getTime() -
        new Date('2020-01-01').getTime()) /
      (1000 * 60 * 60 * 24 * 365.25);
    expectedGratuity = Math.round(BASIC_MONTHLY * (15 / 26) * yearsOfService);
    const expectedLeaveEncashment = Math.round(24 * (BASIC_MONTHLY / 30));
    expectedNet = Math.round(
      BASIC_MONTHLY +
        expectedLeaveEncashment +
        2000 +
        expectedGratuity -
        500 -
        5000 -
        1000,
    );

    const res = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        lastWorkingDay: LAST_WORKING_DAY,
        bonusAmount: 2000,
        recoveriesAmount: 500,
        noticePeriodRecovery: 1000,
      })
      .expect(201);
    const body = res.body as SettlementBody;
    settlementId = body.id;
    expect(body.status).toBe('DRAFT');
    expect(body.pendingSalaryAmount).toBe(BASIC_MONTHLY); // full month present
    expect(body.leaveEncashmentAmount).toBe(expectedLeaveEncashment);
    expect(body.loanBalanceRecovered).toBe(5000);
    expect(body.gratuityAmount).toBe(expectedGratuity);
    expect(body.gratuityAmount).toBeGreaterThan(0);
    expect(body.netSettlementAmount).toBe(expectedNet);
  });

  it('recalculating updates the same DRAFT row rather than creating a new one', async () => {
    const res = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        employeeId,
        lastWorkingDay: LAST_WORKING_DAY,
        bonusAmount: 3000,
      })
      .expect(201);
    const body = res.body as SettlementBody;
    expect(body.id).toBe(settlementId);
    expect(body.bonusAmount).toBe(3000);
    expect(body.recoveriesAmount).toBe(0); // not passed this time -> reset

    // Restore the original draft used by later assertions.
    const restore = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId,
        lastWorkingDay: LAST_WORKING_DAY,
        bonusAmount: 2000,
        recoveriesAmount: 500,
        noticePeriodRecovery: 1000,
      })
      .expect(201);
    expect((restore.body as SettlementBody).id).toBe(settlementId);
  });

  it('EMPLOYEE only sees their own settlement in the list', async () => {
    const res = await request(app.getHttpServer())
      .get('/settlements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const rows = (res.body as SettlementListBody).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.employeeId === employeeId)).toBe(true);
  });

  it('list responses include the employee relation, not just the ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/settlements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const [row] = (res.body as SettlementListBody).data;
    expect(row.employee?.id).toBe(employeeId);
  });

  it('404s processing a non-existent settlement', async () => {
    await request(app.getHttpServer())
      .post('/settlements/00000000-0000-4000-8000-000000000000/process')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('EMPLOYEE gets 403 processing a settlement', async () => {
    await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/process`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('processes the settlement: creates an APPROVED final-settlement PayrollRun, closes the loan, deactivates the employee', async () => {
    const res = await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/process`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(201);
    const body = res.body as ProcessResultBody;
    expect(body.settlement.status).toBe('PROCESSED');
    expect(body.settlement.payrollRunId).toBe(body.payrollRun.id);
    expect(body.payrollRun.status).toBe('APPROVED');
    expect(body.payrollRun.isFinalSettlement).toBe(true);
    expect(body.payrollRun.netPay).toBe(expectedNet);

    const loan = await prisma.loan.findFirstOrThrow({ where: { employeeId } });
    expect(loan.status).toBe('CLOSED');
    expect(loan.outstandingBalance).toBe(0);

    const employee = await prisma.user.findFirstOrThrow({
      where: { id: employeeId },
    });
    expect(employee.isActive).toBe(false);
  });

  it('processing an already-processed settlement is rejected', async () => {
    await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/process`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('marking paid before processing is rejected for a different (still-draft) settlement', async () => {
    const draft = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: `${YEAR}-07-01` })
      .expect(201);
    const draftId = (draft.body as SettlementBody).id;

    await request(app.getHttpServer())
      .post(`/settlements/${draftId}/pay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('marks the processed settlement paid, and stamps the linked PayrollRun PAID', async () => {
    const res = await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/pay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((res.body as SettlementBody).status).toBe('PAID');

    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { id: settlementId },
    });
    const payrollRun = await prisma.payrollRun.findFirstOrThrow({
      where: { id: settlement.payrollRunId! },
    });
    expect(payrollRun.status).toBe('PAID');
    expect(payrollRun.paidById).not.toBeNull();
    expect(payrollRun.paidAt).not.toBeNull();
  });

  it('marking an already-paid settlement paid again is rejected', async () => {
    await request(app.getHttpServer())
      .post(`/settlements/${settlementId}/pay`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
