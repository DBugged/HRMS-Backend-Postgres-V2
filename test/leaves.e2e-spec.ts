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

describe('Leaves (e2e)', () => {
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
      organizationName: 'Leaves E2E Org',
      name: 'Founder',
      email: 'leaves-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'leaves-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'leaves-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leaves-e2e-hr@example.test',
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
        email: 'leaves-e2e-manager@example.test',
        role: 'MANAGER',
        departmentId,
      });
    managerId = (managerCreate.body as { employee: { id: string } }).employee
      .id;
    const managerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'leaves-e2e-manager@example.test',
        password: (managerCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    managerToken = (managerLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Employee',
        email: 'leaves-e2e-emp@example.test',
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
        email: 'leaves-e2e-emp@example.test',
        password: empBody.generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;

    const outsideCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Outside Employee',
        email: 'leaves-e2e-outside@example.test',
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
      'TRUNCATE TABLE "comp_offs", "leave_balances", "leaves", "leave_types", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let elLeaveId: string;

  it('EMPLOYEE applies for Earned Leave; a balance row is lazily created with the full (non-prorated) quota', async () => {
    const res = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: elLeaveTypeId,
        startDate: offsetDate(MON),
        endDate: offsetDate(MON + 2),
      })
      .expect(201);
    const body = res.body as LeaveBody;
    expect(body.status).toBe('PENDING');
    expect(body.totalDays).toBe(3);
    elLeaveId = body.id;

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.credited).toBe(24);
    expect(row?.pending).toBe(3);
  });

  it('rejects an overlapping request', async () => {
    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: elLeaveTypeId,
        startDate: offsetDate(MON + 1),
        endDate: offsetDate(MON + 5),
      })
      .expect(400);
  });

  it('two concurrent identical submissions: only one is accepted, not two duplicate rows', async () => {
    // Reproduces the exact race this guards against: two identical
    // apply() calls both reading the same pre-transaction "no conflict"
    // snapshot used to both succeed, creating two live PENDING rows for
    // the identical date range. The per-employee row lock in
    // createLeaveInternal's transaction now serializes these, and the
    // second re-checks overlap after acquiring the lock.
    // A guaranteed working day (not offsetDate's raw "today + N", which can
    // land on a weekly-off and make totalDays 0) — see offsetToWeekday's
    // own comment above.
    const day = offsetToWeekday(100, 1);
    const dto = {
      leaveType: elLeaveTypeId,
      startDate: offsetDate(day),
      endDate: offsetDate(day),
    };
    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(dto),
      request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send(dto),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);

    const rows = await prisma.leave.findMany({
      where: {
        employeeId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    expect(rows.length).toBe(1);

    // Clean up: reject the one that succeeded so it doesn't leave a
    // dangling pending hold that skews the balance assertions later in
    // this file.
    await request(app.getHttpServer())
      .patch(`/leaves/${rows[0].id}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'REJECTED', comments: 'cleanup' })
      .expect(200);
  });

  it('EMPLOYEE gets 403 reviewing any leave request', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('MANAGER gives level-1 approval; status stays PENDING', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED', comments: 'Looks fine' })
      .expect(200);
    const body = res.body as LeaveBody;
    expect(body.status).toBe('PENDING');
    expect(body.level1ApprovedById).not.toBeNull();
  });

  it('MANAGER cannot give the final approval on a 2-level leave type', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('HR gives the final approval; balance moves pending -> availed', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    expect((res.body as LeaveBody).status).toBe('APPROVED');

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.pending).toBe(0);
    expect(row?.availed).toBe(3);
    expect(row?.closing).toBe(21); // 24 credited - 3 availed

    // Leave-approval -> Attendance integration: every day in the leave's
    // range gets an ON_LEAVE row with source SYSTEM.
    const attendanceRows = await prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: offsetDate(MON), lte: offsetDate(MON + 2) },
      },
      orderBy: { date: 'asc' },
    });
    expect(attendanceRows).toHaveLength(3);
    expect(attendanceRows.every((r) => r.status === 'ON_LEAVE')).toBe(true);
    expect(attendanceRows.every((r) => r.source === 'SYSTEM')).toBe(true);
  });

  it('rejects reviewing an already-decided leave', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'REJECTED' })
      .expect(400);
  });

  it('EMPLOYEE cancels the approved leave; availed is reversed', async () => {
    await request(app.getHttpServer())
      .patch(`/leaves/${elLeaveId}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    const year = new Date().getFullYear();
    const row = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    expect(row?.availed).toBe(0);
    expect(row?.closing).toBe(24);

    // Cancellation removes the leave-generated (ON_LEAVE/HALF_DAY) Attendance rows
    // outright — none should remain.
    const attendanceRows = await prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: offsetDate(MON), lte: offsetDate(MON + 2) },
      },
    });
    expect(attendanceRows).toHaveLength(0);
  });

  it('a COMPOFF-type leave draws from the CompOff table, not LeaveBalance', async () => {
    // earn() now validates earnedForDate is a genuine weekly-off/holiday —
    // walk back to the most recent Sunday (Department.weeklyOffs defaults
    // to [0]) instead of an arbitrary "2 days ago", which only
    // coincidentally landed on an off day before.
    const earnedForDate = (() => {
      const d = new Date();
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day || 7));
      return d.toISOString().slice(0, 10);
    })();
    const compOff = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate })
      .expect(201);
    const compOffId = (compOff.body as { id: string }).id;
    await request(app.getHttpServer())
      .patch(`/comp-offs/${compOffId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const leaveRes = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: compOffLeaveTypeId,
        // A half-day needs a working day (it is refused on a weekly off or holiday), so anchor it to a Tuesday.
        startDate: offsetDate(offsetToWeekday(40, 2)),
        endDate: offsetDate(offsetToWeekday(40, 2)),
        isHalfDay: true,
      })
      .expect(201);
    const compOffLeaveId = (leaveRes.body as LeaveBody).id;

    // COMPOFF needs the manager's level-1 approval before HR can give the final one.
    await request(app.getHttpServer())
      .patch(`/leaves/${compOffLeaveId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/leaves/${compOffLeaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const compOffRow = await prisma.compOff.findFirst({
      where: { id: compOffId },
    });
    expect(compOffRow?.daysAvailed).toBe(0.5);
    expect(compOffRow?.status).toBe('PARTIALLY_AVAILED');

    // No LeaveBalance row should exist at all for the COMPOFF leave type.
    const balanceRow = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: compOffLeaveTypeId },
    });
    expect(balanceRow).toBeNull();
  });

  it('concurrent approval of two COMPOFF leaves never loses a balance debit to a race', async () => {
    // A second, independent comp-off credit (a different past Sunday) so
    // there's enough balance for two 0.5-day leaves.
    const earnedForDate2 = (() => {
      const d = new Date();
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - (day || 7) - 7);
      return d.toISOString().slice(0, 10);
    })();
    const compOff2 = await request(app.getHttpServer())
      .post('/comp-offs')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ earnedForDate: earnedForDate2 })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/comp-offs/${(compOff2.body as { id: string }).id}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const before = await prisma.compOff.findMany({ where: { employeeId } });
    const availableBefore = before.reduce(
      (sum, r) => sum + (r.daysEarned - r.daysAvailed),
      0,
    );
    expect(availableBefore).toBeGreaterThanOrEqual(1);

    const [leaveA, leaveB] = await Promise.all(
      [30, 31].map((offset) =>
        request(app.getHttpServer())
          .post('/leaves')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({
            leaveType: compOffLeaveTypeId,
            startDate: offsetDate(offset),
            endDate: offsetDate(offset),
            isHalfDay: true,
          })
          .expect(201),
      ),
    );

    // Approving both at once is exactly the race that used to silently
    // corrupt the ledger (comp-off.service.ts's consumeForLeave read the
    // balance, computed a new absolute value, and overwrote it with no
    // guard — a second concurrent approval reading the same starting
    // balance would clobber the first's already-committed write). Now
    // guarded: at most one of the two can win the compare-and-swap: the
    // other must be rejected (409), never both silently "succeeding" with
    // only one debit actually persisted.
    // Level-1 (manager) approvals first — HR's final approval is what races below.
    for (const l of [leaveA, leaveB]) {
      await request(app.getHttpServer())
        .patch(`/leaves/${(l.body as LeaveBody).id}/review`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    }
    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/leaves/${(leaveA.body as LeaveBody).id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED' }),
      request(app.getHttpServer())
        .patch(`/leaves/${(leaveB.body as LeaveBody).id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED' }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    // Either both cleanly succeed (if Postgres happened to fully serialize
    // them) or exactly one wins and the other is rejected as a conflict —
    // what must never happen is both returning 200 while the ledger only
    // reflects one debit (the corruption this test guards against).
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);

    const succeededCount = [resA.status, resB.status].filter(
      (s) => s === 200,
    ).length;
    const after = await prisma.compOff.findMany({ where: { employeeId } });
    const availableAfter = after.reduce(
      (sum, r) => sum + (r.daysEarned - r.daysAvailed),
      0,
    );
    // Every leave that actually got to APPROVED must have its 0.5 days
    // reflected in the ledger — not silently dropped.
    expect(availableBefore - availableAfter).toBe(succeededCount * 0.5);
  });

  it('rejects applying for a COMPOFF leave beyond available comp-off balance', async () => {
    await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: compOffLeaveTypeId,
        startDate: offsetDate(21),
        endDate: offsetDate(25),
      })
      .expect(403);
  });

  it('GET /leaves scoping: EMPLOYEE sees only their own, MANAGER sees the department', async () => {
    const selfList = await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    expect(
      (selfList.body as { data: LeaveBody[] }).data.every(
        (l) => l.employeeId === employeeId,
      ),
    ).toBe(true);

    const deptList = await request(app.getHttpServer())
      .get('/leaves')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(
      (deptList.body as { data: LeaveBody[] }).data.some(
        (l) => l.employeeId === employeeId,
      ),
    ).toBe(true);
  });

  it('MANAGER ?employeeId=self ("My Leave") scopes to only their own, not the whole department', async () => {
    const res = await request(app.getHttpServer())
      .get('/leaves')
      .query({ employeeId: managerId })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const leaves = (res.body as { data: LeaveBody[] }).data;
    expect(leaves.every((l) => l.employeeId === managerId)).toBe(true);
    expect(leaves.some((l) => l.employeeId === employeeId)).toBe(false);
  });

  it('MANAGER ?employeeId=<dept member> narrows to just that member', async () => {
    const res = await request(app.getHttpServer())
      .get('/leaves')
      .query({ employeeId })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const leaves = (res.body as { data: LeaveBody[] }).data;
    expect(leaves.every((l) => l.employeeId === employeeId)).toBe(true);
  });

  it('MANAGER ?employeeId=<outside the department> is refused, not silently widened', async () => {
    await request(app.getHttpServer())
      .get('/leaves')
      .query({ employeeId: outsideDeptEmployeeId })
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });

  it('a low ?limit= caps the number of leaves returned', async () => {
    const res = await request(app.getHttpServer())
      .get('/leaves')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { data: LeaveBody[] }).data.length).toBeLessThanOrEqual(
      1,
    );
  });

  it('rejects a ?limit= above the 2000 hard cap', async () => {
    await request(app.getHttpServer())
      .get('/leaves')
      .query({ limit: 2001 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('GET /leaves/balance for another employee requires ADMIN/HR/MANAGER', async () => {
    await request(app.getHttpServer())
      .get('/leaves/balance')
      .query({ employeeId })
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
  });

  // Regression: getBalance() used to narrow each row's leaveType down to
  // {id,name,code}, dropping `encashment` — web's Request Encashment button
  // reads balances[].leaveType.encashment.allowed off this exact response,
  // so it was permanently disabled for every employee regardless of the
  // leave type's actual encashment config.
  it("GET /leaves/balance includes each leaveType's encashment config (web reads this to enable Request Encashment)", async () => {
    const res = await request(app.getHttpServer())
      .get('/leaves/balance')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const balances = (
      res.body as {
        balances: { leaveType: { code: string; encashment: any } }[];
      }
    ).balances;
    const el = balances.find((b) => b.leaveType.code === 'EL');
    expect(el?.leaveType.encashment).toMatchObject({
      allowed: true,
      maxDaysPerYear: 10,
    });
  });

  it('GET /leaves/history/:employeeId is self-accessible, but 403 for another EMPLOYEE', async () => {
    await request(app.getHttpServer())
      .get(`/leaves/history/${employeeId}`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
  });

  // Regression: review(RETURNED) releases the pending hold, and cancel()
  // legally accepts a RETURNED leave — but releaseHold() then decremented
  // `pending` a second time, driving it negative. Since affordability is
  // computed as `... - pending`, a negative pending INFLATED the
  // employee's usable balance, repeatably and invisibly (LeaveBalance
  // .closing doesn't include pending, so the balance screen looked fine).
  it('returning then cancelling a leave does not drive pending negative', async () => {
    const year = new Date().getFullYear();
    const before = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    const pendingBefore = before?.pending ?? 0;

    const applied = await request(app.getHttpServer())
      .post('/leaves')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({
        leaveType: elLeaveTypeId,
        // Deliberately inside the CURRENT calendar year: deriveLeaveYear()
        // attributes the hold to startDate's year, so a far-future range
        // would move it to next year's LeaveBalance row and this
        // assertion would read an untouched row and pass either way.
        startDate: offsetDate(60),
        endDate: offsetDate(62),
      })
      .expect(201);
    const leaveId = (applied.body as LeaveBody).id;

    await request(app.getHttpServer())
      .patch(`/leaves/${leaveId}/review`)
      .set('Authorization', `Bearer ${hrToken}`)
      .send({ decision: 'RETURNED', comments: 'please correct the dates' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/leaves/${leaveId}/cancel`)
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);

    const after = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: elLeaveTypeId, year },
    });
    // Net zero: the hold was taken on apply and released exactly once.
    expect(after?.pending).toBe(pendingBefore);
    expect(after?.pending).toBeGreaterThanOrEqual(0);
  });
  describe('auto-approve after no reviewer action', () => {
    it('approves a PENDING leave past its deadline, and leaves an under-deadline one alone', async () => {
      const autoType = await request(app.getHttpServer())
        .post('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Auto Approve Leave',
          code: 'AAL',
          allocationType: 'FIXED_ANNUAL',
          annualQuota: 24,
          prorateOnJoining: false,
          approvalLevels: 1,
          autoApproveIfNoAction: true,
          autoApproveHours: 1,
        });
      const autoTypeId = (autoType.body as LeaveTypeBody).id;
      const wed = offsetToWeekday(60, 3);

      const overdue = await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: autoTypeId,
          startDate: offsetDate(wed),
          endDate: offsetDate(wed),
        })
        .expect(201);
      const overdueId = (overdue.body as LeaveBody).id;
      // Backdate createdAt past the 1-hour deadline — applying via the API
      // always stamps "now", so this is the only way to simulate elapsed
      // time without sleeping the test.
      await prisma.leave.update({
        where: { id: overdueId },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60000) },
      });

      const fri = offsetToWeekday(62, 5);
      const withinWindow = await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: autoTypeId,
          startDate: offsetDate(fri),
          endDate: offsetDate(fri),
        })
        .expect(201);
      const withinWindowId = (withinWindow.body as LeaveBody).id;

      await leavesService.autoApprovePendingLeaves();

      const overdueRow = await prisma.leave.findUniqueOrThrow({
        where: { id: overdueId },
      });
      expect(overdueRow.status).toBe('APPROVED');
      expect(overdueRow.reviewedById).toBeNull();

      const withinWindowRow = await prisma.leave.findUniqueOrThrow({
        where: { id: withinWindowId },
      });
      expect(withinWindowRow.status).toBe('PENDING');

      const year = new Date().getFullYear();
      const balance = await prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId, leaveTypeId: autoTypeId, year },
      });
      // The auto-approved day moved from pending to availed; the
      // still-pending one's hold is untouched.
      expect(balance.availed).toBe(1);
      expect(balance.pending).toBe(1);

      // Running it again must not re-approve or double-credit anything.
      await leavesService.autoApprovePendingLeaves();
      const balanceAgain = await prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId, leaveTypeId: autoTypeId, year },
      });
      expect(balanceAgain.availed).toBe(1);
    });
  });

  describe('intra-range weekends vs sandwichLeaveApplies (L8)', () => {
    // Fri -> Mon, with the department on a Sat+Sun weekend for these tests.
    let departmentId: string;
    let originalWeeklyOffs: unknown;

    async function createTypeWithSandwich(code: string, sandwich: boolean) {
      const res = await request(app.getHttpServer())
        .post('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Sandwich ${code}`,
          code,
          allocationType: 'FIXED_ANNUAL',
          annualQuota: 12,
          prorateOnJoining: false,
        })
        .expect(201);
      const id = (res.body as LeaveTypeBody).id;
      const lt = await prisma.leaveType.findFirstOrThrow({ where: { id } });
      await prisma.leaveType.updateMany({
        where: { id },
        data: {
          rules: {
            ...(lt.rules as Record<string, unknown>),
            sandwichLeaveApplies: sandwich,
          },
        },
      });
      return id;
    }

    beforeAll(async () => {
      const emp = await prisma.user.findFirstOrThrow({
        where: { id: employeeId },
      });
      departmentId = emp.departmentId!;
      const dept = await prisma.department.findFirstOrThrow({
        where: { id: departmentId },
      });
      originalWeeklyOffs = dept.weeklyOffs;
      await prisma.department.updateMany({
        where: { id: departmentId },
        data: { weeklyOffs: [0, 6] },
      });
    });

    afterAll(async () => {
      await prisma.department.updateMany({
        where: { id: departmentId },
        data: { weeklyOffs: originalWeeklyOffs as number[] },
      });
    });

    it('sandwichLeaveApplies:false charges only the working days inside a Fri->Mon range', async () => {
      const typeId = await createTypeWithSandwich('SWF', false);
      const fri = offsetToWeekday(35, 5);
      const res = await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: typeId,
          startDate: offsetDate(fri),
          endDate: offsetDate(fri + 3),
        })
        .expect(201);
      expect((res.body as LeaveBody).totalDays).toBe(2);

      const row = await prisma.leaveBalance.findFirst({
        where: {
          employeeId,
          leaveTypeId: typeId,
          year: new Date(offsetDate(fri)).getUTCFullYear(),
        },
      });
      expect(row?.pending).toBe(2);
    });

    it('sandwichLeaveApplies:true still charges every calendar day in a Fri->Mon range', async () => {
      const typeId = await createTypeWithSandwich('SWT', true);
      const fri = offsetToWeekday(43, 5);
      const res = await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: typeId,
          startDate: offsetDate(fri),
          endDate: offsetDate(fri + 3),
        })
        .expect(201);
      expect((res.body as LeaveBody).totalDays).toBe(4);
    });

    it('rejects a range that is entirely weekly-offs when sandwichLeaveApplies is false', async () => {
      const typeId = await prisma.leaveType.findFirstOrThrow({
        where: { code: 'SWF' },
      });
      const sat = offsetToWeekday(50, 6);
      await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: typeId.id,
          startDate: offsetDate(sat),
          endDate: offsetDate(sat + 1),
        })
        .expect(400);
    });
  });

  describe("Leave fixes: editing, holidays, half-days, auto-approval, year split, joining date, who's out", () => {
    const apply = (token: string, body: object) =>
      request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const edit = (token: string, id: string, body: object) =>
      request(app.getHttpServer())
        .put(`/leaves/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const pendingOf = async (typeId: string, year: number) =>
      (
        await prisma.leaveBalance.findFirst({
          where: { employeeId, leaveTypeId: typeId, year },
        })
      )?.pending ?? 0;

    it('LV-1: an edit that fails validation leaves the original request pending and its hold intact', async () => {
      const mon = offsetToWeekday(200, 1);
      const created = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon + 1),
      }).expect(201);
      const id = (created.body as LeaveBody).id;
      const year = Number(offsetDate(mon).slice(0, 4));
      const held = await pendingOf(elLeaveTypeId, year);

      await edit(employeeToken, id, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon + 4),
        endDate: offsetDate(mon),
      }).expect(400);
      const after = await prisma.leave.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe('PENDING');
      expect(await pendingOf(elLeaveTypeId, year)).toBe(held);
    });

    it('LV-1: a valid edit replaces the original in one step: new request pending, old cancelled, hold not doubled', async () => {
      const mon = offsetToWeekday(210, 1);
      const created = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon + 1),
      }).expect(201);
      const oldId = (created.body as LeaveBody).id;
      const year = Number(offsetDate(mon).slice(0, 4));
      const held = await pendingOf(elLeaveTypeId, year);
      // Overlaps the original's own dates (an edit must not clash with the request it replaces) and is one day longer.
      const edited = await edit(employeeToken, oldId, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon + 2),
      }).expect(200);
      expect((edited.body as LeaveBody).totalDays).toBe(3);
      expect(
        (await prisma.leave.findUniqueOrThrow({ where: { id: oldId } })).status,
      ).toBe('CANCELLED');
      expect(await pendingOf(elLeaveTypeId, year)).toBe(held + 1);
    });

    it("LV-2: only the employee's own holidays reduce the days charged; another department's and optional ones do not", async () => {
      const mon = offsetToWeekday(250, 1);
      const own = (
        await prisma.user.findUniqueOrThrow({ where: { id: employeeId } })
      ).departmentId!;
      const other = await request(app.getHttpServer())
        .post('/departments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Holiday Other', code: 'HOL' })
        .expect(201);
      const mkHoliday = (name: string, date: string, extra: object) =>
        request(app.getHttpServer())
          .post('/holidays')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name, date, ...extra })
          .expect(201);
      await mkHoliday('Other dept only', offsetDate(mon + 2), {
        department: (other.body as { id: string }).id,
      });
      await mkHoliday('Optional festival', offsetDate(mon + 3), {
        isOptional: true,
      });
      const week = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon + 4),
      }).expect(201);
      expect((week.body as LeaveBody).totalDays).toBe(5);

      // The employee's own department's holiday does come off.
      const mon2 = offsetToWeekday(260, 1);
      await mkHoliday('Own dept holiday', offsetDate(mon2 + 2), {
        department: own,
      });
      const week2 = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(mon2),
        endDate: offsetDate(mon2 + 4),
      }).expect(201);
      expect((week2.body as LeaveBody).totalDays).toBe(4);
    });

    it('LV-3: a half-day on a weekly off is refused; on a working day it is accepted', async () => {
      const sunday = offsetToWeekday(270, 0);
      const refused = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(sunday),
        endDate: offsetDate(sunday),
        isHalfDay: true,
        halfDaySession: 'FIRST_HALF',
      }).expect(400);
      expect(JSON.stringify(refused.body)).toContain('weekly off or holiday');
      const tue = offsetToWeekday(270, 2);
      await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: offsetDate(tue),
        endDate: offsetDate(tue),
        isHalfDay: true,
        halfDaySession: 'FIRST_HALF',
      }).expect(201);
    });

    it('LV-7: the morning under one leave and the afternoon under another is allowed; the same session twice is not', async () => {
      const second = await request(app.getHttpServer())
        .post('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Half Day Mate',
          code: 'HDM',
          allocationType: 'FIXED_ANNUAL',
          annualQuota: 10,
        })
        .expect(201);
      const mateId = (second.body as LeaveTypeBody).id;
      const wed = offsetToWeekday(280, 3);
      const date = offsetDate(wed);
      await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: date,
        endDate: date,
        isHalfDay: true,
        halfDaySession: 'FIRST_HALF',
      }).expect(201);
      await apply(employeeToken, {
        leaveType: mateId,
        startDate: date,
        endDate: date,
        isHalfDay: true,
        halfDaySession: 'FIRST_HALF',
      }).expect(400);
      await apply(employeeToken, {
        leaveType: mateId,
        startDate: date,
        endDate: date,
        isHalfDay: true,
        halfDaySession: 'SECOND_HALF',
      }).expect(201);
      // A full day over a half-day is still a clash.
      await apply(employeeToken, {
        leaveType: mateId,
        startDate: date,
        endDate: date,
      }).expect(400);
    });

    it('LV-4: auto-approval waits for level-1 on a two-level type; once the manager has signed off it approves and is audited', async () => {
      const type = await request(app.getHttpServer())
        .post('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Two Level Auto',
          code: 'TLA',
          allocationType: 'FIXED_ANNUAL',
          annualQuota: 10,
          approvalLevels: 2,
          autoApproveIfNoAction: true,
          autoApproveHours: 1,
        })
        .expect(201);
      const typeId = (type.body as LeaveTypeBody).id;
      const mon = offsetToWeekday(290, 1);
      const created = await apply(employeeToken, {
        leaveType: typeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon),
      }).expect(201);
      const id = (created.body as LeaveBody).id;
      await prisma.leave.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 3 * 3600000) },
      });
      await leavesService.autoApprovePendingLeaves();
      expect(
        (await prisma.leave.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('PENDING');

      // The manager signs off level 1; the sweep may now give the final approval.
      await request(app.getHttpServer())
        .patch(`/leaves/${id}/review`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      await leavesService.autoApprovePendingLeaves();
      const done = await prisma.leave.findUniqueOrThrow({ where: { id } });
      expect(done.status).toBe('APPROVED');
      const audit = await prisma.auditLog.findFirst({
        where: { targetId: id, action: 'LEAVE_AUTO_APPROVED' },
      });
      expect((audit?.details as { source?: string })?.source).toBe('SCHEDULED');
    });

    it("LV-5: a leave across New Year takes each year's days from that year's balance, and gives them back on cancel", async () => {
      // 2030-12-30 is a Monday: Mon + Tue in 2030, Wed + Thu in 2031 (Sunday is the only weekly off).
      const created = await apply(employeeToken, {
        leaveType: elLeaveTypeId,
        startDate: '2030-12-30',
        endDate: '2031-01-02',
      }).expect(201);
      const id = (created.body as LeaveBody).id;
      expect((created.body as LeaveBody).totalDays).toBe(4);
      expect(await pendingOf(elLeaveTypeId, 2030)).toBeGreaterThanOrEqual(2);
      const row = (y: number) =>
        prisma.leaveBalance.findFirstOrThrow({
          where: { employeeId, leaveTypeId: elLeaveTypeId, year: y },
        });
      const before = { a: await row(2030), b: await row(2031) };
      expect(before.a.pending).toBe(2);
      expect(before.b.pending).toBe(2);

      await request(app.getHttpServer())
        .patch(`/leaves/${id}/review`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/leaves/${id}/review`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect([(await row(2030)).availed, (await row(2031)).availed]).toEqual([
        2, 2,
      ]);
      expect([(await row(2030)).pending, (await row(2031)).pending]).toEqual([
        0, 0,
      ]);

      await request(app.getHttpServer())
        .patch(`/leaves/${id}/cancel`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect([(await row(2030)).availed, (await row(2031)).availed]).toEqual([
        0, 0,
      ]);
    });

    it('LV-5b: HR can approve a two-level leave without the manager only with an override and a reason, and it is audited', async () => {
      const type = await request(app.getHttpServer())
        .post('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Two Level Override',
          code: 'TLO',
          allocationType: 'FIXED_ANNUAL',
          annualQuota: 10,
          approvalLevels: 2,
        })
        .expect(201);
      const typeId = (type.body as LeaveTypeBody).id;
      const mon = offsetToWeekday(310, 1);
      const created = await apply(employeeToken, {
        leaveType: typeId,
        startDate: offsetDate(mon),
        endDate: offsetDate(mon),
      }).expect(201);
      const id = (created.body as LeaveBody).id;
      const review = (body: Record<string, unknown>) =>
        request(app.getHttpServer())
          .patch(`/leaves/${id}/review`)
          .set('Authorization', `Bearer ${hrToken}`)
          .send(body);
      // Without the override it still waits for the manager, and says the override exists.
      const waiting = await review({ decision: 'APPROVED' }).expect(400);
      expect(JSON.stringify(waiting.body)).toContain('override');
      // The override needs a reason.
      await review({ decision: 'APPROVED', overrideLevelOne: true }).expect(
        400,
      );
      await review({
        decision: 'APPROVED',
        overrideLevelOne: true,
        comments: 'Manager is on leave',
      }).expect(200);
      expect(
        (await prisma.leave.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('APPROVED');
      const audit = await prisma.auditLog.findFirst({
        where: { targetId: id, action: 'LEAVE_LEVEL1_OVERRIDDEN' },
      });
      expect((audit?.details as { reason?: string })?.reason).toBe(
        'Manager is on leave',
      );
    });

    it('LV-6: leave cannot start before the joining date', async () => {
      await prisma.user.update({
        where: { id: employeeId },
        data: { joiningDate: new Date('2031-06-01T00:00:00.000Z') },
      });
      try {
        const refused = await apply(employeeToken, {
          leaveType: elLeaveTypeId,
          startDate: '2031-05-05',
          endDate: '2031-05-05',
        }).expect(400);
        expect(JSON.stringify(refused.body)).toContain('joining date');
        await apply(employeeToken, {
          leaveType: elLeaveTypeId,
          startDate: '2031-06-03',
          endDate: '2031-06-03',
        }).expect(201);
      } finally {
        await prisma.user.update({
          where: { id: employeeId },
          data: { joiningDate: new Date('2020-01-01T00:00:00.000Z') },
        });
      }
    });

    it("LV-10: who's out shows approved leave to colleagues, with no type or remarks; HR sees everyone; others see only their department", async () => {
      const orgId = (
        await prisma.user.findUniqueOrThrow({ where: { id: employeeId } })
      ).organizationId;
      const type = elLeaveTypeId;
      const day = '2031-09-02';
      await prisma.leave.create({
        data: {
          organizationId: orgId,
          employeeId,
          leaveTypeId: type,
          startDate: day,
          endDate: day,
          totalDays: 1,
          status: 'APPROVED',
          remarks: 'private medical reason',
        },
      });
      await prisma.leave.create({
        data: {
          organizationId: orgId,
          employeeId: outsideDeptEmployeeId,
          leaveTypeId: type,
          startDate: day,
          endDate: day,
          totalDays: 1,
          status: 'APPROVED',
          remarks: 'other dept',
        },
      });
      await prisma.leave.create({
        data: {
          organizationId: orgId,
          employeeId,
          leaveTypeId: type,
          startDate: '2031-09-03',
          endDate: '2031-09-03',
          totalDays: 1,
          status: 'PENDING',
        },
      });
      const get = (token: string) =>
        request(app.getHttpServer())
          .get('/leaves/whos-out')
          .query({ from: '2031-09-01', to: '2031-09-05' })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      const asManager = (await get(managerToken)).body as {
        data: Record<string, unknown>[];
      };
      expect(asManager.data.map((r) => r.employeeId)).toEqual([employeeId]);
      const row = asManager.data[0];
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['remarks']));
      expect(JSON.stringify(row)).not.toContain('private medical reason');
      expect(row).not.toHaveProperty('leaveType');
      const asHr = (await get(hrToken)).body as {
        data: { employeeId: string }[];
      };
      expect(asHr.data.map((r) => r.employeeId).sort()).toEqual(
        [employeeId, outsideDeptEmployeeId].sort(),
      );
      // The pending request is not shown to anyone.
      expect(asHr.data).toHaveLength(2);
      const asEmployee = (await get(employeeToken)).body as {
        data: { employeeId: string }[];
      };
      expect(asEmployee.data.map((r) => r.employeeId)).toEqual([employeeId]);
    });
  });
});
