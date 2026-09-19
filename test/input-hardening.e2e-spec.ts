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

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}
const PASSWORD = 'TestPass123!';

describe('Input hardening (e2e): body sanity, type/range validation, email escaping', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let sendSpy: jest.SpyInstance<
    ReturnType<EmailService['send']>,
    Parameters<EmailService['send']>
  >;

  const admin = (m: 'post' | 'put' | 'patch', url: string) =>
    request(app.getHttpServer())
      [m](url)
      .set('Authorization', `Bearer ${adminToken}`);

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
    sendSpy = jest.spyOn(app.get(EmailService), 'send');
    const reg = await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Hardening E2E Org',
      name: 'Founder',
      email: 'hardening-admin@example.test',
      password: PASSWORD,
    });
    await prisma.organization.update({
      where: { id: (reg.body as { organizationId: string }).organizationId },
      data: { isInitialized: true },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'hardening-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "leave_types", "holidays", "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a top-level JSON array body is a 400, not a 500', async () => {
    await admin('patch', '/organizations/me').send([]).expect(400);
    await admin('put', '/payroll-settings').send([]).expect(400);
    await admin('post', '/payroll-templates').send([]).expect(400);
  });

  it('absurdly long values are rejected, while long-form text fields stay allowed', async () => {
    await admin('post', '/holidays')
      .send({ name: 'A'.repeat(3000), date: '2027-01-26' })
      .expect(400);
    await admin('patch', '/organizations/me')
      .send({ name: 'B'.repeat(3000) })
      .expect(400);
    // A template body / description may legitimately be long.
    const ok = await admin('post', '/email-templates/signatures').send({
      name: 'Long',
      html: '<p>x</p>'.repeat(2000),
    });
    expect(ok.status).toBeLessThan(300);
  });

  it('a number where text is required is a 400, not a 500', async () => {
    await admin('post', '/leave-types')
      .send({ name: 12345, code: 'QX' })
      .expect(400);
    await admin('post', '/holidays')
      .send({ name: 12345, date: '2027-01-26' })
      .expect(400);
    await admin('post', '/tax-declarations')
      .send({ financialYear: 12345 })
      .expect(400);
  });

  it('payroll settings reject negative / absurd rates and overflow-sized integers', async () => {
    for (const body of [
      { pfEmployeeRate: -5 },
      { pfEmployeeRate: 500 },
      { esiWageCeiling: -1 },
      { esiWageCeiling: 1e12 },
      { roundingDecimals: 1e18 },
      { compOffExpiryDays: 1e18 },
    ]) {
      await admin('put', '/payroll-settings').send(body).expect(400);
    }
    await admin('put', '/payroll-settings')
      .send({ pfEmployeeRate: 12, roundingDecimals: 2 })
      .expect(200);
  });

  it('tax declarations reject negative or absurd deduction amounts', async () => {
    await admin('post', '/tax-declarations')
      .send({ financialYear: '2026-27', section80E: 1e11 })
      .expect(400);
    await admin('post', '/tax-declarations')
      .send({ financialYear: '2026-27', otherDeductions: -100 })
      .expect(400);
  });

  it('emails escape user-supplied text: an employee named with HTML cannot inject markup', async () => {
    const created = await admin('post', '/employees').send({
      name: 'Eve <i>Evil</i> & Co',
      email: 'eve-hardening@example.test',
      joiningDate: '2024-01-01',
    });
    const id = (created.body as EmployeeCreateBody).employee.id;
    sendSpy.mockClear();
    await admin('patch', `/employees/${id}`)
      .send({ role: 'MANAGER' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 400));
    const mail = sendSpy.mock.calls
      .map((c) => c[0])
      .find((a) => a.to === 'eve-hardening@example.test');
    expect(mail).toBeDefined();
    expect(mail!.html).toContain('Eve &lt;i&gt;Evil&lt;/i&gt; &amp; Co');
    expect(mail!.html).not.toContain('<i>Evil</i>');
  });
});
