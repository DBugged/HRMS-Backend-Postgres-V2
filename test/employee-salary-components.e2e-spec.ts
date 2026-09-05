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
interface ComponentBody {
  id: string;
  code: string;
}
interface StructureRow {
  id: string | null;
  componentCode: string;
  fixedAmount: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  synthesized?: boolean;
}

const PASSWORD = 'TestPass123!';

function offsetDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Employee Salary Components (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let employeeToken: string;
  let employeeId: string;
  let basicId: string;

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
      organizationName: 'Employee Salary E2E Org',
      name: 'Founder',
      email: 'empsal-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'empsal-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'empsal-e2e-emp@example.test' });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'empsal-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const basic = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Basic Pay', type: 'EARNING', defaultValue: 30000 });
    basicId = (basic.body as ComponentBody).id;

    // Named/coded distinctly from 'HRA' — that code collides with the
    // auto-seeded default (see SalaryComponentsService.seedDefaults).
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HRA Test',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'BASIC_PAY',
        percentageValue: 40,
      })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_salary_components", "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a percentage component with no override is synthesized into the structure', async () => {
    const res = await request(app.getHttpServer())
      .get(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const structure = (res.body as { structure: StructureRow[] }).structure;
    const hra = structure.find((r) => r.componentCode === 'HRA');
    expect(hra).toMatchObject({ id: null, synthesized: true });
    expect(
      structure.find((r) => r.componentCode === 'BASIC_PAY'),
    ).toBeUndefined();
  });

  it('EMPLOYEE can view their own structure', async () => {
    await request(app.getHttpServer())
      .get(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
  });

  it('EMPLOYEE can view their own history (SelfOrRoles, same as structure) but gets 403 setting values', async () => {
    await request(app.getHttpServer())
      .get(`/employee-salary/${employeeId}/history`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ componentCode: 'BASIC_PAY', fixedAmount: 30000 })
      .expect(403);
  });

  it('ADMIN sets a fixed override for BASIC_PAY', async () => {
    const res = await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        componentCode: 'BASIC_PAY',
        valueType: 'FIXED',
        fixedAmount: 30000,
        effectiveFrom: offsetDate(0),
      })
      .expect(201);
    expect((res.body as StructureRow).fixedAmount).toBe(30000);

    const structure = await request(app.getHttpServer())
      .get(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const basicRow = (
      structure.body as { structure: StructureRow[] }
    ).structure.find((r) => r.componentCode === 'BASIC_PAY');
    expect(basicRow?.fixedAmount).toBe(30000);
  });

  it('revising BASIC_PAY closes out the old row and inserts a new one', async () => {
    const revisionDate = offsetDate(30);
    await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        componentId: basicId,
        valueType: 'FIXED',
        fixedAmount: 35000,
        effectiveFrom: revisionDate,
        revisionNote: 'Annual hike',
      })
      .expect(201);

    const history = await request(app.getHttpServer())
      .get(`/employee-salary/${employeeId}/history`)
      .query({ componentCode: 'BASIC_PAY' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = history.body as StructureRow[];
    expect(rows).toHaveLength(2);

    const closed = rows.find((r) => r.fixedAmount === 30000);
    const current = rows.find((r) => r.fixedAmount === 35000);
    expect(closed?.effectiveTo).not.toBeNull();
    expect(current?.effectiveTo).toBeNull();
  });

  it('POST /structure/bulk applies multiple lines, skipping unresolvable components', async () => {
    const res = await request(app.getHttpServer())
      .post(`/employee-salary/${employeeId}/structure/bulk`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        effectiveFrom: offsetDate(60),
        lines: [
          {
            componentCode: 'BASIC_PAY',
            valueType: 'FIXED',
            fixedAmount: 40000,
          },
          {
            componentCode: 'DOES_NOT_EXIST',
            valueType: 'FIXED',
            fixedAmount: 1,
          },
        ],
      })
      .expect(201);
    expect((res.body as { count: number }).count).toBe(1);
  });
});
