import { AttendanceService } from './attendance.service';

const dept = {
  id: 'd1',
  shiftStartTime: '09:00',
  shiftEndTime: '18:00',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 8,
  minHoursForHalfDay: 1,
  breakMinutes: 0,
  weeklyOffs: [0], // Sunday only: Saturdays are working days now
  crossesMidnight: false,
};
const baseRow = {
  organizationId: 'org',
  employeeId: 'e1',
  departmentId: 'd1',
  inTime: null as Date | null,
  outTime: null as Date | null,
  isLate: false,
  isEarlyOut: false,
  workDurationMinutes: 0,
};

function build(rows: Record<string, unknown>[], locked: string[] = []) {
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const prisma = {
    organization: {
      findUnique: async () => ({
        timezone: 'Asia/Kolkata',
        attendancePayrollPrefs: null,
      }),
    },
  };
  const scoped = {
    user: {
      findMany: async () => [
        {
          id: 'e1',
          departmentId: 'd1',
          joiningDate: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    },
    payrollRun: {
      findMany: async () => locked.map((employeeId) => ({ employeeId })),
    },
    department: { findMany: async () => [dept] },
    attendance: {
      findMany: async () => rows,
      updateMany: async (a: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        updates.push({ id: a.where.id, data: a.data });
        return { count: 1 };
      },
    },
    holiday: { findFirst: async () => null },
    leave: { findFirst: async () => null },
  };
  const audit = { log: async () => undefined };
  const service = new AttendanceService(
    scoped as never,
    prisma as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    audit as never,
  );
  return { service, updates };
}

describe('rederiveCurrentMonth', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T08:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('a 4-hour day saved as Absent becomes Half-Day under the new 1-hour minimum', async () => {
    const { service, updates } = build([
      {
        ...baseRow,
        id: 'r2',
        date: '2026-10-02',
        status: 'ABSENT',
        inTime: new Date('2026-10-02T04:00:00Z'),
        outTime: new Date('2026-10-02T08:00:00Z'),
        workDurationMinutes: 240,
      },
    ]);
    const r = await service.rederiveCurrentMonth('org', ['d1'], 'actor');
    expect(r.updated).toBe(1);
    expect(updates[0].data).toMatchObject({
      status: 'HALF_DAY',
      workDurationMinutes: 240,
    });
  });

  it('a Saturday saved as Weekly Off with no punches is Absent now that Saturday is a working day', async () => {
    const { service, updates } = build([
      { ...baseRow, id: 'r3', date: '2026-10-03', status: 'WEEKLY_OFF' },
    ]);
    await service.rederiveCurrentMonth('org', ['d1']);
    expect(updates[0].data).toMatchObject({ status: 'ABSENT' });
  });

  it("leaves today's row alone while nobody has punched, and leaves locked employees alone", async () => {
    const a = build([
      { ...baseRow, id: 'today', date: '2026-10-10', status: 'WEEKLY_OFF' },
    ]);
    expect((await a.service.rederiveCurrentMonth('org', ['d1'])).updated).toBe(
      0,
    );
    const b = build(
      [{ ...baseRow, id: 'r3', date: '2026-10-03', status: 'WEEKLY_OFF' }],
      ['e1'],
    );
    expect((await b.service.rederiveCurrentMonth('org', ['d1'])).updated).toBe(
      0,
    );
  });

  it('does not rewrite a row that already matches', async () => {
    const { service, updates } = build([
      { ...baseRow, id: 'r1', date: '2026-10-04', status: 'WEEKLY_OFF' },
    ]);
    await service.rederiveCurrentMonth('org', ['d1']);
    expect(updates).toHaveLength(0);
  });
});
