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
});
