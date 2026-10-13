import {
  documentFirstNameToken,
  documentNameToken,
  previewDocumentNumber,
  formatDocumentNumber,
  issueDocumentNumber,
  type DocumentNumberingEntry,
} from './document-numbering';

describe('formatDocumentNumber', () => {
  const date = new Date('2026-03-05T00:00:00.000Z');

  it('replaces every documented token, matching the frontend Live Preview exactly', () => {
    expect(
      formatDocumentNumber(
        '{DD}/{MM}/{YYYY}-{YYYYMM}-{MM_YYYY}-{DD_MM_YYYY}-{001}',
        7,
        date,
      ),
    ).toBe('05/03/2026-202603-03_2026-05_03_2026-007');
  });

  it("pads the counter to the placeholder's own digit width", () => {
    expect(formatDocumentNumber('X-{00}', 3, date)).toBe('X-03');
    expect(formatDocumentNumber('X-{00000}', 3, date)).toBe('X-00003');
  });

  it("carries the employee's ID into the number with {EMPID}", () => {
    expect(
      formatDocumentNumber('PS-{EMPID}-{YYYYMM}-{0001}', 2, date, 'DP-00002'),
    ).toBe('PS-DP-00002-202603-0002');
  });

  it('carries a cleaned employee name with {EMPNAME}, after the ID', () => {
    expect(
      formatDocumentNumber(
        'PS-{DD_MM_YYYY}-{00001}-{EMPID}-{EMPNAME}',
        7,
        date,
        'DP-00002',
        "Rohit  Mane-D'Souza",
      ),
    ).toBe('PS-05_03_2026-00007-DP-00002-ROHITMANEDSOUZA');
  });

  it('caps {EMPNAME} at 20 characters and strips accents', () => {
    expect(documentNameToken('Ñandú Ramírez Venkatasubramanian Iyer')).toBe(
      'NANDURAMIREZVENKATAS',
    );
    expect(documentNameToken('')).toBe('');
  });

  it('writes the month as a name: {MON} Jan, {MONTH} March, {MON_YYYY}, {MONTH_YYYY}', () => {
    // `date` is 5 March 2026
    expect(formatDocumentNumber('Payslip_{MON}', 1, date)).toBe('Payslip_Mar');
    expect(formatDocumentNumber('Payslip_{MONTH}', 1, date)).toBe(
      'Payslip_March',
    );
    expect(formatDocumentNumber('PS-{MON_YYYY}-{001}', 1, date)).toBe(
      'PS-Mar_2026-001',
    );
    expect(formatDocumentNumber('PS-{MONTH_YYYY}-{001}', 1, date)).toBe(
      'PS-March_2026-001',
    );
    expect(formatDocumentNumber('PS-{MM}-{MON}', 1, date)).toBe('PS-03-Mar');
  });

  it('{FIRSTNAME} is the first name as written: Payslip_Kunal_Jan', () => {
    const jan = new Date(2026, 0, 15);
    expect(
      formatDocumentNumber(
        'Payslip_{FIRSTNAME}_{MON}',
        1,
        jan,
        'DP-00002',
        'KUNAL SHARMA',
      ),
    ).toBe('Payslip_Kunal_Jan');
    expect(documentFirstNameToken("  éLodie   d'Arc ")).toBe('Elodie');
    expect(documentFirstNameToken('')).toBe('');
  });

  it('drops {EMPID} when no employee is given', () => {
    expect(formatDocumentNumber('PS-{EMPID}-{0001}', 2, date)).toBe('PS--0002');
  });

  it('leaves an unrecognized token untouched', () => {
    expect(formatDocumentNumber('X-{FOO}-{0001}', 2, date)).toBe(
      'X-{FOO}-0002',
    );
  });
});

