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
interface ComponentBody {
  id: string;
  code: string;
  displayOrder: number;
  isActive: boolean;
}

const PASSWORD = 'TestPass123!';

describe('Salary Components (e2e)', () => {
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
      organizationName: 'Salary Components E2E Org',
      name: 'Founder',
      email: 'salcomp-e2e-admin@example.test',
      password: PASSWORD,
    });
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'salcomp-e2e-admin@example.test', password: PASSWORD });
    adminToken = (adminLogin.body as AuthBody).accessToken;

    const empCreate = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Plain Employee', email: 'salcomp-e2e-emp@example.test' });
    const empLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'salcomp-e2e-emp@example.test',
        password: (empCreate.body as { generatedPassword: string })
          .generatedPassword,
      });
    employeeToken = (empLogin.body as AuthBody).accessToken;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "salary_components", "refresh_tokens", "users", "departments", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  let basicId: string;

  it('ADMIN creates a FIXED component; code is slugified from name when omitted', async () => {
    const res = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Basic Pay', type: 'EARNING' })
      .expect(201);
    const body = res.body as ComponentBody;
    expect(body.code).toBe('BASIC_PAY');
    basicId = body.id;
  });

  it('rejects a duplicate code', async () => {
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Another', code: 'BASIC_PAY', type: 'EARNING' })
      .expect(409);
  });

  it('EMPLOYEE gets 403 on every route', async () => {
    await request(app.getHttpServer())
      .get('/salary-components')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(403);
  });

  it('POST /validate-formula reports unknown references without saving anything', async () => {
    const res = await request(app.getHttpServer())
      .post('/salary-components/validate-formula')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ formula: 'BASIC_PAY + NONEXISTENT' })
      .expect(201);
    const body = res.body as { valid: boolean; unknownRefs: string[] };
    expect(body.valid).toBe(true);
    expect(body.unknownRefs).toEqual(['NONEXISTENT']);
  });

  it('POST /validate-formula reports a parse error as valid:false, still 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/salary-components/validate-formula')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ formula: 'BASIC_PAY +' })
      .expect(201);
    expect((res.body as { valid: boolean }).valid).toBe(false);
  });

  it('rejects creating a component whose formula would introduce a cycle', async () => {
    const hra = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'HRA Test',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'BASIC_PAY * 0.4',
      })
      .expect(201);
    const hraId = (hra.body as ComponentBody).id;

    await request(app.getHttpServer())
      .patch(`/salary-components/${basicId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ calcType: 'FORMULA', formula: 'HRA_TEST * 2' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/salary-components/${hraId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('code is immutable — sending a different code on update is ignored', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/salary-components/${basicId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SHOULD_NOT_APPLY', defaultValue: 30000 })
      .expect(200);
    const body = res.body as ComponentBody & { defaultValue: number };
    expect(body.code).toBe('BASIC_PAY');
    expect(body.defaultValue).toBe(30000);
  });

  it('PATCH /:id accepts displayOrder directly (not just via /reorder)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/salary-components/${basicId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayOrder: 7 })
      .expect(200);
    expect(
      (res.body as ComponentBody & { displayOrder: number }).displayOrder,
    ).toBe(7);
  });

  it('rejects an out-of-range percentageValue', async () => {
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Bad Percentage',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'BASIC_PAY',
        percentageValue: 150,
      })
      .expect(400);
  });

  it('PATCH /reorder bulk-updates displayOrder', async () => {
    const second = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Conveyance Test', type: 'EARNING' })
      .expect(201);
    const secondId = (second.body as ComponentBody).id;

    await request(app.getHttpServer())
      .patch('/salary-components/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        order: [
          { id: basicId, displayOrder: 5 },
          // 0 rather than 1 — the auto-seeded defaults (see
          // SalaryComponentsService.seedDefaults) already occupy
          // displayOrder 1, so this needs a value lower than any of them
          // to deterministically sort first.
          { id: secondId, displayOrder: 0 },
        ],
      })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = (list.body as { data: ComponentBody[] }).data;
    expect(body[0].id).toBe(secondId);
  });

  it('PATCH /:id/toggle flips isActive', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/salary-components/${basicId}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as ComponentBody).isActive).toBe(false);
  });

  // Changed with the P12a fix: this used to be accepted (201) — a disabled component is not in the payroll
  // formula context, so the saved formula then failed with 'Unknown reference "BASIC_PAY"' for every employee
  // on the next payroll run. It is now rejected at save time as an unknown reference (still not reported as a
  // cycle — disabled components stay out of the cycle graph).
  it('a formula referencing a disabled component is rejected as an unknown reference, not as a cycle', async () => {
    const res = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'DA Test',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'BASIC_PAY * 0.1',
      })
      .expect(400);
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/unknown name\(s\): BASIC_PAY/);
    expect(message).not.toMatch(/Circular/);
  });

  // P12a — unknown references used to be accepted on save.
  it('rejects saving a formula with an unknown reference; system variables and component codes are fine', async () => {
    await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Typo Allowance',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'BASICC * 0.1',
      })
      .expect(400);
    const ok = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Attendance Allowance',
        type: 'EARNING',
        calcType: 'FORMULA',
        formula: 'ROUND(BASIC * PAYABLE_DAYS / TOTAL_DAYS_IN_MONTH * 0.05, 0)',
      })
      .expect(201);
    const okId = (ok.body as ComponentBody).id;
    // Editing it to an unknown reference is rejected too.
    await request(app.getHttpServer())
      .patch(`/salary-components/${okId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ formula: 'NOT_A_THING + 1' })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/salary-components/${okId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  // P1 — these used to be reported valid and saved, then paid out as NaN/Infinity.
  it.each([
    ['MIN()', /MIN\(\) expects/],
    ['IF(1 > 2, 5)', /IF\(\) expects/],
    ['.', /Invalid number/],
    ['ROUND(BASIC, 400)', /ROUND\(\)/],
  ])(
    'validate-formula reports %s as invalid and create rejects it',
    async (formula, reason) => {
      const validated = await request(app.getHttpServer())
        .post('/salary-components/validate-formula')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ formula })
        .expect(201);
      const body = validated.body as { valid: boolean; error: string };
      expect(body.valid).toBe(false);
      expect(body.error).toMatch(reason);

      await request(app.getHttpServer())
        .post('/salary-components')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Bad Formula ${formula}`,
          code: `BAD_FORMULA_${formula.length}`,
          type: 'EARNING',
          calcType: 'FORMULA',
          formula,
        })
        .expect(400);
    },
  );

  // P12b — toggling a component back on re-adds it to the dependency graph without a cycle check.
  it('re-enabling a component via toggle is rejected when it would close a reference cycle', async () => {
    const a = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Toggle A',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'TOGGLE_B',
        percentageValue: 10,
      })
      .expect(201);
    const aId = (a.body as ComponentBody).id;
    await request(app.getHttpServer())
      .patch(`/salary-components/${aId}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // With A disabled, B -> A passes the (active-only) cycle check.
    const b = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Toggle B',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'TOGGLE_A',
        percentageValue: 10,
      })
      .expect(201);
    const bId = (b.body as ComponentBody).id;

    const res = await request(app.getHttpServer())
      .patch(`/salary-components/${aId}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect((res.body as { message: string }).message).toMatch(
      /Circular reference detected in salary formulas/,
    );
    const stillOff = await prisma.salaryComponent.findFirstOrThrow({
      where: { id: aId },
    });
    expect(stillOff.isActive).toBe(false);

    for (const id of [bId, aId]) {
      await request(app.getHttpServer())
        .delete(`/salary-components/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
  });

  it('ADMIN deletes a component', async () => {
    const created = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Deletable', type: 'DEDUCTION' })
      .expect(201);
    const id = (created.body as ComponentBody).id;

    await request(app.getHttpServer())
      .delete(`/salary-components/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('a built-in component (seeded, e.g. PF) cannot be renamed or deleted, even with zero employee overrides', async () => {
    const list = await request(app.getHttpServer())
      .get('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const pf = (
      list.body as {
        data: (ComponentBody & { name: string; isSystemDefault: boolean })[];
      }
    ).data.find((c) => c.code === 'PF');
    expect(pf).toBeDefined();
    expect(pf!.isSystemDefault).toBe(true);

    await request(app.getHttpServer())
      .patch(`/salary-components/${pf!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed PF' })
      .expect(409);
    await request(app.getHttpServer())
      .delete(`/salary-components/${pf!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    // Non-identity fields (e.g. displayOrder) stay editable on a built-in.
    await request(app.getHttpServer())
      .patch(`/salary-components/${pf!.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayOrder: 5 })
      .expect(200);

    // statutory built-ins (PF) follow Statutory Compliance, so a manual toggle is rejected.
    await request(app.getHttpServer())
      .patch(`/salary-components/${pf!.id}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('a custom (non-built-in) component can still be renamed normally', async () => {
    const created = await request(app.getHttpServer())
      .post('/salary-components')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Custom Allowance', type: 'EARNING' })
      .expect(201);
    const id = (created.body as ComponentBody).id;
    expect(
      (created.body as ComponentBody & { isSystemDefault: boolean })
        .isSystemDefault,
    ).toBe(false);

    await request(app.getHttpServer())
      .patch(`/salary-components/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Custom Allowance' })
      .expect(200);
  });
});
