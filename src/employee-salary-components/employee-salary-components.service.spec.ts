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
  {
    id: 'c-VARIABLE_PAY',
    organizationId: 'org',
    code: 'VARIABLE_PAY',
    name: 'Variable Pay',
    type: 'EARNING',
    calcType: 'MANUAL',
    defaultValue: 0,
    displayOrder: 20,
    isActive: true,
    payFrequency: 'YEARLY',
    isEmployerContribution: false,
  },
];

function build(
  opts: {
    rows?: Row[];
    finalizedRun?: Row | null;
    employee?: boolean;
    prefs?: Row;
    users?: Row[];
  } = {},
) {
  const rows: Row[] = (opts.rows ?? []).map((r) => ({
    organizationId: 'org',
    employeeId: 'e1',
    ...r,
  }));
  const audit: Row[] = [];
  const timeline: Row[] = [];
  const notifications: Row[] = [];
  const emails: Row[] = [];
  const built: unknown[][] = [];
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
    count: async (a: Row) => {
      const { effectiveFrom, ...rest } = (a?.where ?? {}) as Row;
      return rows.filter(
        (x) =>
          match(x, rest) &&
          (effectiveFrom === undefined ||
            (typeof effectiveFrom === 'object' && effectiveFrom !== null
              ? x.effectiveFrom < (effectiveFrom as { lt: string }).lt
              : x.effectiveFrom === effectiveFrom)),
      ).length;
    },
  };
  const prisma: Row = {
    user: {
      findMany: async () => opts.users ?? [],
      findFirst: async () =>
        opts.employee === false
          ? null
          : {
              id: 'e1',
              name: 'Emp One',
              email: 'e1@x.test',
              isActive: true,
              joiningDate: new Date('2026-01-12T00:00:00.000Z'),
            },
    },
    organization: {
      findFirst: async () => ({
        timezone: 'Asia/Kolkata',
        orgPayrollAttendancePrefs: opts.prefs ?? {},
      }),
    },
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
    { create: async (n: Row) => notifications.push(n) } as never,
    { send: async (m: Row) => emails.push(m) } as never,
    {
      renderOccasion: async (_org: string, key: string, vars: Row) => ({
        subject: key,
        html: JSON.stringify(vars),
      }),
      defaultFor: () => ({ subject: 's', html: 'h' }),
    } as never,
    {
      build: async (...a: unknown[]) => {
        built.push(a);
        return {
          buffer: Buffer.from('pdf'),
          filename: 'E1-Salary Structure.pdf',
        };
      },
    } as never,
  );
  return { service, rows, audit, timeline, notifications, emails, built };
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
    // Not the first salary (an earlier revision exists), so its start cannot be moved earlier.
    const { service, rows } = build({
      rows: [
        { ...open('BASIC', 20000, '2026-04-01'), effectiveTo: '2026-09-30' },
        open('BASIC', 30000, '2026-10-01'),
      ],
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
      /cannot start before the current one \(01-10-2026\) for BASIC/,
    );
    expect(rows).toHaveLength(2);
  });

  it('the first salary can be moved earlier, down to the joining date, without adding a row', async () => {
    const { service, rows } = build({
      rows: [open('BASIC', 30000, '2026-04-01')],
    });
    await service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-01-12',
      } as never,
      'admin',
      'org',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].effectiveFrom).toBe('2026-01-12');
    await expect(
      service.setComponentValue(
        'e1',
        {
          componentCode: 'BASIC',
          fixedAmount: 30000,
          effectiveFrom: '2026-01-01',
        } as never,
        'admin',
        'org',
      ),
    ).rejects.toThrow(/only down to the joining date \(12-01-2026\)/);
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
    // An earlier revision exists, so a date before the current one is refused (the first salary could be moved).
    const { service } = build({
      rows: [
        { ...open('BASIC', 20000, '2026-04-01'), effectiveTo: '2026-09-30' },
        open('BASIC', 30000, '2026-10-01'),
      ],
    });
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