describe('previewDocumentNumber', () => {
  it('formats a never-resetting counter with zero-padding matching the placeholder width', () => {
    const entry: DocumentNumberingEntry = {
      label: 'Employee ID',
      format: 'DP-{0000}',
      resetRule: 'never',
      counter: 4,
      lastPeriodKey: null,
    };
    expect(previewDocumentNumber(entry)).toBe('DP-0005');
  });

  it('resets to 1 for a monthly counter when the period key has rolled over', () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entry: DocumentNumberingEntry = {
      label: 'Payslip',
      format: 'PS-{YYYYMM}-{0001}',
      resetRule: 'monthly',
      counter: 12,
      lastPeriodKey: '190001', // deliberately stale
    };
    expect(previewDocumentNumber(entry)).toBe(`PS-${currentPeriod}-0001`);
  });

  it('continues incrementing a monthly counter within the same period', () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entry: DocumentNumberingEntry = {
      label: 'Payslip',
      format: 'PS-{YYYYMM}-{0001}',
      resetRule: 'monthly',
      counter: 3,
      lastPeriodKey: currentPeriod,
    };
    expect(previewDocumentNumber(entry)).toBe(`PS-${currentPeriod}-0004`);
  });

  it('formats a yearly counter', () => {
    const now = new Date();
    const entry: DocumentNumberingEntry = {
      label: 'Offer Letter',
      format: 'OL-{YYYY}-{0001}',
      resetRule: 'yearly',
      counter: 0,
      lastPeriodKey: String(now.getFullYear()),
    };
    expect(previewDocumentNumber(entry)).toBe(`OL-${now.getFullYear()}-0001`);
  });
});

describe('issueDocumentNumber', () => {
  function fakeTx(documentNumbering: Record<string, unknown>) {
    const updateCalls: unknown[] = [];
    return {
      tx: {
        $queryRaw: jest.fn().mockResolvedValue([{ documentNumbering }]),
        organization: {
          update: jest.fn((args: unknown) => {
            updateCalls.push(args);
            return Promise.resolve(undefined);
          }),
        },
      },
      updateCalls,
    };
  }

  it('formats using the current counter+1 and persists the new counter', async () => {
    const { tx, updateCalls } = fakeTx({
      employeeId: {
        label: 'Employee ID',
        format: 'DP-{00000}',
        resetRule: 'never',
        counter: 2,
        lastPeriodKey: null,
      },
    });

    const result = await issueDocumentNumber(
      tx as never,
      'org-1',
      'employeeId',
    );

    expect(result).toBe('DP-00003');
    expect(updateCalls).toHaveLength(1);
    const data = (
      updateCalls[0] as { data: { documentNumbering: Record<string, unknown> } }
    ).data;
    expect(
      (data.documentNumbering.employeeId as DocumentNumberingEntry).counter,
    ).toBe(3);
  });

  it('two sequential issues for the same type increment (not repeat) the counter', async () => {
    const { tx } = fakeTx({
      payslip: {
        label: 'Payslip',
        format: 'PS-{0001}',
        resetRule: 'never',
        counter: 0,
        lastPeriodKey: null,
      },
    });

    const first = await issueDocumentNumber(tx as never, 'org-1', 'payslip');
    expect(first).toBe('PS-0001');

    // Simulates the row-lock re-read a second call would do — the mock's
    // $queryRaw always returns the same fixture, so this manually reflects
    // what the first call's update() persisted, the way a real DB would.
    const updateMock = tx.organization.update as jest.Mock<
      Promise<undefined>,
      [{ data: { documentNumbering: Record<string, unknown> } }]
    >;
    const persisted = updateMock.mock.calls[0][0].data.documentNumbering;
    const queryRawMock = tx.$queryRaw;
    queryRawMock.mockResolvedValue([{ documentNumbering: persisted }]);
    const second = await issueDocumentNumber(tx as never, 'org-1', 'payslip');
    expect(second).toBe('PS-0002');
  });

  it('falls back to a sane default entry for an unknown docType instead of throwing', async () => {
    const { tx } = fakeTx({});
    const result = await issueDocumentNumber(tx as never, 'org-1', 'custom');
    expect(result).toBe('CUSTOM-0001');
  });

  it('throws if the organization row is not found', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await expect(
      issueDocumentNumber(tx as never, 'missing-org', 'employeeId'),
    ).rejects.toThrow('Organization missing-org not found');
  });
});
