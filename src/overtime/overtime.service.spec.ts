import { Role } from '@prisma/client';
import {
  OvertimeService,
  getOvertimeRates,
  RATE_MULTIPLIERS,
} from './overtime.service';
import { isOvertimePayEnabled } from './overtime-pay';

// The calendar/punch rules have their own spec (overtime-day-rules.spec.ts); here they are stubbed so these tests stay about logging.
jest.mock('./overtime-day-rules', () => ({
  overtimeDayProblem: jest.fn(() => null),
}));
import { overtimeDayProblem } from './overtime-day-rules';

type Row = Record<string, any>;

const CONFIGURED_OPTIONS = [
  { key: 'COMP_OFF', label: 'Comp-off (1 day)', compOffDays: 1, payDays: 0 },
  { key: 'PAY_1', label: '1 day pay', compOffDays: 0, payDays: 1 },
  { key: 'PAY_2', label: '2 days pay', compOffDays: 0, payDays: 2 },
  { key: 'COMP_OFF_PAY_1', label: 'Comp-off + 1 day pay', compOffDays: 1, payDays: 1 },
  { key: 'COMP_OFF_PAY_2', label: 'Comp-off + 2 days pay', compOffDays: 1, payDays: 2 },
];

function build(
  opts: {
    overtimePayOn?: boolean;
    attendance?: Row | null;
    records?: Row[];
    runs?: Row[];
    rates?: Row | null;
    compOffClaimed?: boolean;
    workCompensation?: Row;
  } = {},
) {
  const records: Row[] = (opts.records ?? []).map((r) => ({
    organizationId: 'org',
    ...r,
  }));
  const runs: Row[] = (opts.runs ?? []).map((r) => ({ ...r }));
  const audit: Row[] = [];
  const compOffs: Row[] = [];
  const notes: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId' || k === 'OR') return true;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return v === undefined || r[k] === v;
    });
  const prisma: Row = {
    salaryComponent: {
      count: async () => (opts.overtimePayOn === false ? 0 : 1),
    },
    attendance: {
      findFirst: async () =>
        opts.attendance === undefined ? null : opts.attendance,
    },
    payrollSettings: {
      findFirst: async () =>
        opts.rates === null
          ? null
          : {
              otRegularRate: 1.5,
              otHolidayRate: 2.5,
              otWeekendRate: 2,
              otNightRate: 1.75,
              compOffExpiryDays: 90,
              // A configured list: the built-in options start at 0 / 0 and are not offered until set, so these
              // tests state the shapes they approve with.
              workCompensation: { options: CONFIGURED_OPTIONS, ...(opts.workCompensation ?? {}) },
              ...opts.rates,
            },
    },
    organization: {
      findFirst: async () => ({
        policies: {},
        attendancePayrollPrefs: null,
        timezone: 'Asia/Kolkata',
      }),
    },
    holiday: { findFirst: async () => null },
    compOff: {
      findFirst: async () => (opts.compOffClaimed ? { id: 'co0' } : null),
      create: async (a: Row) => {
        const row = { id: `co${compOffs.length + 1}`, ...a.data };
        compOffs.push(row);
        return row;
      },
    },
    user: {
      findFirst: async () => ({
        id: 'e1',
        name: 'Asha',
        email: 'a@x.com',
        departmentId: 'd1',
      }),
    },
    overtimeRecord: {
      findFirst: async (a: Row) => {
        const r = records.find((x) => match(x, a?.where));
        return r ? { ...r } : null;
      },
      findFirstOrThrow: async (a: Row) => ({
        ...records.find((x) => match(x, a?.where))!,
      }),
      create: async (a: Row) => {
        const row = {
          id: `ot${records.length + 1}`,
          status: 'PENDING',
          organizationId: 'org',
          ...a.data,
        };
        records.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = records.filter((r) => match(r, a.where));
        hits.forEach((r) => Object.assign(r, a.data));
        return { count: hits.length };
      },
    },
    payrollRun: {
      findFirst: async (a: Row) =>
        runs.find((r) => a.where.status.in.includes(r.status)) ?? null,
      updateMany: async (a: Row) => {
        const hits = runs.filter((r) => a.where.status.in.includes(r.status));
        hits.forEach((r) => Object.assign(r, a.data));
        return { count: hits.length };
      },
    },
  };
  prisma.$transaction = async (fn: (tx: Row) => unknown) => fn(prisma);
  const stub = <T>(x: T) => x as never;
  const service = new OvertimeService(
    stub(prisma),
    stub({
      create: async (n: Row) => notes.push(n),
      notifyReviewers: async (n: Row) => notes.push(n),
    }),
    stub({ send: async () => undefined }),
    stub({ isActiveDelegate: async () => false }),
    stub({
      log: async (e: Row) => audit.push(e),
      logSelfApproval: async () => undefined,
    }),
    stub({ logEvent: async () => undefined }),
    stub({ renderOccasion: async () => ({ subject: 's', html: 'h' }) }),
  );
  return { service, records, runs, audit, notes, prisma, compOffs };
}

