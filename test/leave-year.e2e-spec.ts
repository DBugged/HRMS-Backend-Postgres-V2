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
import { LeavesService } from '../src/leaves/leaves.service';

interface AuthBody {
  accessToken: string;
}
interface LeaveBody {
  id: string;
  status: string;
  totalDays: number;
  level1ApprovedById: string | null;
  employeeId: string;
  leaveTypeId: string;
}
interface LeaveTypeBody {
  id: string;
  code: string;
}

const PASSWORD = 'TestPass123!';

function offsetDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Smallest offset >= minDays that lands on the given UTC weekday (0=Sun).
// Leave day-counts exclude weekly-offs (Sunday by default) when
// sandwichLeaveApplies is false, so tests asserting a day count must anchor
// their ranges to known weekdays instead of "today + N".
function offsetToWeekday(minDays: number, weekday: number): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDays);
  return minDays + ((weekday - d.getUTCDay() + 7) % 7);
}
// Mon..Wed working-day block used by the apply/approve/cancel flow below.
const MON = offsetToWeekday(10, 1);

describe('Leave year (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let leavesService: LeavesService;

  let adminToken: string;
  let hrToken: string;
  let managerToken: string;
  let managerId: string;
  let employeeToken: string;
  let employeeId: string;
  let outsideDeptEmployeeId: string;
  let elLeaveTypeId: string;
  let compOffLeaveTypeId: string;

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
    leavesService = app.get(LeavesService);

    await request(app.getHttpServer()).post('/auth/register').send({
      organizationName: 'Leave Year Org',
      name: 'Founder',
      email: 'lvy-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'lvy-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'lvy-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lvy-hr@example.test',
        password: (hrCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;

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
        email: 'lvy-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    managerId = (managerCreate.body as { employee: { id: string } }).employee
      .id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lvy-manager@example.test',
        password: (managerCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'lvy-emp@example.test',
        departmentId,
        reportingManagerId: managerId,
      });
    const empBody = empCreate.body as {
      employee: { id: string };
      generatedPassword: string;
    };
    employeeId = empBody.employee.id;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'lvy-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'lvy-outside@example.test',
      });
    outsideDeptEmployeeId = (outsideCreate.body as { employee: { id: string } })
      .employee.id;

    const elType = await request(app.getHttpServer())
      .post('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Annual Leave',
        code: 'TAL',
        allocationType: 'FIXED_ANNUAL',
        annualQuota: 24,
        prorateOnJoining: false,
      });
    elLeaveTypeId = (elType.body as LeaveTypeBody).id;

    // COMPOFF is auto-seeded on every new org already (see
    // LeaveTypesService.seedDefaults) with this exact shape (code
    // 'COMPOFF' is hardcoded in leaves.service.ts, so a duplicate can't be
    // created alongside it) — just look up the seeded row's id.
    const leaveTypesList = await request(app.getHttpServer())
      .get('/leave-types')
      .set('Authorization', `Bearer ${adminToken}`);
    compOffLeaveTypeId = (
      leaveTypesList.body as { data: LeaveTypeBody[] }
    ).data.find((t) => t.code === 'COMPOFF')!.id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  const todayYear = Number(new Date().toISOString().slice(0, 4));
  const anchor = todayYear + 1;
  const ymd = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const apply = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const row = (year: number) =>
    prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
  const transition = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/leave-year/transition')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  // A leave in February of the anchor year: before the move it is charged to the anchor year's balance.
  let febStart: string;
  let febEnd: string;
  let febLeaveId: string;

  it('starts on the calendar year, and everyone can read it', async () => {
    const res = await request(app.getHttpServer())
      .get('/leave-year')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const body = res.body as {
      startMonth: number;
      current: { label: string; months: number };
    };
    expect(body.startMonth).toBe(1);
    expect(body.current.label).toBe(String(todayYear));
    expect(body.current.months).toBe(12);
  });

  it('only an Admin can change it', async () => {
    await transition(hrToken, { startMonth: 4 }).expect(403);
    await transition(managerToken, { startMonth: 4 }).expect(403);
    await transition(employeeToken, { startMonth: 4 }).expect(403);
    await transition(adminToken, { startMonth: 13 }).expect(400);
    await transition(adminToken, { startMonth: 1 }).expect(400);
  });

  it('a February leave of the coming year is charged to that calendar year before the move', async () => {
    // First Monday on or after 8 Feb of the anchor year, plus the Tuesday.
    let d = new Date(Date.UTC(anchor, 1, 8));
    while (d.getUTCDay() !== 1) d = new Date(d.getTime() + 86400000);
    febStart = d.toISOString().slice(0, 10);
    febEnd = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    const res = await apply(employeeToken, {
      leaveType: elLeaveTypeId,
      startDate: febStart,
      endDate: febEnd,
    }).expect(201);
    febLeaveId = (res.body as { id: string }).id;
    expect((await row(anchor))?.pending).toBe(2);
  });

  it('dry run: shows the extended year, the leaves it would re-file and the top-ups - and changes nothing', async () => {
    const res = await transition(adminToken, {
      startMonth: 4,
      dryRun: true,
    }).expect(201);
    const body = res.body as {
      dryRun: boolean;
      extendedYear: {
        label: string;
        months: number;
        start: string;
        end: string;
      };
      nextYear: { label: string; start: string };
      leavesRefiled: number;
      balancesToppedUp: number;
      topUps: { from: number; to: number }[];
    };
    expect(body.dryRun).toBe(true);
    expect(body.extendedYear).toMatchObject({
      label: `${todayYear}-${String(anchor).slice(2)}`,
      months: 15,
      start: ymd(todayYear, 1, 1),
      end: ymd(anchor, 3, 31),
    });
    expect(body.nextYear.start).toBe(ymd(anchor, 4, 1));
    expect(body.leavesRefiled).toBe(1);
    // 24 days a year over 15 months = 30.
    expect(body.topUps.some((t) => t.from === 24 && t.to === 30)).toBe(true);
    const org = await prisma.organization.findFirstOrThrow({});
    expect(org.leaveYearStartMonth).toBe(1);
    expect((await row(todayYear))?.credited).toBe(24);
  });

  it('the move: the current year is extended and topped up, the February leave is re-filed into it', async () => {
    await transition(adminToken, { startMonth: 4 }).expect(201);
    const org = await prisma.organization.findFirstOrThrow({});
    expect([org.leaveYearStartMonth, org.leaveYearAnchorYear]).toEqual([
      4,
      anchor,
    ]);

    const ext = await row(todayYear);
    expect(ext?.credited).toBe(30);
    expect(ext?.pending).toBe(2); // the February leave, now in the extended year
    expect((await row(anchor))?.pending).toBe(0);
    const leave = await prisma.leave.findUniqueOrThrow({
      where: { id: febLeaveId },
    });
    expect(leave.yearSplit).toEqual([{ year: todayYear, days: 2 }]);

    const current = await request(app.getHttpServer())
      .get('/leave-year')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (current.body as { current: { key: number; months: number } }).current,
    ).toMatchObject({ key: todayYear, months: 15 });
  });

  it('cancelling the re-filed leave gives the days back to the extended year', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${febLeaveId}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect((await row(todayYear))?.pending).toBe(0);
    expect((await row(anchor))?.pending).toBe(0);
  });

  it('new leaves are filed by the new years: Jan-Mar of the anchor year in the extended year, April on in the next', async () => {
    // A week in the first half of March (inside the extended year), and one in May (the new April year).
    const mar = await apply(employeeToken, {
      leaveType: elLeaveTypeId,
      startDate: ymd(anchor, 3, 2),
      endDate: ymd(anchor, 3, 7),
    }).expect(201);
    const may = await apply(employeeToken, {
      leaveType: elLeaveTypeId,
      startDate: ymd(anchor, 5, 4),
      endDate: ymd(anchor, 5, 9),
    }).expect(201);
    const marDays = (mar.body as { totalDays: number }).totalDays;
    const mayDays = (may.body as { totalDays: number }).totalDays;
    expect(marDays).toBeGreaterThan(0);
    expect(mayDays).toBeGreaterThan(0);
    expect((await row(todayYear))?.pending).toBe(marDays);
    expect((await row(anchor))?.pending).toBe(mayDays);
  });

  it('a leave across 31 March / 1 April is split between the extended year and the new one', async () => {
    const start = ymd(anchor, 3, 25);
    const end = ymd(anchor, 4, 3);
    const before = {
      ext: (await row(todayYear))?.pending ?? 0,
      next: (await row(anchor))?.pending ?? 0,
    };
    const res = await apply(employeeToken, {
      leaveType: elLeaveTypeId,
      startDate: start,
      endDate: end,
    }).expect(201);
    const body = res.body as {
      totalDays: number;
      yearSplit: { year: number; days: number }[];
    };
    // Charged to both years, the parts add up to the total, and each year's balance got exactly its part.
    expect(body.yearSplit.map((p) => p.year)).toEqual([todayYear, anchor]);
    expect(body.yearSplit[0].days).toBeGreaterThan(0);
    expect(body.yearSplit[1].days).toBeGreaterThan(0);
    expect(body.yearSplit[0].days + body.yearSplit[1].days).toBe(
      body.totalDays,
    );
    expect(((await row(todayYear))?.pending ?? 0) - before.ext).toBe(
      body.yearSplit[0].days,
    );
    expect(((await row(anchor))?.pending ?? 0) - before.next).toBe(
      body.yearSplit[1].days,
    );
  });

  it('the year can be moved only once from the calendar year', async () => {
    await transition(adminToken, { startMonth: 7 }).expect(400);
  });
});
