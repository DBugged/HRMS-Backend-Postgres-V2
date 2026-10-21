import { TdsComplianceService } from './tds-compliance.service';

type Row = Record<string, any>;

// An in-memory challan table and statement table behind the same calls the service makes.
function build(
  o: {
    challans?: Row[];
    statements?: Row[];
    org?: Row;
    runs?: Row[];
    employeePan?: string;
  } = {},
) {
  const challans: Row[] = (o.challans ?? []).map((c) => ({
    organizationId: 'org',
    ...c,
  }));
  const statements: Row[] = o.statements ?? [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) =>
      v && typeof v === 'object' && 'not' in (v as Row)
        ? r[k] !== (v as Row).not
        : r[k] === v,
    );
  const audit: Row[] = [];
  const prisma: Row = {
    organization: {
      findFirst: async () => ({ timezone: 'Asia/Kolkata', ...o.org }),
    },
    payrollRun: { findMany: async () => o.runs ?? [] },
    user: {
      findMany: async () => [
        { id: 'e1', personalData: { panNumber: o.employeePan ?? '' } },
      ],
    },
    tdsStatement: {
      findFirst: async (a: { where: Row }) =>
        statements.find((s) => match(s, a.where)) ?? null,
    },
    tdsChallan: {
      findFirst: async (a: { where: Row }) =>
        challans.find((c) => match(c, a.where)) ?? null,
      findFirstOrThrow: async (a: { where: Row }) => {
        const found = challans.find((c) => match(c, a.where));
        if (!found) throw new Error('not found');
        return found;
      },
      create: async (a: { data: Row }) => {
        const row = { id: `c${challans.length + 1}`, ...a.data };
        challans.push(row);
        return row;
      },
      updateMany: async (a: { where: Row; data: Row }) => {
        challans
          .filter((c) => match(c, a.where))
          .forEach((c) => Object.assign(c, a.data));
        return { count: 1 };
      },
      deleteMany: async (a: { where: Row }) => {
        const keep = challans.filter((c) => !match(c, a.where));
        challans.splice(0, challans.length, ...keep);
        return { count: 1 };
      },
    },
  };
  const service = new TdsComplianceService(
    prisma as never,
    {
      log: async (e: Row) => {
        audit.push(e);
      },
    } as never,
  );
  return { service, challans };
}

const actor = { id: 'hr', role: 'HR' } as never;
const dto = (over: Row = {}) =>
  ({
    month: 10,
    year: 2026,
    bsrCode: '0510308',
    challanSerialNo: '00123',
    depositDate: '2026-11-06',
    tdsAmount: 5000,
    ...over,
  }) as never;
const filedQ3 = [
  {
    financialYear: '2026-27',
    quarter: 3,
    receiptNumber: 'ACK-1',
    organizationId: 'org',
  },
];

beforeEach(() =>
  jest.useFakeTimers().setSystemTime(new Date('2026-11-10T08:00:00Z')),
);
afterEach(() => jest.useRealTimers());

describe('TDS challans: adding', () => {
  it('records a challan deposited on or before today', async () => {
    const { service, challans } = build();
    await service.createChallan(dto(), actor, 'org');
    expect(challans).toHaveLength(1);
    await service.createChallan(
      dto({ challanSerialNo: '00124', depositDate: '2026-11-10' }),
      actor,
      'org',
    );
    expect(challans).toHaveLength(2);
  });

  it('refuses a deposit date that has not come yet', async () => {
    const { service, challans } = build();
    await expect(
      service.createChallan(dto({ depositDate: '2026-11-11' }), actor, 'org'),
    ).rejects.toThrow(/cannot be in the future/);
    expect(challans).toHaveLength(0);
  });

  it('refuses a challan for a quarter whose statement is already filed', async () => {
    const { service, challans } = build({ statements: filedQ3 });
    await expect(service.createChallan(dto(), actor, 'org')).rejects.toThrow(
      /Q3 statement for FY 2026-27 is already filed.*ACK-1.*added/,
    );
    expect(challans).toHaveLength(0);
  });

  it('still accepts a challan for a quarter that is not filed', async () => {
    const { service } = build({ statements: filedQ3 });
    // July is Q2 of the same tax year.
    await expect(
      service.createChallan(
        dto({ month: 7, depositDate: '2026-08-05' }),
        actor,
        'org',
      ),
    ).resolves.toBeDefined();
  });

  it('refuses the same BSR code, serial number and deposit date twice', async () => {
    const { service } = build();
    await service.createChallan(dto(), actor, 'org');
    await expect(service.createChallan(dto(), actor, 'org')).rejects.toThrow(
      /already recorded/,
    );
  });
});

