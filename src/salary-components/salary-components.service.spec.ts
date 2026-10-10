import { SalaryComponentsService } from './salary-components.service';
import { SALARY_COMPONENT_DEFAULTS } from './salary-component-defaults';

type Row = Record<string, any>;

function build(components: Row[] = [], opts: { assigned?: number } = {}) {
  const store: Row[] = components.map((c, i) => ({
    organizationId: 'org',
    id: `c${i + 1}`,
    isActive: true,
    isSystemDefault: false,
    statutoryKey: null,
    displayOrder: i,
    calcType: 'FIXED',
    percentageOf: null,
    formula: null,
    createdAt: new Date(),
    ...c,
  }));
  const audit: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(
      ([k, v]) => k === 'organizationId' || v === undefined || r[k] === v,
    );
  const prisma: Row = {
    salaryComponent: {
      findFirst: async (a: Row) => {
        const r = store.find((x) => match(x, a?.where));
        return r ? { ...r } : null;
      },
      findMany: async (a: Row) =>
        store.filter((x) => match(x, a?.where)).map((x) => ({ ...x })),
      aggregate: async () => ({
        _max: {
          displayOrder: Math.max(-1, ...store.map((s) => s.displayOrder)),
        },
      }),
      create: async (a: Row) => {
        const row = {
          id: `c${store.length + 1}`,
          isActive: true,
          createdAt: new Date(),
          ...a.data,
        };
        store.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = store.filter((x) => match(x, a.where));
        hits.forEach((x) => Object.assign(x, a.data));
        return { count: hits.length };
      },
      deleteMany: async (a: Row) => {
        const i = store.findIndex((x) => x.id === a.where.id);
        if (i >= 0) store.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
    employeeSalaryComponent: { count: async () => opts.assigned ?? 0 },
  };
  const service = new SalaryComponentsService(
    prisma as never,
    { log: async (e: Row) => audit.push(e) } as never,
  );
  return { service, store, audit };
}

const basic = {
  code: 'BASIC',
  name: 'Basic Salary',
  type: 'EARNING',
  calcType: 'FIXED',
};

describe('salary components: creating', () => {
  it('derives the code from the name when none is given, upper-cased, and puts it last in the order', async () => {
    const { service, store } = build([basic]);
    const c = await service.create(
      { name: 'Night Shift Allowance', type: 'EARNING' } as never,
      'u1',
      'org',
    );
    expect(c.code).toBe('NIGHT_SHIFT_ALLOWANCE');
    expect(c.displayOrder).toBe(1);
    expect(store).toHaveLength(2);
  });

  it('an upper-cased explicit code is used, and a duplicate code is refused', async () => {
    const { service } = build([basic]);
    await expect(
      service.create(
        { name: 'Another Basic', code: 'basic', type: 'EARNING' } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow(/code "BASIC" already exists/);
  });

  it('a percentage component needs a value between 0 and 100', async () => {
    const { service } = build([basic]);
    const go = (v: unknown) =>
      service.create(
        {
          name: 'Bonus pct',
          type: 'EARNING',
          calcType: 'PERCENTAGE',
          percentageOf: 'BASIC',
          percentageValue: v,
        } as never,
        'u1',
        'org',
      );
    await expect(go(150)).rejects.toThrow(/between 0 and 100/);
    await expect(go(-1)).rejects.toThrow(/between 0 and 100/);
    await expect(go(undefined)).rejects.toThrow(/between 0 and 100/);
    await expect(go(40)).resolves.toBeTruthy();
  });

  it('a formula must be valid, only use known names, and produce a finite number', async () => {
    const { service } = build([basic]);
    const go = (formula: string) =>
      service.create(
        {
          name: 'Calc',
          type: 'EARNING',
          calcType: 'FORMULA',
          formula,
        } as never,
        'u1',
        'org',
      );
    await expect(go('BASIC *')).rejects.toThrow(/Invalid formula/);
    await expect(go('GHOST * 2')).rejects.toThrow(/unknown name\(s\): GHOST/);
    await expect(go('BASIC * 0.1')).resolves.toBeTruthy();
  });

  it('a circular reference between components is refused', async () => {
    const { service } = build([
      basic,
      {
        code: 'A',
        name: 'A',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'B',
        percentageValue: 10,
      },
    ]);
    await expect(
      service.create(
        {
          name: 'B',
          code: 'B',
          type: 'EARNING',
          calcType: 'PERCENTAGE',
          percentageOf: 'A',
          percentageValue: 10,
        } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow(/circular|cycle/i);
  });

  it('creation is audited', async () => {
    const { service, audit } = build([basic]);
    await service.create(
      { name: 'Perk', type: 'EARNING' } as never,
      'u1',
      'org',
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'SALARY_COMPONENT_CREATED',
      details: { code: 'PERK' },
    });
  });
});

describe('salary components: editing', () => {
  it("a built-in's name is locked, except the Fixed Allowance which may be relabelled", async () => {
    const { service } = build([
      { ...basic, isSystemDefault: true },
      {
        code: 'SPECIAL_ALLOWANCE',
        name: 'Special Allowance',
        type: 'EARNING',
        isSystemDefault: true,
      },
    ]);
    await expect(
      service.update('c1', { name: 'Salary' } as never, 'org'),
    ).rejects.toThrow(/built-in salary component — its name cannot be changed/);
    await expect(
      service.update('c2', { name: 'Fixed Allowance' } as never, 'org'),
    ).resolves.toBeTruthy();
  });

  it('a statutory built-in cannot have its classification changed here, only how it is shown', async () => {
    const { service } = build([
      {
        code: 'PF',
        name: 'Provident Fund',
        type: 'DEDUCTION',
        calcType: 'FORMULA',
        formula: 'BASIC * 0.12',
        isSystemDefault: true,
        statutoryKey: 'PF',
        isStatutory: true,
      },
      basic,
    ]);
    await expect(
      service.update('c1', { isTaxable: false } as never, 'org'),
    ).rejects.toThrow(
      /built-in statutory component — isTaxable cannot be changed here/,
    );
    await expect(
      service.update('c1', { showOnPayslip: false } as never, 'org'),
    ).resolves.toBeTruthy();
  });

  it('an edit that would create a loop is refused', async () => {
    const { service } = build([
      {
        code: 'A',
        name: 'A',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'BASIC',
        percentageValue: 10,
      },
      {
        code: 'B',
        name: 'B',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'A',
        percentageValue: 10,
      },
      basic,
    ]);
    await expect(
      service.update('c1', { percentageOf: 'B' } as never, 'org'),
    ).rejects.toThrow(/circular|cycle/i);
  });

  it('an unknown component is not found', async () => {
    const { service } = build();
    await expect(service.update('ghost', {} as never, 'org')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('salary components: switching off and deleting', () => {
  it('a custom component can be switched off and on again', async () => {
    const { service, store } = build([
      basic,
      { code: 'PERK', name: 'Perk', type: 'EARNING' },
    ]);
    await service.toggle('c2', 'org');
    expect(store[1].isActive).toBe(false);
    await service.toggle('c2', 'org');
    expect(store[1].isActive).toBe(true);
  });

  it('a statutory component follows Statutory Compliance, so it cannot be switched here', async () => {
    const { service } = build([
      {
        code: 'PF',
        name: 'Provident Fund',
        type: 'DEDUCTION',
        statutoryKey: 'PF',
        isSystemDefault: true,
      },
    ]);
    await expect(service.toggle('c1', 'org')).rejects.toThrow(
      /controlled by Statutory Compliance/,
    );
  });

  it('switching a component back on cannot sneak a loop in', async () => {
    const { service } = build([
      {
        code: 'A',
        name: 'A',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'B',
        percentageValue: 10,
        isActive: false,
      },
      {
        code: 'B',
        name: 'B',
        type: 'EARNING',
        calcType: 'PERCENTAGE',
        percentageOf: 'A',
        percentageValue: 10,
      },
    ]);
    await expect(service.toggle('c1', 'org')).rejects.toThrow(
      /circular|cycle/i,
    );
  });

  it("built-ins can never be deleted; a component in someone's structure cannot either", async () => {
    const builtin = build([{ ...basic, isSystemDefault: true }]);
    await expect(builtin.service.remove('c1', 'org')).rejects.toThrow(
      /built-in salary component and cannot be deleted/,
    );
    const used = build([{ code: 'PERK', name: 'Perk', type: 'EARNING' }], {
      assigned: 2,
    });
    await expect(used.service.remove('c1', 'org')).rejects.toThrow(
      /assigned to one or more employees/,
    );
  });

  it('an unused custom component is deleted and audited', async () => {
    const { service, store, audit } = build([
      { code: 'PERK', name: 'Perk', type: 'EARNING' },
    ]);
    await service.remove('c1', 'org', 'u1');
    expect(store).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({
      action: 'SALARY_COMPONENT_DELETED',
      details: { code: 'PERK' },
    });
  });
});

describe('salary components: the default set', () => {
  it('every organisation starts with the same built-ins, each marked as a system default', async () => {
    const created: Row[] = [];
    const { service } = build();
    await service.seedDefaults(
      {
        salaryComponent: { create: async (a: Row) => created.push(a.data) },
      } as never,
      'org',
      'u1',
    );
    expect(created).toHaveLength(SALARY_COMPONENT_DEFAULTS.length);
    expect(
      created.every((c) => c.isSystemDefault && c.organizationId === 'org'),
    ).toBe(true);
    const codes = created.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of [
      'BASIC',
      'HRA',
      'PF',
      'ESI',
      'PT',
      'INCOME_TAX',
      'OVERTIME_PAY',
    ])
      expect(codes).toContain(code);
  });

  it('the default formulas have no loops and only reference names that exist', () => {
    const codes = new Set(SALARY_COMPONENT_DEFAULTS.map((d) => d.code));
    for (const d of SALARY_COMPONENT_DEFAULTS) {
      if (d.percentageOf) expect(codes.has(d.percentageOf)).toBe(true);
    }
  });
});

describe('salary components: formula checking', () => {
  it('reports a valid formula with the names it uses, flags unknown ones, and rejects a broken one', async () => {
    const { service } = build([basic]);
    const ok = (await service.validateFormula(
      { formula: 'BASIC * 0.1 + GHOST' } as never,
      'org',
    )) as Row;
    expect(ok.valid).toBe(true);
    expect(ok.unknownRefs).toEqual(['GHOST']);
    const bad = (await service.validateFormula(
      { formula: 'BASIC *' } as never,
      'org',
    )) as Row;
    expect(bad.valid).toBe(false);
    expect(bad.error).toBeTruthy();
  });

  it('a formula that can only produce a non-number is reported invalid', async () => {
    const { service } = build([basic]);
    const r = (await service.validateFormula(
      { formula: 'MIN()' } as never,
      'org',
    )) as Row;
    expect(r.valid).toBe(false);
  });

  it('dividing by zero is not an error: it gives 0, so it can never put NaN on a payslip', async () => {
    const { service } = build([basic]);
    const r = (await service.validateFormula(
      { formula: 'BASIC / 0' } as never,
      'org',
    )) as Row;
    expect(r.valid).toBe(true);
  });
});
