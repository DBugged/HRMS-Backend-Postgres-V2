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
interface OrgListItemBody {
  id: string;
  type: string;
  name: string;
  isActive: boolean;
  isSystemDefault: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Org List Items (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;

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
      organizationName: 'Org List Items E2E Org',
      name: 'Founder',
      email: 'orglistitems-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'orglistitems-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "org_list_items", "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a newly-registered org gets the 4 built-in Employee Categories, marked isSystemDefault', async () => {
    const res = await request(app.getHttpServer())
      .get('/org-list-items')
      .query({ type: 'EMPLOYEE_CATEGORY' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const data = (res.body as { data: OrgListItemBody[] }).data;
    const names = data.map((i) => i.name).sort();
    expect(names).toEqual(['Contract', 'Full-Time', 'Intern', 'Part-Time']);
    expect(data.every((i) => i.isSystemDefault)).toBe(true);
  });

  it('a Designation created fresh is never built-in — no protection outside Employee Category', async () => {
    const res = await request(app.getHttpServer())
      .post('/org-list-items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'DESIGNATION', name: 'Software Engineer' })
      .expect(201);
    expect((res.body as OrgListItemBody).isSystemDefault).toBe(false);
  });

  it('a built-in Employee Category cannot be renamed or deleted, but can be deactivated', async () => {
    const list = await request(app.getHttpServer())
      .get('/org-list-items')
      .query({ type: 'EMPLOYEE_CATEGORY' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const fullTime = (list.body as { data: OrgListItemBody[] }).data.find(
      (i) => i.name === 'Full-Time',
    );
    expect(fullTime).toBeDefined();

    await request(app.getHttpServer())
      .patch(`/org-list-items/${fullTime!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Full Time (Renamed)' })
      .expect(409);
    await request(app.getHttpServer())
      .delete(`/org-list-items/${fullTime!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    const deactivated = await request(app.getHttpServer())
      .patch(`/org-list-items/${fullTime!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);
    expect((deactivated.body as OrgListItemBody).isActive).toBe(false);
  });

  it('a custom Employee Category can be renamed and deleted normally', async () => {
    const created = await request(app.getHttpServer())
      .post('/org-list-items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'EMPLOYEE_CATEGORY', name: 'Consultant' })
      .expect(201);
    const id = (created.body as OrgListItemBody).id;
    expect((created.body as OrgListItemBody).isSystemDefault).toBe(false);

    await request(app.getHttpServer())
      .patch(`/org-list-items/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Freelance Consultant' })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/org-list-items/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
