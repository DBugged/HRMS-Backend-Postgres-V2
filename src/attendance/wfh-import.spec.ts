import { AttendanceService } from './attendance.service';

type Row = Record<string, any>;

// In-memory tables behind the calls importWfh() makes. Sundays are the weekly off; 2026-10-04 is a Sunday.
function build(
  o: {
    attendance?: Row[];
    leaves?: Row[];
    holidays?: Row[];
    lockedRuns?: Row[];
    employees?: Row[];
  } = {},
) {
  const attendance: Row[] = (o.attendance ?? []).map((r) => ({
    organizationId: 'org',
    ...r,
  }));
  const employees = o.employees ?? [
    {
      id: 'e1',
      employeeId: 'DP-00004',
      name: 'Asha',
      role: 'EMPLOYEE',
      departmentId: null,
      department: null,
      joiningDate: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 'h1',
      employeeId: 'DP-00002',
      name: 'Hari HR',
      role: 'HR',
      departmentId: null,
      department: null,
      joiningDate: new Date('2026-01-01T00:00:00Z'),
    },
  ];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR' || k === 'AND') return true;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const c = v as Row;
        if ('gte' in c && !(r[k] >= c.gte)) return false;
        if ('lte' in c && !(r[k] <= c.lte)) return false;
        if ('in' in c && !c.in.includes(r[k])) return false;
        return true;
      }
      return r[k] === v;
    });
  const events: Row[] = [];
  const audit: Row[] = [];
  const prisma: Row = {
    organization: {
      findFirst: async () => ({
        id: 'org',
        timezone: 'Asia/Kolkata',
        enableWFH: true,
        attendancePayrollPrefs: { weeklyOffs: [0] },
      }),
    },
    user: {
      findMany: async () => employees,
      findFirst: async (a: { where: Row }) =>
        employees.find((e) => e.id === a.where.id) ?? null,
    },
    holiday: { findMany: async () => o.holidays ?? [] },
    leave: { findMany: async () => o.leaves ?? [] },
    attendance: {
      findMany: async (a: { where: Row }) =>
        attendance.filter((r) => match(r, a.where)),
      findFirst: async (a: { where: Row }) =>
        attendance.find((r) => match(r, a.where)) ?? null,
      create: async (a: { data: Row }) => {
        attendance.push({ id: `a${attendance.length + 1}`, ...a.data });
        return a.data;
      },
      updateMany: async (a: { where: Row; data: Row }) => {
        attendance
          .filter((r) => match(r, a.where))
          .forEach((r) => Object.assign(r, a.data));
        return { count: 1 };
      },
    },
    payrollRun: {
      findFirst: async () => (o.lockedRuns ?? [])[0] ?? null,
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: (tx: Row) => unknown) => fn(prisma),
  };
  const service = Object.create(
    AttendanceService.prototype,
  ) as AttendanceService;
  Object.assign(service as unknown as Row, {
    scopedPrisma: prisma,
    timelineService: { logEvent: async (e: Row) => events.push(e) },
    auditLogService: { log: async (e: Row) => audit.push(e) },
  });
  return { service, attendance, events, audit };
}

