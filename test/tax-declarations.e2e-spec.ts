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
interface DeclarationBody {
  id: string;
  employeeId: string;
  financialYear: string;
  status: string;
  section80C: number;
}

const PASSWORD = 'TestPass123!';

describe('Tax Declarations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let hrId: string;
  let employeeToken: string;
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
      organizationName: 'Tax Declarations E2E Org',
      name: 'Founder',
      email: 'taxdecl-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'taxdecl-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'taxdecl-e2e-hr@example.test',
        role: 'HR',
      });
    hrId = (hrCreate.body as { employee: { id: string } }).employee.id;
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'taxdecl-e2e-hr@example.test',
        password: (hrCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'taxdecl-e2e-emp@example.test' });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'taxdecl-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_tax_declarations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE creates their own declaration; status stays DRAFT even if they try to set it', async () => {
    const res = await request(app.getHttpServer())
      .post('/tax-declarations')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ financialYear: '2026-27', section80C: 50000, status: 'VERIFIED' })
      .expect(201);
    const body = res.body as DeclarationBody;
    expect(body.employeeId).toBe(employeeId);
    expect(body.status).toBe('DRAFT');
    expect(body.section80C).toBe(50000);
  });

  it('EMPLOYEE can view their own declaration; GET ignores an employeeId query param for EMPLOYEE callers', async () => {
    const res = await request(app.getHttpServer())
      .get('/tax-declarations')
      .query({ employeeId: 'someone-else', financialYear: '2026-27' })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (res.body as { declaration: DeclarationBody }).declaration.employeeId,
    ).toBe(employeeId);
  });

  it("HR editing the EMPLOYEE's declaration can set status to VERIFIED", async () => {
    const res = await request(app.getHttpServer())
      .post('/tax-declarations')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ employeeId, financialYear: '2026-27', status: 'VERIFIED' })
      .expect(201);
    expect((res.body as DeclarationBody).status).toBe('VERIFIED');
  });

  it("HR editing their OWN declaration (by passing their own id) cannot self-verify, even though they're HR", async () => {
    const res = await request(app.getHttpServer())
      .post('/tax-declarations')
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ employeeId: hrId, financialYear: '2026-27', status: 'VERIFIED' })
      .expect(201);
    expect((res.body as DeclarationBody).status).not.toBe('VERIFIED');
  });

  it('one declaration per employee per financial year (unique upsert, not duplicate rows)', async () => {
    await request(app.getHttpServer())
      .post('/tax-declarations')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ financialYear: '2026-27', section80C: 75000 })
      .expect(201);

    const count = await prisma.employeeTaxDeclaration.count({
      where: { employeeId, financialYear: '2026-27' },
    });
    expect(count).toBe(1);
  });
});
