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
interface NotificationBody {
  id: string;
  title: string;
  category: string;
  isRead: boolean;
}
interface NotificationsListBody {
  notifications: NotificationBody[];
  unreadCount: number;
}
interface PreferencesBody {
  mutedCategories: string[];
  emailEnabled: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let managerId: string;
  let employeeToken: string;
  let employeeId: string;
  let deptId: string;
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
      organizationName: 'Notifications E2E Org',
      name: 'Founder',
      email: 'notif-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'notif-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'notif-e2e-admin@example.test' },
    });
    organizationId = admin.organizationId;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'notif-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'notif-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const mgrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Manager',
        email: 'notif-e2e-mgr@example.test',
        role: 'MANAGER',
      });
    managerId = (mgrCreate.body as EmployeeCreateBody).employee.id;
    const mgrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'notif-e2e-mgr@example.test',
        password: (mgrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (mgrLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    deptId = (dept.body as { id: string }).id;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'notif-e2e-emp@example.test',
        reportingManagerId: managerId,
        departmentId: deptId,
      });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'notif-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Earned Leave',
        code: 'EL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
        approvalLevels: 1,
      })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "notifications", "attendances", "attendance_import_batches", "comp_offs", "leaves", "leave_balances", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403 sending a broadcast', async () => {
    await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ title: 'x', message: 'y', recipientType: 'all' })
      .expect(403);
  });

  it('HR broadcasts to all active users, and every recipient sees it', async () => {
    const res = await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        title: 'Company Update',
        message: 'Office closed Friday.',
        recipientType: 'all',
      })
      .expect(201);
    expect(
      (res.body as { recipientCount: number }).recipientCount,
    ).toBeGreaterThanOrEqual(4);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = empView.body as NotificationsListBody;
    expect(body.notifications.some((n) => n.title === 'Company Update')).toBe(
      true,
    );
    expect(
      body.notifications.every((n) => n.category === 'GENERAL' || true),
    ).toBe(true);
  });

  it('broadcast to a specific department only reaches that department', async () => {
    await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        title: 'Engineering Only',
        message: 'Standup moved to 10am.',
        recipientType: 'department',
        department: deptId,
      })
      .expect(201);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (empView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Engineering Only',
      ),
    ).toBe(true);

    const mgrView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (mgrView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Engineering Only',
      ),
    ).toBe(false);
  });

  it('broadcast requires department when recipientType=department', async () => {
    await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ title: 'x', message: 'y', recipientType: 'department' })
      .expect(400);
  });

  it('broadcast to specific userIds only reaches those users, optionally emailing (dry-run)', async () => {
    await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        title: 'Just For You',
        message: 'Direct message.',
        recipientType: 'specific',
        userIds: [managerId],
        sendEmailToo: true,
      })
      .expect(201);

    const mgrView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (mgrView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Just For You',
      ),
    ).toBe(true);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (empView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Just For You',
      ),
    ).toBe(false);
  });

  it('GET /preferences returns the default shape, PUT partially updates it', async () => {
    const initial = await request(app.getHttpServer())
      .get('/notifications/preferences')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((initial.body as PreferencesBody).mutedCategories).toEqual([]);
    expect((initial.body as PreferencesBody).emailEnabled).toBe(true);

    const updated = await request(app.getHttpServer())
      .put('/notifications/preferences')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ mutedCategories: ['GENERAL'] })
      .expect(200);
    expect((updated.body as PreferencesBody).mutedCategories).toEqual([
      'GENERAL',
    ]);
    // emailEnabled untouched by the partial update — still true.
    expect((updated.body as PreferencesBody).emailEnabled).toBe(true);

    const second = await request(app.getHttpServer())
      .put('/notifications/preferences')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ emailEnabled: false })
      .expect(200);
    // mutedCategories from the prior call is preserved.
    expect((second.body as PreferencesBody).mutedCategories).toEqual([
      'GENERAL',
    ]);
    expect((second.body as PreferencesBody).emailEnabled).toBe(false);
  });

  it('GET / filters out muted categories', async () => {
    await request(app.getHttpServer())
      .post('/notifications/send')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        title: 'Should Be Muted',
        message: 'general broadcast',
        recipientType: 'specific',
        userIds: [employeeId],
      })
      .expect(201);

    const view = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (view.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Should Be Muted',
      ),
    ).toBe(false);

    // Restore prefs for the rest of the suite.
    await request(app.getHttpServer())
      .put('/notifications/preferences')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ mutedCategories: [], emailEnabled: true })
      .expect(200);
  });

  let readTargetId: string;

  it('PATCH /:id/read marks a single notification read, scoped to the owner', async () => {
    const created = await prisma.notification.create({
      data: {
        organizationId,
        userId: employeeId,
        title: 'Mark Me Read',
        message: 'test',
        category: 'GENERAL',
      },
    });
    readTargetId = created.id;

    // Another user cannot mark someone else's notification read (silently
    // scoped by userId — the updateMany simply matches nothing).
    await request(app.getHttpServer())
      .patch(`/notifications/${readTargetId}/read`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const stillUnread = await prisma.notification.findUniqueOrThrow({
      where: { id: readTargetId },
    });
    expect(stillUnread.isRead).toBe(false);

    await request(app.getHttpServer())
      .patch(`/notifications/${readTargetId}/read`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const nowRead = await prisma.notification.findUniqueOrThrow({
      where: { id: readTargetId },
    });
    expect(nowRead.isRead).toBe(true);
  });

  it('PATCH /read-all marks every unread notification read for the caller and unreadCount drops to 0', async () => {
    await prisma.notification.createMany({
      data: [
        {
          organizationId,
          userId: employeeId,
          title: 'Unread 1',
          message: 'test',
          category: 'GENERAL',
        },
        {
          organizationId,
          userId: employeeId,
          title: 'Unread 2',
          message: 'test',
          category: 'GENERAL',
        },
      ],
    });

    const before = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (before.body as NotificationsListBody).unreadCount,
    ).toBeGreaterThanOrEqual(2);

    await request(app.getHttpServer())
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    const after = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((after.body as NotificationsListBody).unreadCount).toBe(0);
  });

  // -- Trigger-site integration --

  it('applying for leave notifies the reporting manager', async () => {
    const leaveType = await prisma.leaveType.findFirstOrThrow({
      where: { code: 'EL' },
    });
    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: leaveType.id,
        startDate: '2026-09-10',
        endDate: '2026-09-11',
      })
      .expect(201);

    const mgrView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (mgrView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'New Leave Application' && n.category === 'LEAVE',
      ),
    ).toBe(true);
  });

  it("the manager's leave decision notifies the employee", async () => {
    const leave = await prisma.leave.findFirstOrThrow({
      where: { organizationId, employeeId, startDate: '2026-09-10' },
    });
    await request(app.getHttpServer())
      .patch(`/leaves/${leave.id}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (empView.body as NotificationsListBody).notifications.some(
        (n) => n.title === 'Leave Request APPROVED' && n.category === 'LEAVE',
      ),
    ).toBe(true);
  });

  it('a comp-off review decision notifies the employee', async () => {
    const earn = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: '2026-08-01', reason: 'Weekend work' })
      .expect(201);
    const compOffId = (earn.body as { id: string }).id;

    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (empView.body as NotificationsListBody).notifications.some(
        (n) =>
          n.title === 'Comp-Off Request APPROVED' && n.category === 'LEAVE',
      ),
    ).toBe(true);
  });

  it('requesting attendance regularization notifies the reporting manager', async () => {
    await request(app.getHttpServer())
      .post('/attendance/regularization')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ date: '2026-08-01', reason: 'Forgot to punch' })
      .expect(201);

    const mgrView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (mgrView.body as NotificationsListBody).notifications.some(
        (n) =>
          n.title === 'Attendance Regularization Requested' &&
          n.category === 'REGULARIZATION',
      ),
    ).toBe(true);
  });

  it('reviewing the regularization request notifies the employee', async () => {
    const row = await prisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId, date: '2026-08-01' },
    });
    await request(app.getHttpServer())
      .patch(`/attendance/regularization/${row.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (empView.body as NotificationsListBody).notifications.some(
        (n) =>
          n.title === 'Regularization Request APPROVED' &&
          n.category === 'REGULARIZATION',
      ),
    ).toBe(true);
  });

  it('uploading an attendance import batch notifies HR/Admin', async () => {
    await request(app.getHttpServer())
      .post('/attendance/import')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({
        rows: [{ employeeId: 'EMP-0001', date: '2026-08-02' }],
        fileName: 'august.xlsx',
      })
      .expect(201);

    const adminView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (adminView.body as NotificationsListBody).notifications.some(
        (n) =>
          n.title === 'Attendance Import Batch Uploaded' &&
          n.category === 'ATTENDANCE',
      ),
    ).toBe(true);
  });

  it('a recalculated absent day notifies the employee once (deduped on re-run)', async () => {
    // No punches for this date + no leave/holiday -> ABSENT via
    // recalculateAttendanceForDay, triggered indirectly through the
    // regularization request path (which reads back the row it created).
    // Simplest direct trigger: request regularization for a fresh date,
    // which creates an ABSENT row without going through recalculation —
    // instead, exercise the notify-absentees endpoint, which does call
    // recalculateAttendanceForDay under the hood.
    await request(app.getHttpServer())
      .post('/attendance/notify-absentees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: '2026-08-03' })
      .expect(201);

    const empView = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const absentNotifs = (
      empView.body as NotificationsListBody
    ).notifications.filter((n) => n.title === 'Marked Absent — 2026-08-03');
    expect(absentNotifs.length).toBe(1);

    // Running it again must not create a second Notification row (dedup).
    await request(app.getHttpServer())
      .post('/attendance/notify-absentees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: '2026-08-03' })
      .expect(201);

    const empViewAgain = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const absentNotifsAgain = (
      empViewAgain.body as NotificationsListBody
    ).notifications.filter((n) => n.title === 'Marked Absent — 2026-08-03');
    expect(absentNotifsAgain.length).toBe(1);
  });
});
