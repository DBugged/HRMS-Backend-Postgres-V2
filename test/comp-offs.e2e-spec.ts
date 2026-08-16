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
interface CompOffBody {
  id: string;
  employeeId: string;
  status: string;
  daysEarned: number;
  daysAvailed: number;
  employee?: { id: string; name: string; employeeId: string };
}

const PASSWORD = 'TestPass123!';

describe('Comp-Offs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let managerToken: string;
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
      organizationName: 'Comp-Offs E2E Org',
      name: 'Founder',
      email: 'compoffs-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'compoffs-e2e-admin@example.test', password: PASSWORD });
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
        email: 'compoffs-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    const managerPassword = (
      managerCreate.body as { generatedPassword: string }
    ).generatedPassword;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'compoffs-e2e-manager@example.test',
        password: managerPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'compoffs-e2e-emp@example.test',
        departmentId,
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'compoffs-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "comp_offs", "leave_balances", "leaves", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const pastDate = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 2);
    return d.toISOString().slice(0, 10);
  };

  let compOffId: string;

  it('EMPLOYEE earns a comp-off for a worked date', async () => {
    const res = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: pastDate(), reason: 'Worked the weekend' })
      .expect(201);
    const body = res.body as CompOffBody;
    expect(body.status).toBe('PENDING');
    expect(body.employeeId).toBe(employeeId);
    compOffId = body.id;
  });

  it('rejects a future earnedForDate', async () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 5);
    await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: future.toISOString().slice(0, 10) })
      .expect(400);
  });

  it('EMPLOYEE only sees their own comp-offs; MANAGER sees the whole department', async () => {
    const selfList = await request(app.getHttpServer())
      .get('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((selfList.body as { data: CompOffBody[] }).data).toHaveLength(1);

    const deptList = await request(app.getHttpServer())
      .get('/comp-offs')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const deptBody = (deptList.body as { data: CompOffBody[] }).data;
    expect(deptBody.some((c) => c.id === compOffId)).toBe(true);
    expect(deptBody.find((c) => c.id === compOffId)?.employee?.id).toBe(
      deptBody.find((c) => c.id === compOffId)?.employeeId,
    );
  });

  it('EMPLOYEE gets 403 reviewing a comp-off', async () => {
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('MANAGER approves the comp-off', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    expect((res.body as CompOffBody).status).toBe('APPROVED');
  });

  it('rejects reviewing an already-reviewed comp-off', async () => {
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'REJECTED' })
      .expect(400);
  });

  it('GET /comp-offs/balance reflects the approved, unconsumed comp-off', async () => {
    const res = await request(app.getHttpServer())
      .get('/comp-offs/balance')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as { available: number }).available).toBe(1);
  });

  it('MANAGER earns a comp-off on behalf of the employee', async () => {
    const res = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ earnedForDate: pastDate(), employeeId, reason: 'Manager-raised' })
      .expect(201);
    expect((res.body as CompOffBody).employeeId).toBe(employeeId);
  });
});
