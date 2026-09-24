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
import { calculateGratuity } from '../src/settlements/gratuity-math';
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
// HRA is auto-seeded (see SalaryComponentsService.seedDefaults) as 40% of
// BASIC and auto-applies to every employee once BASIC is opted into, so it
// now contributes to gross pay alongside BASIC.
const HRA_MONTHLY = BASIC_MONTHLY * 0.4;
const DAYS_IN_MONTH = 30;
// An APPROVED-but-unpaid reimbursement is settled with the final payout.
const REIMBURSEMENT_AMOUNT = 700;

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

    // BASIC (FIXED, opt-in) at a known monthly value — BASIC is
    // auto-seeded on every new org (see LeaveTypesService/
    // SalaryComponentsService.seedDefaults), only the per-employee
    // override is needed here.
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
        name: 'Test Annual Leave',
        code: 'TAL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
        encashment: { allowed: true },
      })
      .expect(201);

    // The auto-seeded 'EL' default (see LeaveTypesService.seedDefaults) is
    // also encashment-enabled — disable it so this test's encashment total
    // stays isolated to the single TAL type it controls.
    const seededTypesForEncash = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`);
    const seededElId = (
      seededTypesForEncash.body as { data: { id: string; code: string }[] }
    ).data.find((t) => t.code === 'EL')!.id;
    await request(app.getHttpServer())
      .put(`/leave-types/${seededElId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        encashment: {
          allowed: false,
          maxDaysPerYear: 0,
          minBalanceToRetain: 0,
        },
      })
      .expect(200);

    // A non-encashable leave type — proves it's excluded from the payout.
    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Sick Leave',
        code: 'SLT',
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
    // Completed years, not the fraction served, and never above the 20-lakh
    // statutory ceiling — the same rules the service applies.
    expectedGratuity = calculateGratuity(BASIC_MONTHLY, yearsOfService);
    const expectedLeaveEncashment = Math.round(24 * (BASIC_MONTHLY / 30));
    expectedNet = Math.round(
      BASIC_MONTHLY +
        HRA_MONTHLY +
        expectedLeaveEncashment +
        2000 +
        expectedGratuity +
        REIMBURSEMENT_AMOUNT -
        500 -
        5000 -
        1000,
    );

    await prisma.reimbursement.create({
      data: {
        organizationId,
        employeeId,
        amount: REIMBURSEMENT_AMOUNT,
        claimDate: '2026-06-05',
        status: 'APPROVED',
      },
    });
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
    expect(
      (res.body as SettlementBody & { reimbursementAmount: number })
        .reimbursementAmount,
    ).toBe(REIMBURSEMENT_AMOUNT);
    expect(body.status).toBe('DRAFT');
    expect(body.pendingSalaryAmount).toBe(BASIC_MONTHLY + HRA_MONTHLY); // full month present
    expect(body.leaveEncashmentAmount).toBe(expectedLeaveEncashment);
    expect(body.loanBalanceRecovered).toBe(5000);
    expect(body.gratuityAmount).toBe(expectedGratuity);
    expect(body.gratuityAmount).toBeGreaterThan(0);
    // Independent of the helper: the payout must be a whole number of
    // completed years' worth. It used to be the raw fraction served
    // (5.6 years here), which this catches.
    const yearsPaidFor = body.gratuityAmount / (BASIC_MONTHLY * (15 / 26));
    expect(yearsPaidFor).toBeCloseTo(Math.round(yearsPaidFor), 4);
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

  it('processes the settlement: creates an APPROVED final-settlement PayrollRun, closes the loan, pays approved reimbursements, leaves deactivation to offboarding', async () => {
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
    // process() no longer deactivates — OffboardingService.complete() owns that (exit gates, manager
    // reassignment, final employmentStatus).
    expect(employee.isActive).toBe(true);

    const reimbursement = await prisma.reimbursement.findFirstOrThrow({
      where: { employeeId },
    });
    expect(reimbursement.status).toBe('PAID');
    expect(reimbursement.payrollRunId).toBe(body.payrollRun.id);
    const earnings = (
      await prisma.payrollRun.findFirstOrThrow({
        where: { id: body.payrollRun.id },
      })
    ).earnings as { code: string; amount: number }[];
    expect(earnings.find((e) => e.code === 'REIMBURSEMENT')?.amount).toBe(
      REIMBURSEMENT_AMOUNT,
    );
    // P4: the pending salary is carried as the month's real lines, not one net PENDING_SALARY figure.
    expect(earnings.find((e) => e.code === 'PENDING_SALARY')).toBeUndefined();
    expect(earnings.find((e) => e.code === 'BASIC')?.amount).toBe(
      BASIC_MONTHLY,
    );
    expect(earnings.find((e) => e.code === 'HRA')?.amount).toBe(HRA_MONTHLY);
    const run = await prisma.payrollRun.findFirstOrThrow({
      where: { id: body.payrollRun.id },
    });
    const deductions = run.deductions as { code: string; amount: number }[];
    // The month's EMI is not deducted twice — the loan is recovered in full as LOAN_RECOVERY.
    expect(deductions.find((d) => d.code === 'LOAN_EMI')).toBeUndefined();
    expect(deductions.find((d) => d.code === 'LOAN_RECOVERY')?.amount).toBe(
      5000,
    );
    expect(run.grossSalary - run.totalDeductions).toBeCloseTo(run.netPay, 0);
  });

  // Changed with the P3 fix: a CALCULATED (not yet locked) regular run used to count as "already paid", so the
  // settlement dropped the salary while the run could still be locked later (charging that month's EMI on top of
  // the settlement's full loan recovery). An open run now blocks the settlement; only a LOCKED/PAID run covers
  // the month.
  it('does not pay the LWD month salary again when a regular payroll run already exists for it', async () => {
    const run = await prisma.payrollRun.create({
      data: {
        organizationId,
        employeeId,
        month: 7,
        year: YEAR,
        status: 'CALCULATED',
        netPay: 12345,
      },
    });
    const blocked = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: `${YEAR}-07-15` })
      .expect(400);
    expect((blocked.body as { message: string }).message).toMatch(
      /7\/2026 payroll run for this employee is calculated but not locked/,
    );

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: 'LOCKED' },
    });
    const res = await request(app.getHttpServer())
      .post('/settlements/calculate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeId, lastWorkingDay: `${YEAR}-07-15` })
      .expect(201);
    const body = res.body as SettlementBody & { pendingSalaryNote: string };
    expect(body.pendingSalaryAmount).toBe(0);
    expect(body.pendingSalaryNote).toContain('already covered');
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

  // R1: calculate/process/pay were only on the employee timeline, never in the audit log.
  it('writes audit log entries for calculate, process and pay', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { organizationId, targetId: settlementId, module: 'PAYROLL' },
    });
    const actions = new Set(logs.map((l) => l.action));
    expect(actions.has('SETTLEMENT_CALCULATED')).toBe(true);
    expect(actions.has('SETTLEMENT_PROCESSED')).toBe(true);
    expect(actions.has('SETTLEMENT_PAID')).toBe(true);
    const processed = logs.find((l) => l.action === 'SETTLEMENT_PROCESSED');
    expect(
      (processed?.details as { employeeId?: string } | null)?.employeeId,
    ).toBe(employeeId);
  });

  describe('Loan recovery, statutory detail and gratuity (regressions)', () => {
    async function newEmployee(
      name: string,
      email: string,
      joiningDate: string,
      basic: number,
    ): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, email, joiningDate });
      const id = (res.body as EmployeeCreateBody).employee.id;
      await request(app.getHttpServer())
        .post(`/employee-salary/${id}/structure`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: basic,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);
      return id;
    }

    async function markPresent(empId: string, month: number, days: number) {
      await prisma.attendance.createMany({
        data: Array.from({ length: days }, (_, i) => ({
          organizationId,
          employeeId: empId,
          date: `${YEAR}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
          status: AttendanceStatus.PRESENT,
          source: 'FACE_API' as const,
        })),
      });
    }

    // P3: the settlement recovered the loan's full balance while the LWD month's regular run (counted as
    // "already paid" even though only CALCULATED) went on to deduct that month's EMI again once locked; and
    // process() never re-read the balance captured at calculate time.
    it('never recovers the same loan money twice', async () => {
      const loanEmpId = await newEmployee(
        'FnF Loan Employee',
        'settle-e2e-loan@example.test',
        '2024-01-01',
        BASIC_MONTHLY,
      );
      await markPresent(loanEmpId, 8, 31);
      const loanRes = await request(app.getHttpServer())
        .post('/loans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          employeeId: loanEmpId,
          principal: 3000,
          tenureMonths: 3,
          startMonth: 8,
          startYear: YEAR,
        })
        .expect(201);
      const loanId = (loanRes.body as { id: string }).id;
      const lwd = `${YEAR}-08-20`;

      // The August run is calculated (with its 1,000 EMI) but not locked -> the settlement is refused.
      const calc = await request(app.getHttpServer())
        .post('/payroll/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ month: 8, year: YEAR, employeeId: loanEmpId })
        .expect(201);
      const augRun = (
        calc.body as {
          payrolls: {
            id: string;
            deductions: { code: string; amount: number }[];
          }[];
        }
      ).payrolls[0];
      expect(augRun.deductions.find((d) => d.code === 'LOAN_EMI')?.amount).toBe(
        1000,
      );
      await request(app.getHttpServer())
        .post('/settlements/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: loanEmpId, lastWorkingDay: lwd })
        .expect(400);

      // Locked: August pays the salary and charges its EMI; the settlement recovers only what's left.
      for (const step of ['verify', 'approve', 'lock']) {
        await request(app.getHttpServer())
          .post(`/payroll/${augRun.id}/${step}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(201);
      }
      const draft = await request(app.getHttpServer())
        .post('/settlements/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: loanEmpId, lastWorkingDay: lwd })
        .expect(201);
      const draftBody = draft.body as SettlementBody;
      expect(draftBody.pendingSalaryAmount).toBe(0);
      expect(draftBody.loanBalanceRecovered).toBe(2000); // not the original 3,000

      // The balance moves again before processing (a manual repayment) -> process refuses the stale figure.
      await prisma.loan.update({
        where: { id: loanId },
        data: { outstandingBalance: 1500 },
      });
      const stale = await request(app.getHttpServer())
        .post(`/settlements/${draftBody.id}/process`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect((stale.body as { message: string }).message).toMatch(
        /loan balance changed/i,
      );
      const stillDraft = await prisma.settlement.findFirstOrThrow({
        where: { id: draftBody.id },
      });
      expect(stillDraft.status).toBe('DRAFT');

      const recalculated = await request(app.getHttpServer())
        .post('/settlements/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeId: loanEmpId, lastWorkingDay: lwd })
        .expect(201);
      expect((recalculated.body as SettlementBody).loanBalanceRecovered).toBe(
        1500,
      );
      const processed = await request(app.getHttpServer())
        .post(`/settlements/${draftBody.id}/process`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      const fnfRun = await prisma.payrollRun.findFirstOrThrow({
        where: { id: (processed.body as ProcessResultBody).payrollRun.id },
      });
      const fnfDeductions = fnfRun.deductions as {
        code: string;
        amount: number;
      }[];
      expect(
        fnfDeductions.find((d) => d.code === 'LOAN_RECOVERY')?.amount,
      ).toBe(1500);
      const loan = await prisma.loan.findFirstOrThrow({
        where: { id: loanId },
      });
      expect(loan.status).toBe('CLOSED');
    });

    // P4 + P5: the final-settlement run carries the LWD month's statutory lines, and gratuity follows the
    // GRATUITY statutory version (it read only the legacy payroll-settings flag, so it was always 0 for an
    // org that enabled gratuity under Statutory Compliance).
    it('carries PF and employer contributions onto the FnF run, and pays gratuity enabled via Statutory Compliance', async () => {
      const BASIC = 20000;
      const JOINED = '2015-01-01';
      const LWD = `${YEAR}-05-20`;
      const fnfEmpId = await newEmployee(
        'FnF Detail Employee',
        'settle-e2e-detail@example.test',
        JOINED,
        BASIC,
      );
      await markPresent(fnfEmpId, 5, 31);

      // Legacy flag OFF; gratuity ON only through an effective GRATUITY statutory version.
      await request(app.getHttpServer())
        .put('/payroll-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ gratuityEnabled: false, pfEnabled: true })
        .expect(200);
      const version = await prisma.statutoryConfigVersion.create({
        data: {
          organizationId,
          module: 'GRATUITY',
          effectiveFrom: `${YEAR}-01-01`,
          effectiveTo: `${YEAR}-06-30`,
          config: { rate: 4.81 },
          isEnabled: true,
        },
      });
      try {
        const res = await request(app.getHttpServer())
          .post('/settlements/calculate')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ employeeId: fnfEmpId, lastWorkingDay: LWD })
          .expect(201);
        const settlement = res.body as SettlementBody;
        const years =
          (new Date(LWD).getTime() - new Date(JOINED).getTime()) /
          (1000 * 60 * 60 * 24 * 365.25);
        expect(settlement.gratuityAmount).toBe(calculateGratuity(BASIC, years));
        expect(settlement.gratuityAmount).toBeGreaterThan(0);
        // Gross 28,000 (Basic + 40% HRA) less PF: 12% of Basic capped at the (legacy default) 15,000 ceiling.
        expect(settlement.pendingSalaryAmount).toBe(28000 - 1800);

        const processed = await request(app.getHttpServer())
          .post(`/settlements/${settlement.id}/process`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(201);
        const run = await prisma.payrollRun.findFirstOrThrow({
          where: { id: (processed.body as ProcessResultBody).payrollRun.id },
        });
        const earnings = run.earnings as { code: string; amount: number }[];
        const deductions = run.deductions as { code: string; amount: number }[];
        const employer = run.employerContributions as {
          code: string;
          amount: number;
        }[];
        expect(
          earnings.find((e) => e.code === 'PENDING_SALARY'),
        ).toBeUndefined();
        expect(earnings.find((e) => e.code === 'BASIC')?.amount).toBe(BASIC);
        expect(earnings.find((e) => e.code === 'GRATUITY')?.amount).toBe(
          settlement.gratuityAmount,
        );
        expect(deductions.find((d) => d.code === 'PF')?.amount).toBe(1800);
        expect(employer.find((e) => e.code === 'PF_EMPLOYER')?.amount).toBe(
          1800,
        );
        // Gratuity accrual (4.81% of 20,000) is on too, via the same GRATUITY version.
        expect(
          employer.find((e) => e.code === 'GRATUITY_ACCRUAL')?.amount,
        ).toBe(962);
        expect(run.totalEmployerContributions).toBe(
          employer.reduce((s, e) => s + e.amount, 0),
        );
        expect(run.netPay).toBe(settlement.netSettlementAmount);
        expect(run.grossSalary - run.totalDeductions).toBeCloseTo(
          run.netPay,
          0,
        );
      } finally {
        await prisma.statutoryConfigVersion.delete({
          where: { id: version.id },
        });
        await request(app.getHttpServer())
          .put('/payroll-settings')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ gratuityEnabled: true, pfEnabled: false })
          .expect(200);
      }
    });
  });
});
