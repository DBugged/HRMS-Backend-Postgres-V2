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
interface HolidayBody {
  id: string;
  name: string;
  date: string;
  year: number;
  type: string;
}
interface BulkImportBody {
  created: number;
  failed: { row: number; name: string; error: string }[];
}

const PASSWORD = 'TestPass123!';

describe('Holidays (e2e)', () => {
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
      organizationName: 'Holidays E2E Org',
      name: 'Founder',
      email: 'holidays-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'holidays-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'holidays-e2e-emp@example.test' });
    const empPassword = (empCreate.body as { generatedPassword: string })
      .generatedPassword;
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'holidays-e2e-emp@example.test', password: empPassword });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "holidays", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let holidayId: string;

  it('ADMIN creates a holiday', async () => {
    const res = await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Diwali', date: '2026-11-08', type: 'NATIONAL' })
      .expect(201);
    const body = res.body as HolidayBody;
    expect(body.year).toBe(2026);
    holidayId = body.id;
  });

  it('rejects a duplicate holiday (same name + date)', async () => {
    await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Diwali', date: '2026-11-08' })
      .expect(409);
  });

  it('EMPLOYEE gets 403 creating a holiday', async () => {
    await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ name: 'Should Fail', date: '2026-12-25' })
      .expect(403);
  });

  it('any authenticated caller can list holidays', async () => {
    const res = await request(app.getHttpServer())
      .get('/holidays')
      .query({ year: 2026 })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    // Holiday Calendar starts empty for a new org (holidays are no longer
    // auto-seeded at registration — see AuthService.register()), so this
    // is just the 'Diwali' row created above.
    expect((res.body as { data: HolidayBody[] }).data).toHaveLength(1);
  });

  it('a department-scoped holiday comes back with the department relation joined in, not just the id', async () => {
    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Engineering', code: 'ENG' })
      .expect(201);
    const departmentId = (dept.body as { id: string }).id;

    await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Eng Offsite',
        date: '2026-12-01',
        department: departmentId,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/holidays')
      .query({ year: 2026 })
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200);
    const rows = (
      res.body as {
        data: (HolidayBody & {
          department: { id: string; name: string } | null;
        })[];
      }
    ).data;
    const scoped = rows.find((r) => r.name === 'Eng Offsite');
    expect(scoped?.department).toEqual({
      id: departmentId,
      name: 'Engineering',
    });
  });

  it('ADMIN updates a holiday, duplicate check excludes self', async () => {
    const res = await request(app.getHttpServer())
      .put(`/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Festival of lights' })
      .expect(200);
    expect(
      (res.body as HolidayBody & { description: string }).description,
    ).toBe('Festival of lights');
  });

  it('updating the date recomputes year', async () => {
    const res = await request(app.getHttpServer())
      .put(`/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: '2027-11-01' })
      .expect(200);
    expect((res.body as HolidayBody).year).toBe(2027);
  });

  it('ADMIN deactivates a holiday — flag persists and the management list still shows it', async () => {
    const res = await request(app.getHttpServer())
      .put(`/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);
    expect((res.body as HolidayBody & { isActive: boolean }).isActive).toBe(
      false,
    );

    // The management screen (Holiday Calendar) needs to see inactive
    // holidays too, to let HR/Admin toggle them back on — only the
    // calendar's *consumers* (attendance/dashboard/leave-tracker/leave
    // eligibility) filter isActive:true, not this list itself.
    const listRes = await request(app.getHttpServer())
      .get('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listed = (
      listRes.body as { data: (HolidayBody & { isActive: boolean })[] }
    ).data.find((h) => h.id === holidayId);
    expect(listed?.isActive).toBe(false);

    // Reactivate so the remaining tests below see the holiday as normal.
    await request(app.getHttpServer())
      .put(`/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: true })
      .expect(200);
  });

  it('a holiday added or deleted after the fact recalculates that day; a locked payroll month only gets a warning', async () => {
    const emp = await prisma.user.findFirstOrThrow({
      where: { email: 'holidays-e2e-emp@example.test' },
    });
    await prisma.user.update({
      where: { id: emp.id },
      data: { joiningDate: new Date('2025-01-01T00:00:00.000Z') },
    });
    // Two past weekdays (the default weekly offs are Saturday and Sunday), in one month.
    const pastWeekday = (from: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - from);
      while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    };
    const day = pastWeekday(40);
    let other = pastWeekday(41);
    for (let n = 42; other.slice(0, 7) !== day.slice(0, 7) || other === day; n += 1) other = pastWeekday(n);
    for (const date of [day, other]) {
      await prisma.attendance.create({
        data: {
          organizationId: emp.organizationId,
          employeeId: emp.id,
          date,
          status: 'ABSENT',
          source: 'SYSTEM',
        },
      });
    }
    const statusOn = async (date: string) =>
      (await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.id, date } })).status;

    // Added for a date that has passed: accepted, and the Absent day becomes Holiday.
    const created = await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Late Holiday', date: day, type: 'COMPANY' })
      .expect(201);
    const body = created.body as HolidayBody & { attendance: { updated: number; warning: string | null } };
    expect(body.attendance.updated).toBeGreaterThanOrEqual(1);
    expect(body.attendance.warning).toBeNull();
    expect(await statusOn(day)).toBe('HOLIDAY');

    // Deleted again: the day goes back to Absent.
    const removed = await request(app.getHttpServer())
      .delete(`/holidays/${body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((removed.body as { attendance: { updated: number } }).attendance.updated).toBeGreaterThanOrEqual(1);
    expect(await statusOn(day)).toBe('ABSENT');

    // Payroll for that month is locked: the holiday is saved, attendance is left as it was, and a warning names the person.
    await prisma.payrollRun.create({
      data: {
        organizationId: emp.organizationId,
        employeeId: emp.id,
        month: Number(other.slice(5, 7)),
        year: Number(other.slice(0, 4)),
        status: 'LOCKED',
      },
    });
    const lockedRes = await request(app.getHttpServer())
      .post('/holidays')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Locked Month Holiday', date: other, type: 'COMPANY' })
      .expect(201);
    const warning = (lockedRes.body as { attendance: { warning: string | null } }).attendance.warning;
    expect(warning).toMatch(/Plain Employee/);
    expect(warning).toMatch(/locked or paid/);
    expect(await statusOn(other)).toBe('ABSENT');
  });

  it('bulk-import: valid rows create, invalid/duplicate rows fail without aborting the batch', async () => {
    const res = await request(app.getHttpServer())
      .post('/holidays/bulk-import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rows: [
          // Uses a name/date distinct from the 'Diwali' row created earlier
          // in this suite to avoid a duplicate-detection collision.
          { name: 'Test Import Holiday', date: '2027-03-15', rowNum: 2 },
          { name: '', date: '2027-02-01', rowNum: 3 }, // missing name
          { name: 'Bad Date', date: 'not-a-date', rowNum: 4 }, // invalid date
          { name: 'Test Import Holiday', date: '2027-03-15', rowNum: 5 }, // duplicate within batch
        ],
      })
      .expect(201);
    const body = res.body as BulkImportBody;
    expect(body.created).toBe(1);
    expect(body.failed).toHaveLength(3);
  });

  it('ADMIN deletes a holiday', async () => {
    await request(app.getHttpServer())
      .delete(`/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/holidays')
      .query({ year: 2027 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      (res.body as { data: HolidayBody[] }).data.find(
        (h) => h.id === holidayId,
      ),
    ).toBeUndefined();
  });
});
