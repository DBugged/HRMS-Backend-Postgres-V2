// Test-only: runs the real PayrollService.calculatePayroll against an in-memory "database", so payroll can be tested
// end to end (attendance -> proration -> statutory -> tax -> net pay) without Postgres. Never imported by app code.
import {
  AttendanceStatus,
  LeaveStatus,
  PayFrequency,
  SalaryComponentType,
  TaxRegime,
} from '@prisma/client';
import { PayrollService } from '../payroll.service';
import { SALARY_COMPONENT_DEFAULTS } from '../../salary-components/salary-component-defaults';
import { getDefaultTaxSlabConfig } from '../../tax-slabs/default-tax-slabs';

type Row = Record<string, any>;

export interface World {
  employee: Row;
  department: Row | null;
  org: Row;
  settings: Row;
  components: Row[];
  overrides: Row[]; // EmployeeSalaryComponent rows
  attendance: Row[];
  leaves: Row[];
  overtime: Row[];
  holidays: Row[];
  runs: Row[]; // earlier PayrollRun rows (year-to-date / ESI history)
  loans: Row[];
  encashments: Row[];
  declaration: Row | null;
  slabs: Row[];
  ratings?: Row[]; // approved performance ratings (payout %)
  companyPerf?: Row[]; // company / department achievement %
}

export const ORG = 'org-1';
export const EMP = 'emp-1';

export function defaultSettings(over: Row = {}): Row {
  return {
    id: 's1',
    organizationId: ORG,
    financialYearStartMonth: 4,
    processingDay: 0,
    paymentDay: 0,
    currency: 'INR',
    currencySymbol: '₹',
    roundingRule: 'nearest',
    roundingDecimals: 0,
    pfEnabled: false,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    npsEnabled: false,
    gratuityEnabled: false,
    bonusEnabled: false,
    incomeTaxEnabled: true,
    employerInsuranceEnabled: false,
    pfEmployeeRate: 12,
    pfEmployerRate: 12,
    pfWageCeiling: 15000,
    esiEmployeeRate: 0.75,
    esiEmployerRate: 3.25,
    esiWageCeiling: 21000,
    ptSlabs: [
      { upTo: 7500, amount: 0 },
      { upTo: 10000, amount: 175 },
      { upTo: null, amount: 200 },
    ],
    lwfEmployeeAmount: 25,
    lwfEmployerAmount: 75,
    npsEmployerRate: 10,
    gratuityRate: 4.81,
    compOffExpiryDays: 90,
    otRegularRate: 1.5,
    otHolidayRate: 2,
    otWeekendRate: 2,
    otNightRate: 1.75,
    companyPerformanceEnabled: false,
    taxDeclarationRequiresVerification: false,
    higherTdsWithoutPan: false,
    refundExcessTdsOnExit: true,
    perquisiteLoanBenchmarkRate: 0,
    ...over,
  };
}

export function defaultComponents(): Row[] {
  return SALARY_COMPONENT_DEFAULTS.map((d, i) => ({
    id: `c-${d.code}`,
    organizationId: ORG,
    name: d.name,
    code: d.code,
    type: d.type,
    calcType: d.calcType,
    percentageOf: d.percentageOf ?? null,
    percentageValue: d.percentageValue ?? null,
    formula: d.formula ?? null,
    defaultValue: 0,
    isTaxable: true,
    includeInGross: d.includeInGross ?? true,
    includeInNet: d.includeInNet ?? true,
    includeInCTC: true,
    isEmployerContribution: d.isEmployerContribution ?? false,
    showOnPayslip: d.showOnPayslip ?? true,
    isStatutory: d.isStatutory ?? false,
    statutoryKey: d.statutoryKey ?? null,
    payFrequency: d.payFrequency ?? PayFrequency.MONTHLY,
    displayOrder: d.displayOrder ?? i,
    isActive: d.isActive ?? true,
    isSystemDefault: true,
  }));
}

/** A fixed amount on one component for the employee, in force since `from`. */
export function fixed(code: string, amount: number, from = '2020-01-01'): Row {
  return {
    id: `o-${code}-${from}`,
    organizationId: ORG,
    employeeId: EMP,
    componentId: `c-${code}`,
    componentCode: code,
    valueType: 'FIXED',
    fixedAmount: amount,
    percentageValue: null,
    percentageOf: null,
    formula: null,
    amountBasis: 'MONTHLY',
    isEnabled: true,
    effectiveFrom: from,
    effectiveTo: null,
    revisionNote: '',
  };
}

export function percent(code: string, value: number, of: string): Row {
  return {
    ...fixed(code, 0),
    valueType: 'PERCENTAGE',
    fixedAmount: null,
    percentageValue: value,
    percentageOf: of,
  };
}

export function att(
  date: string,
  status: AttendanceStatus,
  extra: Row = {},
): Row {
  return {
    id: `a-${date}`,
    organizationId: ORG,
    employeeId: EMP,
    date,
    status,
    workDurationMinutes: status === AttendanceStatus.PRESENT ? 540 : 0,
    isLate: false,
    isEarlyOut: false,
    ...extra,
  };
}

