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
interface SettingsBody {
  settings: {
    compOffExpiryDays: number;
    financialYearStartMonth: number;
    processingDay: number;
  };
  resolvedForCurrentMonth: { processingDate: string; paymentDate: string };
}

const PASSWORD = 'TestPass123!';

describe('Payroll Settings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let employeeToken: string;

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
      organizationName: 'Payroll Settings E2E Org',
      name: 'Founder',
      email: 'payrollsettings-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'payrollsettings-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'payrollsettings-e2e-emp@example.test',
      });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'payrollsettings-e2e-emp@example.test',
        password: (empCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "comp_offs", "payroll_settings", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/payroll-settings')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('GET lazily creates the singleton row with documented defaults', async () => {
    const res = await request(app.getHttpServer())
      .get('/payroll-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as SettingsBody;
    expect(body.settings.compOffExpiryDays).toBe(90);
    expect(body.settings.financialYearStartMonth).toBe(4);
    expect(body.resolvedForCurrentMonth.processingDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(body.resolvedForCurrentMonth.paymentDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('GET is idempotent — a second call does not create a second row', async () => {
    await request(app.getHttpServer())
      .get('/payroll-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = await prisma.payrollSettings.findMany();
    expect(rows).toHaveLength(1);
  });

  it('PUT updates only the fields sent, leaving the rest unchanged', async () => {
    const res = await request(app.getHttpServer())
      .put('/payroll-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ compOffExpiryDays: 30 })
      .expect(200);
    const body = res.body as SettingsBody['settings'];
    expect(body.compOffExpiryDays).toBe(30);
    expect(body.financialYearStartMonth).toBe(4); // untouched
  });

  it("CompOff.earn now reads the org's real compOffExpiryDays instead of a hardcoded default", async () => {
    const earnedForDate = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const compOff = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ earnedForDate })
      .expect(201);
    const expiryDate = (compOff.body as { expiryDate: string }).expiryDate;

    const expected = new Date(`${earnedForDate}T00:00:00.000Z`);
    expected.setUTCDate(expected.getUTCDate() + 30); // the PUT above set this to 30
    expect(expiryDate).toBe(expected.toISOString().slice(0, 10));
  });
});
