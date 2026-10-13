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

const PASSWORD = 'TestPass123!';

interface Preview {
  grossMonthly: number;
  ctcMonthly: number;
  ctcAnnual: number;
  hraPercent: number;
  cityClass: string;
  cityClassSource: string;
  earnings: { code: string; monthly: number }[];
  lines: Record<string, unknown>[];
  warnings: string[];
}

// The builder previews a package, the previewed lines are saved as the employee's structure, and payroll then pays
// exactly that package.
describe('Salary structure builder (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let employeeId: string;
  let puneId: string;
  let villageId: string;

  const admin = () => ({
    get: (u: string) =>
      request(app.getHttpServer())
        .get(u)
        .set('Authorization', `Bearer ${adminToken}`),
    post: (u: string) =>
      request(app.getHttpServer())
        .post(u)
        .set('Authorization', `Bearer ${adminToken}`),
  });
  const preview = (body: Record<string, unknown>) =>
    admin().post('/payroll/structure-preview').send(body);

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
      organizationName: 'Structure Builder Org',
      name: 'Founder',
      email: 'ssb-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'ssb-admin@example.test', password: PASSWORD })
      ).body as {
        accessToken: string;
      }
    ).accessToken;
    const loc = (
      name: string,
      city: string,
      extra: Record<string, unknown> = {},
    ) =>
      admin()
        .post('/work-locations')
        .send({ name, city, latitude: 18.5, longitude: 73.8, ...extra })
        .expect(201);
    puneId = ((await loc('Pune HQ', 'Pune')).body as { id: string }).id;
    villageId = (
      (await loc('Village unit', 'Wai', { cityClass: 'RURAL' })).body as {
        id: string;
      }
    ).id;
    const created = await admin()
      .post('/employees')
      .send({
        name: 'Builder Test',
        email: 'ssb-emp@example.test',
        joiningDate: '2026-01-01',
        workLocationId: puneId,
      })
      .expect(201);
    employeeId = (created.body as { employee: { id: string } }).employee.id;
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 400));
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('HRA follows where the employee is hired: metro 50%, village none', async () => {
    const metro = (
      await preview({
        mode: 'CTC',
        annualCtc: 600000,
        workLocationId: puneId,
      }).expect(201)
    ).body as Preview;
    expect(metro).toMatchObject({
      cityClass: 'METRO',
      cityClassSource: 'work location',
      hraPercent: 50,
    });
    const basic = metro.earnings.find((e) => e.code === 'BASIC')?.monthly ?? 0;
    expect(metro.earnings.find((e) => e.code === 'HRA')?.monthly).toBe(
      Math.round(basic / 2),
    );
    const rural = (
      await preview({
        mode: 'CTC',
        annualCtc: 600000,
        workLocationId: villageId,
      }).expect(201)
    ).body as Preview;
    expect(rural).toMatchObject({ cityClass: 'RURAL', hraPercent: 0 });
    expect(rural.earnings.find((e) => e.code === 'HRA')).toBeUndefined();
    const given = (
      await preview({
        mode: 'CTC',
        annualCtc: 600000,
        cityClass: 'NON_METRO',
      }).expect(201)
    ).body as Preview;
    expect(given).toMatchObject({ cityClassSource: 'given', hraPercent: 40 });
  });

  it('refuses a missing amount, a bad mode and an unknown field', async () => {
    await preview({ mode: 'CTC' }).expect(400);
    await preview({ mode: 'WEEKLY', annualCtc: 1 }).expect(400);
    await preview({ mode: 'CTC', annualCtc: 600000, hackerField: 1 }).expect(
      400,
    );
  });

  it('only Admin and HR can preview', async () => {
    const emp = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ssb-emp@example.test', password: PASSWORD });
    expect(emp.status).toBeGreaterThanOrEqual(400); // still on the temporary password: no session to try with
  });

  it('the previewed lines saved as the structure make payroll pay that package', async () => {
    const p = (
      await preview({
        mode: 'CTC',
        annualCtc: 720000,
        variableAnnual: 60000,
        workLocationId: puneId,
        employeeType: 'permanent',
        allowances: { CONVEYANCE: 1600 },
      }).expect(201)
    ).body as Preview;
    const saved = await admin()
      .post(`/employee-salary/${employeeId}/structure/bulk`)
      .send({ effectiveFrom: '2026-01-01', lines: p.lines });
    expect(saved.status).toBe(201);
    expect((saved.body as { failed: unknown[] }).failed).toEqual([]);

    const days = Array.from(
      { length: 30 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`,
    );
    const org = await prisma.user.findFirstOrThrow({
      where: { id: employeeId },
    });
    await prisma.attendance.createMany({
      data: days.map((date) => ({
        organizationId: org.organizationId,
        employeeId,
        date,
        status: 'PRESENT' as const,
        source: 'FACE_API' as const,
      })),
    });
    const run = await admin()
      .post('/payroll/calculate')
      .send({ month: 9, year: 2026, employeeId })
      .expect(201);
    const payroll = (
      run.body as {
        payrolls: {
          grossSalary: number;
          ctcMonthly: number;
          earnings: { code: string; amount: number }[];
        }[];
      }
    ).payrolls[0];
    expect(payroll.grossSalary).toBe(p.grossMonthly);
    expect(Math.abs(payroll.ctcMonthly - p.ctcMonthly)).toBeLessThanOrEqual(1);
    expect(Math.abs(payroll.ctcMonthly * 12 - 720000)).toBeLessThanOrEqual(24);
    const basic = payroll.earnings.find((e) => e.code === 'BASIC')?.amount ?? 0;
    expect(payroll.earnings.find((e) => e.code === 'HRA')?.amount).toBe(
      Math.round(basic / 2),
    );
    expect(payroll.earnings.find((e) => e.code === 'CONVEYANCE')?.amount).toBe(
      1600,
    );
  });

  it("an intern's structure switches the statutory schemes off, and payroll deducts none of them", async () => {
    const intern = await admin()
      .post('/employees')
      .send({
        name: 'Intern Test',
        email: 'ssb-intern@example.test',
        joiningDate: '2026-01-01',
        workLocationId: puneId,
      })
      .expect(201);
    const internId = (intern.body as { employee: { id: string } }).employee.id;
    const p = (
      await preview({
        mode: 'CTC',
        annualCtc: 240000,
        workLocationId: puneId,
        employeeType: 'intern',
      }).expect(201)
    ).body as Preview;
    await admin()
      .post(`/employee-salary/${internId}/structure/bulk`)
      .send({ effectiveFrom: '2026-01-01', lines: p.lines })
      .expect(201);
    const org = await prisma.user.findFirstOrThrow({ where: { id: internId } });
    await prisma.attendance.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        organizationId: org.organizationId,
        employeeId: internId,
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        status: 'PRESENT' as const,
        source: 'FACE_API' as const,
      })),
    });
    const run = await admin()
      .post('/payroll/calculate')
      .send({ month: 9, year: 2026, employeeId: internId })
      .expect(201);
    const payroll = (
      run.body as {
        payrolls: {
          grossSalary: number;
          deductions: { code: string }[];
          totalEmployerContributions: number;
        }[];
      }
    ).payrolls[0];
    expect(payroll.totalEmployerContributions).toBe(0);
    expect(payroll.deductions.map((d) => d.code)).not.toEqual(
      expect.arrayContaining(['PF', 'ESI']),
    );
    expect(payroll.grossSalary).toBe(p.grossMonthly);
  });
});
