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
import { getFinancialYear } from '../src/payroll-settings/financial-year';

interface AuthBody {
  accessToken: string;
}
interface EmployeeCreateBody {
  employee: { id: string };
}
interface CalcBody {
  failures: unknown[];
  payrolls: {
    deductions: { code: string; amount: number }[];
    employerContributions?: { code: string; amount: number }[];
  }[];
}

const PASSWORD = 'TestPass123!';
// December of NEXT year — comfortably after the seeded statutory versions (dated the day the org registers),
// which new versions must follow, so the spec doesn't depend on today's date.
const YEAR = new Date().getFullYear() + 1;
const MONTH = 12;

describe('State-wise LWF by work location (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let organizationId: string;
  const emp: Record<string, string> = {};
  let kaLocationId: string;

  const post = (url: string, body: object) =>
    request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  async function employeeIn(name: string, departmentId?: string) {
    const res = await post('/employees', {
      name,
      email: `${name.toLowerCase().replace(/\s/g, '.')}@lwf-e2e.example.test`,
      joiningDate: '2024-01-01',
      ...(departmentId && { departmentId }),
    }).expect(201);
    const id = (res.body as EmployeeCreateBody).employee.id;
    await post(`/employee-salary/${id}/structure`, {
      componentCode: 'BASIC',
      fixedAmount: 30000,
      effectiveFrom: '2024-01-01',
    }).expect(201);
    await prisma.attendance.createMany({
      data: Array.from({ length: 31 }, (_, i) => ({
        organizationId,
        employeeId: id,
        date: `${YEAR}-${MONTH}-${String(i + 1).padStart(2, '0')}`,
        status: AttendanceStatus.PRESENT,
        source: 'FACE_API' as const,
      })),
    });
    return id;
  }

  async function lwfDeduction(employeeId: string): Promise<number | undefined> {
    const res = await post('/payroll/calculate', {
      month: MONTH,
      year: YEAR,
      employeeId,
    }).expect(201);
    const body = res.body as CalcBody;
    expect(body.failures).toEqual([]);
    return body.payrolls[0].deductions.find((d) => d.code === 'LWF')?.amount;
  }

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
      organizationName: 'LWF State E2E Org',
      name: 'Founder',
      email: 'lwf-e2e-admin@example.test',
      password: PASSWORD,
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'lwf-e2e-admin@example.test', password: PASSWORD });
    adminToken = (login.body as AuthBody).accessToken;
    organizationId = (
      await prisma.user.findFirstOrThrow({
        where: { email: 'lwf-e2e-admin@example.test' },
      })
    ).organizationId;

    // Two work locations in different states, one department at each, plus a department with no location.
    const location = async (name: string, state: string) =>
      (
        await post('/work-locations', {
          name,
          state,
          latitude: 19.07,
          longitude: 72.87,
        }).expect(201)
      ).body as { id: string; state: string };
    const ka = await location('Bengaluru Office', 'Karnataka');
    expect(ka.state).toBe('Karnataka');
    kaLocationId = ka.id;
    const mh = await location('Mumbai Office', 'Maharashtra');
    // workLocationId isn't accepted on create — a department is linked to its location by an update.
    const dept = async (
      name: string,
      code: string,
      workLocationId?: string,
    ) => {
      const id = (
        (await post('/departments', { name, code }).expect(201)).body as {
          id: string;
        }
      ).id;
      if (workLocationId) {
        await request(app.getHttpServer())
          .patch(`/departments/${id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ workLocationId })
          .expect(200);
      }
      return id;
    };
    const kaDept = await dept('Bengaluru Eng', 'BLR', ka.id);
    const mhDept = await dept('Mumbai Eng', 'MUM', mh.id);
    const noLocDept = await dept('Remote', 'REM');

    emp.ka = await employeeIn('Ka Employee', kaDept);
    emp.mh = await employeeIn('Mh Employee', mhDept);
    emp.noLoc = await employeeIn('Remote Employee', noLocDept);
    emp.noDept = await employeeIn('Floating Employee');

    // LWF on, with a default rate plus a Karnataka-only state rate.
    await post('/statutory-config/lwf', {
      isEnabled: true,
      effectiveFrom: `${YEAR}-01-01`,
      config: {
        employeeAmount: 25,
        employerAmount: 75,
        months: [6, 12],
        stateRates: [
          {
            state: 'Karnataka',
            employeeAmount: 50,
            employerAmount: 100,
            months: [12],
          },
        ],
      },
    }).expect(201);
    // December of next year is in a financial year registration doesn't seed income-tax slabs for; with income
    // tax enabled a missing slab config now fails the employee instead of silently skipping TDS.
    await post('/tax-slabs', {
      financialYear: getFinancialYear(MONTH, YEAR, 4),
      regime: 'NEW',
    }).expect(201);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "payroll_runs", "attendances", "employee_salary_components", "salary_components", "tax_slab_configs", "employee_tax_declarations", "statutory_config_versions", "refresh_tokens", "users", "departments", "work_locations", "organizations" RESTART IDENTITY CASCADE',
    );
    await app.close();
  });

  it('an employee at a Karnataka work location pays the Karnataka rate', async () => {
    expect(await lwfDeduction(emp.ka)).toBe(50);
  });

  it('employees whose state has no rate, or who have no location/department, pay the org-wide default', async () => {
    expect(await lwfDeduction(emp.mh)).toBe(25); // Maharashtra has no entry -> default 25
    expect(await lwfDeduction(emp.noLoc)).toBe(25);
    expect(await lwfDeduction(emp.noDept)).toBe(25);
  });

  it("an employee's own work location overrides the department's state, and clearing it falls back", async () => {
    const patch = (workLocationId: string | null) =>
      request(app.getHttpServer())
        .patch(`/employees/${emp.mh}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ workLocationId })
        .expect(200);
    await patch(kaLocationId);
    expect(await lwfDeduction(emp.mh)).toBe(50); // Mumbai dept, but overridden to Karnataka
    await patch(null);
    expect(await lwfDeduction(emp.mh)).toBe(25);
  });

  it('rejects an unknown state on a work location and in stateRates', async () => {
    await post('/work-locations', {
      name: 'Bad State',
      state: 'Atlantis',
      latitude: 1,
      longitude: 1,
    }).expect(400);
    await post('/statutory-config/lwf', {
      isEnabled: true,
      effectiveFrom: `${YEAR}-02-01`,
      config: {
        employeeAmount: 25,
        employerAmount: 75,
        months: [6, 12],
        stateRates: [
          {
            state: 'Atlantis',
            employeeAmount: 1,
            employerAmount: 1,
            months: [12],
          },
        ],
      },
    }).expect(400);
  });
});
