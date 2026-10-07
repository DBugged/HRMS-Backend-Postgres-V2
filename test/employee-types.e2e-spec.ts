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
interface EmployeeTypeBody {
  value: string;
  label: string;
  isCustom: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Employee Types (e2e)', () => {
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
      organizationName: 'Employee Types E2E Org',
      name: 'Founder',
      email: 'employeetypes-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'employeetypes-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a custom employee type assigned to an employee cannot be deleted, but can once reassigned', async () => {
    await request(app.getHttpServer())
      .post('/organizations/employee-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Freelance Contractor' })
      .expect(201);

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Employee Type User',
        email: 'employeetypes-e2e-emp@example.test',
        employeeType: 'freelance_contractor',
      })
      .expect(201);
    const employeeId = (emp.body as { employee: { id: string } }).employee.id;

    const blocked = await request(app.getHttpServer())
      .delete('/organizations/employee-types/freelance_contractor')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect((blocked.body as { message: string }).message).toContain('1');

    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ employeeType: 'permanent' })
      .expect(200);

    await request(app.getHttpServer())
      .delete('/organizations/employee-types/freelance_contractor')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/organizations/employee-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (list.body as EmployeeTypeBody[]).some(
        (t) => t.value === 'freelance_contractor',
      ),
    ).toBe(false);
  });
});
