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
interface EmployeeCreateBody {
  employee: { id: string };
  generatedPassword: string;
}
interface RatingBody {
  id: string;
  employeeId: string;
  financialYear: string;
  rating: number;
  payoutPercentage: number;
}

const PASSWORD = 'TestPass123!';

describe('Performance Ratings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let deptEmployeeId: string;
  let outsideEmployeeId: string;

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
      organizationName: 'Performance E2E Org',
      name: 'Founder',
      email: 'perf-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'perf-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' });
    const departmentId = (dept.body as { id: string }).id;

    const managerCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Manager',
        email: 'perf-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'perf-e2e-manager@example.test',
        password: (managerCreate.body as EmployeeCreateBody).generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const deptEmpCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Dept Employee',
        email: 'perf-e2e-deptemp@example.test',
        departmentId,
      });
    deptEmployeeId = (deptEmpCreate.body as EmployeeCreateBody).employee.id;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'perf-e2e-outside@example.test',
      });
    outsideEmployeeId = (outsideCreate.body as EmployeeCreateBody).employee.id;

    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'perf-e2e-outside@example.test',
        password: (outsideCreate.body as EmployeeCreateBody).generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "performance_ratings", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('EMPLOYEE gets 403', async () => {
    await request(app.getHttpServer())
      .get('/performance-ratings')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('rejects an out-of-range rating and payoutPercentage', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 6,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 3,
        payoutPercentage: 250,
      })
      .expect(400);
  });

  it('MANAGER gets 403 rating an employee outside their department', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 4,
      })
      .expect(403);
  });

  it('MANAGER rates an employee in their own department; payoutPercentage defaults to 100', async () => {
    const res = await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ employeeId: deptEmployeeId, financialYear: '2026-27', rating: 4 })
      .expect(201);
    const body = res.body as RatingBody;
    expect(body.rating).toBe(4);
    expect(body.payoutPercentage).toBe(100);
  });

  it('upsert by (employee, financialYear) updates rather than duplicates', async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: deptEmployeeId,
        financialYear: '2026-27',
        rating: 5,
        payoutPercentage: 150,
      })
      .expect(201);

    const count = await prisma.performanceRating.count({
      where: { employeeId: deptEmployeeId, financialYear: '2026-27' },
    });
    expect(count).toBe(1);

    const row = await prisma.performanceRating.findFirst({
      where: { employeeId: deptEmployeeId, financialYear: '2026-27' },
    });
    expect(row?.rating).toBe(5);
    expect(row?.payoutPercentage).toBe(150);
  });

  it("MANAGER's GET is scoped to their own department", async () => {
    await request(app.getHttpServer())
      .post('/performance-ratings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: outsideEmployeeId,
        financialYear: '2026-27',
        rating: 2,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/performance-ratings')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const rows = res.body as RatingBody[];
    expect(rows.some((r) => r.employeeId === deptEmployeeId)).toBe(true);
    expect(rows.every((r) => r.employeeId !== outsideEmployeeId)).toBe(true);
  });
});
