import { buildSetupStatus, findSettingsClashes, hasLeft, type SettingsFacts } from './org-health';

const FULL = { workLocations: 1, workSchedules: 1, departments: 2, designations: 3, leaveTypes: 4, holidaysThisYear: 10, salaryComponents: 5, documentRequirements: 2, employees: 20 };

const OK: SettingsFacts = {
  processingDate: '2026-11-25', paymentDate: '2026-11-30', processingFixed: true, paymentFixed: true, weeklyOffs: [0, 6],
  pfEnabled: false, esiEnabled: false, ptEnabled: false, epfoEstablishmentCode: null, esicEmployerCode: null, ptRegistrationNumber: null,
  taxRegimeEmployeeChange: true, taxRegimeCutoffMonth: null,
};

describe('buildSetupStatus', () => {
  it('is 100% when everything has at least one record', () => {
    expect(buildSetupStatus(FULL)).toMatchObject({ percent: 100, done: 9, total: 9 });
  });

  it('lists what is missing with the screen that fixes it', () => {
    const s = buildSetupStatus({ ...FULL, holidaysThisYear: 0, designations: 0 });
    expect(s.percent).toBe(78);
    expect(s.items.filter((i) => !i.done).map((i) => i.link)).toEqual(['/designations', '/holidays']);
  });

  it('counts a company with only its founder as not having employees yet', () => {
    expect(buildSetupStatus({ ...FULL, employees: 1 }).items.find((i) => i.key === 'employees')?.done).toBe(false);
  });
});

describe('findSettingsClashes', () => {
  const keys = (f: Partial<SettingsFacts>) => findSettingsClashes({ ...OK, ...f }).map((c) => c.key);

  it('finds nothing in a consistent setup', () => expect(keys({})).toEqual([]));

  it('flags salary paid before payroll is processed', () => {
    expect(keys({ processingDate: '2026-11-26', paymentDate: '2026-11-05' })).toEqual(['pay-before-processing']);
    expect(keys({ processingDate: '2026-11-26', paymentDate: '2026-11-26' })).toEqual([]);
  });

  it('flags a fixed processing or payment day that lands on a weekly off, but not "last working day"', () => {
    // 2026-11-28 is a Saturday.
    expect(keys({ processingDate: '2026-11-28', paymentDate: '2026-11-30' })).toEqual(['processing-on-weekly-off']);
    expect(keys({ paymentDate: '2026-11-29' })).toEqual(['payment-on-weekly-off']);
    expect(keys({ processingDate: '2026-11-28', processingFixed: false })).toEqual([]);
  });

  it('flags a statutory switch that is on without its registration number', () => {
    expect(keys({ pfEnabled: true })).toEqual(['pf-no-code']);
    expect(keys({ pfEnabled: true, epfoEstablishmentCode: 'MHBAN0012345' })).toEqual([]);
    expect(keys({ esiEnabled: true, ptEnabled: true })).toEqual(['esi-no-code', 'pt-no-number']);
  });

  it('flags a tax regime deadline that has no effect', () => {
    expect(keys({ taxRegimeEmployeeChange: false, taxRegimeCutoffMonth: 9 })).toEqual(['regime-cutoff-unused']);
    expect(keys({ taxRegimeEmployeeChange: false, taxRegimeCutoffMonth: null })).toEqual([]);
  });
});

describe('hasLeft', () => {
  it('is true when deactivated, finally exited or past the last working day', () => {
    expect(hasLeft({ isActive: false, employmentStatus: 'CONFIRMED', exitDate: null }, '2026-11-01')).toBe(true);
    expect(hasLeft({ isActive: true, employmentStatus: 'RELEASED', exitDate: null }, '2026-11-01')).toBe(true);
    expect(hasLeft({ isActive: true, employmentStatus: 'RESIGNED', exitDate: '2026-10-31' }, '2026-11-01')).toBe(true);
  });
  it('is false while still working, including the last working day itself and notice', () => {
    expect(hasLeft({ isActive: true, employmentStatus: 'RESIGNED', exitDate: '2026-11-01' }, '2026-11-01')).toBe(false);
    expect(hasLeft({ isActive: true, employmentStatus: 'CONFIRMED', exitDate: null }, '2026-11-01')).toBe(false);
  });
});