const emp = {
  id: 'e1',
  role: Role.EMPLOYEE,
  name: 'Asha',
  departmentId: 'd1',
} as never;
const hr = {
  id: 'hr1',
  role: Role.HR,
  name: 'HR',
  departmentId: null,
} as never;

describe('overtime: logging', () => {
  it('logs pending overtime with the organisation rate for its type', async () => {
    const { service, records } = build();
    const r = await service.log(
      { date: '2026-10-05', hours: 2, type: 'HOLIDAY' } as never,
      emp,
      'org',
    );
    expect(r).toMatchObject({
      status: 'PENDING',
      hours: 2,
      type: 'HOLIDAY',
      rateMultiplier: 2.5,
      employeeId: 'e1',
    });
    expect(records).toHaveLength(1);
  });

  it('defaults to regular overtime at its own rate', async () => {
    const { service } = build();
    const r = await service.log(
      { date: '2026-10-05', hours: 1 } as never,
      emp,
      'org',
    );
    expect(r).toMatchObject({ type: 'REGULAR', rateMultiplier: 2 });
  });

  it('is refused while the Overtime Pay component is off', async () => {
    const { service } = build({ overtimePayOn: false });
    await expect(
      service.log({ date: '2026-10-05', hours: 1 } as never, emp, 'org'),
    ).rejects.toThrow(/Overtime Pay is turned off/);
  });

  it('regular overtime cannot be logged for a day marked absent, on leave or incomplete', async () => {
    for (const status of ['ABSENT', 'ON_LEAVE', 'INCOMPLETE']) {
      const { service } = build({ attendance: { status } });
      await expect(
        service.log(
          { date: '2026-10-05', hours: 1, type: 'REGULAR' } as never,
          emp,
          'org',
        ),
      ).rejects.toThrow(/Cannot log regular overtime/);
    }
  });

  it('holiday and weekend overtime are exempt from that check, as is a day with no attendance row', async () => {
    const holiday = build({ attendance: { status: 'HOLIDAY' } });
    await expect(
      holiday.service.log(
        { date: '2026-10-02', hours: 3, type: 'HOLIDAY' } as never,
        emp,
        'org',
      ),
    ).resolves.toBeTruthy();
    const weekend = build({ attendance: { status: 'WEEKLY_OFF' } });
    await expect(
      weekend.service.log(
        { date: '2026-10-04', hours: 3, type: 'WEEKEND' } as never,
        emp,
        'org',
      ),
    ).resolves.toBeTruthy();
    const none = build({ attendance: null });
    await expect(
      none.service.log({ date: '2026-10-05', hours: 1 } as never, emp, 'org'),
    ).resolves.toBeTruthy();
  });

  it('only one overtime record per employee per day, whatever its source', async () => {
    const { service } = build({
      records: [
        { id: 'x', employeeId: 'e1', date: '2026-10-05', status: 'APPROVED' },
      ],
    });
    await expect(
      service.log({ date: '2026-10-05', hours: 1 } as never, emp, 'org'),
    ).rejects.toThrow(/already exists for 05-10-2026 \(status: approved\)/);
  });

  it('is refused when the calendar/punch rules reject the day, and nothing is saved', async () => {
    (overtimeDayProblem as jest.Mock).mockReturnValueOnce(
      '2026-10-07 is a working day.',
    );
    const { service, records } = build();
    await expect(
      service.log(
        { date: '2026-10-07', hours: 2, type: 'WEEKEND' } as never,
        emp,
        'org',
      ),
    ).rejects.toThrow('working day');
    expect(records).toHaveLength(0);
  });

  it('tells the reviewers and is audited', async () => {
    const { service, audit, notes } = build();
    await service.log({ date: '2026-10-05', hours: 2 } as never, emp, 'org');
    expect(audit.at(-1)).toMatchObject({
      action: 'OVERTIME_LOGGED',
      details: { hours: 2, type: 'REGULAR' },
    });
    expect(notes[0].title).toBe('Overtime Requested');
  });
});

