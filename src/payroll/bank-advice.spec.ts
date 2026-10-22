import {
  buildBankAdvice,
  type AdviceEmployee,
  type AdviceRun,
} from './bank-advice';

const run = (over: Partial<AdviceRun> = {}): AdviceRun => ({
  id: 'r1',
  employeeId: 'e1',
  month: 9,
  year: 2026,
  netPay: 50000,
  payslipNumber: 'PS-1',
  heldAt: null,
  holdReason: null,
  runLabel: null,
  ...over,
});

const emp = (personalData: unknown = {}): AdviceEmployee => ({
  employeeId: 'DP-00002',
  name: 'Priya Sharma',
  personalData: {
    bankAccountNo: '500100207919',
    bankIFSC: 'HDFC0001234',
    bankName: 'HDFC Bank',
    ...(personalData as object),
  },
});

const advice = (r: AdviceRun, e: AdviceEmployee = emp()) =>
  buildBankAdvice([r], new Map([['e1', e]]));

describe('buildBankAdvice', () => {
  it('lists a payable run with account, IFSC, amount and a salary narration', () => {
    const a = advice(run());
    expect(a.leftOut).toEqual([]);
    expect(a.rows).toEqual([
      expect.objectContaining({
        employeeCode: 'DP-00002',
        accountNumber: '500100207919',
        ifsc: 'HDFC0001234',
        amount: 50000,
        narration: 'Salary Sep 2026',
        payslipNumber: 'PS-1',
      }),
    ]);
    expect(a.total).toBe(50000);
  });

  it('uses the label of an off-cycle run as the narration', () => {
    const a = advice(run({ runLabel: 'Diwali bonus' }));
    expect(a.rows[0].narration).toBe('Diwali bonus');
  });

  it('leaves out a held salary and says why', () => {
    const a = advice(
      run({ heldAt: new Date(), holdReason: 'Asset not returned' }),
    );
    expect(a.rows).toEqual([]);
    expect(a.leftOut[0].reason).toBe(
      'Salary on hold: Asset not returned. Release the hold to pay.',
    );
  });

  it('leaves out a zero net pay', () => {
    expect(advice(run({ netPay: 0 })).leftOut[0].reason).toMatch(/zero/);
  });

  it.each([
    [{ bankAccountNo: '' }, /account number is missing/],
    [{ bankIFSC: '' }, /IFSC is missing/],
    [
      { bankAccountNo: '', bankIFSC: '' },
      /account number and IFSC are missing/,
    ],
  ])('names what is missing from the bank details (%j)', (pd, expected) => {
    expect(advice(run(), emp(pd)).leftOut[0].reason).toMatch(expected);
  });

  it('cleans spaces and dashes from the account number and upper-cases the IFSC', () => {
    const a = advice(
      run(),
      emp({ bankAccountNo: '5001 0020-7919', bankIFSC: ' hdfc0001234 ' }),
    );
    expect(a.rows[0]).toMatchObject({
      accountNumber: '500100207919',
      ifsc: 'HDFC0001234',
    });
  });

  it('rejects a malformed account number or IFSC instead of sending it to the bank', () => {
    expect(
      advice(run(), emp({ bankAccountNo: '12345' })).leftOut[0].reason,
    ).toMatch(/9 to 18 digits/);
    expect(
      advice(run(), emp({ bankIFSC: 'HDFC1234567' })).leftOut[0].reason,
    ).toMatch(/IFSC should be/);
  });

  it('totals only what is in the file and keeps paise', () => {
    const a = buildBankAdvice(
      [
        run({ id: 'a', netPay: 1000.456 }),
        run({ id: 'b', netPay: 2000.1 }),
        run({ id: 'c', heldAt: new Date() }),
      ],
      new Map([['e1', emp()]]),
    );
    expect(a.rows.map((r) => r.amount)).toEqual([1000.46, 2000.1]);
    expect(a.total).toBe(3000.56);
    expect(a.leftOut).toHaveLength(1);
  });

  it('copes with an employee that no longer exists', () => {
    const a = buildBankAdvice([run()], new Map());
    expect(a.leftOut[0]).toMatchObject({ name: 'Unknown employee' });
  });

  it('splits the payments by the beneficiary bank, largest first', () => {
    const runs = [run({ id: 'a', employeeId: 'e1', netPay: 30000 }), run({ id: 'b', employeeId: 'e2', netPay: 80000 }), run({ id: 'c', employeeId: 'e3', netPay: 20000 })];
    const people = new Map([
      ['e1', emp()],
      ['e2', emp({ bankIFSC: 'ICIC0000007', bankName: 'ICICI Bank', bankAccountNo: '123456789012' })],
      ['e3', emp({ bankAccountNo: '999988887777' })],
    ]);
    const a = buildBankAdvice(runs, people);
    expect(a.banks).toEqual([
      { code: 'ICIC', name: 'ICICI Bank', count: 1, total: 80000 },
      { code: 'HDFC', name: 'HDFC Bank', count: 2, total: 50000 },
    ]);
  });

  it('marks a payment IFT inside the paying bank, otherwise NEFT, or RTGS from 2 lakh', () => {
    const people = new Map([['e1', emp()]]);
    expect(buildBankAdvice([run({ netPay: 50000 })], people, 'HDFC0000001').rows[0].transferMode).toBe('IFT');
    expect(buildBankAdvice([run({ netPay: 50000 })], people, 'ICIC0000001').rows[0].transferMode).toBe('NEFT');
    expect(buildBankAdvice([run({ netPay: 250000 })], people, 'ICIC0000001').rows[0].transferMode).toBe('RTGS');
    expect(buildBankAdvice([run({ netPay: 250000 })], people).rows[0].transferMode).toBe('RTGS');
  });
});
