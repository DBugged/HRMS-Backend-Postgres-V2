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
interface WorkLocationBody {
  id: string;
  name: string;
  fenceType: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
}
interface CheckBody {
  inside: boolean | null;
  fenceType: string;
}

const PASSWORD = 'TestPass123!';

describe('Work Locations (e2e)', () => {
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
      organizationName: 'Work Locations E2E Org',
      name: 'Founder',
      email: 'worklocations-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'worklocations-e2e-admin@example.test',
        password: PASSWORD,
      });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Plain Employee',
        email: 'worklocations-e2e-emp@example.test',
      });
    const empPassword = (empCreate.body as { generatedPassword: string })
      .generatedPassword;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'worklocations-e2e-emp@example.test',
        password: empPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "work_locations", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let circleId: string;
  let rectangleId: string;

  it('ADMIN creates a CIRCLE work location', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HQ Mumbai',
        latitude: 19.076,
        longitude: 72.8777,
        radiusMeters: 200,
      })
      .expect(201);
    const body = res.body as WorkLocationBody;
    expect(body.fenceType).toBe('CIRCLE');
    circleId = body.id;
  });

  it('rejects a CIRCLE with missing latitude/longitude', async () => {
    await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Bad Circle' })
      .expect(400);
  });

  it('EMPLOYEE gets 403 creating a work location', async () => {
    await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ name: 'Should Fail', latitude: 19.0, longitude: 72.8 })
      .expect(403);
  });

  it('ADMIN creates a RECTANGLE work location; latitude/longitude are derived', async () => {
    const res = await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch Office',
        fenceType: 'RECTANGLE',
        boundary: {
          bounds: [
            [19.0, 72.8],
            [19.2, 73.0],
          ],
        },
      })
      .expect(201);
    const body = res.body as WorkLocationBody;
    expect(body.latitude).toBeCloseTo(19.1, 5);
    expect(body.longitude).toBeCloseTo(72.9, 5);
    rectangleId = body.id;
  });

  it('rejects a RECTANGLE with malformed bounds', async () => {
    await request(app.getHttpServer())
      .post('/work-locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Bad Rectangle',
        fenceType: 'RECTANGLE',
        boundary: { bounds: [[19.0, 72.8]] },
      })
      .expect(400);
  });

  it('any authenticated caller can list work locations, filtered by search', async () => {
    const res = await request(app.getHttpServer())
      .get('/work-locations')
      .query({ search: 'HQ' })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = (res.body as { data: WorkLocationBody[] }).data;
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('HQ Mumbai');
  });

  it('GET /:id/check returns true for a point inside the circle fence', async () => {
    const res = await request(app.getHttpServer())
      .get(`/work-locations/${circleId}/check`)
      .query({ latitude: 19.076, longitude: 72.8777 })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as CheckBody).inside).toBe(true);
  });

  it('GET /:id/check returns false for a point far outside the fence', async () => {
    const res = await request(app.getHttpServer())
      .get(`/work-locations/${circleId}/check`)
      .query({ latitude: 25.0, longitude: 80.0 })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as CheckBody).inside).toBe(false);
  });

  it('GET /:id/check for the rectangle fence', async () => {
    const res = await request(app.getHttpServer())
      .get(`/work-locations/${rectangleId}/check`)
      .query({ latitude: 19.1, longitude: 72.9 })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((res.body as CheckBody).inside).toBe(true);
  });

  it('ADMIN toggles isActive without touching geometry', async () => {
    const res = await request(app.getHttpServer())
      .put(`/work-locations/${circleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);
    const body = res.body as WorkLocationBody;
    expect(body.isActive).toBe(false);
    expect(body.latitude).toBeCloseTo(19.076, 3);
  });

  it('activeOnly filter excludes the deactivated location', async () => {
    const res = await request(app.getHttpServer())
      .get('/work-locations')
      .query({ activeOnly: 'true' })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = (res.body as { data: WorkLocationBody[] }).data;
    expect(body.find((l) => l.id === circleId)).toBeUndefined();
  });

  it('ADMIN deletes a work location', async () => {
    await request(app.getHttpServer())
      .delete(`/work-locations/${rectangleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/work-locations/${rectangleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
