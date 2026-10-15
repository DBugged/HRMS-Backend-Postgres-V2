import {
  planSetup,
  suggestedAnswers,
  compulsorySkipped,
} from './statutory-setup';
import { StatutoryConfigService } from './statutory-config.service';
import { validateModuleConfig } from './statutory-config-validation';

const answers = (over = {}) => ({
  employeeCount: 9,
  state: 'Maharashtra',
  pf: true,
  esi: true,
  pt: true,
  ...over,
});

describe('planSetup', () => {
  it('switches on exactly the modules answered yes, with valid configs', () => {
    const plan = planSetup(answers({ esi: false }));
    expect(plan.map((p) => p.module)).toEqual(['PF', 'PT']);
    plan.forEach((p) =>
      expect(() => validateModuleConfig(p.module, p.config)).not.toThrow(),
    );
  });

  it('uses the current PF ceiling and Maharashtra PT slabs', () => {
    const [pf, , pt] = planSetup(answers());
    expect(pf.config).toMatchObject({ employeeRate: 12, wageCeiling: 25000 });
    expect(pt.config).toHaveProperty('womenSlabs');
  });

  it('refuses a state other than Maharashtra', () => {
    expect(() => planSetup(answers({ state: 'Gujarat' }))).toThrow(
      /Maharashtra/,
    );
  });

  it('plans nothing when all answers are no', () => {
    expect(planSetup(answers({ pf: false, esi: false, pt: false }))).toEqual(
      [],
    );
  });
});

describe('suggestions by headcount', () => {
  it('ESI from 10, PF from 20, PT always', () => {
    expect(suggestedAnswers(9)).toEqual({ pf: false, esi: false, pt: true });
    expect(suggestedAnswers(10)).toEqual({ pf: false, esi: true, pt: true });
    expect(suggestedAnswers(20)).toEqual({ pf: true, esi: true, pt: true });
  });

  it('notes compulsory modules answered no', () => {
    expect(
      compulsorySkipped(answers({ employeeCount: 25, pf: false, esi: false })),
    ).toEqual(['PF', 'ESI']);
    expect(
      compulsorySkipped(answers({ employeeCount: 5, pf: false, esi: false })),
    ).toEqual([]);
  });
});

type Row = Record<string, any>;
function build(initial: Row[], finalized: Row | null = null) {
  const store: Row[] = initial.map((v, i) => ({
    id: `v${i}`,
    organizationId: 'o',
    effectiveTo: null,
    ...v,
  }));
  const model = {
    findMany: async (a: Row) =>
      store
        .filter((r) => r.module === a.where.module)
        .sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? 1 : -1)),
    findFirst: async (a: Row) => {
      let rows = store.filter((r) => r.module === a.where.module);
      if (a.where.effectiveTo === null)
        rows = rows.filter((r) => r.effectiveTo === null);
      if (a.where.effectiveFrom && typeof a.where.effectiveFrom === 'string')
        rows = rows.filter((r) => r.effectiveFrom === a.where.effectiveFrom);
      if (a.where.effectiveFrom?.lte) {
        const d = a.where.effectiveFrom.lte;
        rows = rows.filter(
          (r) =>
            r.effectiveFrom <= d &&
            (r.effectiveTo === null || r.effectiveTo >= d),
        );
      }
      rows.sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? 1 : -1));
      return rows[0] ?? null;
    },
    updateMany: async (a: Row) => {
      store
        .filter((r) => r.id === a.where.id)
        .forEach((r) => Object.assign(r, a.data));
      return { count: 1 };
    },
    create: async (a: Row) => {
      const row = { id: `n${store.length}`, effectiveTo: null, ...a.data };
      store.push(row);
      return row;
    },
  };
  const prisma: Row = {
    statutoryConfigVersion: model,
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    payrollRun: { findFirst: async () => finalized },
    user: { count: async () => 9 },
    $transaction: async (fn: any) => fn({ statutoryConfigVersion: model }),
  };
  const cache = {
    getOrSet: async (_k: string, _t: number, fn: () => unknown) => fn(),
    invalidatePrefix: async () => undefined,
  };
  const service = new StatutoryConfigService(
    prisma as never,
    cache as never,
    { log: async () => undefined } as never,
  );
  return { service, store };
}

const seed = (module: string, isEnabled = false) => ({
  module,
  effectiveFrom: '2026-10-01',
  isEnabled,
  config: {},
});
const allSeeds = () =>
  ['PF', 'ESI', 'PT', 'LWF', 'GRATUITY', 'BONUS'].map((m) => seed(m));
const dto = (over = {}) => ({
  ...answers(),
  effectiveFrom: '2026-09-01',
  ...over,
});

describe('StatutoryConfigService setup', () => {
  it('reports setup due while everything is off, and not after', async () => {
    const { service } = build(
      allSeeds().map((s) => ({ ...s, effectiveFrom: '2026-01-01' })),
    );
    expect((await service.getSetupStatus('o')).needsSetup).toBe(true);
    await service.applySetup(dto({ effectiveFrom: '2026-01-01' }), 'u', 'o');
    expect((await service.getSetupStatus('o')).needsSetup).toBe(false);
  });

  it('replaces an untouched default in place so the date can reach back', async () => {
    const { service, store } = build(allSeeds());
    const res = await service.applySetup(dto(), 'u', 'o');
    expect(res.enabled).toEqual(['PF', 'ESI', 'PT']);
    const pf = store.filter((r) => r.module === 'PF');
    expect(pf).toHaveLength(1);
    expect(pf[0]).toMatchObject({
      isEnabled: true,
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
    });
    expect(pf[0].config.wageCeiling).toBe(25000);
  });

  it('leaves a module that is already on untouched', async () => {
    const { service, store } = build([
      { ...seed('PF', true), config: { employeeRate: 10 } },
      seed('ESI'),
      seed('PT'),
    ]);
    const res = await service.applySetup(dto(), 'u', 'o');
    expect(res.alreadyOn).toEqual(['PF']);
    expect(store.find((r) => r.module === 'PF')!.config).toEqual({
      employeeRate: 10,
    });
  });

  it('adds a new version when a module was switched off after a history', async () => {
    const { service, store } = build([
      {
        module: 'PF',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-05-31',
        isEnabled: true,
        config: {},
      },
      {
        module: 'PF',
        effectiveFrom: '2026-06-01',
        isEnabled: false,
        config: {},
      },
    ]);
    await service.applySetup(dto({ esi: false, pt: false }), 'u', 'o');
    const pf = store.filter((r) => r.module === 'PF');
    expect(pf).toHaveLength(3);
    expect(pf.find((r) => r.effectiveFrom === '2026-09-01')).toMatchObject({
      isEnabled: true,
    });
  });

  it('refuses a start date inside a locked month', async () => {
    const { service } = build(allSeeds(), { month: 9, year: 2026 });
    await expect(service.applySetup(dto(), 'u', 'o')).rejects.toThrow(
      /locked or paid/,
    );
  });

  it('refuses other states', async () => {
    const { service } = build(allSeeds());
    await expect(
      service.applySetup(dto({ state: 'Goa' }), 'u', 'o'),
    ).rejects.toThrow(/Maharashtra/);
  });
});
