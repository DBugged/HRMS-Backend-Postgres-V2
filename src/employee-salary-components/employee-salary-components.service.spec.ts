import { BadRequestException } from '@nestjs/common';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';

type Row = Record<string, any>;

const COMPONENTS: Row[] = [
  {
    id: 'c-BASIC',
    organizationId: 'org',
    code: 'BASIC',
    name: 'Basic Salary',
    type: 'EARNING',
    calcType: 'FIXED',
    defaultValue: 0,
    displayOrder: 1,
    isActive: true,
    payFrequency: 'MONTHLY',
    isEmployerContribution: false,
  },
  {
    id: 'c-HRA',
    organizationId: 'org',
    code: 'HRA',
    name: 'House Rent Allowance',
    type: 'EARNING',
    calcType: 'PERCENTAGE',
    percentageOf: 'BASIC',
    percentageValue: 40,
    defaultValue: 0,
    displayOrder: 2,
    isActive: true,
    payFrequency: 'MONTHLY',
    isEmployerContribution: false,
  },
];

function build(
  opts: { rows?: Row[]; finalizedRun?: Row | null; employee?: boolean } = {},
) {
  const rows: Row[] = (opts.rows ?? []).map((r) => ({
    organizationId: 'org',
    employeeId: 'e1',
    ...r,
  }));
  const audit: Row[] = [];
  const timeline: Row[] = [];
  let seq = 0;
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(
      ([k, v]) => k === 'organizationId' || v === undefined || r[k] === v,
    );
  const esc = {
    findFirst: async (a: Row) => {
      const r = rows.find((x) => match(x, a?.where));
      return r ? { ...r } : null;
    },
    findFirstOrThrow: async (a: Row) => ({
      ...rows.find((x) => match(x, a?.where))!,
    }),
    findMany: async (a: Row) =>
      rows
        .filter((x) => match(x, a?.where))
        .map((r) => ({
          ...r,
          component: COMPONENTS.find((c) => c.code === r.componentCode),
        })),
    create: async (a: Row) => {
      const row = { id: `row${++seq}`, ...a.data };
      rows.push(row);
      return { ...row };
    },
    updateMany: async (a: Row) => {
      const hits = rows.filter((x) => match(x, a.where));
      hits.forEach((x) => Object.assign(x, a.data));
      return { count: hits.length };
    },
  };
  const prisma: Row = {
    user: {
      findFirst: async () => (opts.employee === false ? null : { id: 'e1' }),
    },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    salaryComponent: {
      findFirst: async (a: Row) =>
        COMPONENTS.find((c) =>
          a.where.id ? c.id === a.where.id : c.code === a.where.code,
        ) ?? null,
      findMany: async () => COMPONENTS,
    },
    employeeSalaryComponent: esc,
    payrollRun: { findFirst: async () => opts.finalizedRun ?? null },
    $transaction: async (cb: (tx: Row) => unknown) =>
      cb({ employeeSalaryComponent: esc }),
  };
  const service = new EmployeeSalaryComponentsService(
    prisma as never,
    { log: async (e: Row) => audit.push(e) } as never,
    { logEvent: async (e: Row) => timeline.push(e) } as never,
  );
  return { service, rows, audit, timeline };
}

const open = (code: string, amount: number, from: string, over: Row = {}) => ({
  id: `old-${code}-${from}`,
  componentId: `c-${code}`,
  componentCode: code,
  valueType: 'FIXED',
  fixedAmount: amount,
  amountBasis: 'MONTHLY',
  isEnabled: true,
  effectiveFrom: from,
  effectiveTo: null,
  ...over,
});

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('salary structure: setting a value', () => {
  it('the first value creates an open row effective from the given date', async () => {
    const { service, rows } = build();
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-10-01',
      } as never,
      'admin',
      'org',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      componentCode: 'BASIC',
      fixedAmount: 30000,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      createdById: 'admin',
    });
  });

  it('with no date it takes effect today in the organisation timezone', async () => {
    const { service, rows } = build();
    await service.setComponentValue(
      'e1',
      { componentCode: 'BASIC', fixedAmount: 30000 } as never,
      'admin',
      'org',
    );
    expect(rows[0].effectiveFrom).toBe('2026-10-10');
  });

  it('a later revision closes the old row the day before and opens a new one; history is kept', async () => {
    const { service, rows } = build({
      rows: [open('BASIC', 30000, '2026-04-01')],
    });
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 36000,
        effectiveFrom: '2026-10-01',
      } as never,
      'admin',
      'org',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      fixedAmount: 30000,
      effectiveTo: '2026-09-30',
    });
    expect(rows[1]).toMatchObject({
      fixedAmount: 36000,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
    });
  });

  it('a revision on the same day corrects the open row in place instead of adding one', async () => {
    const { service, rows } = build({
      rows: [open('BASIC', 30000, '2026-10-01')],
    });
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 33000,
        effectiveFrom: '2026-10-01',
      } as never,
      'admin',
      'org',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fixedAmount: 33000,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
    });
  });

  it('a date before the current row starts is refused, saying which date to use', async () => {
    const { service, rows } = build({
      rows: [open('BASIC', 30000, '2026-10-01')],
    });
    await expect(
      service.setComponentValue(
        'e1',
        {
          componentCode: 'BASIC',
          fixedAmount: 1,
          effectiveFrom: '2026-07-01',
        } as never,
        'admin',
        'org',
      ),
    ).rejects.toThrow(
      /cannot start before the current one \(2026-10-01\) for BASIC/,
    );
    expect(rows).toHaveLength(1);
  });

  it('a revision effective in a month already locked or paid is refused', async () => {
    const { service } = build({
      finalizedRun: { month: 9, year: 2026, status: 'PAID' },
    });
    await expect(
      service.setComponentValue(
        'e1',
        {
          componentCode: 'BASIC',
          fixedAmount: 1,
          effectiveFrom: '2026-09-01',
        } as never,
        'admin',
        'org',
      ),
    ).rejects.toThrow(/9\/2026 payroll is already paid/);
  });

  it('can switch a component off for one employee', async () => {
    const { service, rows } = build({
      rows: [open('HRA', 0, '2026-04-01', { valueType: 'PERCENTAGE' })],
    });
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'HRA',
        isEnabled: false,
        effectiveFrom: '2026-10-01',
      } as never,
      'admin',
      'org',
    );
    expect(rows.at(-1)).toMatchObject({ isEnabled: false });
  });

  it('every revision is audited with before and after, and put on the employee timeline without amounts', async () => {
    const { service, audit, timeline } = build({
      rows: [open('BASIC', 30000, '2026-04-01')],
    });
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 36000,
        effectiveFrom: '2026-10-01',
        revisionNote: 'Annual raise',
      } as never,
      'admin',
      'org',
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'EMPLOYEE_SALARY_COMPONENT_SET',
      details: {
        componentCode: 'BASIC',
        before: { fixedAmount: 30000 },
        after: { fixedAmount: 36000 },
      },
    });
    expect(timeline.at(-1)).toMatchObject({
      eventKey: 'SALARY_REVISION',
      remarks: 'Annual raise',
    });
    expect(JSON.stringify(timeline.at(-1))).not.toContain('36000');
  });

  it('an unknown component or employee is not found', async () => {
    const a = build();
    await expect(
      a.service.setComponentValue(
        'e1',
        { componentCode: 'NOPE', fixedAmount: 1 } as never,
        'admin',
        'org',
      ),
    ).rejects.toThrow(/Salary component not found/);
    const b = build({ employee: false });
    await expect(
      b.service.setComponentValue(
        'e1',
        { componentCode: 'BASIC', fixedAmount: 1 } as never,
        'admin',
        'org',
      ),
    ).rejects.toThrow(/Employee not found/);
  });
});