const admin = { id: 'a1', role: 'ADMIN' } as never;
const hr = { id: 'h2', role: 'HR' } as never;
const row = (over: Row = {}) => ({
  employeeId: 'DP-00004',
  fromDate: '2026-10-05',
  toDate: '2026-10-07',
  reason: 'Migrated',
  ...over,
});

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-10-21T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('WFH import: checking', () => {
  it('a check run says what it would record and writes nothing', async () => {
    const { service, attendance } = build();
    const r = await service.importWfh({ rows: [row()] } as never, admin, 'org');
    expect(r).toMatchObject({ dryRun: true, ok: 1, imported: 0, failed: 0 });
    expect(r.rows[0]).toMatchObject({
      status: 'OK',
      days: 3,
      employeeName: 'Asha',
    });
    expect(attendance).toHaveLength(0);
  });

  it('weekly offs inside the range are left out and the row says so', async () => {
    const { service } = build();
    // Fri 2 - Mon 5 Oct: Saturday works, Sunday the 4th is the weekly off.
    const r = await service.importWfh(
      {
        rows: [row({ fromDate: '2026-10-02', toDate: '2026-10-05' })],
      } as never,
      admin,
      'org',
    );
    expect(r.rows[0].days).toBe(3);
    expect(r.rows[0].message).toMatch(/1 other day\(s\)/);
  });

  it('refuses bad rows with a message each: unknown employee, bad date, reversed, future, before joining, too long', async () => {
    const { service } = build();
    const r = await service.importWfh(
      {
        rows: [
          row({ employeeId: 'NOPE' }),
          row({ fromDate: 'x' }),
          row({ fromDate: '2026-10-07', toDate: '2026-10-05' }),
          row({ fromDate: '2026-10-20', toDate: '2026-10-22' }),
          row({ fromDate: '2025-12-30', toDate: '2025-12-31' }),
          row({ fromDate: '2026-01-05', toDate: '2026-03-30' }),
        ],
      } as never,
      admin,
      'org',
    );
    expect(r.rows.map((x) => x.message)).toEqual([
      'Unknown employee ID.',
      'From and To must be real dates (YYYY-MM-DD).',
      'To cannot be before From.',
      expect.stringMatching(/Only past days/),
      expect.stringMatching(/before the employee's joining date/),
      expect.stringMatching(/at most 31 days/),
    ]);
    expect(r.failed).toBe(6);
  });

  it('holidays, leave and days that already have Work From Home are not recorded again', async () => {
    const { service } = build({
      holidays: [{ date: '2026-10-05' }],
      leaves: [{ startDate: '2026-10-06', endDate: '2026-10-06' }],
      attendance: [
        {
          employeeId: 'e1',
          date: '2026-10-07',
          workArrangement: 'WFH',
          workArrangementStatus: 'APPROVED',
        },
      ],
    });
    const r = await service.importWfh({ rows: [row()] } as never, admin, 'org');
    expect(r.rows[0].status).toBe('ERROR');
    expect(r.rows[0].message).toMatch(/no working day to record/);
  });

  it('a day given twice in the same file is recorded once; a row that is only repeats is refused', async () => {
    const { service } = build();
    const r = await service.importWfh(
      {
        rows: [
          row({ fromDate: '2026-10-05', toDate: '2026-10-06' }),
          row({ fromDate: '2026-10-06', toDate: '2026-10-07' }),
          row({ fromDate: '2026-10-05', toDate: '2026-10-06' }),
        ],
      } as never,
      admin,
      'org',
    );
    expect(r.rows.map((x) => [x.status, x.days])).toEqual([
      ['OK', 2],
      ['OK', 1],
      ['ERROR', undefined],
    ]);
    expect(r.rows[2].message).toMatch(/already given by an earlier row/);
  });

  it('a month whose payroll is already locked is refused', async () => {
    const { service } = build({
      lockedRuns: [{ month: 10, year: 2026, status: 'LOCKED' }],
    });
    const r = await service.importWfh({ rows: [row()] } as never, admin, 'org');
    expect(r.rows[0].message).toMatch(/10\/2026 payroll period.*locked/);
  });

  it('only an Admin can import for an HR or Admin employee', async () => {
    const { service } = build();
    const forHr = row({ employeeId: 'DP-00002' });
    const byHr = await service.importWfh({ rows: [forHr] } as never, hr, 'org');
    expect(byHr.rows[0].message).toMatch(/Only an Admin/);
    const byAdmin = await service.importWfh(
      { rows: [forHr] } as never,
      admin,
      'org',
    );
    expect(byAdmin.rows[0].status).toBe('OK');
  });
});

describe('WFH import: recording', () => {
  it('records approved, Present days approved by the importer, one request id for the row', async () => {
    const { service, attendance, events, audit } = build();
    const r = await service.importWfh(
      { dryRun: false, rows: [row()] } as never,
      admin,
      'org',
    );
    expect(r).toMatchObject({ dryRun: false, imported: 1, failed: 0 });
    expect(attendance.map((a) => a.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    for (const a of attendance) {
      expect(a).toMatchObject({
        status: 'PRESENT',
        source: 'EXCEL_IMPORT',
        workArrangement: 'WFH',
        workArrangementStatus: 'APPROVED',
        workArrangementReviewedById: 'a1',
        workArrangementReviewComments: 'Imported: Migrated',
      });
    }
    expect(new Set(attendance.map((a) => a.wfhRequestId)).size).toBe(1);
    expect(attendance[0].wfhRequestId).toBeTruthy();
    expect(events[0]).toMatchObject({
      eventKey: 'WFH_APPROVED',
      performedById: 'a1',
    });
    expect(audit.map((a) => a.action)).toEqual([
      'WFH_IMPORTED',
      'WFH_IMPORT_RUN',
    ]);
  });

  it('a single day has no request id; an Absent day becomes Present, a day with real punches keeps them', async () => {
    const { service, attendance } = build({
      attendance: [
        {
          id: 'x1',
          employeeId: 'e1',
          date: '2026-10-05',
          status: 'ABSENT',
          source: 'SYSTEM',
        },
        {
          id: 'x2',
          employeeId: 'e1',
          date: '2026-10-06',
          status: 'PRESENT',
          source: 'FACE_API',
        },
        {
          id: 'x3',
          employeeId: 'e1',
          date: '2026-10-07',
          status: 'HALF_DAY',
          source: 'FACE_API',
        },
      ],
    });
    await service.importWfh(
      {
        dryRun: false,
        rows: [row({ fromDate: '2026-10-05', toDate: '2026-10-07' })],
      } as never,
      admin,
      'org',
    );
    const by = (d: string) => attendance.find((a) => a.date === d)!;
    expect(by('2026-10-05')).toMatchObject({
      status: 'PRESENT',
      source: 'EXCEL_IMPORT',
    });
    expect(by('2026-10-06')).toMatchObject({
      status: 'PRESENT',
      source: 'FACE_API',
      workArrangementStatus: 'APPROVED',
    });
    expect(by('2026-10-07')).toMatchObject({
      status: 'HALF_DAY',
      source: 'FACE_API',
    });

    const single = build();
    await single.service.importWfh(
      {
        dryRun: false,
        rows: [row({ fromDate: '2026-10-05', toDate: '2026-10-05' })],
      } as never,
      admin,
      'org',
    );
    expect(single.attendance[0].wfhRequestId).toBeNull();
  });
});
