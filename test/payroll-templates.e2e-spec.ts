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
interface TemplateBody {
  id: string;
  name: string;
  isDefault: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Payroll Templates (e2e)', () => {
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
      organizationName: 'Payroll Templates E2E Org',
      name: 'Founder',
      email: 'payrolltpl-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'payrolltpl-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'payrolltpl-e2e-emp@example.test',
      });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'payrolltpl-e2e-emp@example.test',
        password: (empCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_templates", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let firstId: string;
  let secondId: string;

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/payroll-templates')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('the first template created for an org is forced isDefault regardless of body', async () => {
    const res = await request(app.getHttpServer())
      .post('/payroll-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Standard', isDefault: false })
      .expect(201);
    const body = res.body as TemplateBody;
    expect(body.isDefault).toBe(true);
    firstId = body.id;
  });

  it('a second template is not default by default', async () => {
    const res = await request(app.getHttpServer())
      .post('/payroll-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alternate' })
      .expect(201);
    const body = res.body as TemplateBody;
    expect(body.isDefault).toBe(false);
    secondId = body.id;
  });

  it('PUT ignores isDefault in the payload', async () => {
    const res = await request(app.getHttpServer())
      .put(`/payroll-templates/${secondId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Alternate Renamed', showCTC: false })
      .expect(200);
    const body = res.body as TemplateBody & { showCTC: boolean };
    expect(body.name).toBe('Alternate Renamed');
    expect(body.isDefault).toBe(false);
    expect(body.showCTC).toBe(false);
  });

  it('DELETE is blocked while the template is default', async () => {
    await request(app.getHttpServer())
      .delete(`/payroll-templates/${firstId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('set-default flips the default and unsets the old one', async () => {
    const res = await request(app.getHttpServer())
      .post(`/payroll-templates/${secondId}/set-default`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((res.body as TemplateBody).isDefault).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/payroll-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const templates = (list.body as { data: TemplateBody[] }).data;
    expect(templates.find((t) => t.id === firstId)?.isDefault).toBe(false);
    expect(templates.find((t) => t.id === secondId)?.isDefault).toBe(true);
  });

  it('the now-non-default template can be deleted', async () => {
    await request(app.getHttpServer())
      .delete(`/payroll-templates/${firstId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/payroll-templates/${firstId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('draft preview renders a PDF from an in-progress, unsaved editor config', async () => {
    const res = await request(app.getHttpServer())
      .post('/payroll-templates/draft/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Unsaved Draft', primaryColor: '#123456' })
      .expect(201);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(
      1000,
    );
  });

  it('saved-template preview renders a PDF for an existing template', async () => {
    const res = await request(app.getHttpServer())
      .post(`/payroll-templates/${secondId}/preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(
      1000,
    );
  });

  it('404s previewing a non-existent saved template', async () => {
    await request(app.getHttpServer())
      .post('/payroll-templates/00000000-0000-4000-8000-000000000000/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
