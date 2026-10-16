import { buildReadiness, type ReadinessEmployee } from './payroll-readiness';

const emp = (over: Partial<ReadinessEmployee> = {}): ReadinessEmployee => ({
  id: 'e1',
  name: 'Priya Sharma',
  code: 'DP-00002',
  joiningDate: '2026-04-01',
  personalData: { bankAccountNo: '500100207919', bankIFSC: 'HDFC0001234' },
  ...over,
});

const check = (
  employees: ReadinessEmployee[],
  over: { withStructure?: string[]; exits?: [string, string][] } = {},
) =>
  buildReadiness({
    month: 9,
    year: 2026,
    employees,
    withStructure: new Set(over.withStructure ?? employees.map((e) => e.id)),
    exits: new Map(over.exits ?? []),
  });

describe('buildReadiness', () => {
  it('is empty when everyone is ready', () => {
    expect(check([emp()])).toEqual([]);
  });

  it('flags someone with no salary structure as a blocker', () => {
    const [c] = check([emp()], { withStructure: [] });
    expect(c).toMatchObject({ key: 'structure', level: 'blocker' });
    expect(c.people[0]).toMatchObject({
      name: 'Priya Sharma',
      code: 'DP-00002',
    });
  });

  it('flags missing bank details, whether the account or the IFSC is blank', () => {
    const [c] = check([
      emp({ id: 'a', personalData: { bankIFSC: 'HDFC0001234' } }),
      emp({
        id: 'b',
        personalData: { bankAccountNo: '500100207919', bankIFSC: '  ' },
      }),
      emp({ id: 'c' }),
    ]);
    expect(c.key).toBe('bank');
    expect(c.people.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('treats a person without any personal data as missing bank details', () => {
    expect(check([emp({ personalData: null })])[0].key).toBe('bank');
  });

  it('lists joiners of the month with their joining date, and not earlier joiners', () => {
    const checks = check([
      emp({ id: 'old' }),
      emp({ id: 'new', joiningDate: '2026-09-28' }),
    ]);
    const joiners = checks.find((c) => c.key === 'joiners')!;
    expect(joiners.people).toEqual([
      expect.objectContaining({ id: 'new', detail: '28 Sep' }),
    ]);
  });

  it('ignores someone who joins after the month: they are not on this payroll', () => {
    expect(
      check([emp({ joiningDate: '2026-10-05' })], { withStructure: [] }),
    ).toEqual([]);
  });

  it('lists people whose last working day falls in the month', () => {
    const exits = check([emp()], { exits: [['e1', '2026-09-20']] }).find(
      (c) => c.key === 'exits',
    )!;
    expect(exits.people[0].detail).toBe('last day 20 Sep');
  });

  it('keeps a stable order: blockers first, then warnings, then information', () => {
    const checks = check(
      [emp({ personalData: {}, joiningDate: '2026-09-02' })],
      { withStructure: [], exits: [['e1', '2026-09-29']] },
    );
    expect(checks.map((c) => c.key)).toEqual([
      'structure',
      'bank',
      'joiners',
      'exits',
    ]);
  });
});

describe('buildReadiness - statutory', () => {
  const run = (statutoryOff: boolean, employees = [emp()]) =>
    buildReadiness({
      month: 9,
      year: 2026,
      employees,
      withStructure: new Set(employees.map((e) => e.id)),
      exits: new Map(),
      statutoryOff,
    });

  it('flags statutory not set up when everything is off', () => {
    expect(run(true)).toEqual([
      {
        key: 'statutory',
        level: 'warning',
        title: 'Statutory not set up',
        people: [],
      },
    ]);
  });

  it('says nothing when something is switched on', () => {
    expect(run(false)).toEqual([]);
  });

  it('says nothing when nobody is on payroll that month', () => {
    expect(run(true, [emp({ joiningDate: '2026-12-01' })])).toEqual([]);
  });
});

describe('buildReadiness - opening balances', () => {
  const run = (
    over: {
      month?: number;
      hasYtd?: string[];
      employees?: ReadinessEmployee[];
    } = {},
  ) =>
    buildReadiness({
      month: over.month ?? 9,
      year: 2026,
      employees: over.employees ?? [emp()],
      withStructure: new Set((over.employees ?? [emp()]).map((e) => e.id)),
      exits: new Map(),
      fyStartMonth: 4,
      hasYtd: new Set(over.hasYtd ?? []),
    });

  it('asks for opening balances when payroll starts after April and none exist', () => {
    const [c] = run();
    expect(c).toMatchObject({ key: 'opening', level: 'warning' });
    expect(c.people[0].code).toBe('DP-00002');
  });

  it('is quiet once the balance is entered or earlier runs exist', () => {
    expect(run({ hasYtd: ['e1'] })).toEqual([]);
  });

  it('is quiet in the first month of the financial year', () => {
    expect(run({ month: 4 }).map((c) => c.key)).not.toContain('opening');
  });

  it('skips someone who joined this month', () => {
    expect(
      run({ employees: [emp({ joiningDate: '2026-09-10' })] }).map(
        (c) => c.key,
      ),
    ).not.toContain('opening');
  });
});
