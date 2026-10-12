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

  describe('C-2 - unlock clears the old payment details', () => {
    it('the bank reference, mode and date leave the run (and stay in the audit entry)', async () => {
      const run = await progress(5, 'PAID');
      await patch(`/payroll/${run.id}/payment`)
        .send({ paymentMode: 'NEFT', paymentReference: 'UTR-OLD-1' })
        .expect(200);
      expect((await runOf(5)).paymentReference).toBe('UTR-OLD-1');

      await post(`/payroll/${run.id}/unlock`)
        .send({ reason: 'Bank rejected the transfer' })
        .expect(201);
      const reopened = await runOf(5);
      expect(reopened.status).toBe('CALCULATED');
      expect(reopened.paymentReference).toBeNull();
      expect(reopened.paymentMode).toBeNull();
      expect(reopened.paymentDate).toBeNull();

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { targetId: run.id, action: 'PAYROLL_UNLOCKED' },
      });
      expect(
        (audit.details as { previousPayment: { reference: string } })
          .previousPayment.reference,
      ).toBe('UTR-OLD-1');
    });
  });

  describe('C-1 - a finalised payroll keeps its original figures when it is corrected', () => {
    it('each unlock saves what was finalised; the corrected run and the history both stay readable', async () => {
      const run = await progress(4, 'PAID');
      const original = { gross: run.grossSalary, net: run.netPay };
      await patch(`/payroll/${run.id}/payment`)
        .send({ paymentMode: 'NEFT', paymentReference: 'UTR-REV-0' })
        .expect(200);
      expect((await runOf(4)).revisionNumber).toBe(0);

      await post(`/payroll/${run.id}/unlock`)
        .send({ reason: 'Salary was revised from 1 April' })
        .expect(201);
      await post(`/employee-salary/${employeeId}/structure`)
        .send({
          componentCode: 'BASIC',
          fixedAmount: 36000,
          effectiveFrom: '2026-04-01',
        })
        .expect(201);
      await post('/payroll/calculate')
        .send({ month: 4, year: YEAR, employeeId })
        .expect(201);
      const corrected = await runOf(4);
      expect(corrected.revisionNumber).toBe(1);
      expect(corrected.grossSalary).toBeGreaterThan(original.gross);
      expect(corrected.payslipNumber).toBe(run.payslipNumber);

      const list = await get(`/payroll/${run.id}/revisions`).expect(200);
      const body = list.body as {
        currentRevision: number;
        data: {
          revision: number;
          reason: string;
          netPay: number;
          paymentReference: string;
          previousStatus: string;
          reopenedBy: { name: string } | null;
        }[];
      };
      expect(body.currentRevision).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        revision: 0,
        reason: 'Salary was revised from 1 April',
        netPay: original.net,
        paymentReference: 'UTR-REV-0',
        previousStatus: 'PAID',
      });
      expect(body.data[0].reopenedBy?.name).toBe('Founder');

      const detail = await get(`/payroll/${run.id}/revisions/0`).expect(200);
      const snapshot = (detail.body as { snapshot: Record<string, unknown> })
        .snapshot;
      expect(snapshot.grossSalary).toBe(original.gross);
      expect((snapshot.earnings as unknown[]).length).toBeGreaterThan(0);
      expect(snapshot.status).toBe('PAID');

      const pdf = await get(`/payroll/${run.id}/revisions/0/pdf`).expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('-rev0.pdf');
      await get(`/payroll/${run.id}/revisions/7`).expect(404);

      // a second correction adds revision 1 (the corrected figures) and keeps revision 0
      for (const step of ['verify', 'approve', 'lock']) {
        await post(`/payroll/${run.id}/${step}`).expect(201);
      }
      await post(`/payroll/${run.id}/unlock`)
        .send({ reason: 'Second correction' })
        .expect(201);
      const again = (
        (await get(`/payroll/${run.id}/revisions`).expect(200)).body as {
          data: { revision: number; netPay: number }[];
        }
      ).data;
      expect(again.map((r) => r.revision)).toEqual([1, 0]);
      expect(again[1].netPay).toBe(original.net);
    });

    it('revisions are for HR/Admin only and never cross organisations', async () => {
      const run = await runOf(4);
      await get(`/payroll/${run.id}/revisions`, employeeToken).expect(403);
      await get(`/payroll/${run.id}/revisions/0`, employeeToken).expect(403);
      await get(`/payroll/${run.id}/revisions/0/pdf`, employeeToken).expect(
        403,
      );
      await get(`/payroll/${run.id}/revisions`, hrToken).expect(200);

      await request(app.getHttpServer()).post('/auth/register').send({
        organizationName: 'Controls Other Org',
        name: 'Founder B',
        email: 'pc-b-admin@example.test',
        password: PASSWORD,
      });
      const otherToken = (
        (
          await request(app.getHttpServer())
            .post('/auth/login')
            .send({ email: 'pc-b-admin@example.test', password: PASSWORD })
        ).body as AuthBody
      ).accessToken;
      await get(`/payroll/${run.id}/revisions`, otherToken).expect(404);
      await get(`/payroll/${run.id}/revisions/0`, otherToken).expect(404);
      await get(`/payroll/${run.id}/revisions/0/pdf`, otherToken).expect(404);
    });
  });

  describe('C-4 - a manual edit must say why and is recorded with before and after', () => {
    it('no reason or an unknown component is refused; a valid edit is audited with the figures that moved', async () => {
      await post('/payroll/calculate')
        .send({ month: 7, year: YEAR, employeeId })
        .expect(201);
      const run = await runOf(7);

      await patch(`/payroll/${run.id}`)
        .send({ earnings: [{ code: 'BASIC', name: 'Basic', amount: 31000 }] })
        .expect(400);
      await patch(`/payroll/${run.id}`)
        .send({
          earnings: [{ code: 'BASIC', name: 'Basic', amount: 31000 }],
          reason: 'x',
        })
        .expect(400);
      const unknown = await patch(`/payroll/${run.id}`)
        .send({
          earnings: [{ code: 'MADE_UP', name: 'Made up', amount: 5000 }],
          reason: 'extra payment agreed verbally',
        })
        .expect(400);
      expect(JSON.stringify(unknown.body)).toContain('MADE_UP');
      expect((await runOf(7)).grossSalary).toBe(run.grossSalary);

      await patch(`/payroll/${run.id}`)
        .send({
          earnings: [{ code: 'BASIC', name: 'Basic', amount: 31000 }],
          reason: 'Basic corrected after revision letter',
        })
        .expect(200);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { targetId: run.id, action: 'PAYROLL_ADJUSTED' },
        orderBy: { createdAt: 'desc' },
      });
      const details = entry.details as {
        reason: string;
        before: { grossSalary: number };
        after: { grossSalary: number };
        changedLines: { code: string; from: number; to: number }[];
      };
      expect(details.reason).toBe('Basic corrected after revision letter');
      expect(details.before.grossSalary).toBe(run.grossSalary);
      expect(details.after.grossSalary).toBe(31000);
      expect(details.changedLines).toContainEqual(
        expect.objectContaining({
          code: 'BASIC',
          from: (
            run.earnings as unknown as { code: string; amount: number }[]
          ).find((l) => l.code === 'BASIC')?.amount,
          to: 31000,
        }),
      );
    });
  });
});
