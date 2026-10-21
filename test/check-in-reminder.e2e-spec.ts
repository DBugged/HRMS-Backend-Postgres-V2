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
import { CheckInReminderService } from '../src/scheduled-reminders/check-in-reminder.service';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}

const PASSWORD = 'TestPass123!';

describe('Check-in reminder before the shift (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let service: CheckInReminderService;
  let adminToken: string;
  let organizationId: string;
  let plainId: string;
  let punchedId: string;
  let onLeaveId: string;

  // The organization is on UTC with the default 09:30 shift, so 09:15 UTC is "15 minutes before".
  const at = (date: string, hhmm: string) =>
    new Date(`${date}T${hhmm}:00.000Z`);
  const remindersFor = (userId: string) =>
    prisma.notification.count({
      where: { userId, title: { startsWith: 'Mark your attendance' } },
    });

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
    service = app.get(CheckInReminderService, { strict: false });

    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Reminder Org',
      name: 'Founder',
      email: 'cir-e2e-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'cir-e2e-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'cir-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { timezone: 'UTC' },
    });

    const mk = async (name: string, email: string) =>
      (
        (
          await request(app.getHttpServer())
            .post('/employees')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name, email, joiningDate: '2020-01-01' })
        ).body as EmployeeCreateBody
      ).employee.id;
    plainId = await mk('Plain Employee', 'cir-e2e-plain@example.test');
    punchedId = await mk('Punched Employee', 'cir-e2e-punched@example.test');
    onLeaveId = await mk('On Leave Employee', 'cir-e2e-leave@example.test');

    const lt = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Reminder Leave',
        code: 'RML',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 5,
        prorateOnJoining: false,
      });
    await prisma.leave.create({
      data: {
        organizationId,
        employeeId: onLeaveId,
        leaveTypeId: (lt.body as { id: string }).id,
        startDate: '2026-11-04',
        endDate: '2026-11-04',
        totalDays: 1,
        status: 'APPROVED',
      },
    });
    await prisma.attendance.create({
      data: {
        organizationId,
        employeeId: punchedId,
        date: '2026-11-04',
        status: 'PRESENT',
        source: 'FACE_API',
        inTime: at('2026-11-04', '09:05'),
      },
    });
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 500));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('reminds people who have not checked in 15 minutes before the shift, once, and not those who are away or in', async () => {
    const sent = await service.remindForOrg(
      organizationId,
      at('2026-11-04', '09:15'),
    );
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(await remindersFor(plainId)).toBe(1);
    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: plainId, title: { startsWith: 'Mark your attendance' } },
    });
    expect(note.title).toMatch(/shift starts at 09:30/);
    expect(note.category).toBe('ATTENDANCE');
    expect(await remindersFor(punchedId)).toBe(0); // already punched in
    expect(await remindersFor(onLeaveId)).toBe(0); // a full day of approved leave

    // A re-run in the same window (a restart, a manual trigger) does not remind again.
    await service.remindForOrg(organizationId, at('2026-11-04', '09:15'));
    expect(await remindersFor(plainId)).toBe(1);
  });

  it('only at the reminder moment', async () => {
    await service.remindForOrg(organizationId, at('2026-11-05', '09:00')); // 30 minutes before
    await service.remindForOrg(organizationId, at('2026-11-05', '09:25')); // 5 minutes before
    expect(await remindersFor(plainId)).toBe(1); // still only the first day's
  });

  it('not on a holiday, a weekly off, or when the Admin has switched it off', async () => {
    const holidayDate = '2026-11-05';
    await prisma.holiday.create({
      data: {
        organizationId,
        name: 'Test Holiday',
        date: holidayDate,
        year: 2026,
      },
    });
    await service.remindForOrg(organizationId, at(holidayDate, '09:15'));
    expect(await remindersFor(plainId)).toBe(1);

    await service.remindForOrg(organizationId, at('2026-11-08', '09:15')); // a Sunday, the default weekly off
    expect(await remindersFor(plainId)).toBe(1);

    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        orgPayrollAttendancePrefs: {
          checkInReminder: { enabled: false, minutesBefore: 15 },
        },
      },
    });
    await service.remindForOrg(organizationId, at('2026-11-06', '09:15'));
    expect(await remindersFor(plainId)).toBe(1);

    // Back on with 30 minutes' notice: the next working day's 09:00 reminder goes out.
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        orgPayrollAttendancePrefs: {
          checkInReminder: { enabled: true, minutesBefore: 30 },
        },
      },
    });
    await service.remindForOrg(organizationId, at('2026-11-06', '09:00'));
    expect(await remindersFor(plainId)).toBe(2);
  });

  it('the Admin setting is validated', async () => {
    const patch = (checkInReminder: object) =>
      request(app.getHttpServer())
        .patch('/organizations/settings/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ orgPayrollAttendancePrefs: { checkInReminder } });
    await patch({ minutesBefore: 2 }).expect(400);
    await patch({ minutesBefore: 500 }).expect(400);
    await patch({ enabled: 'yes' }).expect(400);
    await patch({ enabled: true, minutesBefore: 20 }).expect(200);
  });
});
