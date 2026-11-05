import { AttendanceService } from './attendance.service';
import { chargedDatesInclusive } from '../leaves/leave-rules';

// Approving a leave marks only the days it is charged for as On Leave: a holiday inside 9-12 Nov (10th and 11th) keeps its own
// status when the leave type's sandwich rule is off, instead of showing four days of leave.
describe('approving a leave: which days are marked On Leave', () => {
  const holidays = new Set(['2026-11-10', '2026-11-11']);

  it('sandwich rule off: the 9th and 12th only', () => {
    expect(
      chargedDatesInclusive('2026-11-09', '2026-11-12', holidays, [0], {
        weeklyOffs: false,
        holidays: false,
      }),
    ).toEqual(['2026-11-09', '2026-11-12']);
  });

  it('holiday sandwich on: all four days; weekly-off sandwich only does not take in the holidays', () => {
    expect(
      chargedDatesInclusive('2026-11-09', '2026-11-12', holidays, [0], {
        weeklyOffs: false,
        holidays: true,
      }),
    ).toHaveLength(4);
    expect(
      chargedDatesInclusive('2026-11-09', '2026-11-12', holidays, [0], {
        weeklyOffs: true,
        holidays: false,
      }),
    ).toEqual(['2026-11-09', '2026-11-12']);
  });

  it('a weekly off inside the leave is left out unless the weekly-off sandwich is on (Sunday 15 Nov)', () => {
    expect(
      chargedDatesInclusive('2026-11-13', '2026-11-16', new Set(), [0], {
        weeklyOffs: false,
        holidays: false,
      }),
    ).toEqual(['2026-11-13', '2026-11-14', '2026-11-16']);
  });

  it('the attendance write creates rows for just the dates it is given', async () => {
    const created: { date: string; status: string }[] = [];
    const tx = {
      attendance: {
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
        createMany: async (a: { data: { date: string; status: string }[] }) => {
          created.push(...a.data);
          return { count: a.data.length };
        },
      },
    };
    const svc = Object.create(AttendanceService.prototype) as AttendanceService;
    const leave = {
      employeeId: 'e1',
      startDate: '2026-11-09',
      endDate: '2026-11-12',
      isHalfDay: false,
    };
    await svc.writeAttendanceForApprovedLeave(
      tx as never,
      leave as never,
      'org',
      ['2026-11-09', '2026-11-12'],
    );
    expect(created.map((r) => r.date)).toEqual(['2026-11-09', '2026-11-12']);
    expect(created.every((r) => r.status === 'ON_LEAVE')).toBe(true);
    // Without a list it keeps writing every date, as before.
    created.length = 0;
    await svc.writeAttendanceForApprovedLeave(
      tx as never,
      leave as never,
      'org',
    );
    expect(created).toHaveLength(4);
  });
});
