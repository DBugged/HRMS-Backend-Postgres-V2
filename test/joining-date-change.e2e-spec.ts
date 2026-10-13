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
}

const PASSWORD = 'TestPass123!';
const DAY = 86_400_000;
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// Correcting a joining date: the change returns promptly without notifying the employee about the days it brings in,
// and the salary structure follows it, so a revision effective from the corrected date is accepted.
describe('Joining date correction (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;

  const call = (method: 'post' | 'patch' | 'get', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${adminToken}`);
  const employee = async (name: string, email: string, joined: string) => {
    const created = await call('post', '/employees')
      .send({ name, email, joiningDate: joined })
      .expect(201);
    const id = (created.body as EmployeeCreateBody).employee.id;
    await call('post', `/employee-salary/${id}/structure`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: joined,
      })
      .expect(201);
    return id;
  };
  const basicRows = (employeeId: string) =>
    prisma.employeeSalaryComponent.findMany({
      where: { employeeId, componentCode: 'BASIC' },
      orderBy: { effectiveFrom: 'asc' },
    });

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
      organizationName: 'Joining Date Org',
      name: 'Founder',
      email: 'jd-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'jd-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'jd-admin@example.test' },
      })
    ).organizationId;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('moving the date months earlier is quick, brings in the days quietly and moves the salary start with it', async () => {
    const was = iso(-5);
    const id = await employee('Moved Earlier', 'jd-early@example.test', was);
    const now = iso(0);
    const earlier = iso(-270);

    const started = Date.now();
    await call('patch', `/employees/${id}`)
      .send({ joiningDate: earlier })
      .expect(200);
    expect(Date.now() - started).toBeLessThan(15_000);

    // the days from the new date are there ...
    const rows = await prisma.attendance.count({
      where: { employeeId: id, date: { gte: earlier, lt: was } },
    });
    expect(rows).toBeGreaterThan(200);
    // ... without a "marked absent" notice for each of them
    expect(
      await prisma.notification.count({
        where: {
          userId: id,
          organizationId,
          title: { contains: 'Marked Absent' },
        },
      }),
    ).toBe(0);

    // the salary structure starts on the new date, and a revision from that date is accepted
    expect((await basicRows(id))[0].effectiveFrom).toBe(earlier);
    await call('post', `/employee-salary/${id}/structure`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 35000,
        effectiveFrom: earlier,
      })
      .expect(201);
    expect((await basicRows(id))[0].fixedAmount).toBe(35000);
    // a date before the (corrected) start is still refused
    await call('post', `/employee-salary/${id}/structure`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 36000,
        effectiveFrom: iso(-300),
      })
      .expect(400);
    expect(now).toBeTruthy();
  });

  it('moving the date later moves the salary start too, and leaves a later revision alone', async () => {
    const was = iso(-60);
    const id = await employee('Moved Later', 'jd-late@example.test', was);
    const revisedOn = iso(-20);
    await call('post', `/employee-salary/${id}/structure`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 32000,
        effectiveFrom: revisedOn,
      })
      .expect(201);
    const later = iso(-40);
    await call('patch', `/employees/${id}`)
      .send({ joiningDate: later })
      .expect(200);
    const rows = await basicRows(id);
    expect(rows.map((r) => r.effectiveFrom)).toEqual([later, revisedOn]);
    expect(rows.map((r) => r.fixedAmount)).toEqual([30000, 32000]);
    await call('post', `/employee-salary/${id}/structure`)
      .send({
        componentCode: 'BASIC',
        fixedAmount: 33000,
        effectiveFrom: iso(-10),
      })
      .expect(201);
  });

  it('a salary that started after the joining date is not moved', async () => {
    const id = await employee('Later Start', 'jd-keep@example.test', iso(-30));
    // structure started 10 days after joining
    await prisma.employeeSalaryComponent.updateMany({
      where: { employeeId: id },
      data: { effectiveFrom: iso(-20) },
    });
    await call('patch', `/employees/${id}`)
      .send({ joiningDate: iso(-35) })
      .expect(200);
    expect((await basicRows(id))[0].effectiveFrom).toBe(iso(-20));
  });
});
