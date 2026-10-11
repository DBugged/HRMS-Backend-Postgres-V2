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
import { LeavesService } from '../src/leaves/leaves.service';

interface AuthBody {
  accessToken: string;
}
interface LeaveBody {
  id: string;
  status: string;
  totalDays: number;
  level1ApprovedById: string | null;
  employeeId: string;
  leaveTypeId: string;
}
interface LeaveTypeBody {
  id: string;
  code: string;
}

const PASSWORD = 'TestPass123!';

// Whole months of the current calendar year that are over (period end <= today) - what a monthly END accrual has paid
// for an employee who joined on 1 January.
function completedMonths(): number {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let n = 0;
  for (let m = 0; m < 12; m++) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), m + 1, 0))
      .toISOString()
      .slice(0, 10);
    if (end <= today) n++;
  }
  return n;
}

describe('Leave accrual (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let managerId: string;
  let employeeId: string;
  let outsideDeptEmployeeId: string;
  const year = new Date().getUTCFullYear();

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const createType = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/leave-types')
      .set(auth(adminToken))
      .send({
        allocationType: 'FIXED_ANNUAL',
        prorateOnJoining: false,
        ...body,
      });
  const balanceOf = async (code: string) => {
    const res = await request(app.getHttpServer())
      .get(`/leaves/balance?employeeId=${employeeId}`)
      .set(auth(adminToken));
    const rows = (
      res.body as {
        balances: {
          credited: number;
          leaveType: { code: string };
          accrual?: { annualEntitlement: number; frequency: string };
        }[];
      }
    ).balances;
    return rows.find((b) => b.leaveType.code === code);
  };

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
      organizationName: 'Leave Accrual Org',
      name: 'Founder',
      email: 'lva-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'lva-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'lva-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lva-hr@example.test',
        password: (hrCreate.body as { generatedPassword: string })
          .generatedPassword,
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
        email: 'lva-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    managerId = (managerCreate.body as { employee: { id: string } }).employee
      .id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lva-manager@example.test',
        password: (managerCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'lva-emp@example.test',
        departmentId,
        reportingManagerId: managerId,
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lva-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'lva-outside@example.test',
      });
    outsideDeptEmployeeId = (outsideCreate.body as { employee: { id: string } })
      .employee.id;

    await prisma.user.updateMany({
      where: { id: { in: [employeeId, outsideDeptEmployeeId] } },
      data: { joiningDate: new Date(Date.UTC(year, 0, 1)) },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects a periodic type with no frequency, and one that is not quota based', async () => {
    const noFreq = await createType({
      name: 'Bad A',
      code: 'BADA',
      annualQuota: 12,
      accrualMode: 'PERIODIC',
    });
    expect(noFreq.status).toBe(400);
    const noQuota = await createType({
      name: 'Bad B',
      code: 'BADB',
      allocationType: 'NONE',
      accrualMode: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
    });
    expect(noQuota.status).toBe(400);
  });

  it('a periodic type credits what has been earned so far, and says what is yet to come', async () => {
    const res = await createType({
      name: 'Accrued Leave',
      code: 'ACR',
      annualQuota: 24,
      accrualMode: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrueAt: 'END',
    });
    expect(res.status).toBe(201);
    const b = await balanceOf('ACR');
    expect(b?.credited).toBeCloseTo(completedMonths() * 2, 2);
    expect(b?.accrual?.annualEntitlement).toBe(24);
    expect(b?.accrual?.frequency).toBe('MONTHLY');
  });

  it('running accrual again credits nothing more (idempotent)', async () => {
    const before = await prisma.leaveAccrualEntry.count();
    const run = await request(app.getHttpServer())
      .post('/leave-types/run-accrual')
      .set(auth(hrToken))
      .send({});
    expect(run.status).toBe(201);
    expect((run.body as { credits: number }).credits).toBe(0);
    expect(await prisma.leaveAccrualEntry.count()).toBe(before);
  });

  it('only HR/Admin can run it; a dry run changes nothing', async () => {
    const denied = await request(app.getHttpServer())
      .post('/leave-types/run-accrual')
      .set(auth(employeeToken))
      .send({});
    expect(denied.status).toBe(403);
    const dry = await request(app.getHttpServer())
      .post('/leave-types/run-accrual')
      .set(auth(adminToken))
      .send({ dryRun: true });
    expect(dry.status).toBe(201);
    expect((dry.body as { dryRun: boolean }).dryRun).toBe(true);
  });

  it('a dry run lists due credits and leaves balances alone; the real run then credits them', async () => {
    // Remove one ledger row + its days to simulate a missed night.
    const entry = await prisma.leaveAccrualEntry.findFirst({
      where: { employeeId },
      orderBy: { periodStart: 'desc' },
    });
    if (!entry) return; // January: nothing accrued yet
    await prisma.leaveAccrualEntry.delete({ where: { id: entry.id } });
    await prisma.leaveBalance.updateMany({
      where: { employeeId, leaveTypeId: entry.leaveTypeId, year: entry.year },
      data: {
        credited: { decrement: entry.days },
        closing: { decrement: entry.days },
      },
    });
    const dry = await request(app.getHttpServer())
      .post('/leave-types/run-accrual')
      .set(auth(adminToken))
      .send({ dryRun: true });
    const dryBody = dry.body as {
      credits: number;
      items: { employeeId: string; days: number }[];
    };
    expect(dryBody.credits).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.leaveAccrualEntry.count({ where: { id: entry.id } }),
    ).toBe(0);
    const real = await request(app.getHttpServer())
      .post('/leave-types/run-accrual')
      .set(auth(adminToken))
      .send({});
    expect((real.body as { credits: number }).credits).toBe(dryBody.credits);
    const b = await balanceOf('ACR');
    expect(b?.credited).toBeCloseTo(completedMonths() * 2, 2);
  });

  it('a balance ceiling stops the credits at the cap', async () => {
    const res = await createType({
      name: 'Capped',
      code: 'CAP',
      annualQuota: 24,
      accrualMode: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrueAt: 'START',
      maxBalance: 5,
    });
    expect(res.status).toBe(201);
    const b = await balanceOf('CAP');
    expect(b?.credited).toBeLessThanOrEqual(5);
    expect(b?.credited).toBeCloseTo(
      Math.min(5, (new Date().getUTCMonth() + 1) * 2),
      2,
    );
  });

  it("switching an upfront type to periodic mid-year keeps this year's credit", async () => {
    const res = await createType({
      name: 'Switcher',
      code: 'SWT',
      annualQuota: 12,
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    expect((await balanceOf('SWT'))?.credited).toBe(12);
    const sw = await request(app.getHttpServer())
      .put(`/leave-types/${id}`)
      .set(auth(adminToken))
      .send({ accrualMode: 'PERIODIC', accrualFrequency: 'QUARTERLY' });
    expect(sw.status).toBe(200);
    expect((sw.body as { periodicFromYear: number }).periodicFromYear).toBe(
      year + 1,
    );
    expect((await balanceOf('SWT'))?.credited).toBe(12);
    expect(
      await prisma.leaveAccrualEntry.count({ where: { leaveTypeId: id } }),
    ).toBe(0);
  });

  it("accrual history: self and HR can read it; an employee cannot read another's", async () => {
    const own = await request(app.getHttpServer())
      .get('/leaves/accrual-history')
      .set(auth(employeeToken));
    expect(own.status).toBe(200);
    const hr = await request(app.getHttpServer())
      .get(`/leaves/accrual-history?employeeId=${employeeId}&year=${year}`)
      .set(auth(hrToken));
    expect(hr.status).toBe(200);
    const rows = (hr.body as { data: { year: number; days: number }[] }).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.year === year)).toBe(true);
    const other = await request(app.getHttpServer())
      .get(`/leaves/accrual-history?employeeId=${outsideDeptEmployeeId}`)
      .set(auth(employeeToken));
    expect(other.status).toBe(403);
    const mgrOutside = await request(app.getHttpServer())
      .get(`/leaves/accrual-history?employeeId=${outsideDeptEmployeeId}`)
      .set(auth(managerToken));
    expect([200, 403]).toContain(mgrOutside.status);
  });
});
