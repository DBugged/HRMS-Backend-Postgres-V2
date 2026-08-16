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
interface SlabConfigBody {
  id: string;
  financialYear: string;
  regime: string;
  standardDeduction: number;
}

const PASSWORD = 'TestPass123!';

describe('Tax Slabs (e2e)', () => {
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
      organizationName: 'Tax Slabs E2E Org',
      name: 'Founder',
      email: 'taxslabs-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'taxslabs-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'taxslabs-e2e-emp@example.test' });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'taxslabs-e2e-emp@example.test',
        password: (empCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "tax_slab_configs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/tax-slabs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('GET /defaults returns the static reference dataset for each regime', async () => {
    const oldRes = await request(app.getHttpServer())
      .get('/tax-slabs/defaults')
      .query({ regime: 'old' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (oldRes.body as { standardDeduction: number }).standardDeduction,
    ).toBe(50000);

    const newRes = await request(app.getHttpServer())
      .get('/tax-slabs/defaults')
      .query({ regime: 'new' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (newRes.body as { standardDeduction: number }).standardDeduction,
    ).toBe(75000);
  });

  it('rejects an invalid regime for defaults', async () => {
    await request(app.getHttpServer())
      .get('/tax-slabs/defaults')
      .query({ regime: 'flat' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('upserts a tax slab config by (financialYear, regime)', async () => {
    const created = await request(app.getHttpServer())
      .post('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        financialYear: '2026-27',
        regime: 'NEW',
        standardDeduction: 80000,
      })
      .expect(201);
    expect((created.body as SlabConfigBody).standardDeduction).toBe(80000);
    const id = (created.body as SlabConfigBody).id;

    const updated = await request(app.getHttpServer())
      .post('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        financialYear: '2026-27',
        regime: 'NEW',
        standardDeduction: 90000,
      })
      .expect(201);
    expect((updated.body as SlabConfigBody).id).toBe(id); // same row, updated not duplicated
    expect((updated.body as SlabConfigBody).standardDeduction).toBe(90000);
  });

  it('GET / filters by financialYear', async () => {
    await request(app.getHttpServer())
      .post('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ financialYear: '2025-26', regime: 'OLD' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/tax-slabs')
      .query({ financialYear: '2026-27' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = (res.body as { data: SlabConfigBody[] }).data;
    expect(rows.every((r) => r.financialYear === '2026-27')).toBe(true);
  });

  it('DELETE removes a config', async () => {
    const list = await request(app.getHttpServer())
      .get('/tax-slabs')
      .query({ financialYear: '2025-26' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const id = (list.body as { data: SlabConfigBody[] }).data[0].id;

    await request(app.getHttpServer())
      .delete(`/tax-slabs/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
