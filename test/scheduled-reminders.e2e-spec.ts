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
import { EmailTemplatesService } from '../src/email-templates/email-templates.service';
import { ProbationReminderService } from '../src/scheduled-reminders/probation-reminder.service';
import { PayrollCutoffReminderService } from '../src/scheduled-reminders/payroll-cutoff-reminder.service';
import { StatutoryDueReminderService } from '../src/scheduled-reminders/statutory-due-reminder.service';
import { MissedPunchOutService } from '../src/scheduled-reminders/missed-punch-out.service';
import { ApprovalEscalationService } from '../src/scheduled-reminders/approval-escalation.service';

const PASSWORD = 'TestPass123!';
const TRUNCATE_ALL =
  'TRUNCATE TABLE "organizations", "users" RESTART IDENTITY CASCADE';

describe('Scheduled reminders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sendSpy: jest.SpyInstance<
    ReturnType<EmailService['send']>,
    Parameters<EmailService['send']>
  >;
  let organizationId: string;
  let adminId: string;
  let hrId: string;
  let managerId: string;
  let empId: string;

  const sentTo = () => sendSpy.mock.calls.map((c) => c[0].to).sort();
  const notificationsFor = (userId: string) =>
    prisma.notification.findMany({ where: { userId } });

  const makeEmployee = async (name: string, email: string) => {
    const token = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'rem-admin@example.test', password: PASSWORD })
      ).body as { accessToken: string }
    ).accessToken;
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, email, joiningDate: '2025-01-01' })
      .expect(201);
    return (res.body as { employee: { id: string } }).employee.id;
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
    await prisma.$executeRawUnsafe(TRUNCATE_ALL);
    sendSpy = jest
      .spyOn(app.get(EmailService), 'send')
      .mockResolvedValue({ dryRun: true });

    const reg = await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Reminders E2E Org',
      name: 'Rem Admin',
      email: 'rem-admin@example.test',
      password: PASSWORD,
    });
    organizationId = (reg.body as { organizationId: string }).organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { isInitialized: true },
    });
    adminId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'rem-admin@example.test' },
      })
    ).id;

    hrId = await makeEmployee('Rem HR', 'rem-hr@example.test');
    managerId = await makeEmployee('Rem Manager', 'rem-manager@example.test');
    empId = await makeEmployee('Rem Employee', 'rem-emp@example.test');
    await prisma.user.update({ where: { id: hrId }, data: { role: 'HR' } });
    await prisma.user.update({
      where: { id: managerId },
      data: { role: 'MANAGER' },
    });
    await prisma.user.update({
      where: { id: empId },
      data: { reportingManagerId: managerId },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE_ALL);
    await app.close();
  });

  beforeEach(() => sendSpy.mockClear());

  it('probation: reminds the manager and HR/Admin 7 days before the end date, once, never the employee', async () => {
    await prisma.user.update({
      where: { id: empId },
      data: { probationEndDate: '2026-11-17', probationStatus: 'PENDING' },
    });
    const service = app.get(ProbationReminderService);
    const first = await service.remindForOrg(organizationId, '2026-11-10');
    expect(first).toBe(3); // manager + HR + admin
    expect(sentTo()).toEqual(
      [
        'rem-admin@example.test',
        'rem-hr@example.test',
        'rem-manager@example.test',
      ].sort(),
    );
    expect((await notificationsFor(empId)).length).toBe(0);
    expect(await service.remindForOrg(organizationId, '2026-11-10')).toBe(0); // deduped
    expect(await service.remindForOrg(organizationId, '2026-11-12')).toBe(0); // 5 days: not a milestone

    await prisma.user.update({
      where: { id: empId },
      data: { probationStatus: 'CONFIRMED' },
    });
    expect(await service.remindForOrg(organizationId, '2026-11-02')).toBe(0); // confirmed: no 15-day reminder
  });

  it('statutory: reminds HR/Admin 5 days before PF only when PF is enabled', async () => {
    const service = app.get(StatutoryDueReminderService);
    await prisma.statutoryConfigVersion.updateMany({
      where: { organizationId, module: 'PF' },
      data: { isEnabled: false },
    });
    expect(await service.remindForOrg(organizationId, '2026-11-10')).toBe(0);

    await prisma.statutoryConfigVersion.updateMany({
      where: { organizationId, module: 'PF' },
      data: { isEnabled: true },
    });
    const sent = await service.remindForOrg(organizationId, '2026-11-10');
    expect(sent).toBe(2); // HR + admin
    expect(sendSpy.mock.calls.map((c) => c[0].subject)).toEqual(
      expect.arrayContaining([expect.stringContaining('PF contribution')]),
    );
    expect(await service.remindForOrg(organizationId, '2026-11-10')).toBe(0);
  });

  it('payroll cut-off: reminds HR/Admin 3 days before processing, listing pending items', async () => {
    const service = app.get(PayrollCutoffReminderService);
    // Default processing day 0 = last working day: Mon 30-Nov-2026.
    expect(await service.remindForOrg(organizationId, '2026-11-27')).toBe(0); // nothing pending yet

    await prisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: empId,
        date: '2026-11-10',
        hours: 2,
        type: 'REGULAR',
        rateMultiplier: 1.5,
        status: 'PENDING',
      },
    });
    expect(await service.remindForOrg(organizationId, '2026-11-26')).toBe(0); // 4 days: not a milestone
    const sent = await service.remindForOrg(organizationId, '2026-11-27');
    expect(sent).toBe(2);
    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('Overtime requests');
    expect(await service.remindForOrg(organizationId, '2026-11-27')).toBe(0);
  });

  it('missed punch-out: nudges only an employee who punched in, did not punch out and has no regularization open', async () => {
    const service = app.get(MissedPunchOutService);
    const day = '2026-11-09';
    const inTime = new Date('2026-11-09T04:00:00Z');
    await prisma.attendance.create({
      data: { organizationId, employeeId: empId, date: day, inTime },
    });
    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId: managerId,
        date: day,
        inTime,
        outTime: new Date('2026-11-09T12:00:00Z'),
      },
    });
    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId: hrId,
        date: day,
        inTime,
        regularization: { requested: true, status: 'pending' },
      },
    });
    const sent = await service.remindForOrg(
      organizationId,
      day,
      'Asia/Kolkata',
    );
    expect(sent).toBe(1);
    expect(sentTo()).toEqual(['rem-emp@example.test']);
    expect(
      await service.remindForOrg(organizationId, day, 'Asia/Kolkata'),
    ).toBe(0);
  });

  it('escalation: tells HR/Admin about a request waiting exactly 3 days, and not before or off-cycle', async () => {
    const service = app.get(ApprovalEscalationService);
    // The punch-out test's rows (one with a pending regularization stamped at real time) must not count here.
    await prisma.attendance.deleteMany({ where: { organizationId } });
    const now = new Date('2026-11-20T10:00:00Z');
    await prisma.overtimeRecord.updateMany({
      where: { organizationId },
      data: { createdAt: new Date('2026-11-17T09:00:00Z') }, // 3 days + 1h old
    });
    expect(await service.escalateForOrg(organizationId, 0, now)).toBe(0); // off

    const sent = await service.escalateForOrg(organizationId, 3, now);
    expect(sent).toBe(2); // the employee has a manager but no skip-level, so HR + admin
    expect(sentTo()).toEqual(['rem-admin@example.test', 'rem-hr@example.test']);
    expect(await service.escalateForOrg(organizationId, 3, now)).toBe(0); // same day: deduped

    sendSpy.mockClear();
    const dayBefore = new Date('2026-11-19T10:00:00Z'); // 2 days old
    expect(await service.escalateForOrg(organizationId, 3, dayBefore)).toBe(0);
    const sixDays = new Date('2026-11-23T10:00:00Z'); // 6 days old: second escalation
    expect(await service.escalateForOrg(organizationId, 3, sixDays)).toBe(2);
  });

  it('escalation never sends a request to its own requester', async () => {
    const service = app.get(ApprovalEscalationService);
    const now = new Date('2026-12-20T10:00:00Z');
    // The HR user's own pending overtime, 3 days old: HR must not be told about it, the admin must.
    await prisma.overtimeRecord.deleteMany({ where: { organizationId } });
    await prisma.overtimeRecord.create({
      data: {
        organizationId,
        employeeId: hrId,
        date: '2026-12-10',
        hours: 1,
        type: 'REGULAR',
        rateMultiplier: 1.5,
        status: 'PENDING',
        createdAt: new Date('2026-12-17T09:00:00Z'),
      },
    });
    sendSpy.mockClear();
    expect(await service.escalateForOrg(organizationId, 3, now)).toBe(1);
    expect(sentTo()).toEqual(['rem-admin@example.test']);
    expect(adminId).toBeDefined();
  });

  it('backfills a missing built-in template without touching an edited one, and a switched-off template sends no email', async () => {
    const templates = app.get(EmailTemplatesService);
    await prisma.emailTemplate.deleteMany({
      where: { organizationId, occasionKey: 'MISSED_PUNCH_OUT' },
    });
    await prisma.emailTemplate.updateMany({
      where: { organizationId, occasionKey: 'BIRTHDAY' },
      data: { subject: 'Edited by admin' },
    });
    expect(await templates.ensureMissingDefaults()).toBe(1);
    expect(await templates.ensureMissingDefaults()).toBe(0); // idempotent
    const birthday = await prisma.emailTemplate.findFirstOrThrow({
      where: { organizationId, occasionKey: 'BIRTHDAY' },
    });
    expect(birthday.subject).toBe('Edited by admin');

    // Switched off: the in-app notice still goes out, the email does not.
    await prisma.emailTemplate.updateMany({
      where: { organizationId, occasionKey: 'MISSED_PUNCH_OUT' },
      data: { isActive: false },
    });
    sendSpy.mockClear();
    const service = app.get(MissedPunchOutService);
    const day = '2026-11-16';
    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId: empId,
        date: day,
        inTime: new Date('2026-11-16T04:00:00Z'),
      },
    });
    expect(
      await service.remindForOrg(organizationId, day, 'Asia/Kolkata'),
    ).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(
      (await notificationsFor(empId)).some((n) =>
        n.title.includes('16-11-2026'),
      ),
    ).toBe(true);
  });
});
