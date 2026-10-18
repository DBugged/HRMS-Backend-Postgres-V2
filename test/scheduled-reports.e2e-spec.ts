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
import { EmailService } from '../src/notifications/email.service';
import { ScheduledReportsService } from '../src/reports/scheduled-reports.service';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface Schedule {
  id: string;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastRunDate: string | null;
  recipients: string[];
}

const PASSWORD = 'TestPass123!';

describe('Scheduled reports (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let employeeToken: string;
  let managerToken: string;
  const sent: {
    to: string;
    subject: string;
    attachments?: { filename: string; content: Buffer }[];
  }[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({ send: async (m: never) => void sent.push(m) })
      .compile();
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
      organizationName: 'Sched Reports Org',
      name: 'Founder',
      email: 'sr-e2e-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'sr-e2e-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    const login = async (name: string, email: string, role?: string) => {
      const created = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name,
          email,
          joiningDate: '2025-01-01',
          ...(role && { role }),
        });
      return (
        (
          await request(app.getHttpServer())
            .post('/auth/login')
            .send({
              email,
              password: (created.body as EmployeeCreateBody).generatedPassword,
            })
        ).body as AuthBody
      ).accessToken;
    };
    employeeToken = await login('Plain Employee', 'sr-e2e-emp@example.test');
    managerToken = await login(
      'A Manager',
      'sr-e2e-mgr@example.test',
      'MANAGER',
    );
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 500));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "scheduled_reports", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const post = (body: object, token = adminToken) =>
    request(app.getHttpServer())
      .post('/reports/scheduled')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('only Admin and HR can use it', async () => {
    for (const token of [employeeToken, managerToken]) {
      await request(app.getHttpServer())
        .get('/reports/scheduled')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await post(
        {
          name: 'x',
          reportKey: 'attendance',
          frequency: 'DAILY',
          recipients: ['a@b.co'],
        },
        token,
      ).expect(403);
    }
  });

  it('lists what can be scheduled', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/scheduled/options')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const keys = (res.body as { key: string }[]).map((o) => o.key);
    expect(keys).toEqual(
      expect.arrayContaining(['attendance', 'overtime', 'payroll-variance']),
    );
  });

  it('validates the report, the day for weekly / monthly, and the recipients', async () => {
    const ok = {
      name: 'Weekly overtime',
      reportKey: 'overtime',
      frequency: 'DAILY',
      recipients: ['hr@company.co'],
    };
    await post({ ...ok, reportKey: 'nope' }).expect(400);
    await post({ ...ok, frequency: 'WEEKLY' }).expect(400);
    await post({ ...ok, frequency: 'MONTHLY' }).expect(400);
    await post({ ...ok, frequency: 'MONTHLY', dayOfMonth: 31 }).expect(400);
    await post({ ...ok, recipients: [] }).expect(400);
    await post({ ...ok, recipients: ['not-an-email'] }).expect(400);
  });

  it('creates, lists, edits, pauses and deletes a schedule', async () => {
    const created = await post({
      name: 'Weekly overtime',
      reportKey: 'overtime',
      frequency: 'WEEKLY',
      dayOfWeek: 1,
      recipients: ['HR@Company.co', 'hr@company.co', 'boss@company.co'],
    }).expect(201);
    const id = (created.body as Schedule).id;
    expect((created.body as Schedule).recipients).toEqual([
      'hr@company.co',
      'boss@company.co',
    ]);

    const list = await request(app.getHttpServer())
      .get('/reports/scheduled')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((list.body as Schedule[]).map((s) => s.id)).toContain(id);

    const edited = await request(app.getHttpServer())
      .patch(`/reports/scheduled/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ frequency: 'MONTHLY', dayOfMonth: 3, enabled: false })
      .expect(200);
    expect(edited.body).toMatchObject({
      frequency: 'MONTHLY',
      dayOfMonth: 3,
      dayOfWeek: null,
      enabled: false,
    });

    await request(app.getHttpServer())
      .delete(`/reports/scheduled/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/reports/scheduled/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Gone' })
      .expect(404);
  });

  it('send-now builds the file and emails it to every recipient as an attachment', async () => {
    sent.length = 0;
    const created = await post({
      name: 'Daily attendance',
      reportKey: 'attendance',
      format: 'csv',
      frequency: 'DAILY',
      recipients: ['one@company.co', 'two@company.co'],
    }).expect(201);
    const id = (created.body as Schedule).id;
    const run = await request(app.getHttpServer())
      .post(`/reports/scheduled/${id}/run`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(run.body).toMatchObject({ status: 'SENT' });
    expect(sent.map((m) => m.to).sort()).toEqual([
      'one@company.co',
      'two@company.co',
    ]);
    expect(sent[0].attachments?.[0].filename).toMatch(
      /^attendance_report.*\.csv$/,
    );
    expect(sent[0].attachments?.[0].content.length).toBeGreaterThan(10);
    const row = await prisma.scheduledReport.findFirstOrThrow({
      where: { id },
    });
    // A test send is not today's scheduled run.
    expect(row).toMatchObject({ lastRunStatus: 'SENT', lastRunDate: null });
  });

  it('a PDF run produces a real PDF', async () => {
    sent.length = 0;
    const created = await post({
      name: 'Variance',
      reportKey: 'payroll-variance',
      format: 'pdf',
      frequency: 'MONTHLY',
      dayOfMonth: 2,
      recipients: ['x@company.co'],
    }).expect(201);
    await request(app.getHttpServer())
      .post(`/reports/scheduled/${(created.body as Schedule).id}/run`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(sent[0].attachments?.[0].content.subarray(0, 4).toString()).toBe(
      '%PDF',
    );
  });

  it('the hourly job runs what is due once, and stops with a reason when the creator is no longer Admin/HR', async () => {
    sent.length = 0;
    const svc = app.get(ScheduledReportsService);
    const created = await post({
      name: 'Hourly',
      reportKey: 'employees',
      format: 'csv',
      frequency: 'DAILY',
      sendHour: 0,
      recipients: ['d@company.co'],
    }).expect(201);
    const id = (created.body as Schedule).id;
    await svc.runDue();
    const first = await prisma.scheduledReport.findFirstOrThrow({
      where: { id },
    });
    expect(first.lastRunStatus).toBe('SENT');
    expect(first.lastRunDate).not.toBeNull();
    const countAfterFirst = sent.length;
    await svc.runDue();
    expect(sent.length).toBe(countAfterFirst); // not again the same day

    await prisma.scheduledReport.update({
      where: { id },
      data: { lastRunDate: null },
    });
    await prisma.user.updateMany({
      where: { email: 'sr-e2e-admin@example.test' },
      data: { isActive: false },
    });
    await svc.runDue();
    const failed = await prisma.scheduledReport.findFirstOrThrow({
      where: { id },
    });
    expect(failed.lastRunStatus).toBe('FAILED');
    expect(failed.lastRunError).toMatch(/no longer an active Admin or HR/);
  });
});
