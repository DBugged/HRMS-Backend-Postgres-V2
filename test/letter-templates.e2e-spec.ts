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
interface LetterTemplateBody {
  id: string;
  key: string;
  bodyText: string;
}

const PASSWORD = 'TestPass123!';

// Covers the rich-text formatting added to Letter Templates: the incoming
// bodyText is sanitized down to bold/italic/underline/lists before it's
// stored (see rich-text-sanitizer.ts), and a template with that surviving
// markup still generates a PDF without erroring (letter-pdf.service.ts's
// inline-run parser / rich-text-blocks.ts's paragraph splitter).
describe('Letter Templates rich text (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let employeeId: string;

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
      organizationName: 'Letter Templates Rich Text E2E Org',
      name: 'Founder',
      email: 'lt-richtext-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lt-richtext-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'lt-richtext-e2e-emp@example.test',
      });
    employeeId = (empCreate.body as { employee: { id: string } }).employee.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_timeline", "audit_logs", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('creating a template strips disallowed tags/attributes but keeps bold/italic/underline/lists', async () => {
    const bodyText =
      '<p>Dear <b>{{employeeName}}</b>,</p>' +
      '<p onclick="alert(1)" style="color:red">This confirms <i>your</i> <u>appointment</u>.</p>' +
      '<script>alert("xss")</script>' +
      '<img src="x" onerror="alert(1)" />' +
      '<ul><li>Role: {{designation}}</li><li>Department: {{department}}</li></ul>';

    const res = await request(app.getHttpServer())
      .post('/letter-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Rich Text E2E Template',
        title: 'Rich Text Certificate',
        bodyText,
        addressedToEmployee: true,
        dataProfile: 'BASIC',
      })
      .expect(201);

    const created = res.body as LetterTemplateBody;
    expect(created.bodyText).toContain('<b>{{employeeName}}</b>');
    expect(created.bodyText).toContain('<i>your</i>');
    expect(created.bodyText).toContain('<u>appointment</u>');
    expect(created.bodyText).toContain('<ul><li>Role: {{designation}}</li>');
    expect(created.bodyText).not.toContain('<script');
    expect(created.bodyText).not.toContain('alert(');
    expect(created.bodyText).not.toContain('<img');
    expect(created.bodyText).not.toContain('onclick');
    expect(created.bodyText).not.toContain('onerror');
    expect(created.bodyText).not.toContain('style=');

    // Generating a PDF from the sanitized, formatted body must not error.
    const download = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/${created.key}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect((download.body as Buffer).length).toBeGreaterThan(0);

    // Updating with an even more malicious payload sanitizes the same way.
    const updateRes = await request(app.getHttpServer())
      .put(`/letter-templates/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        bodyText:
          '<p>Hello <strong>there</strong></p>' +
          '<div class="wrapper"><span onclick="steal()">nested</span></div>' +
          '<ol><li>First</li><li>Second</li></ol>',
      })
      .expect(200);
    const updated = updateRes.body as LetterTemplateBody;
    expect(updated.bodyText).toContain('<strong>there</strong>');
    expect(updated.bodyText).toContain(
      '<ol><li>First</li><li>Second</li></ol>',
    );
    expect(updated.bodyText).toContain('nested');
    expect(updated.bodyText).not.toContain('<div');
    expect(updated.bodyText).not.toContain('<span');
    expect(updated.bodyText).not.toContain('onclick');

    // PDF generation still doesn't error after the update.
    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/${created.key}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('legacy plain-text (no tags) bodies are stored and rendered unchanged', async () => {
    const bodyText =
      'Dear {{employeeName}},\n\nThis is to certify...\n\nRegards,';
    const res = await request(app.getHttpServer())
      .post('/letter-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Text E2E Template',
        title: 'Plain Certificate',
        bodyText,
        addressedToEmployee: false,
        dataProfile: 'BASIC',
      })
      .expect(201);

    const created = res.body as LetterTemplateBody;
    expect(created.bodyText).toBe(bodyText);

    await request(app.getHttpServer())
      .get(`/employees/${employeeId}/letters/${created.key}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
