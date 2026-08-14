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
interface VersionBody {
  id: string;
  module: string;
  isEnabled: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const PASSWORD = 'TestPass123!';

// Server-LOCAL date, deliberately not toISOString() — must match
// StatutoryConfigService.seedDefaults()'s own localDateStr() convention
// (see salary-structure-math.ts's doc comment) or this drifts a day out of
// sync with the seeded row during the IST early-morning UTC-shift window.
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('Statutory Config (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  let adminToken: string;
  let hrToken: string;

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
      organizationName: 'Statutory Config E2E Org',
      name: 'Founder',
      email: 'statcfg-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'statcfg-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const hrCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HR Person',
        email: 'statcfg-e2e-hr@example.test',
        role: 'HR',
      });
    const hrLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'statcfg-e2e-hr@example.test',
        password: (hrCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    hrToken = (hrLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "statutory_config_versions", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('registration seeds all 9 modules with the correct default isEnabled split', async () => {
    const pf = await request(app.getHttpServer())
      .get('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const pfRows = pf.body as VersionBody[];
    expect(pfRows).toHaveLength(1);
    expect(pfRows[0].isEnabled).toBe(false);

    const calendar = await request(app.getHttpServer())
      .get('/statutory-config/payroll_calendar')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((calendar.body as VersionBody[])[0].isEnabled).toBe(true);
  });

  it('HR gets 403 — statutory config is ADMIN-only, not the usual ADMIN/HR collapse', async () => {
    await request(app.getHttpServer())
      .get('/statutory-config/pf')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(403);
  });

  it('rejects an unknown module', async () => {
    await request(app.getHttpServer())
      .get('/statutory-config/not-a-module')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('rejects an invalid config on create', async () => {
    await request(app.getHttpServer())
      .post('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        config: { employeeRate: 200, employerRate: 12, wageCeiling: 15000 },
        effectiveFrom: offsetDate(30),
      })
      .expect(400);
  });

  let futureVersionId: string;

  it('creates a future-dated version, closing out the current open one', async () => {
    const futureDate = offsetDate(30);
    const res = await request(app.getHttpServer())
      .post('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        config: { employeeRate: 12, employerRate: 12, wageCeiling: 21000 },
        isEnabled: true,
        effectiveFrom: futureDate,
      })
      .expect(201);
    futureVersionId = (res.body as VersionBody).id;

    const history = await request(app.getHttpServer())
      .get('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = history.body as VersionBody[];
    expect(rows).toHaveLength(2);
    const closed = rows.find((r) => r.id !== futureVersionId);
    expect(closed?.effectiveTo).not.toBeNull();
  });

  it('resolves the effective version correctly for today vs. the future date', async () => {
    const today = await request(app.getHttpServer())
      .get('/statutory-config/pf/effective')
      .query({ date: offsetDate(0) })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((today.body as { version: VersionBody }).version.id).not.toBe(
      futureVersionId,
    );

    const future = await request(app.getHttpServer())
      .get('/statutory-config/pf/effective')
      .query({ date: offsetDate(35) })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((future.body as { version: VersionBody }).version.id).toBe(
      futureVersionId,
    );
  });

  it('rejects deleting a past/current version', async () => {
    const history = await request(app.getHttpServer())
      .get('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const currentId = (history.body as VersionBody[]).find(
      (r) => r.id !== futureVersionId,
    )!.id;

    await request(app.getHttpServer())
      .delete(`/statutory-config/pf/${currentId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('deleting the future version reopens the predecessor', async () => {
    await request(app.getHttpServer())
      .delete(`/statutory-config/pf/${futureVersionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const history = await request(app.getHttpServer())
      .get('/statutory-config/pf')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = history.body as VersionBody[];
    expect(rows).toHaveLength(1);
    expect(rows[0].effectiveTo).toBeNull();
  });

  it('rejects deleting the sole seeded version for an untouched module', async () => {
    // The seeded row is same-day (not future-dated), so this is blocked by
    // the past/current guard — and since a normal create always leaves at
    // least 2 rows behind (close-out + insert), a lone row can never
    // legitimately be future-dated via the API, so the two guards
    // together make "delete the only version" unreachable in practice.
    const bonusHistory = await request(app.getHttpServer())
      .get('/statutory-config/bonus')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const bonusRows = bonusHistory.body as VersionBody[];
    expect(bonusRows).toHaveLength(1);

    await request(app.getHttpServer())
      .delete(`/statutory-config/bonus/${bonusRows[0].id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
