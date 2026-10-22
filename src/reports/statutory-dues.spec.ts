import { buildStatutoryDues, type DuesInput } from './statutory-dues';

const base = (over: Partial<DuesInput> = {}): DuesInput => ({
  pf: { members: 10, ready: true, challan: { dueDate: '2026-11-15', epfAccount01: 20000, epsAccount10: 8330, edliAccount21: 500, adminAccount02: 500, note: 'n' } },
  esi: { members: 4, ready: true, dueDate: '2026-11-15', employeeContribution: 750, employerContribution: 3250 },
  pt: { states: [{ state: 'Karnataka', employees: 6, totalPt: 1200, dueDate: '2026-11-20', dueNote: '' }, { state: 'Maharashtra', employees: 3, totalPt: 600, dueDate: '2026-11-15', dueNote: '' }] },
  lwf: { states: [{ state: 'Maharashtra', employees: 3, total: 300, dueNote: '' }] },
  ...over,
});

describe('buildStatutoryDues', () => {
  it('adds up what each filing owes and the grand total', () => {
    const { dues, total } = buildStatutoryDues(base());
    expect(dues.map((d) => [d.key, d.amount])).toEqual([['PF', 29330], ['ESI', 4000], ['PT', 1800], ['LWF', 300]]);
    expect(total).toBe(35430);
  });

  it('uses the earliest state due date for Professional Tax and none for LWF', () => {
    const { dues } = buildStatutoryDues(base());
    expect(dues.find((d) => d.key === 'PT')?.dueDate).toBe('2026-11-15');
    expect(dues.find((d) => d.key === 'LWF')?.dueDate).toBeNull();
  });

  it('leaves out a filing nobody is covered by', () => {
    const { dues } = buildStatutoryDues(base({ esi: { members: 0, ready: false, dueDate: '2026-11-15', employeeContribution: 0, employerContribution: 0 }, lwf: { states: [] } }));
    expect(dues.map((d) => d.key)).toEqual(['PF', 'PT']);
  });

  it('carries whether the PF and ESI upload files are ready', () => {
    const { dues } = buildStatutoryDues(base({ pf: { ...base().pf, ready: false } }));
    expect(dues.find((d) => d.key === 'PF')?.fileReady).toBe(false);
    expect(dues.find((d) => d.key === 'PT')?.fileReady).toBeNull();
  });
});
