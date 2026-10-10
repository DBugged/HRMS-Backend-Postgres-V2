import { StatutoryConfigService } from './statutory-config.service';
import { SEED_DEFAULTS } from './statutory-config-validation';

type Row = Record<string, any>;

function build(versions: Row[] = [], opts: { finalizedRun?: Row | null } = {}) {
  const store: Row[] = versions.map((v, i) => ({
    id: `v${i + 1}`,
    organizationId: 'org',
    effectiveTo: null,
    isEnabled: true,
    ...v,
  }));
  const audit: Row[] = [];
  const invalidated: string[] = [];
  let reads = 0;
  const cacheStore = new Map<string, unknown>();
  const cache = {
    getOrSet: async (k: string, _t: number, fn: () => Promise<unknown>) => {
      if (cacheStore.has(k)) return cacheStore.get(k);
      reads++;
      const v = await fn();
      cacheStore.set(k, v);
      return v;
    },
    invalidatePrefix: async (p: string) => {
      invalidated.push(p);
      for (const k of [...cacheStore.keys()])
        if (k.startsWith(p)) cacheStore.delete(k);
    },
  };
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (k === 'OR') return true;
      if (v && typeof v === 'object' && 'lte' in v) return r[k] <= v.lte;
      return v === undefined || r[k] === v;
    });
  const model = {
    findFirst: async (a: Row) => {
      let rows = store.filter((x) => match(x, a?.where));
      // the "effectiveTo is null or >= date" half of getEffective
      const date = a?.where?.effectiveFrom?.lte;
      if (date)
        rows = rows.filter(
          (r) => r.effectiveTo === null || r.effectiveTo >= date,
        );
      if (a?.orderBy?.effectiveFrom === 'desc')
        rows = [...rows].sort((x, y) =>
          x.effectiveFrom < y.effectiveFrom ? 1 : -1,
        );
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async (a: Row) =>
      store.filter((x) => match(x, a?.where)).map((x) => ({ ...x })),
    count: async (a: Row) => store.filter((x) => match(x, a?.where)).length,
    create: async (a: Row) => {
      const row = { id: `v${store.length + 1}`, effectiveTo: null, ...a.data };
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
  };
  const prisma: Row = {
    statutoryConfigVersion: model,
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    payrollRun: { findFirst: async () => opts.finalizedRun ?? null },
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: Row) => unknown)({ statutoryConfigVersion: model })
        : Promise.all(arg as Promise<unknown>[]),
  };
  const service = new StatutoryConfigService(
    prisma as never,
    cache as never,
    { log: async (e: Row) => audit.push(e) } as never,
  );
  return { service, store, audit, invalidated, reads: () => reads };
}

const pf = (over: Row = {}) => ({
  employeeRate: 12,
  employerRate: 12,
  wageCeiling: 25000,
  ...over,
});

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('statutory config: which version applies on a date', () => {
  const versions = [
    {
      module: 'PF',
      effectiveFrom: '2025-04-01',
      effectiveTo: '2026-09-16',
      config: pf({ wageCeiling: 15000 }),
    },
    {
      module: 'PF',
      effectiveFrom: '2026-09-17',
      config: pf({ wageCeiling: 25000 }),
    },
  ];

  it('the old ceiling applies before the change and the new one from it', async () => {
    const { service } = build(versions);
    expect(
      (await service.getEffective('PF' as never, '2026-08-31', 'org')).version
        ?.config,
    ).toMatchObject({ wageCeiling: 15000 });
    expect(
      (await service.getEffective('PF' as never, '2026-09-16', 'org')).version
        ?.config,
    ).toMatchObject({ wageCeiling: 15000 });
    expect(
      (await service.getEffective('PF' as never, '2026-09-17', 'org')).version
        ?.config,
    ).toMatchObject({ wageCeiling: 25000 });
  });

  it('a date before any version has none', async () => {
    const { service } = build(versions);
    expect(
      (await service.getEffective('PF' as never, '2024-01-01', 'org')).version,
    ).toBeNull();
  });

  it('no date means today in the organisation timezone', async () => {
    const { service } = build(versions);
    const r = await service.getEffective('PF' as never, undefined, 'org');
    expect(r.date).toBe('2026-10-10');
    expect(r.version?.config).toMatchObject({ wageCeiling: 25000 });
  });

  it('a payroll batch reads each (module, date) from the database once, not once per employee', async () => {
    const { service, reads } = build(versions);
    for (let i = 0; i < 50; i++)
      await service.getEffective('PF' as never, '2026-10-31', 'org');
    expect(reads()).toBe(1);
  });
});

