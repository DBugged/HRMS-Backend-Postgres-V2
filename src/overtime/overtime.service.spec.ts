import { Role } from '@prisma/client';
import {
  OvertimeService,
  getOvertimeRates,
  RATE_MULTIPLIERS,
} from './overtime.service';
import { isOvertimePayEnabled } from './overtime-pay';

type Row = Record<string, any>;

function build(
  opts: {
    overtimePayOn?: boolean;
    attendance?: Row | null;
    records?: Row[];
    runs?: Row[];
    rates?: Row | null;
  } = {},
) {
  const records: Row[] = (opts.records ?? []).map((r) => ({
    organizationId: 'org',
    ...r,
  }));
  const runs: Row[] = (opts.runs ?? []).map((r) => ({ ...r }));
  const audit: Row[] = [];
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
              ...opts.rates,
            },
    },
    organization: { findFirst: async () => ({ policies: {} }) },
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
  return { service, records, runs, audit, notes, prisma };
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
    expect(r).toMatchObject({ type: 'REGULAR', rateMultiplier: 1.5 });
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
    ).rejects.toThrow(/already exists for 2026-10-05 \(status: approved\)/);
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
      REGULAR: 1.5,
      HOLIDAY: 2.5,
      WEEKEND: 2,
      NIGHT: 1.75,
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
