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

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}

const PASSWORD = 'TestPass123!';
const YEAR = 2026;

// Attendance, leave and payroll must stay consistent: a change to the inputs of a calculated payroll marks it outdated
// (it cannot be verified / approved / locked until recalculated), a cancelled leave puts the day back as it was, and
// the HR sweeps never rewrite locked months or regularized / imported days.
describe('Payroll input integrity (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let employeeId: string;
  let hrId: string;
  let organizationId: string;
  let lwpId: string;

  const post = (url: string, token = adminToken) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${token}`);
  const patch = (url: string, token = adminToken) =>
    request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${token}`);
  const runOf = (month: number, id = employeeId) =>
    prisma.payrollRun.findFirstOrThrow({
      where: {
        employeeId: id,
        month,
        year: YEAR,
        isFinalSettlement: false,
        runSequence: 0,
      },
    });
  const calculate = (month: number, id = employeeId) =>
    post('/payroll/calculate').send({ month, year: YEAR, employeeId: id });
  const makeLeave = (start: string, end: string) =>
    prisma.leave.create({
      data: {
        organizationId,
        employeeId,
        leaveTypeId: lwpId,
        startDate: start,
        endDate: end,
        totalDays: 1,
        status: 'PENDING',
        isHalfDay: false,
        remarks: 'integrity test',
      },
    });
  const approve = (leaveId: string) =>
    patch(`/leaves/${leaveId}/review`).send({ decision: 'APPROVED' });

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
      organizationName: 'Integrity Org',
      name: 'Founder',
      email: 'pi-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'pi-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'pi-admin@example.test' },
      })
    ).organizationId;

    const mk = async (name: string, email: string, role?: string) => {
      const created = await post('/employees').send({
        name,
        email,
        joiningDate: '2025-01-01',
        ...(role ? { role } : {}),
      });
      const body = created.body as EmployeeCreateBody;
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: body.generatedPassword });
      return {
        id: body.employee.id,
        token: (login.body as AuthBody).accessToken,
      };
    };
    const hr = await mk('Hr Person', 'pi-hr@example.test', 'HR');
    hrId = hr.id;
    hrToken = hr.token;
    employeeId = (await mk('Plain Employee', 'pi-emp@example.test')).id;
    for (const id of [employeeId, hrId]) {
      await post(`/employee-salary/${id}/structure`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: 30000,
          effectiveFrom: '2026-01-01',
        })
        .expect(201);
    }
    await prisma.user.updateMany({
      where: { organizationId },
      data: { joiningDate: new Date('2020-01-01T00:00:00.000Z') },
    });
    for (const fy of ['2025-26', '2026-27']) {
      const slab = await prisma.taxSlabConfig.findFirst({
        where: { organizationId, financialYear: fy, regime: 'NEW' },
      });
      if (!slab) {
        await post('/tax-slabs').send({ financialYear: fy, regime: 'NEW' });
      }
    }
    for (const [month, days] of [
      [3, 31],
      [5, 31],
      [6, 30],
      [7, 31],
      [8, 31],
    ]) {
      await prisma.attendance.createMany({
        data: Array.from({ length: days }, (_, i) => ({
          organizationId,
          employeeId,
          date: `${YEAR}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
          status: 'PRESENT' as const,
          source: 'FACE_API' as const,
        })),
      });
    }
    lwpId = (
      await prisma.leaveType.findFirstOrThrow({
        where: { organizationId, code: 'LWP' },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('F1 - a payroll built on old records cannot be signed off', () => {
    it('a leave approved after calculate marks the run outdated and blocks verify until it is recalculated', async () => {
      await calculate(5).expect(201);
      const before = await runOf(5);
      expect(before.inputsChangedAt).toBeNull();

      const leave = await makeLeave('2026-05-12', '2026-05-12');
      await approve(leave.id).expect(200);

      const stale = await runOf(5);
      expect(stale.inputsChangedAt).not.toBeNull();
      expect(stale.grossSalary).toBe(before.grossSalary); // not yet recalculated

      const blocked = await post(`/payroll/${stale.id}/verify`).expect(400);
      expect(JSON.stringify(blocked.body)).toContain('out of date');
      expect((await runOf(5)).status).toBe('CALCULATED');

      await calculate(5).expect(201);
      const fresh = await runOf(5);
      expect(fresh.inputsChangedAt).toBeNull();
      expect(fresh.grossSalary).toBeLessThan(before.grossSalary); // the unpaid day is now deducted
      await post(`/payroll/${fresh.id}/verify`).expect(201);
    });

    it('an approved run reopened by a leave must be recalculated before it can be verified again', async () => {
      await calculate(6).expect(201);
      const run = await runOf(6);
      await post(`/payroll/${run.id}/verify`).expect(201);
      await post(`/payroll/${run.id}/approve`).expect(201);

      const leave = await makeLeave('2026-06-10', '2026-06-10');
      await approve(leave.id).expect(200);
      const reopened = await runOf(6);
      expect(reopened.status).toBe('CALCULATED');
      expect(reopened.inputsChangedAt).not.toBeNull();
      await post(`/payroll/${run.id}/verify`).expect(400);

      await calculate(6).expect(201);
      await post(`/payroll/${run.id}/verify`).expect(201);
    });

    it('an attendance change marks the run outdated as well', async () => {
      await calculate(7).expect(201);
      expect((await runOf(7)).inputsChangedAt).toBeNull();
      await post('/attendance/punch/manual')
        .send({
          employeeId,
          punchTime: '2026-07-08T04:00:00.000Z',
          outPunchTime: '2026-07-08T13:30:00.000Z',
        })
        .expect(201);
      expect((await runOf(7)).inputsChangedAt).not.toBeNull();
      await calculate(7).expect(201);
      expect((await runOf(7)).inputsChangedAt).toBeNull();
    });
  });

  describe('F3 - the HR sweeps never rewrite locked months or regularized days', () => {
    const regularize = (date: string) =>
      prisma.attendance.updateMany({
        where: { employeeId, date },
        data: {
          source: 'REGULARIZED',
          status: 'PRESENT',
          inTime: new Date(`${date}T04:00:00.000Z`),
          outTime: new Date(`${date}T13:00:00.000Z`),
        },
      });
    const lockMarch = async (id: string) => {
      await calculate(3, id).expect(201);
      const run = await runOf(3, id);
      for (const step of ['verify', 'approve', 'lock']) {
        await post(`/payroll/${run.id}/${step}`).expect(201);
      }
    };

    it('absence alerts and backfill leave a locked month untouched', async () => {
      await lockMarch(employeeId);
      await lockMarch(hrId);
      await regularize('2026-03-10');

      const before = await prisma.attendance.count({
        where: { employeeId: hrId, date: { startsWith: '2026-03' } },
      });
      const backfill = await post('/attendance/backfill-missing')
        .send({ startDate: '2026-03-01', endDate: '2026-03-31', dryRun: false })
        .expect(201);
      expect(
        (backfill.body as { skippedLockedDays: number }).skippedLockedDays,
      ).toBeGreaterThan(0);
      expect(
        await prisma.attendance.count({
          where: { employeeId: hrId, date: { startsWith: '2026-03' } },
        }),
      ).toBe(before);

      const sweep = await post('/attendance/notify-absentees', hrToken)
        .send({ date: '2026-03-10' })
        .expect(201);
      expect((sweep.body as { skippedLocked: number }).skippedLocked).toBe(2);
      const row = await prisma.attendance.findFirstOrThrow({
        where: { employeeId, date: '2026-03-10' },
      });
      expect(row.status).toBe('PRESENT');
      expect(row.source).toBe('REGULARIZED');
      expect(row.inTime).not.toBeNull();
    });

    it('a regularized or imported day in an open month survives the absence sweep', async () => {
      await regularize('2026-08-04');
      await prisma.attendance.updateMany({
        where: { employeeId, date: '2026-08-05' },
        data: {
          source: 'EXCEL_IMPORT',
          status: 'PRESENT',
          inTime: new Date('2026-08-05T04:00:00.000Z'),
          outTime: new Date('2026-08-05T13:00:00.000Z'),
        },
      });
      await post('/attendance/notify-absentees', hrToken)
        .send({ date: '2026-08-04' })
        .expect(201);
      await post('/attendance/notify-absentees', hrToken)
        .send({ date: '2026-08-05' })
        .expect(201);
      for (const [date, source] of [
        ['2026-08-04', 'REGULARIZED'],
        ['2026-08-05', 'EXCEL_IMPORT'],
      ]) {
        const row = await prisma.attendance.findFirstOrThrow({
          where: { employeeId, date },
        });
        expect(row.status).toBe('PRESENT');
        expect(row.source).toBe(source);
        expect(row.inTime).not.toBeNull();
        expect(row.outTime).not.toBeNull();
      }
    });
  });
});
