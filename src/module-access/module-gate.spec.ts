import { REQUEST_TYPE_MODULE, SISTER_COMPANIES_FLAG, disabledModulesOf, featureEnabledFor, gate, keepModuleEnabled, moduleEnabledFor, registerModuleGate, sisterCompaniesOn } from './module-gate';
import type { ModuleAccessService } from './module-access.service';

// A stand-in for the real service: company "off" has attendance switched off, everyone else is on.
const fake = {
  enabledAmong: async (ids: string[], module: string) => new Set(ids.filter((id) => !(id === 'off' && module === 'module.attendance'))),
  disabledFor: async (id: string) => new Set(id === 'off' ? ['module.attendance'] : []),
} as unknown as ModuleAccessService;

describe('module gate for background jobs', () => {
  it('runs for everyone before the gate is up (jobs err on the side of running)', async () => {
    const orgs = [{ id: 'a' }, { id: 'off' }];
    expect(await keepModuleEnabled(orgs, 'module.attendance')).toEqual(orgs);
    expect(await moduleEnabledFor('off', 'module.attendance')).toBe(true);
    expect((await disabledModulesOf('off')).size).toBe(0);
  });

  it('drops the companies that switched the module off, and only for that module', async () => {
    registerModuleGate(fake);
    const orgs = [{ id: 'a' }, { id: 'off' }, { id: 'b' }];
    expect((await keepModuleEnabled(orgs, 'module.attendance')).map((o) => o.id)).toEqual(['a', 'b']);
    expect((await keepModuleEnabled(orgs, 'module.leave')).map((o) => o.id)).toEqual(['a', 'off', 'b']);
    expect(await moduleEnabledFor('off', 'module.attendance')).toBe(false);
    expect((await disabledModulesOf('off')).has('module.attendance')).toBe(true);
  });

  it('maps every approval-queue request type to a module', () => {
    expect(REQUEST_TYPE_MODULE.WFH).toBe('module.attendance');
    expect(REQUEST_TYPE_MODULE.COMP_OFF).toBe('module.leave');
    expect(REQUEST_TYPE_MODULE.LOAN).toBe('module.loans_reimbursements');
    expect(REQUEST_TYPE_MODULE.RESIGNATION).toBe('module.offboarding');
  });
});

describe('gate', () => {
  it('runs the query when the module is on, and skips it (resolving to the empty value) when it is off', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return 7;
    };
    expect(await gate(new Set(), 'module.leave', run, 0)).toBe(7);
    expect(await gate(new Set(['module.leave']), 'module.leave', run, 0)).toBe(0);
    expect(await gate(new Set(['module.payroll']), 'module.leave', run, 0)).toBe(7);
    expect(calls).toBe(2);
  });
});

describe('opt-in features (sister companies)', () => {
  it('is on before the gate is up, so unit tests exercise the feature', async () => {
    registerModuleGate(undefined as never);
    expect(await sisterCompaniesOn('any')).toBe(true);
  });

  it('follows the service once it is up', async () => {
    registerModuleGate({ featureEnabledFor: async (id: string, key: string) => id === 'on' && key === SISTER_COMPANIES_FLAG } as unknown as ModuleAccessService);
    expect(await sisterCompaniesOn('on')).toBe(true);
    expect(await sisterCompaniesOn('off')).toBe(false);
    expect(await featureEnabledFor('on', 'feature.other')).toBe(false);
  });
});
