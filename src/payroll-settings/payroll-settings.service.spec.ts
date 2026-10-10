import { PayrollSettingsService } from './payroll-settings.service';

type Row = Record<string, any>;

function build(
  opts: { settings?: Row | null; policies?: Row; overtimePayOn?: boolean } = {},
) {
  let settings: Row | null =
    opts.settings === undefined
      ? {
          id: 's1',
          organizationId: 'org',
          financialYearStartMonth: 4,
          currency: 'INR',
          currencySymbol: '₹',
          processingDay: 0,
          paymentDay: 0,
          pfEnabled: false,
          otRegularRate: 1.5,
          roundingRule: 'nearest',
          roundingDecimals: 0,
        }
      : opts.settings;
  const updates: Row[] = [];
  const versionUpdates: Row[] = [];
  const invalidated: string[] = [];
  const audit: Row[] = [];
  const cache = {
    store: new Map<string, unknown>(),
    getOrSet: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
      if (cache.store.has(key)) return cache.store.get(key);
      const v = await fn();
      cache.store.set(key, v);
      return v;
    },
    invalidate: async (key: string) => {
      invalidated.push(key);
      cache.store.delete(key);
    },
    invalidatePrefix: async (p: string) => {
      invalidated.push(p);
    },
  };
  const prisma: Row = {
    payrollSettings: {
      findFirst: async () => (settings ? { ...settings } : null),
      findFirstOrThrow: async () => ({ ...settings! }),
      create: async (a: Row) => {
        settings = {
          id: 's-new',
          financialYearStartMonth: 4,
          currency: 'INR',
          currencySymbol: '₹',
          ...a.data,
        };
        return { ...settings };
      },
      updateMany: async (a: Row) => {
        updates.push(a.data);
        settings = { ...settings!, ...a.data };
        return { count: 1 };
      },
    },
    organization: {
      findFirst: async () => ({
        policies: opts.policies ?? {},
        attendancePayrollPrefs: null,
      }),
    },
    salaryComponent: {
      count: async () => (opts.overtimePayOn === false ? 0 : 1),
    },
    statutoryConfigVersion: {
      updateMany: async (a: Row) => {
        versionUpdates.push(a);
        return { count: 1 };
      },
    },
  };
  const service = new PayrollSettingsService(
    prisma as never,
    cache as never,
    { log: async (e: Row) => audit.push(e) } as never,
  );
  return {
    service,
    updates,
    versionUpdates,
    invalidated,
    audit,
    cache,
    getSettings: () => settings,
  };
}

describe('payroll settings: reading', () => {
  it('a new organisation gets its settings row created on first read', async () => {
    const { service, getSettings } = build({ settings: null });
    const s = await service.getOrCreate('org');
    expect(s.organizationId).toBe('org');
    expect(getSettings()).not.toBeNull();
  });

  it('the policies chosen in Organization Settings win for currency and the financial year start', async () => {
    const { service } = build({
      policies: {
        currency: 'USD',
        currencySymbol: '$',
        financialYearStartMonth: '1',
      },
    });
    const s = await service.getOrCreate('org');
    expect(s).toMatchObject({
      currency: 'USD',
      currencySymbol: '$',
      financialYearStartMonth: 1,
    });
  });

  it('without policies, the stored defaults apply (INR, April)', async () => {
    const s = await build().service.getOrCreate('org');
    expect(s).toMatchObject({
      currency: 'INR',
      currencySymbol: '₹',
      financialYearStartMonth: 4,
    });
  });

  it('reading is cached so a bulk payroll run reads the database once', async () => {
    const { service, cache } = build();
    await service.getOrCreate('org');
    await service.getOrCreate('org');
    expect(cache.store.size).toBe(1);
  });

  it('the settings screen also gets the processing and payment dates for this month, and whether overtime pay is on', async () => {
    const r = await build().service.getWithResolvedDates('org');
    expect(r.overtimePayEnabled).toBe(true);
    expect(r.resolvedForCurrentMonth.processingDate).toBeTruthy();
    expect(r.resolvedForCurrentMonth.paymentDate).toBeTruthy();
  });
});

describe('payroll settings: saving', () => {
  it('saves the change, clears the cache and records before and after', async () => {
    const { service, updates, invalidated, audit } = build();
    await service.update({ roundingDecimals: 2 } as never, 'u1', 'org');
    expect(updates[0]).toMatchObject({
      roundingDecimals: 2,
      updatedById: 'u1',
    });
    expect(invalidated).toContain('payrollsettings:org');
    expect(audit.at(-1)).toMatchObject({
      action: 'PAYROLL_SETTINGS_UPDATED',
      details: { changes: { roundingDecimals: { before: 0, after: 2 } } },
    });
  });

  it('turning PF on here also turns on its open-ended statutory version, so the two never disagree', async () => {
    const { service, versionUpdates } = build();
    await service.update({ pfEnabled: true } as never, 'u1', 'org');
    expect(versionUpdates).toHaveLength(1);
    expect(versionUpdates[0]).toMatchObject({
      where: { module: 'PF', effectiveTo: null },
      data: { isEnabled: true },
    });
  });

  it('re-sending a switch unchanged leaves a deliberately different statutory version alone', async () => {
    const { service, versionUpdates } = build();
    await service.update(
      { pfEnabled: false, roundingDecimals: 1 } as never,
      'u1',
      'org',
    );
    expect(versionUpdates).toHaveLength(0);
  });

  it('overtime rates are ignored while Overtime Pay is off, and kept when it is on', async () => {
    const off = build({ overtimePayOn: false });
    await off.service.update(
      { otRegularRate: 3, roundingDecimals: 1 } as never,
      'u1',
      'org',
    );
    expect(off.updates[0].otRegularRate).toBeUndefined();
    const on = build({ overtimePayOn: true });
    await on.service.update({ otRegularRate: 3 } as never, 'u1', 'org');
    expect(on.updates[0].otRegularRate).toBe(3);
  });
});

describe('payroll settings: professional tax ladder', () => {
  const go = (ptSlabs: unknown) =>
    build().service.update({ ptSlabs } as never, 'u1', 'org');

  it('accepts a proper ascending ladder with an open last band', async () => {
    await expect(
      go([
        { upTo: 7500, amount: 0 },
        { upTo: 10000, amount: 175 },
        { upTo: null, amount: 200 },
      ]),
    ).resolves.toBeTruthy();
  });

  it('rejects anything that is not a ladder', async () => {
    await expect(go('x')).rejects.toThrow(/must be a list of bands/);
    await expect(go([{ upTo: 100, amount: -5 }])).rejects.toThrow(
      /amount must be a number of 0 or more/,
    );
    await expect(go([{ upTo: 100, amount: 'a' }])).rejects.toThrow(
      /amount must be a number/,
    );
    await expect(
      go([
        { upTo: 5000, amount: 0 },
        { upTo: 3000, amount: 100 },
      ]),
    ).rejects.toThrow(/greater than the previous band/);
    await expect(
      go([
        { upTo: null, amount: 0 },
        { upTo: 3000, amount: 100 },
      ]),
    ).rejects.toThrow(/only the last band can be open-ended/);
  });
});
