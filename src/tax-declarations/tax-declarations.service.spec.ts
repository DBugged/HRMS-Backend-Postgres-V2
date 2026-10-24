import { Role, TaxDeclarationStatus } from '@prisma/client';
import { TaxDeclarationsService } from './tax-declarations.service';

type Row = Record<string, any>;

function build(
  opts: {
    existing?: Row | null;
    orgPrefs?: Row;
    employeeInOrg?: boolean;
    settings?: Row;
    // Payroll runs already calculated for the employee this year (the regime has started to be used).
    payrollRuns?: number;
  } = {},
) {
  const store: Row[] = opts.existing ? [{ ...opts.existing }] : [];
  const audit: Row[] = [];
  const notes: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(
      ([k, v]) => k === 'organizationId' || v === undefined || r[k] === v,
    );
  const prisma: Row = {
    organization: {
      findFirst: async () => ({
        orgPayrollAttendancePrefs: opts.orgPrefs ?? {},
      }),
    },
    user: {
      findMany: async (a: Row) =>
        (a?.where?.id?.in ?? [])
          .filter((id: string) => id !== 'ghost')
          .map((id: string) => ({ id, name: `Emp ${id}` })),
      findFirst: async (a: Row) =>
        opts.employeeInOrg === false
          ? null
          : {
              id: a?.where?.id ?? 'x',
              name: 'Asha',
              email: 'a@x.com',
              departmentId: 'd1',
            },
    },
    payrollRun: { count: async () => opts.payrollRuns ?? 0, updateMany: async () => ({ count: 0 }) },
    employeeTaxDeclaration: {
      findFirst: async (a: Row) => {
        const r = store.find((x) => match(x, a?.where));
        return r ? { ...r } : null;
      },
      findFirstOrThrow: async (a: Row) => ({
        ...store.find((x) => match(x, a?.where))!,
      }),
      create: async (a: Row) => {
        const row = {
          id: `d${store.length + 1}`,
          status: TaxDeclarationStatus.DRAFT,
          ...a.data,
        };
        store.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = store.filter((x) => x.id === a.where.id);
        hits.forEach((x) => Object.assign(x, a.data));
        return { count: hits.length };
      },
    },
  };
  const stub = <T>(x: T) => x as never;
  const service = new TaxDeclarationsService(
    stub(prisma),
    stub({ create: async (n: Row) => notes.push(n) }),
    stub({ send: async () => undefined }),
    stub({ log: async (e: Row) => audit.push(e) }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
    stub({
      getOrCreate: async () => ({
        financialYearStartMonth: 4,
        taxRegimeEmployeeChange: true,
        taxRegimeCutoffMonth: null,
        ...opts.settings,
      }),
    }),
  );
  return { service, store, audit, notes };
}

const employee = { id: 'e1', role: Role.EMPLOYEE, departmentId: 'd1' } as never;
const hr = { id: 'hr1', role: Role.HR, departmentId: null } as never;
const manager = { id: 'm1', role: Role.MANAGER, departmentId: 'd1' } as never;
const FY = '2026-27';

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('tax declaration: an employee filing their own', () => {
  it('saves a draft and cannot set its status directly', async () => {
    const { service, store } = build();
    const d = await service.upsert(
      {
        financialYear: FY,
        regimeChosen: 'OLD',
        section80C: 100000,
        status: 'VERIFIED',
      } as never,
      employee,
      'org',
    );
    expect(d.employeeId).toBe('e1');
    expect(store[0]).toMatchObject({ regimeChosen: 'OLD', section80C: 100000 });
    expect(store[0].status).toBe(TaxDeclarationStatus.DRAFT);
  });

  it('submit moves Draft to Submitted; after that the employee can no longer change it', async () => {
    const { service, store } = build();
    await service.upsert(
      { financialYear: FY, section80C: 50000 } as never,
      employee,
      'org',
    );
    await service.upsert(
      { financialYear: FY, section80C: 60000, submit: true } as never,
      employee,
      'org',
    );
    expect(store[0].status).toBe(TaxDeclarationStatus.SUBMITTED);
    await expect(
      service.upsert(
        { financialYear: FY, section80C: 1 } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(/already been submitted and can no longer be changed/);
  });

  it('cannot file for a financial year that has not started', async () => {
    const { service } = build();
    await expect(
      service.upsert({ financialYear: '2027-28' } as never, employee, 'org'),
    ).rejects.toThrow(/hasn't started yet/);
  });

  it('an employee is forced onto their own record whatever employeeId they send', async () => {
    const { service, store } = build();
    await service.upsert(
      { financialYear: FY, employeeId: 'someone-else' } as never,
      employee,
      'org',
    );
    expect(store[0].employeeId).toBe('e1');
  });

  it('is refused when the organisation has switched Tax Declaration off', async () => {
    const { service } = build({ orgPrefs: { enableTaxDeclaration: false } });
    await expect(
      service.upsert({ financialYear: FY } as never, employee, 'org'),
    ).rejects.toThrow(/currently disabled/);
    await expect(service.get(undefined, FY, employee, 'org')).rejects.toThrow(
      /currently disabled/,
    );
  });

  it('a chosen city decides the metro flag', async () => {
    const { service, store } = build();
    await service.upsert(
      { financialYear: FY, hraCity: 'Mumbai' } as never,
      employee,
      'org',
    );
    expect(store[0]).toMatchObject({ hraCity: 'Mumbai', isMetroCity: true });
    await service.upsert(
      { financialYear: FY, hraCity: 'Nashik' } as never,
      employee,
      'org',
    );
    expect(store[0]).toMatchObject({ hraCity: 'Nashik', isMetroCity: false });
  });
});

describe('tax declaration: previous employer figures', () => {
  it('tax deducted cannot be more than the income paid', async () => {
    const { service } = build();
    await expect(
      service.upsert(
        {
          financialYear: FY,
          previousEmployerIncome: 1000,
          previousEmployerTDS: 5000,
        } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(
      /Tax deducted by the previous employer \(5000\) cannot be more than the income paid by it \(1000\)/,
    );
  });

  it('is judged against the figure already on file when only one side is sent', async () => {
    const { service } = build({
      existing: {
        id: 'd1',
        employeeId: 'e1',
        financialYear: FY,
        status: TaxDeclarationStatus.DRAFT,
        previousEmployerIncome: 100000,
        previousEmployerTDS: 0,
      },
    });
    await expect(
      service.upsert(
        { financialYear: FY, previousEmployerTDS: 120000 } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(/cannot be more than the income paid/);
    await expect(
      service.upsert(
        { financialYear: FY, previousEmployerTDS: 8000 } as never,
        employee,
        'org',
      ),
    ).resolves.toBeTruthy();
  });

  it('equal figures are allowed', async () => {
    const { service } = build();
    await expect(
      service.upsert(
        {
          financialYear: FY,
          previousEmployerIncome: 5000,
          previousEmployerTDS: 5000,
        } as never,
        employee,
        'org',
      ),
    ).resolves.toBeTruthy();
  });
});

describe('tax declaration: HR and managers', () => {
  it('HR can verify someone else, which notifies the employee', async () => {
    const { service, store, notes } = build({
      existing: {
        id: 'd1',
        employeeId: 'e9',
        financialYear: FY,
        status: TaxDeclarationStatus.SUBMITTED,
      },
    });
    await service.upsert(
      { financialYear: FY, employeeId: 'e9', status: 'VERIFIED' } as never,
      hr,
      'org',
    );
    expect(store[0].status).toBe('VERIFIED');
    expect(notes[0].title).toBe('Tax Declaration Verified');
  });

  it('HR can set Section 89 relief on someone else, but never on their own declaration', async () => {
    const other = build();
    await other.service.upsert(
      { financialYear: FY, employeeId: 'e9', section89Relief: 4000 } as never,
      hr,
      'org',
    );
    expect(other.store[0].section89Relief).toBe(4000);
    const own = build();
    await own.service.upsert(
      { financialYear: FY, section89Relief: 4000 } as never,
      hr,
      'org',
    );
    expect(own.store[0].section89Relief).toBeUndefined();
  });

  it('HR cannot verify their own declaration', async () => {
    const { service, store } = build();
    await service.upsert(
      { financialYear: FY, status: 'VERIFIED' } as never,
      hr,
      'org',
    );
    expect(store[0].status).not.toBe('VERIFIED');
  });

  it("a manager can never change someone else's declaration", async () => {
    const { service } = build();
    await expect(
      service.upsert(
        { financialYear: FY, employeeId: 'e9', section80C: 1 } as never,
        manager,
        'org',
      ),
    ).rejects.toThrow(
      /Only HR or an Admin can change another employee's tax declaration/,
    );
  });

  it('an employee outside the organisation cannot be targeted', async () => {
    const { service } = build({ employeeInOrg: false });
    await expect(
      service.upsert(
        { financialYear: FY, employeeId: 'other-org' } as never,
        hr,
        'org',
      ),
    ).rejects.toThrow(/Employee not found/);
  });

  it('every save is audited with what changed from and to', async () => {
    const { service, audit } = build({
      existing: {
        id: 'd1',
        employeeId: 'e1',
        financialYear: FY,
        status: TaxDeclarationStatus.DRAFT,
        section80C: 10000,
      },
    });
    await service.upsert(
      { financialYear: FY, section80C: 90000 } as never,
      employee,
      'org',
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'TAX_DECLARATION_UPDATED',
      details: { changes: { section80C: { from: 10000, to: 90000 } } },
    });
  });
});

describe('tax declaration: reading', () => {
  it('needs an employee and a financial year', async () => {
    const { service } = build();
    await expect(service.get(undefined, undefined, hr, 'org')).rejects.toThrow(
      /financialYear are required/,
    );
  });

  it('an employee always reads their own, even if they ask for another', async () => {
    const { service } = build({
      existing: {
        id: 'd1',
        employeeId: 'e1',
        financialYear: FY,
        status: 'DRAFT',
      },
    });
    const r = await service.get('e9', FY, employee, 'org');
    expect(r.declaration).toMatchObject({ employeeId: 'e1' });
  });
});

describe('tax regime: the employee changes it once a year', () => {
  const submitted = (over: Row = {}) => ({
    id: 'd1',
    organizationId: 'org',
    employeeId: 'e1',
    financialYear: FY,
    regimeChosen: 'NEW',
    status: TaxDeclarationStatus.SUBMITTED,
    regimeChangeCount: 0,
    ...over,
  });
  const regimeOnly = (regime: string) =>
    ({ financialYear: FY, regimeChosen: regime }) as never;

  it('choosing Old before the first payroll is free and not counted', async () => {
    const { service, store } = build({ payrollRuns: 0 });
    await service.upsert(regimeOnly('OLD'), employee, 'org');
    expect(store[0]).toMatchObject({ regimeChosen: 'OLD' });
    expect(store[0].regimeChangeCount ?? 0).toBe(0);
  });

  it('after payroll has started, the first change goes through and is counted', async () => {
    const { service, store } = build({ existing: submitted(), payrollRuns: 3 });
    await service.upsert(regimeOnly('OLD'), employee, 'org');
    expect(store[0]).toMatchObject({
      regimeChosen: 'OLD',
      regimeChangeCount: 1,
    });
    expect(store[0].regimeChangedAt).toBeInstanceOf(Date);
  });

  it('works on a submitted declaration - the regime is the one thing still editable - and the figures stay locked', async () => {
    const { service } = build({ existing: submitted(), payrollRuns: 3 });
    await expect(
      service.upsert(
        { financialYear: FY, section80C: 90000 } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(/Only your tax regime/);
    await expect(
      service.upsert(
        { financialYear: FY, regimeChosen: 'OLD', section80C: 90000 } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(/Only your tax regime/);
  });

  it('a second change is refused', async () => {
    const { service, store } = build({
      existing: submitted({ regimeChosen: 'OLD', regimeChangeCount: 1 }),
      payrollRuns: 5,
    });
    await expect(
      service.upsert(regimeOnly('NEW'), employee, 'org'),
    ).rejects.toThrow(/once a year/);
    expect(store[0].regimeChosen).toBe('OLD');
  });

  it('sending the regime already on file is not a change', async () => {
    const { service, store } = build({
      existing: submitted({ regimeChosen: 'OLD', regimeChangeCount: 1 }),
      payrollRuns: 5,
    });
    await service.upsert(regimeOnly('OLD'), employee, 'org');
    expect(store[0].regimeChangeCount).toBe(1);
  });

  it('is refused after the company cut-off month', async () => {
    // "now" is October 2026 in the fixtures; the cut-off was September.
    const { service } = build({
      existing: submitted(),
      payrollRuns: 3,
      settings: { taxRegimeCutoffMonth: 9 },
    });
    await expect(
      service.upsert(regimeOnly('OLD'), employee, 'org'),
    ).rejects.toThrow(/September/);
  });

  it('is refused when the company has switched employee changes off', async () => {
    const { service } = build({ settings: { taxRegimeEmployeeChange: false } });
    await expect(
      service.upsert(regimeOnly('OLD'), employee, 'org'),
    ).rejects.toThrow(/HR/);
  });

  it('get() tells the screen whether the regime can be changed and why not', async () => {
    const free = build({ payrollRuns: 0 });
    expect(
      (await free.service.get(undefined, FY, employee, 'org')).regimeRule,
    ).toEqual({
      canChange: true,
      reason: null,
      free: true,
    });
    const used = build({
      existing: submitted({ regimeChosen: 'OLD', regimeChangeCount: 1 }),
      payrollRuns: 5,
    });
    const rule = (await used.service.get(undefined, FY, employee, 'org'))
      .regimeRule;
    expect(rule.canChange).toBe(false);
    expect(rule.reason).toMatch(/already changed/);
  });
});

describe('tax regime: HR sets it', () => {
  it('sets it for one employee with no declaration yet, audited with the reason', async () => {
    const { service, store, audit } = build();
    const out = await service.setRegimeForEmployees(
      {
        employeeIds: ['e9'],
        financialYear: FY,
        regime: 'OLD',
        reason: 'Employee asked by email',
      } as never,
      hr,
      'org',
    );
    expect(out.changed).toEqual(['Emp e9']);
    expect(store[0]).toMatchObject({ employeeId: 'e9', regimeChosen: 'OLD' });
    expect(audit[0]).toMatchObject({ action: 'TAX_REGIME_SET_BY_HR' });
    expect(audit[0].details.reason).toBe('Employee asked by email');
  });

  it('does not use up the employee change, and ignores the company cut-off and switch', async () => {
    const { service, store } = build({
      existing: {
        id: 'd1',
        organizationId: 'org',
        employeeId: 'e1',
        financialYear: FY,
        regimeChosen: 'NEW',
        regimeChangeCount: 1,
        status: 'SUBMITTED',
      },
      payrollRuns: 9,
      settings: { taxRegimeEmployeeChange: false, taxRegimeCutoffMonth: 5 },
    });
    await service.setRegimeForEmployees(
      {
        employeeIds: ['e1'],
        financialYear: FY,
        regime: 'OLD',
        reason: 'Correction',
      } as never,
      hr,
      'org',
    );
    expect(store[0]).toMatchObject({
      regimeChosen: 'OLD',
      regimeChangeCount: 1,
    });
  });

  it('a bulk change reports who changed, who already had it, and who was not found', async () => {
    const { service } = build({
      existing: {
        id: 'd1',
        organizationId: 'org',
        employeeId: 'e1',
        financialYear: FY,
        regimeChosen: 'OLD',
        status: 'DRAFT',
      },
    });
    const out = await service.setRegimeForEmployees(
      {
        employeeIds: ['e1', 'e2', 'ghost', 'e2'],
        financialYear: FY,
        regime: 'OLD',
        reason: 'Bulk',
      } as never,
      hr,
      'org',
    );
    expect(out.unchanged).toEqual(['Emp e1']);
    expect(out.changed).toEqual(['Emp e2']);
    expect(out.notFound).toEqual(['ghost']);
  });

  it('an employee cannot call it', async () => {
    const { service } = build();
    await expect(
      service.setRegimeForEmployees(
        {
          employeeIds: ['e1'],
          financialYear: FY,
          regime: 'OLD',
          reason: 'me',
        } as never,
        employee,
        'org',
      ),
    ).rejects.toThrow(/Only HR or an Admin/);
  });
});
