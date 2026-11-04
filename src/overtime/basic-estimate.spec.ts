import { estimateMonthlyBasic, type StructureRow } from './basic-estimate';

const row = (o: Partial<StructureRow>): StructureRow => ({
  componentCode: 'BASIC',
  valueType: 'FIXED',
  fixedAmount: null,
  percentageValue: null,
  percentageOf: null,
  amountBasis: 'MONTHLY',
  ...o,
});

describe('estimateMonthlyBasic', () => {
  it('uses a fixed Basic, monthly or annual', () => {
    expect(
      estimateMonthlyBasic({
        rows: [row({ fixedAmount: 20000 })],
        ctcMonthly: null,
        lastRunBasics: [],
      }),
    ).toBe(20000);
    expect(
      estimateMonthlyBasic({
        rows: [row({ fixedAmount: 240000, amountBasis: 'ANNUAL' })],
        ctcMonthly: null,
        lastRunBasics: [],
      }),
    ).toBe(20000);
  });
  it('resolves a percentage of CTC or of another fixed component', () => {
    expect(
      estimateMonthlyBasic({
        rows: [
          row({
            valueType: 'PERCENTAGE',
            percentageValue: 40,
            percentageOf: 'CTC',
          }),
        ],
        ctcMonthly: 50000,
        lastRunBasics: [],
      }),
    ).toBe(20000);
    expect(
      estimateMonthlyBasic({
        rows: [
          row({
            valueType: 'PERCENTAGE',
            percentageValue: 50,
            percentageOf: 'GROSS',
          }),
          row({ componentCode: 'GROSS', fixedAmount: 40000 }),
        ],
        ctcMonthly: null,
        lastRunBasics: [],
      }),
    ).toBe(20000);
  });
  it('falls back to the largest Basic on recent payroll runs', () => {
    expect(
      estimateMonthlyBasic({
        rows: [row({ valueType: 'FORMULA' })],
        ctcMonthly: null,
        lastRunBasics: [12000, 20000, 0],
      }),
    ).toBe(20000);
    expect(
      estimateMonthlyBasic({
        rows: [],
        ctcMonthly: null,
        lastRunBasics: [18000],
      }),
    ).toBe(18000);
  });
  it('gives no figure when nothing is known', () => {
    expect(
      estimateMonthlyBasic({ rows: [], ctcMonthly: 50000, lastRunBasics: [] }),
    ).toBeNull();
  });
});
