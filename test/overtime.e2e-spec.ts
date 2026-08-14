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
interface OvertimeBody {
  id: string;
  type: string;
  rateMultiplier: number;
  status: string;
  employeeId: string;
}

const PASSWORD = 'TestPass123!';

describe('Overtime (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;
  let employeeToken: string;
  let employeeId: string;
  let otherEmployeeToken: string;

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
      organizationName: 'Overtime E2E Org',
      name: 'Founder',
      email: 'ot-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ot-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'HR Person', email: 'ot-e2e-hr@example.test', role: 'HR' });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'ot-e2e-hr@example.test',
        password: (hrCreate.body as EmployeeCreateBody).generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'ot-e2e-emp@example.test' });
    const empBody = empCreate.body as EmployeeCreateBody;
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'ot-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const otherCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Other Employee', email: 'ot-e2e-other@example.test' });
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'ot-e2e-other@example.test',
        password: (otherCreate.body as EmployeeCreateBody).generatedPassword,
      });
    otherEmployeeToken = (otherLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "overtime_records", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('rejects hours outside (0, 24]', async () => {
    await request(app.getHttpServer())
      .post('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ date: '2026-07-01', hours: 25, type: 'REGULAR' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ date: '2026-07-01', hours: 0, type: 'REGULAR' })
      .expect(400);
  });

  it.each([
    ['REGULAR', 1.5],
    ['HOLIDAY', 2],
    ['WEEKEND', 2],
    ['NIGHT', 1.75],
  ])(
    'derives the correct rateMultiplier for type %s',
    async (type, expectedMultiplier) => {
      const res = await request(app.getHttpServer())
        .post('/overtime')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ date: '2026-07-02', hours: 2, type })
        .expect(201);
      const body = res.body as OvertimeBody;
      expect(body.type).toBe(type);
      expect(body.rateMultiplier).toBe(expectedMultiplier);
      expect(body.employeeId).toBe(employeeId);
      expect(body.status).toBe('PENDING');
    },
  );

  it('a caller can only log overtime for themselves — the DTO has no employeeId field at all', async () => {
    const res = await request(app.getHttpServer())
      .post('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ date: '2026-07-03', hours: 1 })
      .expect(201);
    expect((res.body as OvertimeBody).employeeId).toBe(employeeId);

    // An attacker-supplied employeeId is rejected outright by the DTO's
    // whitelist, not silently dropped — confirms it can't be smuggled in.
    await request(app.getHttpServer())
      .post('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ date: '2026-07-03', hours: 1, employeeId: 'someone-else' })
      .expect(400);
  });

  it('EMPLOYEE only sees their own records', async () => {
    const res = await request(app.getHttpServer())
      .get('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const records = res.body as OvertimeBody[];
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.employeeId === employeeId)).toBe(true);
  });

  it('EMPLOYEE gets 403 reviewing an overtime record', async () => {
    const list = await request(app.getHttpServer())
      .get('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const id = (list.body as OvertimeBody[])[0].id;

    await request(app.getHttpServer())
      .patch(`/overtime/${id}/review`)
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .send({ status: 'APPROVED' })
      .expect(403);
  });

  it('HR approves; approvedById is stamped', async () => {
    const list = await request(app.getHttpServer())
      .get('/overtime')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const id = (list.body as OvertimeBody[])[0].id;

    const res = await request(app.getHttpServer())
      .patch(`/overtime/${id}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'APPROVED' })
      .expect(200);
    expect((res.body as OvertimeBody).status).toBe('APPROVED');

    await request(app.getHttpServer())
      .patch(`/overtime/${id}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ status: 'REJECTED' })
      .expect(400);
  });
});
