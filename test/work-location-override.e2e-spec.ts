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
  employee: { id: string; workLocationId: string | null };
  generatedPassword: string;
}
interface EmployeeBody {
  workLocationId: string | null;
  workLocation: { id: string; name: string; state: string } | null;
  personalData: Record<string, string>;
}

const PASSWORD = 'TestPass123!';

describe('Per-employee work location + personalData encryption (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let empId: string;
  let empToken: string;
  let deptLocId: string;
  let ownLocId: string;

  const http = () => request(app.getHttpServer());
  const admin = (r: request.Test) =>
    r.set('Authorization', `Bearer ${adminToken}`);

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

    await http().post('/auth/register').send({
      organizationName: 'WorkLoc E2E Org',
      name: 'Founder',
      email: 'wl-e2e-admin@example.test',
      password: PASSWORD,
    });
    const login = await http()
      .post('/auth/login')
      .send({ email: 'wl-e2e-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;

    const mk = async (name: string, state: string) =>
      (
        (
          await admin(http().post('/work-locations')).send({
            name,
            state,
            latitude: 19.07,
            longitude: 72.87,
          })
        ).body as { id: string }
      ).id;
    deptLocId = await mk('Dept HQ', 'Maharashtra');
    ownLocId = await mk('Remote Hub', 'Karnataka');

    const dept = await admin(http().post('/departments')).send({
      name: 'WL Dept',
      code: 'WLD',
    });
    const departmentId = (dept.body as { id: string }).id;
    await admin(http().patch(`/departments/${departmentId}`)).send({
      workLocationId: deptLocId,
    });

    const created = await admin(http().post('/employees')).send({
      name: 'WL Employee',
      email: 'wl-e2e-emp@example.test',
      departmentId,
    });
    const body = created.body as EmployeeCreateBody;
    empId = body.employee.id;
    const empLogin = await http().post('/auth/login').send({
      email: 'wl-e2e-emp@example.test',
      password: body.generatedPassword,
    });
    empToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "employee_movements", "employee_timeline", "refresh_tokens", "users", "departments", "work_locations", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const myFence = async () =>
    (
      (
        await http()
          .get('/attendance/geofence/mine')
          .set('Authorization', `Bearer ${empToken}`)
          .expect(200)
      ).body as { geoFence: { id: string } | null }
    ).geoFence?.id;

  it('falls back to the department location when no override is set', async () => {
    expect(await myFence()).toBe(deptLocId);
  });

  it('rejects an unknown work location id', async () => {
    await admin(http().patch(`/employees/${empId}`))
      .send({ workLocationId: '00000000-0000-4000-8000-000000000000' })
      .expect(400);
  });

  it('override wins, is returned with the employee, and records a TRANSFER movement + timeline event', async () => {
    const res = await admin(http().patch(`/employees/${empId}`))
      .send({ workLocationId: ownLocId, changeReason: 'Relocated' })
      .expect(200);
    const emp = res.body as EmployeeBody;
    expect(emp.workLocationId).toBe(ownLocId);
    expect(emp.workLocation).toMatchObject({
      id: ownLocId,
      name: 'Remote Hub',
      state: 'Karnataka',
    });
    expect(await myFence()).toBe(ownLocId);

    const movement = await prisma.employeeMovement.findFirstOrThrow({
      where: { employeeId: empId, type: 'TRANSFER' },
    });
    expect(movement.previousWorkLocationId).toBeNull();
    expect(movement.newWorkLocationId).toBe(ownLocId);
    const events = await prisma.employeeTimeline.count({
      where: { employeeId: empId, eventKey: 'WORK_LOCATION_CHANGED' },
    });
    expect(events).toBe(1);
  });

  it('clearing the override (null) falls back to the department again', async () => {
    await admin(http().patch(`/employees/${empId}`))
      .send({ workLocationId: null })
      .expect(200);
    expect(await myFence()).toBe(deptLocId);
    const moves = await prisma.employeeMovement.findMany({
      where: { employeeId: empId, type: 'TRANSFER' },
      orderBy: { createdAt: 'desc' },
    });
    expect(moves[0].previousWorkLocationId).toBe(ownLocId);
    expect(moves[0].newWorkLocationId).toBeNull();
  });

  it('an employee cannot set their own work location', async () => {
    await http()
      .patch(`/employees/${empId}`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({ workLocationId: ownLocId })
      .expect((r) => {
        // Locked field is stripped for self-update: the override must not be applied.
        expect([200, 400, 403]).toContain(r.status);
      });
    const u = await prisma.user.findFirstOrThrow({ where: { id: empId } });
    expect(u.workLocationId).toBeNull();
  });

  it('stores sensitive personalData encrypted at rest and returns it decrypted', async () => {
    await http()
      .patch(`/employees/${empId}/personal-data`)
      .set('Authorization', `Bearer ${empToken}`)
      .send({
        personalData: {
          panNumber: 'ABCDE1234F',
          bankAccountNo: '000123456789',
          currentAddress: '1 Test Street',
        },
      })
      .expect(200);

    const raw = await prisma.user.findFirstOrThrow({ where: { id: empId } });
    const stored = raw.personalData as Record<string, string>;
    expect(stored.panNumber).toMatch(/^enc:v1:/);
    expect(stored.bankAccountNo).toMatch(/^enc:v1:/);
    expect(stored.currentAddress).toBe('1 Test Street');
    expect(JSON.stringify(raw.personalData)).not.toContain('ABCDE1234F');

    const res = await admin(http().get(`/employees/${empId}`)).expect(200);
    const pd = (res.body as EmployeeBody).personalData;
    expect(pd.panNumber).toBe('ABCDE1234F');
    expect(pd.bankAccountNo).toBe('000123456789');
  });

  it('legacy plaintext values already in the DB still read back', async () => {
    await prisma.user.update({
      where: { id: empId },
      data: { personalData: { panNumber: 'LEGACY1234Z' } },
    });
    const res = await admin(http().get(`/employees/${empId}`)).expect(200);
    expect((res.body as EmployeeBody).personalData.panNumber).toBe(
      'LEGACY1234Z',
    );
  });
});
