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

const PASSWORD = 'TestPass123!';

interface OtRow {
  id: string;
  status: string;
  source: string;
  type: string;
  hours: number;
  date: string;
  compensationKey: string | null;
  payDays: number;
  compOffDays: number;
  compOffId: string | null;
}

// Excel-imported weekend work becomes a pending overtime request; the approver chooses how it is compensated
// (comp-off, days of pay, or both) and payroll plus the comp-off balance follow.
describe('Weekend work compensation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;
  let employeeId: string;
  let employeeCode: string;

  const as = (token: string) => ({
    get: (u: string) =>
      request(app.getHttpServer())
        .get(u)
        .set('Authorization', `Bearer ${token}`),
    post: (u: string) =>
      request(app.getHttpServer())
        .post(u)
        .set('Authorization', `Bearer ${token}`),
    put: (u: string) =>
      request(app.getHttpServer())
        .put(u)
        .set('Authorization', `Bearer ${token}`),
    patch: (u: string) =>
      request(app.getHttpServer())
        .patch(u)
        .set('Authorization', `Bearer ${token}`),
  });
  const admin = () => as(adminToken);

  const importRows = async (
    rows: Array<[string, string, string]>,
    timeBasis?: 'UTC' | 'ORG',
  ) => {
    const upload = await admin()
      .post('/attendance/import')
      .send({
        ...(timeBasis ? { timeBasis } : {}),
        rows: rows.map(([date, inTime, outTime]) => ({
          employeeId: employeeCode,
          date,
          inTime: `${date} ${inTime}:00`,
          outTime: `${date} ${outTime}:00`,
        })),
      })
      .expect(201);
    const id = (upload.body as { id: string }).id;
    await admin().post(`/attendance/import/${id}/validate`).expect(201);
    const run = await admin()
      .post(`/attendance/import/${id}/execute`)
      .expect(201);
    return run.body as {
      executionResult: { imported: number; errors: number };
    };
  };
  const otFor = async (date: string) =>
    (await prisma.overtimeRecord.findFirstOrThrow({
      where: { organizationId, employeeId, date },
    })) as unknown as OtRow;

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
      organizationName: 'Weekend Comp Org',
      name: 'Founder',
      email: 'wc-admin@example.test',
      password: PASSWORD,
    });
    adminToken = (
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'wc-admin@example.test', password: PASSWORD })
      ).body as { accessToken: string }
    ).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'wc-admin@example.test' },
      })
    ).organizationId;
    const created = await admin()
      .post('/employees')
      .send({
        name: 'Yash Weekend',
        email: 'wc-yash@example.test',
        joiningDate: '2026-01-01',
      })
      .expect(201);
    employeeId = (created.body as { employee: { id: string } }).employee.id;
    employeeCode = (created.body as { employee: { employeeId: string } })
      .employee.employeeId;
    await admin()
      .post(`/employee-salary/${employeeId}/structure`)
      .send({
        componentCode: 'BASIC',
        valueType: 'FIXED',
        fixedAmount: 30000,
        effectiveFrom: '2026-01-01',
      })
      .expect(201);
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

  it('an imported Sunday and an imported late weekday each become a pending overtime request', async () => {
    const result = await importRows([
      ['2026-09-13', '03:30', '12:30'], // Sunday (weekly off), 9h on the clock
      ['2026-09-14', '03:30', '14:30'], // Monday, 11h: well past the shift end
      ['2026-09-15', '03:30', '12:30'], // Tuesday, an ordinary day inside the shift
    ]);
    expect(result.executionResult).toMatchObject({
      imported: 3,
      errors: 0,
      overtimeRequests: 2, // the Sunday and the late Monday; the Tuesday stayed inside the shift
    });
    const note = await prisma.notification.findFirst({
      where: {
        organizationId,
        title: 'Overtime requests from an attendance import',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(note?.message).toContain('2 overtime requests');
    const sunday = await otFor('2026-09-13');
    expect(sunday).toMatchObject({
      status: 'PENDING',
      source: 'IMPORT',
      type: 'WEEKEND',
      hours: 9, // the whole day on the clock (this organisation has no unpaid break set)
    });
    const monday = await otFor('2026-09-14');
    expect(monday).toMatchObject({
      status: 'PENDING',
      source: 'IMPORT',
      type: 'REGULAR',
    });
    expect(
      await prisma.overtimeRecord.count({
        where: { organizationId, employeeId, date: '2026-09-15' },
      }),
    ).toBe(0);
  });

  it('an unconfigured organization is offered no compensation option (the built-in list starts at 0 / 0)', async () => {
    const res = await admin().get('/overtime/compensation-options').expect(200);
    const body = res.body as {
      defaultKey: string | null;
      options: { key: string }[];
    };
    expect(body.defaultKey).toBeNull();
    expect(body.options).toEqual([]);
  });

  it('saving the standard options makes them selectable, with no default', async () => {
    const current = await admin().get('/payroll-settings').expect(200);
    await admin()
      .put('/payroll-settings')
      .send({
        ...pickSettings(current.body as Record<string, unknown>),
        workCompensation: {
          defaultKey: null,
          options: [
            { key: 'COMP_OFF', label: 'Comp-off (1 day)', compOffDays: 1, payDays: 0 },
            { key: 'PAY_1', label: '1 day pay', compOffDays: 0, payDays: 1 },
            { key: 'PAY_2', label: '2 days pay', compOffDays: 0, payDays: 2 },
            { key: 'COMP_OFF_PAY_1', label: 'Comp-off + 1 day pay', compOffDays: 1, payDays: 1 },
            { key: 'COMP_OFF_PAY_2', label: 'Comp-off + 2 days pay', compOffDays: 1, payDays: 2 },
          ],
        },
      })
      .expect(200);
    const res = await admin().get('/overtime/compensation-options').expect(200);
    const body = res.body as { defaultKey: string | null; options: { key: string }[] };
    expect(body.defaultKey).toBeNull();
    expect(body.options.map((o) => o.key)).toEqual(['COMP_OFF', 'PAY_1', 'PAY_2', 'COMP_OFF_PAY_1', 'COMP_OFF_PAY_2']);
  });

  it('comp-off + 1 day pay: a comp-off lands in the balance and payroll pays one day', async () => {
    const sunday = await otFor('2026-09-13');
    const res = await admin()
      .patch(`/overtime/${sunday.id}/review`)
      .send({ status: 'APPROVED', compensationKey: 'COMP_OFF_PAY_1' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'APPROVED',
      compensationKey: 'COMP_OFF_PAY_1',
      payDays: 1,
      compOffDays: 1,
    });
    const compOff = await prisma.compOff.findFirstOrThrow({
      where: { organizationId, employeeId, earnedForDate: '2026-09-13' },
    });
    expect(compOff).toMatchObject({ status: 'APPROVED', daysEarned: 1 });
    expect(compOff.expiryDate).toBe('2026-12-12');
    expect((res.body as OtRow).compOffId).toBe(compOff.id);

    const run = await admin()
      .post('/payroll/calculate')
      .send({ month: 9, year: 2026, employeeId })
      .expect(201);
    const payroll = (
      run.body as {
        payrolls: {
          earnings: { code: string; amount: number }[];
          attendanceSummary: Record<string, number>;
        }[];
      }
    ).payrolls[0];
    const overtimePay = payroll.earnings.find(
      (e) => e.code === 'OVERTIME_PAY',
    )?.amount;
    // one day of pay = full-month Basic / 30
    expect(overtimePay).toBe(1000);
    expect(payroll.attendanceSummary.overtimeDayPayDays).toBe(1);
  });

  it('one day, one benefit: a comp-off cannot be claimed for a day already logged as overtime', async () => {
    const res = await admin()
      .post('/comp-offs')
      .send({ employeeId, earnedForDate: '2026-09-13', reason: 'again' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(
      /already (logged as overtime|exists)/,
    );
  });

  it('a rejected overtime day can be claimed as comp-off instead', async () => {
    await importRows([['2026-09-20', '03:30', '12:30']]); // another Sunday
    const sunday = await otFor('2026-09-20');
    await admin()
      .patch(`/overtime/${sunday.id}/review`)
      .send({ status: 'REJECTED' })
      .expect(200);
    await admin()
      .post('/comp-offs')
      .send({
        employeeId,
        earnedForDate: '2026-09-20',
        reason: 'Worked the Sunday',
      })
      .expect(201);
  });

  it('a comp-off already claimed stops the same day being approved as overtime', async () => {
    await admin()
      .post('/comp-offs')
      .send({
        employeeId,
        earnedForDate: '2026-09-27',
        reason: 'Worked the Sunday',
      })
      .expect(201);
    // the claimed day is not suggested from an import either
    await importRows([['2026-09-27', '03:30', '12:30']]);
    expect(
      await prisma.overtimeRecord.count({
        where: { organizationId, employeeId, date: '2026-09-27' },
      }),
    ).toBe(0);
  });

  it('ordinary overtime keeps the hourly rate and refuses a compensation option', async () => {
    const monday = await otFor('2026-09-14');
    await admin()
      .patch(`/overtime/${monday.id}/review`)
      .send({ status: 'APPROVED', compensationKey: 'PAY_1' })
      .expect(400);
    await admin()
      .patch(`/overtime/${monday.id}/review`)
      .send({ status: 'APPROVED' })
      .expect(200);
    const after = await otFor('2026-09-14');
    expect(after.compensationKey).toBeNull();
    const run = await admin()
      .post('/payroll/calculate')
      .send({ month: 9, year: 2026, employeeId })
      .expect(201);
    const payroll = (
      run.body as {
        payrolls: { earnings: { code: string; amount: number }[] }[];
      }
    ).payrolls[0];
    const hours = after.hours;
    const hourly = Math.round(hours * 2 * (30000 / 208));
    expect(
      payroll.earnings.find((e) => e.code === 'OVERTIME_PAY')?.amount,
    ).toBe(1000 + hourly);
  });

  it('the organisation can define its own options and a default, and the default is used', async () => {
    const current = await admin().get('/payroll-settings').expect(200);
    const saved = await admin()
      .put('/payroll-settings')
      .send({
        ...pickSettings(current.body as Record<string, unknown>),
        workCompensation: {
          defaultKey: 'HALF_PAY',
          options: [
            {
              key: 'HALF_PAY',
              label: 'Half day pay',
              compOffDays: 0,
              payDays: 0.5,
            },
            {
              key: 'COMP_OFF_HALF',
              label: 'Comp-off + half day',
              compOffDays: 1,
              payDays: 0.5,
            },
          ],
        },
      });
    expect(saved.status).toBe(200);
    const options = await admin()
      .get('/overtime/compensation-options')
      .expect(200);
    expect((options.body as { defaultKey: string }).defaultKey).toBe(
      'HALF_PAY',
    );

    await importRows([['2026-09-06', '03:30', '12:30']]); // an earlier Sunday
    const sunday = await otFor('2026-09-06');
    const res = await admin()
      .patch(`/overtime/${sunday.id}/review`)
      .send({ status: 'APPROVED' })
      .expect(200);
    expect(res.body).toMatchObject({
      compensationKey: 'HALF_PAY',
      payDays: 0.5,
      compOffDays: 0,
    });
  });

  it('a malformed option list is refused', async () => {
    const current = await admin().get('/payroll-settings').expect(200);
    const res = await admin()
      .put('/payroll-settings')
      .send({
        ...pickSettings(current.body as Record<string, unknown>),
        workCompensation: {
          options: [{ key: 'bad key', label: 'x', compOffDays: 1, payDays: 0 }],
        },
      });
    expect(res.status).toBe(400);
  });

  it('reads the times of an ORG-basis import in the organisation timezone (09:00 IST is 03:30 UTC)', async () => {
    const result = await importRows([['2026-09-27', '09:00', '18:00']], 'ORG');
    expect(result.executionResult).toMatchObject({ imported: 1, errors: 0 });
    const row = await prisma.attendance.findFirstOrThrow({
      where: { organizationId, employeeId, date: '2026-09-27' },
    });
    expect(row.inTime?.toISOString()).toBe('2026-09-27T03:30:00.000Z');
    expect(row.outTime?.toISOString()).toBe('2026-09-27T12:30:00.000Z');
  });
});

// The settings screen sends back what it read; only the editable fields are accepted by the DTO.
function pickSettings(all: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    'processingDay',
    'paymentDay',
    'roundingRule',
    'roundingDecimals',
    'otRegularRate',
    'otHolidayRate',
    'otWeekendRate',
    'otNightRate',
  ];
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => allowed.includes(k)),
  );
}
