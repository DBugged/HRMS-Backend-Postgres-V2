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
import { renderTemplate } from '../src/email-templates/render-template';

interface AuthBody {
  accessToken: string;
}
interface EmailTemplateBody {
  id: string;
  occasionKey: string;
  name: string;
  subject: string;
  bodyHtml: string;
  ccAllActive: boolean;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

describe('EmailTemplates (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let employeeToken: string;
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

    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Email Templates E2E Org',
        name: 'Founder',
        email: 'email-templates-admin@example.test',
        password: PASSWORD,
      });
    organizationId = (registerRes.body as { organizationId: string })
      .organizationId;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { isInitialized: true },
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'email-templates-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'email-templates-emp@example.test',
      });
    const empPassword = (empCreate.body as { generatedPassword: string })
      .generatedPassword;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'email-templates-emp@example.test',
        password: empPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('seeds BIRTHDAY and WORK_ANNIVERSARY templates at registration', async () => {
    const res = await request(app.getHttpServer())
      .get('/email-templates')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const data = (res.body as { data: EmailTemplateBody[] }).data;
    const occasionKeys = data.map((t) => t.occasionKey).sort();
    expect(occasionKeys).toEqual(['BIRTHDAY', 'WORK_ANNIVERSARY']);
    expect(data.every((t) => t.isActive)).toBe(true);
  });

  it('any authenticated caller can get a template by occasionKey', async () => {
    const res = await request(app.getHttpServer())
      .get('/email-templates/BIRTHDAY')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as EmailTemplateBody).occasionKey).toBe('BIRTHDAY');
  });

  it('404s for an unknown occasionKey', async () => {
    await request(app.getHttpServer())
      .get('/email-templates/NOT_A_REAL_OCCASION')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('EMPLOYEE gets 403 updating a template', async () => {
    await request(app.getHttpServer())
      .put('/email-templates/BIRTHDAY')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ subject: 'Should Fail' })
      .expect(403);
  });

  it('ADMIN can update a template subject/body/ccAllActive, and it is audit-logged', async () => {
    const res = await request(app.getHttpServer())
      .put('/email-templates/BIRTHDAY')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        subject: 'Wishing You a Wonderful Birthday, {{employeeName}}!',
        ccAllActive: false,
      })
      .expect(200);
    const body = res.body as EmailTemplateBody;
    expect(body.subject).toBe(
      'Wishing You a Wonderful Birthday, {{employeeName}}!',
    );
    expect(body.ccAllActive).toBe(false);

    const auditRows = await prisma.auditLog.findMany({
      where: { organizationId, action: 'EMAIL_TEMPLATE_UPDATED' },
    });
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it('HR can update a template (not just ADMIN)', async () => {
    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'email-templates-hr@example.test',
        role: 'HR',
      });
    const hrPassword = (hrCreate.body as { generatedPassword: string })
      .generatedPassword;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'email-templates-hr@example.test', password: hrPassword });
    const hrToken = (hrLogin.body as AuthBody).accessToken;

    await request(app.getHttpServer())
      .put('/email-templates/WORK_ANNIVERSARY')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ isActive: false })
      .expect(200);
  });

  it('render() substitutes every matching {{key}} and leaves unknown placeholders untouched', () => {
    const rendered = renderTemplate(
      'Hi {{employeeName}}, happy {{years}} anniversary at {{companyName}}! {{unknownKey}}',
      { employeeName: 'Jane', years: '5th', companyName: 'Acme Co' },
    );
    expect(rendered).toBe(
      'Hi Jane, happy 5th anniversary at Acme Co! {{unknownKey}}',
    );
  });

  it('render() handles repeated and whitespace-padded placeholders', () => {
    const rendered = renderTemplate(
      '{{ employeeName }} and {{employeeName}} again',
      { employeeName: 'Sam' },
    );
    expect(rendered).toBe('Sam and Sam again');
  });
});
