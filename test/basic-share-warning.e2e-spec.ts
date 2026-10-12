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

// Saving a structure whose Basic + DA is under half of the monthly pay answers with a warning (and still saves).
describe('Basic share warning on salary structure save (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let employeeId: string;

  const bulk = (lines: Array<Record<string, unknown>>) =>
    request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure/bulk`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lines, effectiveFrom: '2026-10-01' });

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
      organizationName: 'Basic Share E2E Org',
      name: 'Founder',
      email: 'basic-share-admin@example.test',
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'basic-share-admin@example.test', password: PASSWORD });
    adminToken = (login.body as { accessToken: string }).accessToken;
    const created = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Share Tester',
        email: 'basic-share-emp@example.test',
        joiningDate: '2026-04-01',
      });
    employeeId = (created.body as { employee: { id: string } }).employee.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('warns when Basic + DA is under 50% of monthly pay, and still saves', async () => {
    const res = await bulk([
      { componentCode: 'BASIC', valueType: 'FIXED', fixedAmount: 30000 },
      {
        componentCode: 'SPECIAL_ALLOWANCE',
        valueType: 'FIXED',
        fixedAmount: 70000,
      },
    ]).expect(201);
    const body = res.body as { count: number; warnings: string[] };
    expect(body.count).toBe(2);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/Labour Code/);
    expect(body.warnings[0]).toMatch(/at least 50%/);
  });

  it('gives no warning once Basic is half or more', async () => {
    const res = await bulk([
      { componentCode: 'BASIC', valueType: 'FIXED', fixedAmount: 70000 },
      {
        componentCode: 'SPECIAL_ALLOWANCE',
        valueType: 'FIXED',
        fixedAmount: 20000,
      },
    ]).expect(201);
    expect((res.body as { warnings: string[] }).warnings).toEqual([]);
  });
});
