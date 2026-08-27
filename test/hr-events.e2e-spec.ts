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
import { HrEventsService } from '../src/hr-events/hr-events.service';
import { EmailService } from '../src/notifications/email.service';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}

const PASSWORD = 'TestPass123!';

// UTC "today" — matches how HrEventsService compares dates (see its
// monthDay() comment on why UTC, not local time or a per-org timezone).
function todayMonthDayUtc(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

describe('HrEventsService (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let hrEventsService: HrEventsService;
  let emailService: EmailService;
  let sendSpy: jest.SpyInstance<
    ReturnType<EmailService['send']>,
    Parameters<EmailService['send']>
  >;

  let adminToken: string;
  let organizationId: string;

  let birthdayEmployeeId: string;
  let anniversaryEmployeeId: string;
  let unrelatedEmployeeId: string;

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
    hrEventsService = app.get(HrEventsService);
    emailService = app.get(EmailService);
    sendSpy = jest.spyOn(emailService, 'send');

    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'HR Events E2E Org',
        name: 'Admin User',
        email: 'hr-events-admin@example.com',
        password: PASSWORD,
      });
    organizationId = (registerRes.body as { organizationId: string })
      .organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { isInitialized: true },
    });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'hr-events-admin@example.com', password: PASSWORD });
    adminToken = (loginRes.body as AuthBody).accessToken;

    // Set org variables so the rendered email body's {{companyName}} etc.
    // placeholders (from the seeded BIRTHDAY/WORK_ANNIVERSARY templates)
    // have something real to substitute.
    await request(app.getHttpServer())
      .patch('/organizations/settings/profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'HR Events Test Co' });
    await request(app.getHttpServer())
      .patch('/organizations/settings/contact')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        phone: '+91-9999999999',
        contactEmail: 'contact@hr-events-test.example',
        website: 'https://hr-events-test.example',
        registeredAddress: '123 Test Street, Test City',
      });

    const todayMonthDay = todayMonthDayUtc();

    // Joined exactly 3 years ago today — should get an anniversary wish.
    const anniversaryJoinYear = new Date().getUTCFullYear() - 3;
    const anniversaryRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Anniversary Employee',
        email: 'anniversary.hr-events@example.com',
        joiningDate: `${anniversaryJoinYear}-${todayMonthDay}`,
      });
    anniversaryEmployeeId = (anniversaryRes.body as EmployeeCreateBody).employee
      .id;

    // Joined today (year 0) — should NOT get an anniversary wish (< 1 year).
    const birthdayRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Birthday Employee',
        email: 'birthday.hr-events@example.com',
        joiningDate: `2099-01-01`, // far off, irrelevant month/day
      });
    birthdayEmployeeId = (birthdayRes.body as EmployeeCreateBody).employee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${birthdayEmployeeId}/personal-data`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ personalData: { dateOfBirth: `1990-${todayMonthDay}` } });

    // Neither date matches today — should get nothing.
    const unrelatedRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Unrelated Employee',
        email: 'unrelated.hr-events@example.com',
        joiningDate: '2099-01-01',
      });
    unrelatedEmployeeId = (unrelatedRes.body as EmployeeCreateBody).employee.id;
    await request(app.getHttpServer())
      .patch(`/employees/${unrelatedEmployeeId}/personal-data`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ personalData: { dateOfBirth: '1990-01-01' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends a birthday wish only to the employee whose DOB matches today', async () => {
    await hrEventsService.sendWishesForOrg(organizationId);

    const birthdayNotifications = await prisma.notification.findMany({
      where: {
        organizationId,
        userId: birthdayEmployeeId,
        title: 'Happy Birthday!',
      },
    });
    expect(birthdayNotifications.length).toBeGreaterThan(0);

    const unrelatedNotifications = await prisma.notification.findMany({
      where: {
        organizationId,
        userId: unrelatedEmployeeId,
        title: 'Happy Birthday!',
      },
    });
    expect(unrelatedNotifications).toHaveLength(0);
  });

  it('sends the birthday email to the employee, cc-ing every other active employee but not themselves, rendered from the seeded template', () => {
    const birthdayCall = sendSpy.mock.calls.find(
      (call) => call[0].to === 'birthday.hr-events@example.com',
    );
    expect(birthdayCall).toBeDefined();
    const arg = birthdayCall![0] as {
      to: string;
      subject: string;
      html: string;
      cc?: string[];
    };
    expect(arg.subject).toBe('Happy Birthday!');
    // Rendered from the seeded BIRTHDAY template — real employee name and
    // org variables substituted in, not the raw {{placeholder}} tokens.
    expect(arg.html).toContain('Birthday Employee');
    expect(arg.html).toContain('HR Events Test Co');
    expect(arg.html).toContain('+91-9999999999');
    expect(arg.html).not.toContain('{{');
    // cc = every other active employee, excluding the birthday person.
    expect(arg.cc).toEqual(
      expect.arrayContaining([
        'hr-events-admin@example.com',
        'anniversary.hr-events@example.com',
        'unrelated.hr-events@example.com',
      ]),
    );
    expect(arg.cc).not.toContain('birthday.hr-events@example.com');
  });

  it('sends a work-anniversary wish only to the employee who joined N years ago today', async () => {
    const anniversaryNotifications = await prisma.notification.findMany({
      where: {
        organizationId,
        userId: anniversaryEmployeeId,
        title: 'Happy Work Anniversary!',
      },
    });
    expect(anniversaryNotifications.length).toBeGreaterThan(0);
    expect(anniversaryNotifications[0].message).toContain(
      '3rd work anniversary',
    );

    const unrelatedAnniversary = await prisma.notification.findMany({
      where: {
        organizationId,
        userId: unrelatedEmployeeId,
        title: 'Happy Work Anniversary!',
      },
    });
    expect(unrelatedAnniversary).toHaveLength(0);
  });

  it('sends the anniversary email rendered from the seeded template, with {{years}} substituted', () => {
    const anniversaryCall = sendSpy.mock.calls.find(
      (call) => call[0].to === 'anniversary.hr-events@example.com',
    );
    expect(anniversaryCall).toBeDefined();
    const arg = anniversaryCall![0] as {
      to: string;
      subject: string;
      html: string;
      cc?: string[];
    };
    expect(arg.subject).toBe('Happy Work Anniversary!');
    expect(arg.html).toContain('3rd work anniversary');
    expect(arg.html).toContain('Anniversary Employee');
    expect(arg.html).not.toContain('{{');
    expect(arg.cc).not.toContain('anniversary.hr-events@example.com');
  });

  it('does not send a work-anniversary wish for an employee who joined today (0 years)', async () => {
    const birthdayEmployeeAnniversary = await prisma.notification.findMany({
      where: {
        organizationId,
        userId: birthdayEmployeeId,
        title: 'Happy Work Anniversary!',
      },
    });
    expect(birthdayEmployeeAnniversary).toHaveLength(0);
  });
});
