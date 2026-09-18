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
import { AttendanceStatus } from '@prisma/client';

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
interface CalcBody {
  failures: unknown[];
  payrolls: { deductions: Line[]; employerContributions: Line[] }[];
}

const PASSWORD = 'TestPass123!';
// Next year, so the org's seeded statutory versions (dated the day it registers) always precede these and the
// suite doesn't depend on today's date. ESI contribution periods are Apr-Sep / Oct-Mar, so Oct + Nov share one.
const YEAR = new Date().getFullYear() + 1;

describe('Statutory rules end-to-end: PF 50% wages, ESI period, state PT, bonus accrual (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;
  let empA: string; // Karnataka department
  let empB: string; // no department

  const post = (url: string, body: object) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  async function employee(name: string, departmentId?: string) {
    const res = await post('/employees', {
      name,
      email: `${name.toLowerCase().replace(/\s/g, '.')}@statutory-e2e.example.test`,
      joiningDate: '2024-01-01',
      ...(departmentId && { departmentId }),
    }).expect(201);
    const id = (res.body as EmployeeCreateBody).employee.id;
    // Basic is only 15,000 of a 41,000 gross (36.6%) — deliberately under the 50% wages rule.
    for (const [componentCode, fixedAmount] of [
      ['BASIC', 15000],
      ['SPECIAL_ALLOWANCE', 20000],
    ] as const) {
      await post(`/employee-salary/${id}/structure`, {
        componentCode,
        fixedAmount,
        effectiveFrom: '2024-01-01',
      }).expect(201);
    }
    return id;
  }

  async function attend(employeeId: string, month: number, days: number) {
    await prisma.attendance.createMany({
      data: Array.from({ length: days }, (_, i) => ({
        organizationId,
        employeeId,
        date: `${YEAR}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
        status: AttendanceStatus.PRESENT,
        source: 'FACE_API' as const,
      })),
    });
  }

  async function run(employeeId: string, month: number) {
    const res = await post('/payroll/calculate', {
      month,
      year: YEAR,
      employeeId,
    }).expect(201);
    const body = res.body as CalcBody;
    expect(body.failures).toEqual([]);
    const r = body.payrolls[0];
    const ded = (code: string) =>
      r.deductions.find((d) => d.code === code)?.amount;
    const emp = (code: string) =>
      r.employerContributions.find((d) => d.code === code)?.amount;
    return { ded, emp };
  }

  const version = (module: string, effectiveFrom: string, config: object) =>
    post(`/statutory-config/${module}`, {
      isEnabled: true,
      effectiveFrom,
      config,
    }).expect(201);

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
      organizationName: 'Statutory Rules E2E Org',
      name: 'Founder',
      email: 'statutory-e2e-admin@example.test',
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'statutory-e2e-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'statutory-e2e-admin@example.test' },
      })
    ).organizationId;

    // A Karnataka work location + department for employee A.
    const loc = (
      await post('/work-locations', {
        name: 'Bengaluru',
        state: 'Karnataka',
        latitude: 12.9,
        longitude: 77.5,
      }).expect(201)
    ).body as { id: string };
    const dept = (
      await post('/departments', { name: 'BLR Eng', code: 'BLR' }).expect(201)
    ).body as { id: string };
    await request(app.getHttpServer())
      .patch(`/departments/${dept.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ workLocationId: loc.id })
      .expect(200);

    empA = await employee('Alpha Employee', dept.id);
    empB = await employee('Beta Employee');
    for (const m of [10, 11, 12]) {
      await attend(empA, m, m === 11 ? 30 : 31);
    }
    await attend(empB, 11, 30);
    await attend(empB, 12, 31);

    // PF: ceiling 25,000; the 50% wages rule is off in October and switched on from November.
    const pf = { employeeRate: 12, employerRate: 12, wageCeiling: 25000 };
    await version('pf', `${YEAR}-01-01`, pf);
    await version('pf', `${YEAR}-11-01`, {
      ...pf,
      applyFiftyPercentRule: true,
    });
    // ESI: ceiling above gross (41,000) in October, below it from November.
    const esi = { employeeRate: 0.75, employerRate: 3.25 };
    await version('esi', `${YEAR}-01-01`, { ...esi, wageCeiling: 45000 });
    await version('esi', `${YEAR}-11-01`, { ...esi, wageCeiling: 30000 });
    // PT: default ladder plus a Karnataka-specific one.
    await version('pt', `${YEAR}-01-01`, {
      slabs: [
        { upTo: 7500, amount: 0 },
        { upTo: 10000, amount: 175 },
        { upTo: null, amount: 200, februaryAmount: 300 },
      ],
      // An org-wide women's ladder (e.g. Maharashtra's women's exemption; widened here so it applies at 41,000).
      womenSlabs: [
        { upTo: 50000, amount: 0 },
        { upTo: null, amount: 200 },
      ],
      stateRates: [
        { state: 'Karnataka', slabs: [{ upTo: null, amount: 250 }] },
      ],
    });
    // Bonus accrual with the Act's defaults.
    await version('bonus', `${YEAR}-01-01`, {
      rate: 8.33,
      eligibilityCeiling: 21000,
      calculationCeiling: 7000,
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "attendances", "employee_salary_components", "salary_components", "tax_slab_configs", "employee_tax_declarations", "statutory_config_versions", "refresh_tokens", "users", "departments", "work_locations", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('registration seeds income-tax slabs for BOTH regimes for the current financial year', async () => {
    const res = await request(app.getHttpServer())
      .get('/tax-slabs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = (
      res.body as {
        data: {
          financialYear: string;
          regime: string;
          rebate87AAmount: number;
        }[];
      }
    ).data;
    expect(rows.map((r) => r.regime).sort()).toEqual(['NEW', 'OLD']);
    expect(new Set(rows.map((r) => r.financialYear)).size).toBe(1);
    expect(rows.find((r) => r.regime === 'NEW')?.rebate87AAmount).toBe(60000);
    expect(rows.find((r) => r.regime === 'OLD')?.rebate87AAmount).toBe(12500);
  });

  it('PF: Basic + DA is the base; the 50% wages rule lifts it to half of gross once a version opts in', async () => {
    const oct = await run(empA, 10);
    expect(oct.ded('PF')).toBe(1800); // 12% of 15,000
    const nov = await run(empA, 11);
    expect(nov.ded('PF')).toBe(2460); // 12% of max(15,000, 50% of 41,000 = 20,500)
  });

  it('PF employer-only costs: EDLI and administration charges accrue on PF wages', async () => {
    const oct = await run(empA, 10);
    expect(oct.emp('PF_EMPLOYER')).toBe(1800);
    expect(oct.emp('EDLI_EMPLOYER')).toBe(75); // 0.5% of 15,000
    expect(oct.emp('EPF_ADMIN_EMPLOYER')).toBe(75);
  });

  it('ESI: an employee covered earlier in the contribution period stays covered after wages cross the ceiling', async () => {
    const oct = await run(empA, 10);
    expect(oct.ded('ESI')).toBe(308); // 0.75% of 41,000, within the 45,000 ceiling
    const nov = await run(empA, 11);
    expect(nov.ded('ESI')).toBe(308); // gross now exceeds the 30,000 ceiling, but Oct coverage carries on
  });

  it('ESI: an employee not covered at the start of the period is not brought in when above the ceiling', async () => {
    const nov = await run(empB, 11);
    expect(nov.ded('ESI')).toBe(0);
  });

  it('Professional Tax: a Karnataka work location uses the Karnataka ladder, everyone else the default', async () => {
    expect((await run(empA, 12)).ded('PT')).toBe(250);
    expect((await run(empB, 12)).ded('PT')).toBe(200);
  });

  it("Professional Tax: a woman follows the org-wide women's ladder; a man (or no gender) the standard one", async () => {
    await request(app.getHttpServer())
      .patch(`/employees/${empB}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gender: 'FEMALE' })
      .expect(200);
    expect((await run(empB, 12)).ded('PT')).toBe(0);
    await request(app.getHttpServer())
      .patch(`/employees/${empB}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ gender: 'MALE' })
      .expect(200);
    expect((await run(empB, 12)).ded('PT')).toBe(200);
  });

  it('Statutory bonus accrues on Basic + DA capped at the calculation ceiling, at the Act rate', async () => {
    const oct = await run(empA, 10);
    expect(oct.emp('BONUS_ACCRUAL')).toBe(583); // 8.33% of min(15,000, 7,000)
  });
});
