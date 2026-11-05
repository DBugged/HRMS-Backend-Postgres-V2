import {
  planStampRepair,
  type RepairLeave,
  type RepairRow,
} from './leave-stamp-repair';

const off = { weeklyOffs: false, holidays: false };
const cal = () => ({
  holidayDates: new Set(['2026-11-10', '2026-11-11']),
  weeklyOffs: [0],
});
const leave = (o: Partial<RepairLeave> = {}): RepairLeave => ({
  id: 'L1',
  employeeId: 'e1',
  startDate: '2026-11-09',
  endDate: '2026-11-12',
  isHalfDay: false,
  kinds: off,
  ...o,
});
const row = (date: string, o: Partial<RepairRow> = {}): RepairRow => ({
  id: 'r' + date.slice(8),
  employeeId: 'e1',
  date,
  status: 'ON_LEAVE',
  source: 'SYSTEM',
  leaveOverriddenStatus: null,
  leaveOverriddenSource: null,
  ...o,
});
const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];

describe('repair: days an approved leave wrongly marked On Leave', () => {
  it('fixes only the two holiday days of 9-12 Nov (sandwich off), not the charged 9th and 12th', () => {
    const out = planStampRepair(
      [leave()],
      cal,
      days.map((d) => row(d)),
    );
    expect(out.map((a) => a.date)).toEqual(['2026-11-10', '2026-11-11']);
  });

  it('puts a day back to what it was, or removes a row the leave created', () => {
    const out = planStampRepair([leave()], cal, [
      row('2026-11-10', {
        leaveOverriddenStatus: 'HOLIDAY',
        leaveOverriddenSource: 'FACE_API',
      }),
      row('2026-11-11'),
    ]);
    expect(out[0]).toMatchObject({
      action: 'RESTORE',
      restoreStatus: 'HOLIDAY',
      restoreSource: 'FACE_API',
    });
    expect(out[1]).toMatchObject({ action: 'DELETE', restoreStatus: null });
  });

  it('leaves everything alone when the sandwich rule takes the holidays in', () => {
    expect(
      planStampRepair(
        [leave({ kinds: { weeklyOffs: false, holidays: true } })],
        cal,
        days.map((d) => row(d)),
      ),
    ).toEqual([]);
  });

  it('a weekly off inside the leave is repaired too (Sunday 15 Nov), unless the weekly-off sandwich is on', () => {
    const l = leave({ startDate: '2026-11-13', endDate: '2026-11-16' });
    const rows = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(
      (d) => row(d),
    );
    expect(planStampRepair([l], cal, rows).map((a) => a.date)).toEqual([
      '2026-11-15',
    ]);
    expect(
      planStampRepair(
        [{ ...l, kinds: { weeklyOffs: true, holidays: false } }],
        cal,
        rows,
      ),
    ).toEqual([]);
  });

  it('keeps the mark on a day another approved leave still charges', () => {
    const other = leave({
      id: 'L2',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      isHalfDay: true,
    });
    expect(planStampRepair([leave(), other], cal, [row('2026-11-10')])).toEqual(
      [],
    );
  });

  it('only touches rows the leave integration wrote: a punched or regularized day is never changed', () => {
    const out = planStampRepair([leave()], cal, [
      row('2026-11-10', { source: 'MANUAL' }),
      row('2026-11-11', { status: 'PRESENT' }),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores half-day leaves and other people', () => {
    expect(
      planStampRepair(
        [leave({ isHalfDay: true, endDate: '2026-11-09' })],
        cal,
        [row('2026-11-09')],
      ),
    ).toEqual([]);
    expect(
      planStampRepair([leave()], cal, [
        row('2026-11-10', { employeeId: 'e2' }),
      ]),
    ).toEqual([]);
  });

  it('leaves alone a leave that was charged for all four days (approved with the sandwich rule on, switched off since)', () => {
    expect(
      planStampRepair(
        [leave({ totalDays: 4 })],
        cal,
        days.map((d) => row(d)),
      ),
    ).toEqual([]);
  });

  it('still repairs a leave charged for exactly the days the rule gives (2)', () => {
    const out = planStampRepair(
      [leave({ totalDays: 2 })],
      cal,
      days.map((d) => row(d)),
    );
    expect(out.map((a) => a.date)).toEqual(['2026-11-10', '2026-11-11']);
  });
});
