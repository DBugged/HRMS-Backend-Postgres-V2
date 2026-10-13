import { AttendanceService } from './attendance.service';

// deriveDayOutcome is private and reads only what it is given (db, params); build the service without its other
// dependencies.
const service = Object.create(AttendanceService.prototype) as unknown as {
  deriveDayOutcome(
    db: unknown,
    params: Record<string, unknown>,
  ): Promise<{
    status: string;
    workDurationMinutes: number;
    isLate: boolean;
    isEarlyOut: boolean;
  }>;
};

const shift = {
  shiftStartTime: '09:00',
  shiftEndTime: '18:00',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 8,
  minHoursForHalfDay: 4,
  breakMinutes: 0,
  weeklyOffs: [0],
  crossesMidnight: false,
  timezone: 'Asia/Kolkata',
};

const db = {
  holiday: { findFirst: async () => null },
  leave: { findFirst: async () => null },
};

const derive = (over: Record<string, unknown>) =>
  service.deriveDayOutcome(db, {
    organizationId: 'org',
    employeeId: 'e1',
    employeeDepartmentId: null,
    shiftConfig: shift,
    holiday: null,
    approvedLeave: null,
    ...over,
  });

afterEach(() => jest.useRealTimers());

describe('a punch-in with the shift still running', () => {
  // Tuesday 2026-10-13, 09:05 IST = 03:35 UTC; the shift ends 18:00 IST.
  const inTime = new Date('2026-10-13T03:35:00Z');

  it('is Present (in progress), not Absent - so no "Marked Absent" notice or email', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T03:40:00Z'));
    const r = await derive({ dateStr: '2026-10-13', inTime, outTime: null });
    expect(r.status).toBe('PRESENT');
    expect(r.workDurationMinutes).toBe(0);
    expect(r.isLate).toBe(false);
  });

  it('is still marked late when the punch-in was after the grace period', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T04:30:00Z'));
    const r = await derive({
      dateStr: '2026-10-13',
      inTime: new Date('2026-10-13T04:00:00Z'), // 09:30 IST
      outTime: null,
    });
    expect(r).toMatchObject({ status: 'PRESENT', isLate: true });
  });

  it('becomes Incomplete once the shift is over with no punch-out', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T13:00:00Z')); // 18:30 IST
    const r = await derive({ dateStr: '2026-10-13', inTime, outTime: null });
    expect(r.status).toBe('INCOMPLETE');
  });

  it('a stray punch on a weekly off is still a day off', async () => {
    // Sunday 2026-10-11
    jest.useFakeTimers().setSystemTime(new Date('2026-10-11T04:00:00Z'));
    const r = await derive({
      dateStr: '2026-10-11',
      inTime: new Date('2026-10-11T03:35:00Z'),
      outTime: null,
    });
    expect(r.status).toBe('WEEKLY_OFF');
  });

  it('a completed short day is judged on its hours as before (punch-in and out 10 minutes apart = Absent)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T05:00:00Z'));
    const r = await derive({
      dateStr: '2026-10-13',
      inTime,
      outTime: new Date('2026-10-13T03:45:00Z'),
    });
    expect(r.status).toBe('ABSENT');
  });
});
