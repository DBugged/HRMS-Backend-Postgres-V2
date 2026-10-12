import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}
interface Line {
  code: string;
  amount: number;
}
interface RunBody {
  payrolls: Array<{
    id: string;
    earnings: Line[];
    deductions: Line[];
    grossSalary: number;
    netPay: number;
    attendanceSummary: Record<string, number>;
  }>;
  failures?: unknown[];
}

const PASSWORD = 'TestPass123!';

// Payroll correctness fixes found in the end-to-end payroll test (B1-B9). One describe per fix.
describe('Payroll correctness fixes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;

  const post = (url: string) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${adminToken}`);
  const patch = (url: string) =>
    request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`);

  const mkEmployee = async (name: string, email: string, joining: string) => {
    const res = await post('/employees').send({
      name,
      email,
      joiningDate: joining,
    });
    expect(res.status).toBe(201);
    return (res.body as EmployeeCreateBody).employee.id;
  };
  const setStructure = async (
    id: string,
    lines: Array<Record<string, unknown>>,
    effectiveFrom: string,
  ) => {
    for (const line of lines) {
      const res = await post(`/employee-salary/${id}/structure`).send({
        ...line,
        effectiveFrom,
      });
      expect(res.status).toBe(201);
    }
  };
  const fillAttendance = async (
    id: string,
    year: number,
    month: number,
    opts: { skip?: number[]; status?: 'PRESENT' | 'ABSENT' } = {},
  ) => {
    const days = new Date(year, month, 0).getDate();
    const rows: Prisma.AttendanceCreateManyInput[] = [];
    for (let d = 1; d <= days; d++) {
      if (opts.skip?.includes(d)) continue;
      rows.push({
        organizationId,
        employeeId: id,
        date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        status: opts.status ?? ('PRESENT' as const),
        source: 'FACE_API' as const,
      });
    }
    await prisma.attendance.createMany({ data: rows });
  };
  const calculate = async (id: string, month: number, year: number) => {
    const res = await post('/payroll/calculate').send({
      month,
      year,
      employeeId: id,
    });
    expect(res.status).toBe(201);
    return res.body as RunBody;
  };
  const line = (rows: Line[], code: string) =>
    rows.find((r) => r.code === code)?.amount ?? 0;

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
      organizationName: 'Payroll Fixes Org',
      name: 'Founder',
      email: 'pf-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'pf-admin@example.test', password: PASSWORD })
      ).body as AuthBody
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'pf-admin@example.test' },
      })
    ).organizationId;
    for (const fy of ['2025-26', '2026-27']) {
      const slab = await prisma.taxSlabConfig.findFirst({
        where: { organizationId, financialYear: fy, regime: 'NEW' },
      });
      if (!slab)
        await post('/tax-slabs').send({ financialYear: fy, regime: 'NEW' });
    }
  });

  afterAll(async () => {
    // Background work started by the last requests (attendance recalculation after a punch) can still be writing:
    // wait for it to settle, and retry if the clean-up collides with it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "organizations" RESTART IDENTITY CASCADE',
        );
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    await app.close();
  });

  describe('B7 - a yearly component entered as a yearly amount is paid whole', () => {
    it('Variable Pay 50,000 per year (ANNUAL basis) pays 50,000 in March, not 4,167', async () => {
      const id = await mkEmployee(
        'Var Annual',
        'pf-var-annual@example.test',
        '2025-04-01',
      );
      await setStructure(
        id,
        [
          { componentCode: 'BASIC', fixedAmount: 100000 },
          {
            componentCode: 'VARIABLE_PAY',
            fixedAmount: 50000,
            amountBasis: 'ANNUAL',
          },
        ],
        '2025-04-01',
      );
      await fillAttendance(id, 2026, 3);
      const run = await calculate(id, 3, 2026);
      expect(run.failures ?? []).toHaveLength(0);
      expect(line(run.payrolls[0].earnings, 'VARIABLE_PAY')).toBe(50000);
    });

    it('the same amount entered as MONTHLY basis still pays 50,000 in March', async () => {
      const id = await mkEmployee(
        'Var Monthly',
        'pf-var-monthly@example.test',
        '2025-04-01',
      );
      await setStructure(
        id,
        [
          { componentCode: 'BASIC', fixedAmount: 100000 },
          {
            componentCode: 'VARIABLE_PAY',
            fixedAmount: 50000,
            amountBasis: 'MONTHLY',
          },
        ],
        '2025-04-01',
      );
      await fillAttendance(id, 2026, 3);
      const run = await calculate(id, 3, 2026);
      expect(line(run.payrolls[0].earnings, 'VARIABLE_PAY')).toBe(50000);
    });

    it('a yearly component is not paid in an ordinary month', async () => {
      const id = await mkEmployee(
        'Var Other Month',
        'pf-var-other@example.test',
        '2025-04-01',
      );
      await setStructure(
        id,
        [
          { componentCode: 'BASIC', fixedAmount: 100000 },
          {
            componentCode: 'VARIABLE_PAY',
            fixedAmount: 50000,
            amountBasis: 'ANNUAL',
          },
        ],
        '2025-04-01',
      );
      await fillAttendance(id, 2026, 2);
      const run = await calculate(id, 2, 2026);
      expect(line(run.payrolls[0].earnings, 'VARIABLE_PAY')).toBe(0);
    });
  });

  describe('B9 - overtime is paid at the full-month hourly rate', () => {
    it('a joiner working 15 of 30 days still gets overtime at Basic 1,00,000 / 208 per hour', async () => {
      const id = await mkEmployee(
        'Part Month Ot',
        'pf-ot-part@example.test',
        '2026-06-16',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 100000 }],
        '2026-06-16',
      );
      await prisma.attendance.createMany({
        data: Array.from({ length: 15 }, (_, i) => ({
          organizationId,
          employeeId: id,
          date: `2026-06-${String(16 + i).padStart(2, '0')}`,
          status: 'PRESENT' as const,
          source: 'FACE_API' as const,
        })),
      });
      await prisma.overtimeRecord.create({
        data: {
          organizationId,
          employeeId: id,
          date: '2026-06-17',
          hours: 4,
          type: 'REGULAR',
          rateMultiplier: 1.5,
          status: 'APPROVED',
        },
      });
      const run = await calculate(id, 6, 2026);
      const earnings = run.payrolls[0].earnings;
      expect(line(earnings, 'BASIC')).toBe(50000);
      // 4 h x 1.5 = 6 weighted hours x (1,00,000 / 208)
      expect(line(earnings, 'OVERTIME_PAY')).toBe(
        Math.round(6 * (100000 / 208)),
      );
    });

    it('a full month pays the same hourly rate', async () => {
      const id = await mkEmployee(
        'Full Month Ot',
        'pf-ot-full@example.test',
        '2026-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 100000 }],
        '2026-01-01',
      );
      await fillAttendance(id, 2026, 7);
      await prisma.overtimeRecord.create({
        data: {
          organizationId,
          employeeId: id,
          date: '2026-07-08',
          hours: 4,
          type: 'REGULAR',
          rateMultiplier: 1.5,
          status: 'APPROVED',
        },
      });
      const run = await calculate(id, 7, 2026);
      expect(line(run.payrolls[0].earnings, 'OVERTIME_PAY')).toBe(
        Math.round(6 * (100000 / 208)),
      );
    });
  });

  describe('B8 - a half-day leave with no punch pays half a day, not a full day', () => {
    const halfDayMonth = async (punchedOtherHalf: boolean) => {
      const email = `pf-half-${punchedOtherHalf ? 'worked' : 'nopunch'}@example.test`;
      const created = await post('/employees').send({
        name: 'Half Day Person',
        email,
        joiningDate: '2026-01-01',
      });
      expect(created.status).toBe(201);
      const body = created.body as EmployeeCreateBody & {
        generatedPassword: string;
      };
      const id = body.employee.id;
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 31000 }],
        '2026-01-01',
      );
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: body.generatedPassword });
      const employeeToken = (login.body as AuthBody).accessToken;
      const types = await request(app.getHttpServer())
        .get('/leave-types')
        .set('Authorization', `Bearer ${adminToken}`);
      const typeRows = Array.isArray(types.body)
        ? (types.body as Array<{ id: string; code: string }>)
        : (types.body as { data: Array<{ id: string; code: string }> }).data;
      const cl = typeRows.find((t) => t.code === 'CL');
      // the test month is long past, so this leave type has to accept a backdated request
      const clRow = await prisma.leaveType.findFirstOrThrow({
        where: { id: cl?.id },
      });
      await prisma.leaveType.update({
        where: { id: clRow.id },
        data: {
          rules: {
            ...(clRow.rules as Record<string, unknown>),
            allowBackdated: true,
            maxBackdateDays: 365,
          },
        },
      });
      await prisma.leaveBalance.create({
        data: {
          organizationId,
          employeeId: id,
          leaveTypeId: clRow.id,
          year: 2026,
          credited: 5,
        },
      });
      // every day of July is a present day except the 8th, which only has the half-day leave
      await fillAttendance(id, 2026, 7, { skip: [8] });
      const applied = await request(app.getHttpServer())
        .post('/leaves')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          leaveType: cl?.id,
          startDate: '2026-07-08',
          endDate: '2026-07-08',
          isHalfDay: true,
          halfDaySession: 'FIRST_HALF',
        });
      expect(applied.status).toBe(201);
      const reviewed = await patch(
        `/leaves/${(applied.body as { id: string }).id}/review`,
      ).send({ decision: 'APPROVED' });
      expect(reviewed.status).toBe(200);
      if (punchedOtherHalf) {
        // the afternoon is worked: the punch turns the stamp into a worked half day
        await prisma.attendance.updateMany({
          where: { employeeId: id, date: '2026-07-08' },
          data: { source: 'FACE_API' },
        });
      }
      return calculate(id, 7, 2026);
    };

    it('no punch on the leave day: 30.5 of 31 days payable', async () => {
      const run = await halfDayMonth(false);
      expect(run.payrolls[0].attendanceSummary.payableDays).toBe(30.5);
      expect(line(run.payrolls[0].earnings, 'BASIC')).toBe(
        Math.round((31000 * 30.5) / 31),
      );
    });

    it('the other half worked: the whole day is paid', async () => {
      const run = await halfDayMonth(true);
      expect(run.payrolls[0].attendanceSummary.payableDays).toBe(31);
    });
  });

  describe('B1 and B2 - final settlement', () => {
    let exitedId: string;
    let settlementId: string;

    it('B1: the pending salary stops at the last working day (no paid weekly offs after it)', async () => {
      exitedId = await mkEmployee(
        'Exit Person',
        'pf-exit@example.test',
        '2025-01-01',
      );
      await setStructure(
        exitedId,
        [{ componentCode: 'BASIC', fixedAmount: 31000 }],
        '2026-01-01',
      );
      // present 1-9 July, last working day 9 July; Saturdays/Sundays after it must not be paid
      await prisma.attendance.createMany({
        data: Array.from({ length: 9 }, (_, i) => ({
          organizationId,
          employeeId: exitedId,
          date: `2026-07-${String(i + 1).padStart(2, '0')}`,
          status: 'PRESENT' as const,
          source: 'FACE_API' as const,
        })),
      });
      const res = await post('/settlements/calculate').send({
        employeeId: exitedId,
        lastWorkingDay: '2026-07-09',
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        id: string;
        pendingSalaryBreakdown: { earnings: Line[] };
      };
      settlementId = body.id;
      // 9 of 31 days
      expect(line(body.pendingSalaryBreakdown.earnings, 'BASIC')).toBe(9000);
    });

    it('B2: once the settlement is processed, a regular payroll run skips the employee', async () => {
      const processed = await post(`/settlements/${settlementId}/process`).send(
        {},
      );
      expect(processed.status).toBe(201);
      const res = await post('/payroll/calculate').send({
        month: 7,
        year: 2026,
        employeeId: exitedId,
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        payrolls: unknown[];
        skipped: Array<{ employeeId: string; reason: string }>;
      };
      expect(body.payrolls).toHaveLength(0);
      expect(
        body.skipped.find((s) => s.employeeId === exitedId)?.reason,
      ).toMatch(/final settlement/i);
      expect(
        await prisma.payrollRun.count({
          where: { employeeId: exitedId, isFinalSettlement: false },
        }),
      ).toBe(0);
      // a later month is skipped too
      const later = await post('/payroll/calculate').send({
        month: 8,
        year: 2026,
        employeeId: exitedId,
      });
      expect(
        (later.body as { skipped: Array<{ employeeId: string }> }).skipped.some(
          (s) => s.employeeId === exitedId,
        ),
      ).toBe(true);
    });

    it('B2: an employee without a settlement is still calculated', async () => {
      const id = await mkEmployee(
        'Still Here',
        'pf-still@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 31000 }],
        '2026-01-01',
      );
      await fillAttendance(id, 2026, 7);
      const run = await calculate(id, 7, 2026);
      expect(run.payrolls).toHaveLength(1);
    });
  });

  describe('B5 - a month with no attended day does not pay the weekly offs', () => {
    it('absent every working day of September: nothing is payable', async () => {
      const id = await mkEmployee(
        'No Show',
        'pf-noshow@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      const run = await calculate(id, 9, 2026);
      expect(run.payrolls[0].attendanceSummary.payableDays).toBe(0);
      expect(run.payrolls[0].grossSalary).toBe(0);
    });

    it('weekly-off rows already written by the daily job are not paid either', async () => {
      const id = await mkEmployee(
        'No Show Rows',
        'pf-noshow-rows@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await prisma.attendance.createMany({
        data: ['05', '06', '12', '13', '19', '20', '26', '27'].map((d) => ({
          organizationId,
          employeeId: id,
          date: `2026-09-${d}`,
          status: 'WEEKLY_OFF' as const,
          source: 'SYSTEM' as const,
        })),
      });
      const run = await calculate(id, 9, 2026);
      expect(run.payrolls[0].attendanceSummary.payableDays).toBe(0);
      expect(run.payrolls[0].grossSalary).toBe(0);
    });

    it('present on a single day: the weekly offs are paid as usual', async () => {
      const id = await mkEmployee(
        'One Day',
        'pf-oneday@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await prisma.attendance.create({
        data: {
          organizationId,
          employeeId: id,
          date: '2026-09-10',
          status: 'PRESENT',
          source: 'FACE_API',
        },
      });
      const run = await calculate(id, 9, 2026);
      // Sept 2026: 4 Saturdays + 4 Sundays + the one present day
      expect(run.payrolls[0].attendanceSummary.payableDays).toBe(9);
    });
  });

  describe('B6 - a one-month entry (arrears, bonus) does not repeat', () => {
    const arrears = (id: string, extra: Record<string, unknown>) =>
      post(`/employee-salary/${id}/structure`).send({
        componentCode: 'ARREARS',
        fixedAmount: 5000,
        valueType: 'MANUAL',
        ...extra,
      });

    it('arrears for September are paid in September and gone in October', async () => {
      const id = await mkEmployee(
        'Arrears Once',
        'pf-arrears@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await fillAttendance(id, 2026, 9);
      await fillAttendance(id, 2026, 10, { skip: [] });
      const added = await arrears(id, { applyOnlyForMonth: '2026-09' });
      expect(added.status).toBe(201);
      const sep = await calculate(id, 9, 2026);
      expect(line(sep.payrolls[0].earnings, 'ARREARS')).toBe(5000);
      const oct = await calculate(id, 10, 2026);
      expect(line(oct.payrolls[0].earnings, 'ARREARS')).toBe(0);
    });

    it('without the option the entry still repeats (a running component)', async () => {
      const id = await mkEmployee(
        'Arrears Repeat',
        'pf-arrears-rep@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await fillAttendance(id, 2026, 9);
      await fillAttendance(id, 2026, 10);
      expect((await arrears(id, { effectiveFrom: '2026-09-01' })).status).toBe(
        201,
      );
      expect(
        line((await calculate(id, 9, 2026)).payrolls[0].earnings, 'ARREARS'),
      ).toBe(5000);
      expect(
        line((await calculate(id, 10, 2026)).payrolls[0].earnings, 'ARREARS'),
      ).toBe(5000);
    });

    it('entering the same month again corrects the amount instead of adding another', async () => {
      const id = await mkEmployee(
        'Arrears Fix',
        'pf-arrears-fix@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await fillAttendance(id, 2026, 9);
      await arrears(id, { applyOnlyForMonth: '2026-09' });
      await arrears(id, { applyOnlyForMonth: '2026-09', fixedAmount: 7000 });
      const rows = await prisma.employeeSalaryComponent.findMany({
        where: { employeeId: id, componentCode: 'ARREARS' },
      });
      expect(rows).toHaveLength(1);
      expect(
        line((await calculate(id, 9, 2026)).payrolls[0].earnings, 'ARREARS'),
      ).toBe(7000);
    });

    it('is refused while the employee has a running entry for the component', async () => {
      const id = await mkEmployee(
        'Arrears Clash',
        'pf-arrears-clash@example.test',
        '2025-01-01',
      );
      await setStructure(
        id,
        [{ componentCode: 'BASIC', fixedAmount: 30000 }],
        '2026-01-01',
      );
      await arrears(id, { effectiveFrom: '2026-09-01' });
      const clash = await arrears(id, { applyOnlyForMonth: '2026-10' });
      expect(clash.status).toBe(400);
    });

    it('rejects a malformed month', async () => {
      const id = await mkEmployee(
        'Arrears Bad',
        'pf-arrears-bad@example.test',
        '2025-01-01',
      );
      const bad = await arrears(id, { applyOnlyForMonth: '2026-13' });
      expect(bad.status).toBe(400);
    });
  });

  describe('B3 - work on a weekly off is overtime at the weekend rate, for the whole day', () => {
    const punch = async (id: string, punchTime: string) => {
      const res = await post('/attendance/punch/manual').send({
        employeeId: id,
        punchTime,
      });
      expect(res.status).toBe(201);
    };

    it('a Saturday worked 09:30-18:30 gives WEEKEND overtime (2x) for the hours worked, not 0 or REGULAR', async () => {
      const id = await mkEmployee(
        'Saturday Worker',
        'pf-sat@example.test',
        '2025-01-01',
      );
      await punch(id, '2026-08-08T04:00:00.000Z');
      await punch(id, '2026-08-08T13:00:00.000Z');
      const ot = await prisma.overtimeRecord.findFirstOrThrow({
        where: { employeeId: id, date: '2026-08-08' },
      });
      expect(ot.type).toBe('WEEKEND');
      expect(ot.rateMultiplier).toBe(2);
      expect(ot.source).toBe('AUTO_PUNCH');
      expect(ot.status).toBe('PENDING');
      // 9 hours on the clock less the unpaid break
      const attendance = await prisma.attendance.findFirstOrThrow({
        where: { employeeId: id, date: '2026-08-08' },
      });
      expect(ot.hours).toBeGreaterThanOrEqual(7);
      expect(ot.hours).toBeLessThanOrEqual(9);
      expect(attendance.workDurationMinutes).toBe(540);
    });

    it('an ordinary weekday still counts only the time past the shift end, as REGULAR', async () => {
      const id = await mkEmployee(
        'Weekday Worker',
        'pf-weekday@example.test',
        '2025-01-01',
      );
      await punch(id, '2026-08-11T04:00:00.000Z');
      await punch(id, '2026-08-11T14:00:00.000Z');
      const ot = await prisma.overtimeRecord.findFirstOrThrow({
        where: { employeeId: id, date: '2026-08-11' },
      });
      expect(ot.type).toBe('REGULAR');
      expect(ot.hours).toBe(1);
    });

    it('a weekday worked only to the shift end gives no overtime', async () => {
      const id = await mkEmployee(
        'Weekday Normal',
        'pf-weekday2@example.test',
        '2025-01-01',
      );
      await punch(id, '2026-08-12T04:00:00.000Z');
      await punch(id, '2026-08-12T13:00:00.000Z');
      expect(
        await prisma.overtimeRecord.count({
          where: { employeeId: id, date: '2026-08-12' },
        }),
      ).toBe(0);
    });
  });

  describe('ESI report lists only people ESI is charged on', () => {
    it('a high earner (ESI 0) is left out, a covered employee is in', async () => {
      const high = await mkEmployee(
        'Esi High Earner',
        'pf-esi-high@example.test',
        '2025-01-01',
      );
      const low = await mkEmployee(
        'Esi Covered Person',
        'pf-esi-low@example.test',
        '2025-01-01',
      );
      await setStructure(
        high,
        [{ componentCode: 'BASIC', fixedAmount: 50000 }],
        '2026-01-01',
      );
      await setStructure(
        low,
        [{ componentCode: 'BASIC', fixedAmount: 12000 }],
        '2026-01-01',
      );
      await request(app.getHttpServer())
        .put('/payroll-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ esiEnabled: true })
        .expect(200);
      const ids: string[] = [];
      for (const id of [high, low]) {
        await fillAttendance(id, 2026, 10);
        ids.push((await calculate(id, 10, 2026)).payrolls[0].id);
      }
      for (const action of ['verify', 'approve', 'lock']) {
        const res = await post('/payroll/bulk-transition').send({
          ids,
          action,
        });
        expect(res.status).toBe(201);
      }
      const report = await request(app.getHttpServer())
        .get('/reports/payroll/esi?month=10&year=2026&format=csv')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(report.status).toBe(200);
      const text = report.text;
      expect(text).toContain('Esi Covered Person');
      expect(text).not.toContain('Esi High Earner');
    });
  });
});
