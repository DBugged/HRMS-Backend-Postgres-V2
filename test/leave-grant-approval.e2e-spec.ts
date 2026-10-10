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
interface Created {
  id: string;
  status: string;
  level1ApprovedById?: string | null;
}

const PASSWORD = 'TestPass123!';

// Event-leave grant requests follow the leave type's own Approval Levels (and Requires Approval).
describe('Event leave grant approval flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let employeeToken: string;
  let employeeId: string;
  let oneLevelTypeId: string;
  let twoLevelTypeId: string;
  let noApprovalTypeId: string;
  const year = new Date().getFullYear();
  const day = (m: number, d: number) =>
    `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const login = async (email: string, password: string) =>
    (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password })
      ).body as AuthBody
    ).accessToken;

  const makeType = async (name: string, code: string, extra: object) => {
    const res = await request(app.getHttpServer())
      .post('/leave-types')
      .set(auth(adminToken))
      .send({
        name,
        code,
        allocationType: 'EVENT_BASED',
        annualQuota: 50,
        ...extra,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };
  const file = (leaveTypeId: string, eventDate: string, days = 10) =>
    request(app.getHttpServer())
      .post('/leave-grants/requests')
      .set(auth(employeeToken))
      .send({ leaveTypeId, eventDate, days, reason: 'Event' });

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
      organizationName: 'Grant Approval E2E Org',
      name: 'Founder',
      email: 'grantappr-e2e-admin@example.test',
      password: PASSWORD,
    });
    adminToken = await login('grantappr-e2e-admin@example.test', PASSWORD);

    const create = async (body: object) =>
      (
        await request(app.getHttpServer())
          .post('/employees')
          .set(auth(adminToken))
          .send(body)
      ).body as { employee: { id: string }; generatedPassword: string };

    const hr = await create({
      name: 'HR',
      email: 'grantappr-e2e-hr@example.test',
      role: 'HR',
    });
    hrToken = await login(
      'grantappr-e2e-hr@example.test',
      hr.generatedPassword,
    );

    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set(auth(adminToken))
      .send({ name: 'Grant Dept', code: 'GD' });
    const departmentId = (dept.body as { id: string }).id;

    const manager = await create({
      name: 'Manager',
      email: 'grantappr-e2e-mgr@example.test',
      role: 'MANAGER',
      departmentId,
    });
    managerToken = await login(
      'grantappr-e2e-mgr@example.test',
      manager.generatedPassword,
    );
    const emp = await create({
      name: 'Employee',
      email: 'grantappr-e2e-emp@example.test',
      departmentId,
      reportingManagerId: manager.employee.id,
    });
    employeeId = emp.employee.id;
    employeeToken = await login(
      'grantappr-e2e-emp@example.test',
      emp.generatedPassword,
    );

    oneLevelTypeId = await makeType('One Level Event', 'OLE', {
      approvalLevels: 1,
    });
    twoLevelTypeId = await makeType('Two Level Event', 'TLE', {
      approvalLevels: 2,
    });
    noApprovalTypeId = await makeType('No Approval Event', 'NAE', {
      requiresApproval: false,
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "leave_grant_requests", "leave_grants", "leave_balances", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('1 level: the reporting manager can give the final approval, which grants the days', async () => {
    const req = (await file(oneLevelTypeId, day(2, 1)).expect(201))
      .body as Created;
    const res = await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(managerToken))
      .send({})
      .expect(201);
    expect((res.body as Created).status).toBe('APPROVED');
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: oneLevelTypeId, year },
    });
    expect(row.credited).toBe(10);
  });

  it('2 levels: HR cannot skip the manager; the manager only signs off level 1; HR then decides', async () => {
    const req = (await file(twoLevelTypeId, day(3, 1)).expect(201))
      .body as Created;
    await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(hrToken))
      .send({})
      .expect(403);
    const lvl1 = await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(managerToken))
      .send({})
      .expect(201);
    expect((lvl1.body as Created).status).toBe('PENDING');
    expect((lvl1.body as Created).level1ApprovedById).toBeTruthy();
    expect(
      await prisma.leaveGrant.count({
        where: { employeeId, leaveTypeId: twoLevelTypeId },
      }),
    ).toBe(0);
    await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(managerToken))
      .send({})
      .expect(403);
    const final = await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(hrToken))
      .send({})
      .expect(201);
    expect((final.body as Created).status).toBe('APPROVED');
  });

  it('a manager only decides their own team, and the employee cannot approve', async () => {
    const outsider = await request(app.getHttpServer())
      .post('/employees')
      .set(auth(adminToken))
      .send({ name: 'Outsider', email: 'grantappr-e2e-out@example.test' });
    const outsiderBody = outsider.body as { generatedPassword: string };
    const outsiderToken = await login(
      'grantappr-e2e-out@example.test',
      outsiderBody.generatedPassword,
    );
    const req = (await file(oneLevelTypeId, day(4, 1)).expect(201))
      .body as Created;
    await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/approve`)
      .set(auth(outsiderToken))
      .send({})
      .expect(403);
    const rejected = await request(app.getHttpServer())
      .post(`/leave-grants/requests/${req.id}/reject`)
      .set(auth(managerToken))
      .send({ note: 'Not eligible' })
      .expect(201);
    expect((rejected.body as Created).status).toBe('REJECTED');
  });

  it('requires approval off: the request is granted at once', async () => {
    const res = await file(noApprovalTypeId, day(5, 1)).expect(201);
    expect((res.body as Created).status).toBe('APPROVED');
    const row = await prisma.leaveBalance.findFirstOrThrow({
      where: { employeeId, leaveTypeId: noApprovalTypeId, year },
    });
    expect(row.credited).toBe(10);
  });

  it("a manager lists the team's requests", async () => {
    const res = await request(app.getHttpServer())
      .get('/leave-grants/requests')
      .set(auth(managerToken))
      .expect(200);
    expect(
      (res.body as { employeeId: string }[]).some(
        (r) => r.employeeId === employeeId,
      ),
    ).toBe(true);
  });
});