export function leave(
  startDate: string,
  endDate: string,
  totalDays: number,
  over: Row = {},
): Row {
  return {
    id: `l-${startDate}`,
    organizationId: ORG,
    employeeId: EMP,
    startDate,
    endDate,
    totalDays,
    isHalfDay: false,
    status: LeaveStatus.APPROVED,
    leaveType: { isPaid: true, salaryImpactPercent: 100, rules: {} },
    ...over,
  };
}

export function slabRow(
  financialYear: string,
  regime: TaxRegime = TaxRegime.NEW,
): Row {
  const d = getDefaultTaxSlabConfig(regime);
  return {
    id: `slab-${financialYear}-${regime}`,
    organizationId: ORG,
    financialYear,
    regime,
    isActive: true,
    ...d,
  };
}

export function makeWorld(over: Partial<World> = {}): World {
  return {
    employee: {
      id: EMP,
      organizationId: ORG,
      name: 'Test Employee',
      employeeId: 'DP-1',
      joiningDate: new Date('2024-01-01T00:00:00.000Z'),
      departmentId: null,
      workLocationId: null,
      gender: null,
      lwfExempt: false,
      personalData: {},
      isActive: true,
    },
    department: null,
    org: {
      attendancePayrollPrefs: null,
      timezone: 'Asia/Kolkata',
    },
    settings: defaultSettings(),
    components: defaultComponents(),
    overrides: [],
    attendance: [],
    leaves: [],
    overtime: [],
    holidays: [],
    runs: [],
    loans: [],
    encashments: [],
    declaration: null,
    slabs: [slabRow('2026-27')],
    ...over,
  };
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'organizationId' || k === 'OR' || k === 'AND') continue;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('lt' in v && !(row[k] < (v as Row).lt)) return false;
      continue;
    }
    if (v !== undefined && row[k] !== v) return false;
  }
  return true;
}

export function makeEngine(world: World, today: string) {
  const model = (rows: () => Row[]) => ({
    findMany: async (a?: { where?: Row }) =>
      rows().filter((r) => matches(r, a?.where)),
    findFirst: async (a?: { where?: Row }) =>
      rows().find((r) => matches(r, a?.where)) ?? null,
    create: async (a: { data: Row }) => a.data,
    count: async () => rows().length,
  });
  const prisma: Record<string, unknown> = {
    user: {
      findFirst: async () => world.employee,
    },
    organization: { findFirst: async () => world.org },
    department: { findFirst: async () => world.department },
    attendance: model(() => world.attendance),
    leave: model(() => world.leaves),
    overtimeRecord: model(() => world.overtime),
    holiday: model(() =>
      world.holidays.map((h) => ({
        isActive: true,
        isOptional: false,
        departmentId: null,
        ...h,
      })),
    ),
    payrollRun: model(() => world.runs),
    loan: model(() => world.loans),
    leaveEncashment: model(() => world.encashments),
    salaryComponent: model(() => world.components),
    employeeSalaryComponent: model(() => world.overrides),
    employeeTaxDeclaration: {
      findFirst: async () => world.declaration,
    },
    taxSlabConfig: {
      findFirst: async (a?: { where?: Row; orderBy?: Row }) => {
        const w = a?.where ?? {};
        const hit = world.slabs
          .filter(
            (s) =>
              s.isActive &&
              (w.regime === undefined || s.regime === w.regime) &&
              (w.financialYear === undefined ||
                (typeof w.financialYear === 'string'
                  ? s.financialYear === w.financialYear
                  : s.financialYear < w.financialYear.lt)),
          )
          .sort((x, y) => (x.financialYear < y.financialYear ? 1 : -1));
        return hit[0] ?? null;
      },
      create: async (a: { data: Row }) => {
        const row = { id: 'new', isActive: true, ...a.data };
        world.slabs.push(row);
        return row;
      },
    },
    performanceRating: {
      findFirst: async (a?: { where?: Row }) =>
        (world.ratings ?? []).find(
          (r) =>
            r.financialYear === a?.where?.financialYear &&
            r.status === a?.where?.status,
        ) ?? null,
      findMany: async () => world.ratings ?? [],
    },
    companyPerformance: {
      findFirst: async () => null,
      findMany: async (a?: { where?: Row }) =>
        (world.companyPerf ?? []).filter(
          (r) => r.financialYear === a?.where?.financialYear,
        ),
    },
  };
  const stub = <T>(x: T) => x as never;
  const service = new PayrollService(
    stub(prisma),
    stub({ getOrCreate: async () => world.settings }),
    stub({ getEffective: async () => ({ version: null }) }),
    stub({ log: async () => undefined }),
    stub({ logEvent: async () => undefined }),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
    stub({}),
  );
  // Pin "today" for the month-to-date rules without touching the real clock elsewhere.
  jest.useFakeTimers().setSystemTime(new Date(`${today}T08:00:00.000Z`));
  return {
    service,
    calc: (month: number, year: number, options?: Row) =>
      service.calculatePayroll(EMP, month, year, ORG, options as never),
    done: () => jest.useRealTimers(),
  };
}

export const line = (rows: { code: string; amount: number }[], code: string) =>
  rows.find((r) => r.code === code)?.amount;

export { SalaryComponentType };
