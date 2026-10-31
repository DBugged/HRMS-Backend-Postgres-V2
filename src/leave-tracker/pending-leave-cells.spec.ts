import { markPendingLeave } from './pending-leave-cells';

const days = [
  { day: 3, dateStr: '2026-11-03' },
  { day: 4, dateStr: '2026-11-04' },
  { day: 5, dateStr: '2026-11-05' },
  { day: 6, dateStr: '2026-11-06' },
];
const always = () => true;

describe('markPendingLeave', () => {
  it('shows a pending leave as leave instead of Absent or blank, and marks it pending', () => {
    const cells: Record<string, Record<number, string>> = { e1: { 3: 'ABSENT' } };
    const pending = markPendingLeave(
      cells,
      [{ employeeId: 'e1', startDate: '2026-11-03', endDate: '2026-11-04', kind: 'ON_LEAVE' }],
      days,
      always,
    );
    expect(cells.e1[3]).toBe('ON_LEAVE'); // was Absent
    expect(cells.e1[4]).toBe('ON_LEAVE'); // was blank
    expect(pending.e1).toEqual({ 3: true, 4: true });
    expect(cells.e1[5]).toBeUndefined(); // outside the leave
  });

  it('leaves worked days, weekly offs, holidays and approved leave alone', () => {
    const cells: Record<string, Record<number, string>> = {
      e1: { 3: 'PRESENT', 4: 'WEEKLY_OFF', 5: 'HOLIDAY', 6: 'ON_LEAVE' },
    };
    const pending = markPendingLeave(
      cells,
      [{ employeeId: 'e1', startDate: '2026-11-03', endDate: '2026-11-06', kind: 'LWP' }],
      days,
      always,
    );
    expect(cells.e1).toEqual({ 3: 'PRESENT', 4: 'WEEKLY_OFF', 5: 'HOLIDAY', 6: 'ON_LEAVE' });
    expect(pending).toEqual({});
  });

  it('uses the comp-off and LWP kinds, and skips days the person is not employed', () => {
    const cells: Record<string, Record<number, string>> = {};
    const pending = markPendingLeave(
      cells,
      [
        { employeeId: 'e1', startDate: '2026-11-03', endDate: '2026-11-03', kind: 'COMP_OFF' },
        { employeeId: 'e2', startDate: '2026-11-03', endDate: '2026-11-04', kind: 'LWP' },
      ],
      days,
      (id, date) => !(id === 'e2' && date === '2026-11-03'),
    );
    expect(cells.e1[3]).toBe('COMP_OFF');
    expect(cells.e2[3]).toBeUndefined();
    expect(cells.e2[4]).toBe('LWP');
    expect(pending.e2).toEqual({ 4: true });
  });
});
