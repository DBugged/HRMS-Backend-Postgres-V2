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
interface WorkScheduleBody {
  id: string;
  name: string;
}
interface DepartmentBody {
  id: string;
  name: string;
  workScheduleId: string | null;
}

const PASSWORD = 'TestPass123!';

describe('Work Schedules (e2e)', () => {
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
      organizationName: 'Work Schedules E2E Org',
      name: 'Founder',
      email: 'workschedules-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'workschedules-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "work_schedules", "departments", "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('a work schedule assigned to a department cannot be deleted, but can once unassigned', async () => {
    const schedule = await request(app.getHttpServer())
      .post('/work-schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'General Shift',
        workingDays: [1, 2, 3, 4, 5],
        startTime: '09:30',
        endTime: '18:30',
        breakMinutes: 60,
      })
      .expect(201);
    const scheduleId = (schedule.body as WorkScheduleBody).id;

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' })
      .expect(201);
    const deptId = (dept.body as DepartmentBody).id;

    await request(app.getHttpServer())
      .post(`/work-schedules/${scheduleId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ departmentIds: [deptId] })
      .expect(201);

    const blocked = await request(app.getHttpServer())
      .delete(`/work-schedules/${scheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect((blocked.body as { message: string }).message).toContain(
      'Engineering',
    );

    const stillAssigned = await request(app.getHttpServer())
      .get('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const dept2 = (stillAssigned.body as { data: DepartmentBody[] }).data.find(
      (d) => d.id === deptId,
    )!;
    expect(dept2.workScheduleId).toBe(scheduleId);

    await request(app.getHttpServer())
      .post(`/work-schedules/${scheduleId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ departmentIds: [] })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/work-schedules/${scheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
