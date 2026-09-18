import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/notifications/email.service';
import { ApprovalsDigestService } from '../src/approvals-digest/approvals-digest.service';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}

const PASSWORD = 'TestPass123!';
type SendArg = Parameters<EmailService['send']>[0];

describe('Automated email flows (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let digest: ApprovalsDigestService;
  let sendSpy: jest.SpyInstance<
    ReturnType<EmailService['send']>,
    Parameters<EmailService['send']>
  >;
  let organizationId: string;
  let adminToken: string;
  let employeeToken: string;
  let employeeId: string;
  let managerId: string;

  const sentTo = (email: string): SendArg[] =>
    sendSpy.mock.calls.map((c) => c[0]).filter((a) => a.to === email);

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return (res.body as AuthBody).accessToken;
  }

  // Employees are created with a random temporary password — swap in a known
  // one (already past the forced first-login change) so the spec can sign in.
  async function makeEmployee(name: string, email: string, role?: string) {
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, joiningDate: '2024-01-01', ...(role && { role }) });
    const id = (res.body as EmployeeCreateBody).employee.id;
    await prisma.user.update({
      where: { id },
      data: {
        password: await bcrypt.hash(PASSWORD, 10),
        mustChangePassword: false,
      },
    });
    return id;
  }

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
    digest = app.get(ApprovalsDigestService);
    sendSpy = jest.spyOn(app.get(EmailService), 'send');

    const reg = await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Email Flows E2E Org',
      name: 'Flow Admin',
      email: 'flows-admin@example.test',
      password: PASSWORD,
    });
    organizationId = (reg.body as { organizationId: string }).organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { isInitialized: true },
    });
    adminToken = await login('flows-admin@example.test');

    employeeId = await makeEmployee('Flow Employee', 'flows-emp@example.test');
    managerId = await makeEmployee(
      'Flow Manager',
      'flows-mgr@example.test',
      'MANAGER',
    );
    employeeToken = await login('flows-emp@example.test');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "reimbursements", "notifications", "attendances", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  beforeEach(() => sendSpy.mockClear());

  it('password change: a routine change sends the security notice (never the password); the first-login change does not', async () => {
    const NEW_PASSWORD = 'Another123!Pass';
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(201);
    await new Promise((r) => setTimeout(r, 300)); // fire-and-forget send
    const mails = sentTo('flows-emp@example.test');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Your password was changed');
    expect(mails[0].html).toContain('Flow Employee');
    expect(mails[0].html).toContain('UTC');
    expect(mails[0].html).not.toContain(NEW_PASSWORD);
    expect(mails[0].html).not.toContain('{{');

    // Restore the shared password for later tests.
    await prisma.user.update({
      where: { id: employeeId },
      data: { password: await bcrypt.hash(PASSWORD, 10) },
    });
    employeeToken = await login('flows-emp@example.test');
  });

  it('role change: emails the affected employee once; an unchanged role sends nothing', async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ designation: 'Engineer' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(sentTo('flows-emp@example.test')).toHaveLength(0);

    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'MANAGER' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 300));
    const mails = sentTo('flows-emp@example.test');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Your HRMS role was updated');
    expect(mails[0].html).toContain('Employee');
    expect(mails[0].html).toContain('Manager');
    expect(mails[0].html).not.toContain('{{');

    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'EMPLOYEE' })
      .expect(200);
  });

  it('marked absent: one email per employee per date, however many times the day is recalculated', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post('/attendance/notify-absentees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ date: '2026-08-03' })
        .expect(201);
    }
    const absent = sentTo('flows-emp@example.test').filter((a) =>
      a.subject.startsWith('Marked Absent'),
    );
    expect(absent).toHaveLength(1);
    expect(absent[0].html).toContain('03-08-2026');
  });

  it('approvals digest: HR/Admin get one org-wide summary; a manager without finance scope gets none; nothing pending sends nothing', async () => {
    expect(await digest.sendDigestForOrg(organizationId)).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .post('/reimbursements')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ amount: 500, category: 'TRAVEL', claimDate: '2026-09-01' })
      .expect(201);
    // Make the manager the employee's reporting manager.
    await prisma.user.update({
      where: { id: employeeId },
      data: { reportingManagerId: managerId },
    });
    sendSpy.mockClear();

    const sent = await digest.sendDigestForOrg(organizationId);
    expect(sent).toBe(1);
    const adminMail = sentTo('flows-admin@example.test');
    expect(adminMail).toHaveLength(1);
    expect(adminMail[0].subject).toBe(
      'Pending approvals: 1 waiting for your review',
    );
    expect(adminMail[0].html).toContain('Reimbursement claims');
    expect(adminMail[0].html).not.toContain('Leave requests');
    expect(adminMail[0].html).not.toContain('{{');
    // Reimbursements aren't a manager-level request type.
    expect(sentTo('flows-mgr@example.test')).toHaveLength(0);
    expect(sentTo('flows-emp@example.test')).toHaveLength(0);

    // The recipient's email preference is honoured.
    await prisma.user.updateMany({
      where: { organizationId, email: 'flows-admin@example.test' },
      data: { notificationPreferences: { emailEnabled: false } },
    });
    sendSpy.mockClear();
    expect(await digest.sendDigestForOrg(organizationId)).toBe(0);
  });
});