describe('salary structure: setting many at once', () => {
  it('applies every line with the same effective date', async () => {
    const { service, rows } = build();
    const r = await service.bulkSetStructure(
      'e1',
      {
        effectiveFrom: '2026-10-01',
        lines: [
          { componentCode: 'BASIC', fixedAmount: 30000 },
          {
            componentCode: 'HRA',
            valueType: 'PERCENTAGE',
            percentageValue: 40,
            percentageOf: 'BASIC',
          },
        ],
      } as never,
      'admin',
      'org',
    );
    expect(r.count).toBe(2);
    expect(r.failed).toEqual([]);
    expect(rows.map((x) => x.effectiveFrom)).toEqual([
      '2026-10-01',
      '2026-10-01',
    ]);
  });

  it('a line that cannot be resolved is reported by row and the rest still apply', async () => {
    const { service } = build();
    const r = await service.bulkSetStructure(
      'e1',
      {
        effectiveFrom: '2026-10-01',
        lines: [
          { componentCode: 'BASIC', fixedAmount: 30000 },
          { componentCode: 'GHOST', fixedAmount: 1 },
          {},
        ],
      } as never,
      'admin',
      'org',
    );
    expect(r.count).toBe(1);
    expect(r.failed).toEqual([
      expect.objectContaining({
        row: 2,
        error: 'Salary component not found: GHOST',
      }),
      expect.objectContaining({
        row: 3,
        error: 'Either componentId or componentCode is required',
      }),
    ]);
  });

  it('when every line is refused it is an error, not a silent "saved"', async () => {
    const { service } = build({ rows: [open('BASIC', 30000, '2026-10-01')] });
    await expect(
      service.bulkSetStructure(
        'e1',
        {
          effectiveFrom: '2026-07-01',
          lines: [{ componentCode: 'BASIC', fixedAmount: 1 }],
        } as never,
        'admin',
        'org',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('salary structure: reading', () => {
  it('shows the row in force on the date asked, not a later revision', async () => {
    const { service } = build({
      rows: [
        open('BASIC', 30000, '2026-04-01', { effectiveTo: '2026-09-30' }),
        open('BASIC', 36000, '2026-10-01'),
      ],
    });
    const before = await service.getStructure('e1', '2026-08-15', 'org');
    const after = await service.getStructure('e1', '2026-10-15', 'org');
    expect(
      before.structure.find((s: Row) => s.componentCode === 'BASIC')
        ?.fixedAmount,
    ).toBe(30000);
    expect(
      after.structure.find((s: Row) => s.componentCode === 'BASIC')
        ?.fixedAmount,
    ).toBe(36000);
  });

  it('current monthly value follows a percentage of another component', async () => {
    const { service } = build({ rows: [open('BASIC', 30000, '2026-04-01')] });
    expect(
      await service.getCurrentMonthlyValue('e1', 'BASIC', '2026-10-10', 'org'),
    ).toBe(30000);
    expect(
      await service.getCurrentMonthlyValue('e1', 'HRA', '2026-10-10', 'org'),
    ).toBe(12000);
  });

  it('a component switched off for the employee is worth nothing; an unknown code is zero', async () => {
    const { service } = build({
      rows: [open('BASIC', 30000, '2026-04-01', { isEnabled: false })],
    });
    expect(
      await service.getCurrentMonthlyValue('e1', 'BASIC', '2026-10-10', 'org'),
    ).toBe(0);
    expect(
      await service.getCurrentMonthlyValue('e1', 'NOPE', '2026-10-10', 'org'),
    ).toBe(0);
  });
});
