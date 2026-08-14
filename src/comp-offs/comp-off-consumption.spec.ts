import {
  CompOffRow,
  consumeCompOff,
  releaseCompOff,
  sumAvailable,
} from './comp-off-consumption';

function row(overrides: Partial<CompOffRow>): CompOffRow {
  return {
    id: 'row-1',
    daysEarned: 1,
    daysAvailed: 0,
    expiryDate: null,
    status: 'APPROVED',
    ...overrides,
  };
}

describe('consumeCompOff', () => {
  it('consumes fully from a single row', () => {
    const result = consumeCompOff([row({ id: 'a', daysEarned: 2 })], 1.5);
    expect(result.shortfall).toBe(0);
    expect(result.updated).toEqual([
      { id: 'a', daysAvailed: 1.5, status: 'PARTIALLY_AVAILED' },
    ]);
  });

  it('marks a row AVAILED once fully consumed', () => {
    const result = consumeCompOff([row({ id: 'a', daysEarned: 1 })], 1);
    expect(result.updated).toEqual([
      { id: 'a', daysAvailed: 1, status: 'AVAILED' },
    ]);
  });

  it('consumes soonest-expiring rows first', () => {
    const rows = [
      row({ id: 'late', daysEarned: 1, expiryDate: '2026-12-31' }),
      row({ id: 'soon', daysEarned: 1, expiryDate: '2026-06-01' }),
    ];
    const result = consumeCompOff(rows, 1);
    expect(result.updated).toEqual([
      { id: 'soon', daysAvailed: 1, status: 'AVAILED' },
    ]);
  });

  it('spans multiple rows when one is insufficient', () => {
    const rows = [
      row({ id: 'a', daysEarned: 0.5, expiryDate: '2026-01-01' }),
      row({ id: 'b', daysEarned: 1, expiryDate: '2026-02-01' }),
    ];
    const result = consumeCompOff(rows, 1);
    expect(result.updated).toEqual([
      { id: 'a', daysAvailed: 0.5, status: 'AVAILED' },
      { id: 'b', daysAvailed: 0.5, status: 'PARTIALLY_AVAILED' },
    ]);
    expect(result.shortfall).toBe(0);
  });

  it('rows with no expiry are consumed last', () => {
    const rows = [
      row({ id: 'no-expiry', daysEarned: 1, expiryDate: null }),
      row({ id: 'expiring', daysEarned: 1, expiryDate: '2026-01-01' }),
    ];
    const result = consumeCompOff(rows, 1);
    expect(result.updated).toEqual([
      { id: 'expiring', daysAvailed: 1, status: 'AVAILED' },
    ]);
  });

  it('reports a shortfall when total available is less than requested', () => {
    const result = consumeCompOff([row({ id: 'a', daysEarned: 1 })], 3);
    expect(result.shortfall).toBe(2);
    expect(result.updated).toEqual([
      { id: 'a', daysAvailed: 1, status: 'AVAILED' },
    ]);
  });

  it('skips rows that are already fully consumed', () => {
    const rows = [
      row({ id: 'exhausted', daysEarned: 1, daysAvailed: 1 }),
      row({ id: 'fresh', daysEarned: 1 }),
    ];
    const result = consumeCompOff(rows, 1);
    expect(result.updated).toEqual([
      { id: 'fresh', daysAvailed: 1, status: 'AVAILED' },
    ]);
  });
});

describe('releaseCompOff', () => {
  it('gives back to the most-recently-consumed (latest expiry) row first', () => {
    const rows = [
      row({
        id: 'early',
        daysEarned: 1,
        daysAvailed: 1,
        expiryDate: '2026-01-01',
      }),
      row({
        id: 'late',
        daysEarned: 1,
        daysAvailed: 1,
        expiryDate: '2026-12-31',
      }),
    ];
    const result = releaseCompOff(rows, 1);
    expect(result).toEqual([
      { id: 'late', daysAvailed: 0, status: 'APPROVED' },
    ]);
  });

  it('reverts to PARTIALLY_AVAILED when only part of the row is released', () => {
    const result = releaseCompOff(
      [row({ id: 'a', daysEarned: 2, daysAvailed: 2 })],
      0.5,
    );
    expect(result).toEqual([
      { id: 'a', daysAvailed: 1.5, status: 'PARTIALLY_AVAILED' },
    ]);
  });

  it('spans multiple rows when one alone is insufficient', () => {
    const rows = [
      row({
        id: 'a',
        daysEarned: 1,
        daysAvailed: 0.5,
        expiryDate: '2026-01-01',
      }),
      row({ id: 'b', daysEarned: 1, daysAvailed: 1, expiryDate: '2026-02-01' }),
    ];
    const result = releaseCompOff(rows, 1.5);
    expect(result).toEqual([
      { id: 'b', daysAvailed: 0, status: 'APPROVED' },
      { id: 'a', daysAvailed: 0, status: 'APPROVED' },
    ]);
  });

  it('skips rows with nothing consumed', () => {
    const rows = [
      row({ id: 'untouched', daysEarned: 1, daysAvailed: 0 }),
      row({ id: 'consumed', daysEarned: 1, daysAvailed: 1 }),
    ];
    const result = releaseCompOff(rows, 1);
    expect(result).toEqual([
      { id: 'consumed', daysAvailed: 0, status: 'APPROVED' },
    ]);
  });

  it('rows with no expiry are released first', () => {
    const rows = [
      row({
        id: 'expiring',
        daysEarned: 1,
        daysAvailed: 1,
        expiryDate: '2026-01-01',
      }),
      row({ id: 'no-expiry', daysEarned: 1, daysAvailed: 1, expiryDate: null }),
    ];
    const result = releaseCompOff(rows, 1);
    expect(result).toEqual([
      { id: 'no-expiry', daysAvailed: 0, status: 'APPROVED' },
    ]);
  });
});

describe('sumAvailable', () => {
  it('sums unconsumed days across rows', () => {
    const rows = [
      row({ daysEarned: 2, daysAvailed: 0.5 }),
      row({ daysEarned: 1, daysAvailed: 1 }),
    ];
    expect(sumAvailable(rows)).toBe(1.5);
  });

  it('is 0 for an empty list', () => {
    expect(sumAvailable([])).toBe(0);
  });
});
