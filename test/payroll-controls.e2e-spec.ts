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

// Payroll processing controls: unlock safety, payment details, revisions of finalised payroll, manual adjustments,
// what exports and employees can see, and the audit trail around all of it.
describe('Payroll controls (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let hrId: string;
  let organizationId: string;

  const post = (url: string, token = adminToken) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${token}`);
  const patch = (url: string, token = adminToken) =>
    request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${token}`);
  const get = (url: string, token = adminToken) =>
    request(app.getHttpServer())
      .get(url)
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
  // calculate -> verify -> approve (-> lock (-> pay)) as Admin
  const progress = async (
    month: number,
    upTo: 'CALCULATED' | 'APPROVED' | 'LOCKED' | 'PAID',
    id = employeeId,
  ) => {
    await post('/payroll/calculate')
      .send({ month, year: YEAR, employeeId: id })
      .expect(201);
    const steps = {
      CALCULATED: [],
      APPROVED: ['verify', 'approve'],
      LOCKED: ['verify', 'approve', 'lock'],
      PAID: ['verify', 'approve', 'lock', 'pay'],
    }[upTo];
    const run = await runOf(month, id);
    for (const step of steps) {
      await post(`/payroll/${run.id}/${step}`).expect(201);
    }
    return runOf(month, id);
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
      organizationName: 'Controls Org',
      name: 'Founder',
      email: 'pc-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'pc-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'pc-admin@example.test' },
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
    const hr = await mk('Hr Person', 'pc-hr@example.test', 'HR');
    hrId = hr.id;
    hrToken = hr.token;
    const emp = await mk('Plain Employee', 'pc-emp@example.test');
    employeeId = emp.id;
    employeeToken = emp.token;
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
      [4, 30],
      [5, 31],
      [6, 30],
      [7, 31],
      [8, 31],
    ]) {
      for (const id of [employeeId, hrId]) {
        await prisma.attendance.createMany({
          data: Array.from({ length: days }, (_, i) => ({
            organizationId,
            employeeId: id,
            date: `${YEAR}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
            status: 'PRESENT' as const,
            source: 'FACE_API' as const,
          })),
        });
      }
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  describe('C-3 - unlock happens once', () => {
    it('three simultaneous unlocks: one wins, one audit row, one "withdrawn" notice', async () => {
      const run = await progress(6, 'PAID');
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          post(`/payroll/${run.id}/unlock`).send({
            reason: `parallel unlock ${i}`,
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(
        statuses.filter((s) => s === 201 || s === 400 || s === 409),
      ).toHaveLength(3);
      expect(
        await prisma.auditLog.count({
          where: { targetId: run.id, action: 'PAYROLL_UNLOCKED' },
        }),
      ).toBe(1);
      expect(
        await prisma.notification.count({
          where: { userId: employeeId, title: { contains: 'withdrawn' } },
        }),
      ).toBe(1);
      expect((await runOf(6)).status).toBe('CALCULATED');
    });
  });
});
