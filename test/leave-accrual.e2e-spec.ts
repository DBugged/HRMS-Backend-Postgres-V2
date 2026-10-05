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
import { LeaveBalanceService } from '../src/leave-balances/leave-balance.service';

const PASSWORD = 'TestPass123!';
const TAG = String(Date.now());

// The accrual engine end to end: a Fixed Annual, Quarterly leave type (quota 6 => 1.5 a quarter) for an employee who
// joined in 2020, so the current year is a full year for them.
describe('Leave accrual engine (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let balances: LeaveBalanceService;
  let adminToken: string;
  let organizationId: string;
  let adminId: string;
  let leaveTypeId: string;
  let employeeToken: string;
  let otherOrgToken: string;
  const year = new Date().getFullYear();
  const now = new Date();
  const currentPeriod = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  const currentQuarter = Math.floor(now.getUTCMonth() / 3) + 1;

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
    balances = app.get(LeaveBalanceService);

    const email = `accrual-${TAG}@example.test`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `Accrual E2E ${TAG}`,
        name: 'Founder',
        email,
        password: PASSWORD,
      });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    adminToken = (login.body as { accessToken: string }).accessToken;
    const admin = await prisma.user.findFirstOrThrow({ where: { email } });
    adminId = admin.id;
    organizationId = admin.organizationId;
    await prisma.user.updateMany({
      where: { id: adminId },
      data: { joiningDate: new Date('2020-02-07T00:00:00.000Z') },
    });

    const created = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Accrual EL',
        code: 'AEL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 6,
        accrualFrequency: 'QUARTERLY',
        carryForward: { allowed: false, maxDays: 0, expiryMonths: null },
      })
      .expect(201);
    leaveTypeId = (created.body as { id: string }).id;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: `accrual-emp-${TAG}@example.test`,
      });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: `accrual-emp-${TAG}@example.test`,
        password: (emp.body as { generatedPassword: string }).generatedPassword,
      });
    employeeToken = (empLogin.body as { accessToken: string }).accessToken;

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: `Accrual E2E Other ${TAG}`,
        name: 'Other Founder',
        email: `accrual-other-${TAG}@example.test`,
        password: PASSWORD,
      });
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `accrual-other-${TAG}@example.test`, password: PASSWORD });
    otherOrgToken = (otherLogin.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const row = () =>
    prisma.leaveBalance.findFirstOrThrow({
      where: { organizationId, employeeId: adminId, leaveTypeId, year },
    });
  // A balance row exactly as an earlier version of the engine could have left it.
  const resetRow = async (
    credited: number,
    lastAccrualPeriod: string | null,
  ) => {
    await prisma.leaveBalance.deleteMany({
      where: { organizationId, employeeId: adminId, leaveTypeId, year },
    });
    await prisma.leaveBalance.create({
      data: {
        organizationId,
        employeeId: adminId,
        leaveTypeId,
        year,
        opening: 0,
        credited,
        closing: credited,
        lastAccrualPeriod,
      },
    });
  };

  it('a new row for someone who joined years ago gets every quarter due so far', async () => {
    await prisma.leaveBalance.deleteMany({
      where: { organizationId, leaveTypeId },
    });
    await balances.creditAccrual(leaveTypeId, organizationId);
    const b = await row();
    expect(b.credited).toBe(1.5 * currentQuarter);
    expect(b.lastAccrualPeriod).toBe(currentPeriod);
  });

  it('catches up the quarters missed since the last credited one', async () => {
    if (currentQuarter === 1) return; // nothing to catch up in Q1
    await resetRow(1.5, `${year}-Q1`);
    await balances.creditAccrual(leaveTypeId, organizationId);
    expect((await row()).credited).toBe(1.5 * currentQuarter);
  });

  it('is idempotent: a second run credits nothing', async () => {
    const before = (await row()).credited;
    await balances.creditAccrual(leaveTypeId, organizationId);
    await balances.creditAccrual(leaveTypeId, organizationId);
    expect((await row()).credited).toBe(before);
  });

  it('credits each quarter exactly once when 8 runs start at the same moment', async () => {
    if (currentQuarter === 1) return;
    const outcomes: number[] = [];
    for (let i = 0; i < 5; i++) {
      await resetRow(1.5, `${year}-Q1`);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          balances.creditAccrual(leaveTypeId, organizationId),
        ),
      );
      outcomes.push((await row()).credited);
    }
    expect(outcomes).toEqual(Array(5).fill(1.5 * currentQuarter));
  });

  describe('rows stamped for this period but holding less than is due', () => {
    const expected = 1.5 * currentQuarter;
    const check = (token = adminToken) =>
      request(app.getHttpServer())
        .get(`/leave-types/${leaveTypeId}/accrual-check`)
        .set('Authorization', `Bearer ${token}`);
    const repair = (token = adminToken) =>
      request(app.getHttpServer())
        .post(`/leave-types/${leaveTypeId}/accrual-repair`)
        .set('Authorization', `Bearer ${token}`);
    type CheckBody = {
      summary: {
        short: number;
        pendingRun: number;
        over: number;
        daysShort: number;
      };
      rows: {
        status: string;
        current: number;
        expected: number;
        difference: number;
      }[];
    };

    it('Run Accrual no longer calls such a row simply "up to date"', async () => {
      if (currentQuarter === 1) return;
      await resetRow(1.5, currentPeriod);
      const res = await request(app.getHttpServer())
        .post(`/leave-types/${leaveTypeId}/run-accrual`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);
      const body = res.body as { behind: number; message: string };
      expect(body.behind).toBe(1);
      expect(body.message).toMatch(/Check balances/);
      expect((await row()).credited).toBe(1.5); // Run Accrual itself never changes it
    });

    it('the check is read-only and reports current, expected and the difference', async () => {
      if (currentQuarter === 1) return;
      await resetRow(1.5, currentPeriod);
      const body = (await check().expect(200)).body as CheckBody;
      expect(body.summary.short).toBe(1);
      expect(body.rows[0]).toMatchObject({
        status: 'SHORT',
        current: 1.5,
        expected,
        difference: expected - 1.5,
      });
      expect((await row()).credited).toBe(1.5);
    });

    it('repair adds only the missing days, leaves an audit trail, and a second repair adds nothing', async () => {
      if (currentQuarter === 1) return;
      await resetRow(1.5, currentPeriod);
      const res = await repair().expect(201);
      expect(res.body).toMatchObject({
        repaired: 1,
        totalDaysAdded: expected - 1.5,
      });
      const after = await row();
      expect(after.credited).toBe(expected);
      expect(after.closing).toBe(expected);
      expect(after.lastAccrualPeriod).toBe(currentPeriod);

      const audit = await prisma.auditLog.findFirst({
        where: { organizationId, action: 'LEAVE_ACCRUAL_REPAIRED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit!.details)).toContain('"added"');

      expect((await repair().expect(201)).body).toMatchObject({ repaired: 0 });
      expect((await row()).credited).toBe(expected);
    });

    it('never reduces an over-credited row and leaves a stale-stamped row to Run Accrual', async () => {
      if (currentQuarter === 1) return;
      await resetRow(9, currentPeriod); // e.g. a whole quota granted upfront earlier
      expect(((await check().expect(200)).body as CheckBody).summary.over).toBe(
        1,
      );
      await repair().expect(201);
      expect((await row()).credited).toBe(9);

      await resetRow(1.5, `${year}-Q1`);
      const stale = (await check().expect(200)).body as CheckBody;
      expect(stale.summary.pendingRun).toBe(1);
      await repair().expect(201);
      expect((await row()).credited).toBe(1.5); // repair did not touch it, so Run Accrual cannot double up
    });

    it("is Admin/HR only and cannot reach another organization's leave type", async () => {
      await check(employeeToken).expect(403);
      await repair(employeeToken).expect(403);
      await check(otherOrgToken).expect(404);
      await repair(otherOrgToken).expect(404);
    });
  });
});