describe('TDS challans: editing', () => {
  const existing = (over: Row = {}) => ({
    id: 'c1',
    month: 10,
    year: 2026,
    financialYear: '2026-27',
    quarter: 3,
    bsrCode: '0510308',
    challanSerialNo: '00123',
    depositDate: '2026-11-06',
    tdsAmount: 5000,
    ...over,
  });

  it('changes an open challan', async () => {
    const { service, challans } = build({ challans: [existing()] });
    await service.updateChallan(
      'c1',
      { tdsAmount: 5200 } as never,
      actor,
      'org',
    );
    expect(challans[0].tdsAmount).toBe(5200);
  });

  it('refuses a change once the quarter statement is filed', async () => {
    const { service, challans } = build({
      challans: [existing()],
      statements: filedQ3,
    });
    await expect(
      service.updateChallan('c1', { tdsAmount: 1 } as never, actor, 'org'),
    ).rejects.toThrow(/already filed.*changed/);
    expect(challans[0].tdsAmount).toBe(5000);
  });

  it('refuses moving the deposit date into the future', async () => {
    const { service } = build({ challans: [existing()] });
    await expect(
      service.updateChallan(
        'c1',
        { depositDate: '2026-12-01' } as never,
        actor,
        'org',
      ),
    ).rejects.toThrow(/cannot be in the future/);
  });

  it('refuses an edit that makes it the same challan as another one', async () => {
    const { service } = build({
      challans: [
        existing(),
        existing({
          id: 'c2',
          challanSerialNo: '00200',
          depositDate: '2026-11-08',
        }),
      ],
    });
    await expect(
      service.updateChallan(
        'c2',
        { challanSerialNo: '00123', depositDate: '2026-11-06' } as never,
        actor,
        'org',
      ),
    ).rejects.toThrow(/already recorded/);
  });

  it('saving a challan with its own unchanged details is not a duplicate of itself', async () => {
    const { service } = build({ challans: [existing()] });
    await expect(
      service.updateChallan(
        'c1',
        { bsrCode: '0510308', challanSerialNo: '00123' } as never,
        actor,
        'org',
      ),
    ).resolves.toBeDefined();
  });
});

describe('TDS challans: removing', () => {
  it('is still refused once the quarter statement is filed', async () => {
    const { service, challans } = build({
      challans: [
        {
          id: 'c1',
          month: 10,
          year: 2026,
          financialYear: '2026-27',
          quarter: 3,
        },
      ],
      statements: filedQ3,
    });
    await expect(service.removeChallan('c1', actor, 'org')).rejects.toThrow(
      /already filed.*removed/,
    );
    expect(challans).toHaveLength(1);
  });
});

describe('Form 130 readiness', () => {
  const run = { employeeId: 'e1', month: 10, year: 2026 };
  const org = { tan: 'BLRA12345B', pan: 'AABCD1234E' };

  it('is ready when the company TAN and PAN are set and the employee has payroll', async () => {
    const { service } = build({ org, runs: [run], employeePan: 'ABCDE1234F' });
    expect(await service.form130Readiness('e1', '2026-27', 'org')).toEqual({
      ready: true,
      blockers: [],
      warnings: [],
    });
  });

  it('a missing employee PAN is a warning, still ready', async () => {
    const { service } = build({ org, runs: [run], employeePan: '' });
    const r = await service.form130Readiness('e1', '2026-27', 'org');
    expect(r.ready).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/employee's PAN/);
  });

  it('a missing company TAN or no payroll for the year blocks it', async () => {
    const noTan = build({
      org: { ...org, tan: '' },
      runs: [run],
      employeePan: 'ABCDE1234F',
    });
    const a = await noTan.service.form130Readiness('e1', '2026-27', 'org');
    expect(a.ready).toBe(false);
    expect(a.blockers.join(' ')).toMatch(/TAN is not set/);
    const noPayroll = build({ org, runs: [], employeePan: 'ABCDE1234F' });
    const b = await noPayroll.service.form130Readiness('e1', '2026-27', 'org');
    expect(b.ready).toBe(false);
    expect(b.blockers.join(' ')).toMatch(/No finalized payroll/);
  });
});