describe('salary structure: telling the employee', () => {
  // The notice is fire-and-forget; let its awaited steps settle (microtasks only - timers may be faked).
  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  const revise = (service: EmployeeSalaryComponentsService, actor = 'admin') =>
    service.setComponentValue(
      'e1',
      {
        componentCode: 'BASIC',
        fixedAmount: 30000,
        effectiveFrom: '2026-10-01',
        revisionNote: 'Annual review',
      } as never,
      actor,
      'org',
    );

  it('sends an in-app notification and emails the Salary Structure PDF, with no amount in the notice', async () => {
    const { service, notifications, emails, built } = build();
    await revise(service);
    await flush();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      userId: 'e1',
      category: 'PAYROLL',
    });
    expect(notifications[0].message).toContain('01-10-2026');
    expect(JSON.stringify(notifications)).not.toContain('30000');
    // the document is built for the revision's effective date and attached
    expect(built).toEqual([['e1', 'org', '2026-10-01']]);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: 'e1@x.test' });
    expect(emails[0].attachments).toEqual([
      { filename: 'E1-Salary Structure.pdf', content: Buffer.from('pdf') },
    ]);
    // the email body states the effective date but no pay figure
    expect(String(emails[0].html)).toContain('01-10-2026');
    expect(String(emails[0].html)).not.toContain('30000');
  });

  it('a bulk revision sends one notice and one email, not one per line', async () => {
    const { service, notifications, emails } = build();
    await service.bulkSetStructure(
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
    await flush();
    expect(notifications).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it('says nothing when a person revises their own salary', async () => {
    const { service, notifications, emails } = build();
    await revise(service, 'e1');
    await flush();
    expect(notifications).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it('says nothing when the organisation turned the notice off', async () => {
    const { service, notifications, emails } = build({
      prefs: { notifySalaryRevision: false },
    });
    await revise(service);
    await flush();
    expect(notifications).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});

describe('salary summaries for the directory', () => {
  const at = (cityClass: string | null) => ({
    id: 'e1',
    workLocation: cityClass ? { cityClass } : null,
    department: null,
  });

  it('an employee with no structure is "not set up", with no CTC', async () => {
    const { service } = build({ users: [at('METRO')] });
    expect(await service.listSalarySummaries('org')).toEqual([
      {
        employeeId: 'e1',
        hasStructure: false,
        annualCtc: 0,
        fixedMonthly: 0,
        variableAnnual: 0,
      },
    ]);
  });

  it.each([
    ['METRO', 75000],
    ['NON_METRO', 70000],
    ['RURAL', 50000],
  ])(
    '%s: Basic 50,000 with no HRA line of its own gives %s a month',
    async (cityClass, monthly) => {
      const { service } = build({
        rows: [open('BASIC', 50000, '2026-04-01')],
        users: [at(cityClass)],
      });
      const [s] = await service.listSalarySummaries('org');
      expect(s).toMatchObject({ hasStructure: true, fixedMonthly: monthly });
      expect(s.annualCtc).toBe(monthly * 12);
    },
  );

  it('a saved HRA line wins over the city class', async () => {
    const { service } = build({
      rows: [
        open('BASIC', 50000, '2026-04-01'),
        open('HRA', 0, '2026-04-01', {
          valueType: 'PERCENTAGE',
          fixedAmount: null,
          percentageValue: 30,
          percentageOf: 'BASIC',
        }),
      ],
      users: [at('METRO')],
    });
    const [s] = await service.listSalarySummaries('org');
    expect(s.fixedMonthly).toBe(65000);
  });

  it('yearly variable pay is reported separately and added to the CTC', async () => {
    const { service } = build({
      rows: [
        open('BASIC', 50000, '2026-04-01'),
        open('VARIABLE_PAY', 120000, '2026-04-01', {
          valueType: 'MANUAL',
          amountBasis: 'ANNUAL',
        }),
      ],
      users: [at('NON_METRO')],
    });
    const [s] = await service.listSalarySummaries('org');
    expect(s.variableAnnual).toBe(120000);
    expect(s.annualCtc).toBe(70000 * 12 + 120000);
  });

  it('a structure that starts in the future does not count yet', async () => {
    const { service } = build({
      rows: [open('BASIC', 50000, '2027-01-01')],
      users: [at('METRO')],
    });
    const [s] = await service.listSalarySummaries('org');
    expect(s.hasStructure).toBe(false);
  });

  it('a structure with everything switched off is not set up', async () => {
    const { service } = build({
      rows: [open('BASIC', 50000, '2026-04-01', { isEnabled: false })],
      users: [at('METRO')],
    });
    const [s] = await service.listSalarySummaries('org');
    expect(s.hasStructure).toBe(false);
  });
});
