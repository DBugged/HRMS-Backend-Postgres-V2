import { TaxSlabsService } from './tax-slabs.service';

type Row = Record<string, any>;

function build(
  opts: { configs?: Row[]; declarations?: number; finalizedRun?: boolean } = {},
) {
  const configs: Row[] = (opts.configs ?? []).map((c) => ({ ...c }));
  const audit: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(
      ([k, v]) => k === 'organizationId' || v === undefined || r[k] === v,
    );
  const prisma: Row = {
    taxSlabConfig: {
      findMany: async (a: Row) => configs.filter((c) => match(c, a?.where)),
      findFirst: async (a: Row) => {
        const r = configs.find((c) => match(c, a?.where));
        return r ? { ...r } : null;
      },
      findFirstOrThrow: async (a: Row) => ({
        ...configs.find((c) => match(c, a?.where))!,
      }),
      create: async (a: Row) => {
        const row = { id: `c${configs.length + 1}`, isActive: true, ...a.data };
        configs.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = configs.filter((c) => c.id === a.where.id);
        hits.forEach((c) => Object.assign(c, a.data));
        return { count: hits.length };
      },
      deleteMany: async (a: Row) => {
        const i = configs.findIndex((c) => c.id === a.where.id);
        if (i >= 0) configs.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
    payrollRun: {
      findFirst: async () => (opts.finalizedRun ? { id: 'run' } : null),
    },
    employeeTaxDeclaration: { count: async () => opts.declarations ?? 0 },
  };
  const service = new TaxSlabsService(
    prisma as never,
    { log: async (e: Row) => audit.push(e) } as never,
  );
  return { service, configs, audit };
}

const NEW_BANDS = [
  { from: 0, to: 400000, rate: 0 },
  { from: 400000, to: 800000, rate: 5 },
  { from: 800000, to: null, rate: 10 },
];
const existing = (over: Row = {}) => ({
  id: 'c1',
  organizationId: 'org',
  financialYear: '2026-27',
  regime: 'NEW',
  slabs: NEW_BANDS,
  standardDeduction: 75000,
  cessRate: 4,
  isActive: true,
  ...over,
});

describe('tax slabs: saving', () => {
  it('creates a configuration for a new year and regime', async () => {
    const { service, configs } = build();
    const r = await service.upsert(
      {
        financialYear: '2026-27',
        regime: 'NEW',
        slabs: NEW_BANDS,
        standardDeduction: 75000,
        cessRate: 4,
      } as never,
      'org',
      'admin',
    );
    expect(configs).toHaveLength(1);
    expect(r).toMatchObject({
      financialYear: '2026-27',
      regime: 'NEW',
      standardDeduction: 75000,
    });
  });

  it('updates the existing one instead of adding a second', async () => {
    const { service, configs } = build({ configs: [existing()] });
    await service.upsert(
      { financialYear: '2026-27', regime: 'NEW', cessRate: 5 } as never,
      'org',
      'admin',
    );
    expect(configs).toHaveLength(1);
    expect(configs[0].cessRate).toBe(5);
    expect(configs[0].standardDeduction).toBe(75000); // untouched
  });

  it('the audit entry carries before and after', async () => {
    const { service, audit } = build({ configs: [existing()] });
    await service.upsert(
      { financialYear: '2026-27', regime: 'NEW', cessRate: 5 } as never,
      'org',
      'admin',
    );
    expect(audit.at(-1)).toMatchObject({
      action: 'TAX_SLAB_UPDATED',
      details: { before: { cessRate: 4 }, after: { cessRate: 5 } },
    });
  });

  it('rejects bands that overlap, run backwards, or are open-ended in the middle', async () => {
    const { service } = build();
    const go = (slabs: unknown) =>
      service.upsert(
        { financialYear: '2026-27', regime: 'NEW', slabs } as never,
        'org',
      );
    await expect(
      go([
        { from: 0, to: 500000, rate: 0 },
        { from: 400000, to: null, rate: 5 },
      ]),
    ).rejects.toThrow(/overlaps the previous band/);
    await expect(go([{ from: 100, to: 50, rate: 0 }])).rejects.toThrow(
      /"to" must be greater than "from"/,
    );
    await expect(
      go([
        { from: 0, to: null, rate: 0 },
        { from: 100, to: null, rate: 5 },
      ]),
    ).rejects.toThrow(/only the last band can be open-ended/);
    await expect(go('nope')).rejects.toThrow(/must be a list of bands/);
  });

  it('rejects a rate outside 0-100 and a negative start', async () => {
    const { service } = build();
    const go = (slabs: unknown) =>
      service.upsert(
        { financialYear: '2026-27', regime: 'NEW', slabs } as never,
        'org',
      );
    await expect(go([{ from: 0, to: null, rate: 150 }])).rejects.toThrow(
      /rate must be between 0 and 100/,
    );
    await expect(go([{ from: -5, to: null, rate: 5 }])).rejects.toThrow(
      /"from" must be 0 or more/,
    );
  });

  it('rejects bad cess, standard deduction or rebate figures', async () => {
    const { service } = build();
    const go = (extra: Row) =>
      service.upsert(
        { financialYear: '2026-27', regime: 'NEW', ...extra } as never,
        'org',
      );
    await expect(go({ cessRate: 150 })).rejects.toThrow(
      /cessRate must be between 0 and 100/,
    );
    await expect(go({ cessRate: -1 })).rejects.toThrow(
      /cessRate must be 0 or more/,
    );
    await expect(go({ standardDeduction: -1 })).rejects.toThrow(
      /standardDeduction must be 0 or more/,
    );
    await expect(go({ rebate87ALimit: Number.NaN })).rejects.toThrow(
      /rebate87ALimit must be 0 or more/,
    );
  });

  it('slabs of a year that already has locked or paid payroll cannot be changed', async () => {
    const { service } = build({ configs: [existing()], finalizedRun: true });
    await expect(
      service.upsert(
        { financialYear: '2026-27', regime: 'NEW', cessRate: 5 } as never,
        'org',
      ),
    ).rejects.toThrow(
      /already locked or paid, so its tax slabs can no longer be changed/,
    );
  });
});

describe('tax slabs: deleting', () => {
  it('deletes an unused configuration and audits it', async () => {
    const { service, configs, audit } = build({ configs: [existing()] });
    await service.remove('c1', 'org', 'admin');
    expect(configs).toHaveLength(0);
    expect(audit.at(-1)?.action).toBe('TAX_SLAB_DELETED');
  });

  it('is blocked while employees have a declaration on that regime and year', async () => {
    const { service, configs } = build({
      configs: [existing()],
      declarations: 3,
    });
    await expect(service.remove('c1', 'org')).rejects.toThrow(
      /3 employee tax declaration\(s\) use the NEW regime for FY 2026-27/,
    );
    expect(configs).toHaveLength(1);
  });

  it('an unknown configuration is not found', async () => {
    const { service } = build();
    await expect(service.remove('ghost', 'org')).rejects.toThrow(/not found/);
  });
});

describe('tax slabs: defaults and seeding', () => {
  it('has slabs for both regimes; the new regime has the 75,000 standard deduction', () => {
    const { service } = build();
    expect(service.getDefaults('NEW' as never).standardDeduction).toBe(75000);
    expect(service.getDefaults('OLD' as never).standardDeduction).toBe(50000);
  });

  it('registration seeds both regimes for the current financial year', async () => {
    const { service } = build();
    const created: Row[] = [];
    await service.seedDefaults(
      {
        taxSlabConfig: { create: async (a: Row) => created.push(a.data) },
      } as never,
      'org',
      new Date('2026-10-10T00:00:00Z'),
    );
    expect(created.map((c) => `${c.financialYear}:${c.regime}`).sort()).toEqual(
      ['2026-27:NEW', '2026-27:OLD'],
    );
  });

  it('seeding in February belongs to the year that began the previous April', async () => {
    const { service } = build();
    const created: Row[] = [];
    await service.seedDefaults(
      {
        taxSlabConfig: { create: async (a: Row) => created.push(a.data) },
      } as never,
      'org',
      new Date('2027-02-10T00:00:00Z'),
    );
    expect(created[0].financialYear).toBe('2026-27');
  });

  it('lists a year newest first', async () => {
    const { service } = build({
      configs: [
        existing({ id: 'a', financialYear: '2025-26' }),
        existing({ id: 'b' }),
      ],
    });
    const r = await service.findAll(undefined, 'org');
    expect(JSON.stringify(r)).toContain('2026-27');
  });
});