describe('statutory config: adding a version', () => {
  it('closes the current version the day before and opens the new one, together', async () => {
    const { service, store } = build([
      { module: 'PF', effectiveFrom: '2025-04-01', config: pf() },
    ]);
    await service.create(
      'PF' as never,
      {
        effectiveFrom: '2026-11-01',
        config: pf({ wageCeiling: 30000 }),
      } as never,
      'u1',
      'org',
    );
    expect(store).toHaveLength(2);
    expect(store[0].effectiveTo).toBe('2026-10-31');
    expect(store[1]).toMatchObject({
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
      isEnabled: true,
      createdById: 'u1',
    });
  });

  it('clears the cache for that module so payroll sees it at once, and audits it', async () => {
    const { service, invalidated, audit } = build([
      { module: 'PF', effectiveFrom: '2025-04-01', config: pf() },
    ]);
    await service.create(
      'PF' as never,
      { effectiveFrom: '2026-11-01', config: pf() } as never,
      'u1',
      'org',
    );
    expect(invalidated).toContain('statconfig:org:PF:');
    expect(audit.at(-1)).toMatchObject({
      action: 'STATUTORY_CONFIG_VERSION_CREATED',
      details: { module: 'PF', effectiveFrom: '2026-11-01' },
    });
  });

  it('an invalid configuration is refused with the reason', async () => {
    const { service, store } = build([
      { module: 'PF', effectiveFrom: '2025-04-01', config: pf() },
    ]);
    await expect(
      service.create(
        'PF' as never,
        { effectiveFrom: '2026-11-01', config: { employeeRate: 500 } } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow();
    expect(store).toHaveLength(1);
  });

  it('two versions cannot start on the same day', async () => {
    const { service } = build([
      { module: 'PF', effectiveFrom: '2026-11-01', config: pf() },
    ]);
    await expect(
      service.create(
        'PF' as never,
        { effectiveFrom: '2026-11-01', config: pf() } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow(/already starts on 2026-11-01/);
  });

  it('a version cannot be back-dated before the latest one (it would leave an inverted date range)', async () => {
    const { service } = build([
      { module: 'PF', effectiveFrom: '2026-11-01', config: pf() },
    ]);
    await expect(
      service.create(
        'PF' as never,
        { effectiveFrom: '2026-06-01', config: pf() } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow(/must start after the most recent version/);
  });

  it('a version cannot start in a month whose payroll is already locked or paid', async () => {
    const { service } = build(
      [{ module: 'PF', effectiveFrom: '2025-04-01', config: pf() }],
      { finalizedRun: { month: 9, year: 2026 } },
    );
    await expect(
      service.create(
        'PF' as never,
        { effectiveFrom: '2026-09-17', config: pf() } as never,
        'u1',
        'org',
      ),
    ).rejects.toThrow(/payroll for 9\/2026 is already locked or paid/);
  });
});

describe('statutory config: deleting a version', () => {
  const two = [
    {
      module: 'PF',
      effectiveFrom: '2025-04-01',
      effectiveTo: '2026-12-31',
      config: pf(),
    },
    {
      module: 'PF',
      effectiveFrom: '2027-01-01',
      config: pf({ wageCeiling: 30000 }),
    },
  ];

  it('only a future-dated version can be deleted; the one before it is reopened', async () => {
    const { service, store } = build(two);
    await service.remove('PF' as never, 'v2', 'org');
    expect(store).toHaveLength(1);
    expect(store[0].effectiveTo).toBeNull();
  });

  it('past and current versions are permanent history', async () => {
    const { service } = build(two);
    await expect(service.remove('PF' as never, 'v1', 'org')).rejects.toThrow(
      /Only a future-dated version can be deleted/,
    );
  });

  it('the only version of a module can never be deleted', async () => {
    const { service } = build([
      { module: 'PF', effectiveFrom: '2027-01-01', config: pf() },
    ]);
    await expect(service.remove('PF' as never, 'v1', 'org')).rejects.toThrow(
      /Cannot delete the only version/,
    );
  });

  it('an unknown version is not found', async () => {
    const { service } = build();
    await expect(service.remove('PF' as never, 'ghost', 'org')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('statutory config: a new organisation', () => {
  it('starts with a version of every module so payroll has something to resolve from day one', async () => {
    const created: Row[] = [];
    const { service } = build();
    await service.seedDefaults(
      {
        statutoryConfigVersion: {
          create: async (a: Row) => created.push(a.data),
        },
        organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
      } as never,
      'org',
    );
    expect(created.map((c) => c.module).sort()).toEqual(
      Object.keys(SEED_DEFAULTS).sort(),
    );
    expect(created.every((c) => c.effectiveFrom === '2026-10-10')).toBe(true);
  });

  it('new organisations start at the current PF wage ceiling of 25,000', () => {
    expect((SEED_DEFAULTS.PF.config as Row).wageCeiling).toBe(25000);
  });
});
