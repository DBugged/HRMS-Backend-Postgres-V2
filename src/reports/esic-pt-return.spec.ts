import { buildEsicRows, esicName } from './esic-return';
import { buildPtReturn, ptDueDate } from './pt-return';

const opts = { daysInMonth: 31, month: 10, year: 2026 };
const m = (o: Partial<Parameters<typeof buildEsicRows>[0][0]> = {}) => ({
  ipNumber: '1234567890',
  name: 'Ravi Kumar',
  payableDays: 31,
  wages: 15000,
  unpaidLeaveDays: 0,
  lastWorkingDay: null,
  ...o,
});

describe('buildEsicRows', () => {
  it('lists days, wages and reason 0 for a member paid for the month', () => {
    const r = buildEsicRows([m()], opts);
    expect(r.rows).toEqual([
      {
        ipNumber: '1234567890',
        name: 'RAVI KUMAR',
        days: 31,
        wages: 15000,
        reasonCode: 0,
        lastWorkingDay: '',
      },
    ]);
    expect(r.issues).toEqual([]);
  });

  it('rounds part days up to a whole number', () => {
    expect(buildEsicRows([m({ payableDays: 26.5 })], opts).rows[0].days).toBe(
      27,
    );
  });

  it('zero days: wages 0 with reason 1 (no wages), 2 (on leave) or 3 (left service)', () => {
    const none = buildEsicRows([m({ payableDays: 0 })], opts).rows[0];
    expect([none.wages, none.reasonCode]).toEqual([0, 1]);
    expect(
      buildEsicRows([m({ payableDays: 0, unpaidLeaveDays: 31 })], opts).rows[0]
        .reasonCode,
    ).toBe(2);
    const left = buildEsicRows(
      [m({ payableDays: 0, lastWorkingDay: '2026-09-30' })],
      opts,
    ).rows[0];
    expect([left.reasonCode, left.lastWorkingDay]).toEqual([3, '30/09/2026']);
  });

  it('a member who left mid-month shows the last working day with their wages', () => {
    const r = buildEsicRows(
      [m({ payableDays: 12, wages: 6000, lastWorkingDay: '2026-10-12' })],
      opts,
    ).rows[0];
    expect([r.days, r.wages, r.reasonCode, r.lastWorkingDay]).toEqual([
      12,
      6000,
      0,
      '12/10/2026',
    ]);
  });

  it('refuses a missing / malformed / duplicate ESIC number', () => {
    const r = buildEsicRows(
      [
        m({ ipNumber: '' }),
        m({ ipNumber: '12345' }),
        m(),
        m({ name: 'Other' }),
      ],
      opts,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toHaveLength(3);
  });

  it('names keep letters and spaces only', () => {
    expect(esicName("A.B. O'Neil-2")).toBe('A B O NEIL');
  });
});

describe('buildPtReturn', () => {
  const mem = (state: string, pt: number, wages = 20000) => ({
    state,
    employeeCode: 'E',
    name: 'N',
    gender: null,
    wages,
    pt,
  });

  it('groups by state with slab-wise head-count and tax', () => {
    const r = buildPtReturn(
      [
        mem('Maharashtra', 200),
        mem('Maharashtra', 200),
        mem('Maharashtra', 175, 9000),
        mem('Maharashtra', 0, 6000),
        mem('Karnataka', 200),
      ],
      10,
      2026,
    );
    const mh = r.states.find((s) => s.state === 'Maharashtra')!;
    expect(mh.employees).toBe(4);
    expect(mh.employeesWithTax).toBe(3);
    expect(mh.totalPt).toBe(575);
    expect(mh.slabs).toEqual([
      { amount: 0, employees: 1, tax: 0 },
      { amount: 175, employees: 1, tax: 175 },
      { amount: 200, employees: 2, tax: 400 },
    ]);
    expect(r.totals.totalPt).toBe(775);
  });

  it('warns about employees without a state', () => {
    const r = buildPtReturn([mem('', 200)], 10, 2026);
    expect(r.states[0].state).toBe('State not set');
    expect(r.warnings).toHaveLength(1);
  });

  it('due dates: published states get a date, others a prompt to confirm', () => {
    expect(ptDueDate('Maharashtra', 10, 2026).date).toBe('2026-11-15');
    expect(ptDueDate('Karnataka', 12, 2026).date).toBe('2027-01-20');
    expect(ptDueDate('Kerala', 10, 2026).date).toBeNull();
  });
});
