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
import * as bcrypt from 'bcrypt';

const PASSWORD = 'TestPass123!';

const ymd = (daysFromToday: number) =>
  new Date(Date.now() + daysFromToday * 86400000).toISOString().slice(0, 10);

// Attendance can never be recorded for a day before the person joined, or for someone who has left - whichever way it
// is entered: manual punch, face device, or a regularization request.
describe('Attendance: joining date and inactive checks (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;
  let joinerId: string;
  let joinerCode: string;
  let joinerToken: string;
  let leaverId: string;
  let leaverCode: string;
  let faceApiKey: string;

  const joinedOn = ymd(-2);
  const beforeJoining = ymd(-4);

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
    const server = app.getHttpServer();

    await request(server).post('/auth/register').send({
      organizationName: 'Joining Guard Org',
      name: 'Founder',
      email: 'jg-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(server)
          .post('/auth/login')
          .send({ email: 'jg-admin@example.test', password: PASSWORD })
      ).body as { accessToken: string }
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'jg-admin@example.test' },
      })
    ).organizationId;

    const make = async (name: string, email: string) => {
      const res = await request(server)
        .post('/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, email, joiningDate: joinedOn })
        .expect(201);
      const body = res.body as {
        employee: { id: string; employeeId: string };
        generatedPassword?: string;
      };
      return body;
    };
    const joiner = await make('Joiner Person', 'jg-joiner@example.test');
    joinerId = joiner.employee.id;
    joinerCode = joiner.employee.employeeId;
    await prisma.user.update({
      where: { id: joinerId },
      data: {
        password: await bcrypt.hash(PASSWORD, 4),
        mustChangePassword: false,
      },
    });
    joinerToken = (
      (
        await request(server)
          .post('/auth/login')
          .send({ email: 'jg-joiner@example.test', password: PASSWORD })
      ).body as { accessToken: string }
    ).accessToken;

    const leaver = await make('Leaver Person', 'jg-leaver@example.test');
    leaverId = leaver.employee.id;
    leaverCode = leaver.employee.employeeId;
    await prisma.user.update({
      where: { id: leaverId },
      data: { isActive: false },
    });

    faceApiKey = (
      (
        await request(server)
          .post('/organizations/settings/face-api-key/regenerate')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(201)
      ).body as { faceApiKey: string }
    ).faceApiKey;
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 500));
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
        );
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    await app.close();
  });

  it('a manual punch before the joining date is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendance/punch/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: joinerId,
        punchTime: `${beforeJoining}T04:00:00.000Z`,
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/joining date/);
  });

  it('a manual punch for an inactive employee is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendance/punch/manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        employeeId: leaverId,
        punchTime: `${joinedOn}T04:00:00.000Z`,
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/inactive/);
  });

  it('a regularization request for a day before the joining date is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendance/regularization')
      .set('Authorization', `Bearer ${joinerToken}`)
      .send({
        date: beforeJoining,
        requestedInTime: `${beforeJoining}T04:00:00.000Z`,
        requestedOutTime: `${beforeJoining}T12:30:00.000Z`,
        reason: 'Before joining',
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/joining date/);
    expect(
      await prisma.attendance.count({
        where: { employeeId: joinerId, date: beforeJoining },
      }),
    ).toBe(0);
  });

  it('a face-device punch for an inactive employee is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/attendance/punch/ingest')
      .set('x-face-api-key', faceApiKey)
      .send({ employeeId: leaverCode, organizationId })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/inactive/);
  });

  it('a face-device punch dated before the joining date is refused, and one on a valid day works', async () => {
    const server = app.getHttpServer();
    const early = await request(server)
      .post('/attendance/punch/ingest')
      .set('x-face-api-key', faceApiKey)
      .send({
        employeeId: joinerCode,
        organizationId,
        punchTime: `${beforeJoining}T04:00:00.000Z`,
      })
      .expect(400);
    expect(JSON.stringify(early.body)).toMatch(/joining date/);
    await request(server)
      .post('/attendance/punch/ingest')
      .set('x-face-api-key', faceApiKey)
      .send({
        employeeId: joinerCode,
        organizationId,
        punchTime: `${joinedOn}T04:00:00.000Z`,
      })
      .expect(201);
  });
});