describe('overtime: rates and the pay switch', () => {
  it('rates come from payroll settings, and fall back to the standard ones when there are none', async () => {
    const { prisma } = build();
    expect(await getOvertimeRates(prisma as never, 'org')).toEqual({
      REGULAR: 2, // a stored 1.5 is raised to the legal minimum
      HOLIDAY: 2.5,
      WEEKEND: 2,
      NIGHT: 2, // a stored 1.75 is raised to the legal minimum
    });
    const none = build({ rates: null });
    expect(await getOvertimeRates(none.prisma as never, 'org')).toEqual(
      RATE_MULTIPLIERS,
    );
  });

  it('overtime is "on" exactly when the Overtime Pay component is active', async () => {
    expect(await isOvertimePayEnabled(build().prisma as never, 'org')).toBe(
      true,
    );
    expect(
      await isOvertimePayEnabled(
        build({ overtimePayOn: false }).prisma as never,
        'org',
      ),
    ).toBe(false);
  });
});

describe('overtime: review', () => {
  const pending = (over: Row = {}) => ({
    id: 'ot1',
    employeeId: 'e1',
    date: '2026-10-05',
    hours: 2,
    status: 'PENDING',
    ...over,
  });

  it('approving records who approved and tells the employee', async () => {
    const { service, records, notes } = build({ records: [pending()] });
    await service.review('ot1', { status: 'APPROVED' } as never, hr, 'org');
    expect(records[0]).toMatchObject({
      status: 'APPROVED',
      approvedById: 'hr1',
    });
    expect(notes.at(-1)?.title).toBe('Overtime Request APPROVED');
  });

  it('approving sends a signed-off payroll for that month back to Calculated so it picks the overtime up', async () => {
    const { service, runs } = build({
      records: [pending()],
      runs: [
        { id: 'r1', status: 'APPROVED' },
        { id: 'r2', status: 'VERIFIED' },
      ],
    });
    await service.review('ot1', { status: 'APPROVED' } as never, hr, 'org');
    expect(runs.map((r) => r.status)).toEqual(['CALCULATED', 'CALCULATED']);
  });

  describe('weekend/holiday compensation', () => {
    const weekend = () => pending({ type: 'WEEKEND', date: '2026-10-11' });

    it('stays on the hourly rate when no option is chosen and no default is set', async () => {
      const { service, records, compOffs } = build({ records: [weekend()] });
      await service.review('ot1', { status: 'APPROVED' } as never, hr, 'org');
      expect(records[0].compensationKey).toBeUndefined();
      expect(compOffs).toHaveLength(0);
    });

    it('2 days pay: stores the pay days, no comp-off', async () => {
      const { service, records, compOffs } = build({ records: [weekend()] });
      await service.review(
        'ot1',
        { status: 'APPROVED', compensationKey: 'PAY_2' } as never,
        hr,
        'org',
      );
      expect(records[0]).toMatchObject({
        compensationKey: 'PAY_2',
        payDays: 2,
        compOffDays: 0,
      });
      expect(compOffs).toHaveLength(0);
    });

    it('comp-off + 1 day pay: stores both and adds an approved comp-off with an expiry', async () => {
      const { service, records, compOffs } = build({ records: [weekend()] });
      await service.review(
        'ot1',
        { status: 'APPROVED', compensationKey: 'COMP_OFF_PAY_1' } as never,
        hr,
        'org',
      );
      expect(records[0]).toMatchObject({
        payDays: 1,
        compOffDays: 1,
        compOffId: 'co1',
      });
      expect(compOffs[0]).toMatchObject({
        employeeId: 'e1',
        earnedForDate: '2026-10-11',
        daysEarned: 1,
        status: 'APPROVED',
        expiryDate: '2027-01-09',
      });
    });

    it('uses the organisation default when the approver picks nothing', async () => {
      const { service, records } = build({
        records: [weekend()],
        workCompensation: { defaultKey: 'PAY_1' },
      });
      await service.review('ot1', { status: 'APPROVED' } as never, hr, 'org');
      expect(records[0]).toMatchObject({
        compensationKey: 'PAY_1',
        payDays: 1,
      });
    });

    it('refuses an unknown option, an option on ordinary overtime, and an option on a rejection', async () => {
      const a = build({ records: [weekend()] });
      await expect(
        a.service.review(
          'ot1',
          { status: 'APPROVED', compensationKey: 'NOPE' } as never,
          hr,
          'org',
        ),
      ).rejects.toThrow(/not available/);
      const b = build({ records: [pending({ type: 'REGULAR' })] });
      await expect(
        b.service.review(
          'ot1',
          { status: 'APPROVED', compensationKey: 'PAY_1' } as never,
          hr,
          'org',
        ),
      ).rejects.toThrow(/only to weekend and holiday/);
      const c = build({ records: [weekend()] });
      await expect(
        c.service.review(
          'ot1',
          { status: 'REJECTED', compensationKey: 'PAY_1' } as never,
          hr,
          'org',
        ),
      ).rejects.toThrow(/only be chosen when approving/);
    });

    it('will not approve a day that already has a comp-off claim', async () => {
      const { service, records } = build({
        records: [weekend()],
        compOffClaimed: true,
      });
      await expect(
        service.review(
          'ot1',
          { status: 'APPROVED', compensationKey: 'PAY_1' } as never,
          hr,
          'org',
        ),
      ).rejects.toThrow(/comp-off was already claimed/);
      expect(records[0].status).toBe('PENDING');
    });

    it('logging weekend overtime is refused when the day already has a comp-off claim', async () => {
      const { service } = build({ compOffClaimed: true });
      await expect(
        service.log(
          { date: '2026-10-11', hours: 2, type: 'WEEKEND' } as never,
          emp,
          'org',
        ),
      ).rejects.toThrow(/comp-off was already claimed/);
    });
  });

  it('rejecting leaves payroll alone', async () => {
    const { service, runs } = build({
      records: [pending()],
      runs: [{ id: 'r1', status: 'APPROVED' }],
    });
    await service.review('ot1', { status: 'REJECTED' } as never, hr, 'org');
    expect(runs[0].status).toBe('APPROVED');
  });

  it('a month that is already locked or paid cannot have overtime reviewed into it', async () => {
    const { service, records } = build({
      records: [pending()],
      runs: [{ id: 'r1', status: 'LOCKED', month: 10, year: 2026 }],
    });
    await expect(
      service.review('ot1', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/10\/2026 payroll period, which is already locked/);
    expect(records[0].status).toBe('PENDING');
  });

  it('it can be reviewed only once', async () => {
    const { service } = build({ records: [pending({ status: 'APPROVED' })] });
    await expect(
      service.review('ot1', { status: 'REJECTED' } as never, hr, 'org'),
    ).rejects.toThrow(/already been reviewed/);
  });

  it('an unknown record is not found; HR cannot review their own overtime', async () => {
    const none = build();
    await expect(
      none.service.review('ghost', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/not found/);
    const own = build({ records: [pending({ employeeId: 'hr1' })] });
    await expect(
      own.service.review('ot1', { status: 'APPROVED' } as never, hr, 'org'),
    ).rejects.toThrow(/own request/);
  });
});
