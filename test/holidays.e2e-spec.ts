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
    // 3 auto-seeded National Holidays (see HolidaysService.seedDefaults)
    // + the 'Diwali' row created above.
    expect((res.body as { data: HolidayBody[] }).data).toHaveLength(4);
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
        date: '2026-09-01',
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

  it('bulk-import: valid rows create, invalid/duplicate rows fail without aborting the batch', async () => {
    const res = await request(app.getHttpServer())
      .post('/holidays/bulk-import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rows: [
          // 'Republic Day'/2026-01-26 would collide with the auto-seeded
          // National Holidays (see HolidaysService.seedDefaults), so this
          // uses a name/date not in that set.
          { name: 'Test Import Holiday', date: '2026-03-15', rowNum: 2 },
          { name: '', date: '2026-02-01', rowNum: 3 }, // missing name
          { name: 'Bad Date', date: 'not-a-date', rowNum: 4 }, // invalid date
          { name: 'Test Import Holiday', date: '2026-03-15', rowNum: 5 }, // duplicate within batch
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
