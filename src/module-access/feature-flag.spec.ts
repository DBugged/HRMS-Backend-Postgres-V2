import { ModuleAccessService } from './module-access.service';

type Row = Record<string, any>;

function build(o: { flag?: Row | null; override?: Row | null; fail?: boolean }) {
  const prisma: Row = {
    ccFeatureFlag: { findUnique: async () => { if (o.fail) throw new Error('db down'); return o.flag ?? null; } },
    ccFlagOverride: { findFirst: async () => o.override ?? null },
  };
  return new ModuleAccessService(prisma as never);
}

const flag = (defaultValue: boolean, status = 'ACTIVE') => ({ key: 'feature.sister_companies', defaultValue, status });

describe('ModuleAccessService.featureEnabledFor', () => {
  it('is off by default, and on when the company override is true', async () => {
    expect(await build({ flag: flag(false) }).featureEnabledFor('o', 'feature.sister_companies')).toBe(false);
    expect(await build({ flag: flag(false), override: { value: true } }).featureEnabledFor('o', 'feature.sister_companies')).toBe(true);
  });

  it('follows the default when there is no override, and an override of false wins over a default of true', async () => {
    expect(await build({ flag: flag(true) }).featureEnabledFor('o', 'feature.sister_companies')).toBe(true);
    expect(await build({ flag: flag(true), override: { value: false } }).featureEnabledFor('o', 'feature.sister_companies')).toBe(false);
  });

  it('is off when the flag is missing or inactive, or the lookup fails', async () => {
    expect(await build({ flag: null }).featureEnabledFor('o', 'feature.sister_companies')).toBe(false);
    expect(await build({ flag: flag(true, 'INACTIVE') }).featureEnabledFor('o', 'feature.sister_companies')).toBe(false);
    expect(await build({ fail: true }).featureEnabledFor('o', 'feature.sister_companies')).toBe(false);
  });
});
