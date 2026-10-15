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
