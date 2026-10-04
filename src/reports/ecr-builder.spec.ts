import { buildEcr, ecrName, ECR_SEPARATOR } from './ecr-builder';

const base = {
  uan: '100200300400',
  name: 'Asha Verma',
  grossWages: 30000,
  epfWages: 15000,
  epfContribution: 1800,
  epsContribution: 1250,
  employerEpfShare: 550,
  ncpDays: 0,
};
const opts = { wageCeiling: 15000, daysInMonth: 31 };

describe('ecr-builder', () => {
  it('writes one #~#-separated line per member in the ECR 2.0 field order', () => {
    const r = buildEcr([base], opts);
    expect(r.lines).toEqual([
      [
        '100200300400',
        'ASHA VERMA',
        30000,
        15000,
        15000,
        15000,
        1800,
        1250,
        550,
        0,
        0,
      ].join(ECR_SEPARATOR),
    ]);
    expect(r.issues).toEqual([]);
    expect(r.totals.epfEpsDiff).toBe(550);
  });

  it('keeps only letters, spaces and dots in names', () => {
    expect(ecrName("o'Neil-Rao  (K.) 3rd")).toBe('O NEIL RAO K. RD');
  });

  it('caps EPF wages at gross and EPS/EDLI wages at the ceiling', () => {
    const r = buildEcr([{ ...base, grossWages: 10000, epfWages: 14000 }], opts);
    const f = r.lines[0].split(ECR_SEPARATOR);
    expect(f.slice(2, 6)).toEqual(['10000', '10000', '10000', '10000']);
    expect(r.issues.some((i) => /capped at gross/.test(i.message))).toBe(true);
    const high = buildEcr(
      [
        {
          ...base,
          epfWages: 25000,
          grossWages: 40000,
          epfContribution: 3000,
          epsContribution: 1250,
          employerEpfShare: 1750,
        },
      ],
      opts,
    );
    const g = high.lines[0].split(ECR_SEPARATOR);
    expect(g[3]).toBe('25000');
    expect(g[4]).toBe('15000');
    expect(g[5]).toBe('15000');
  });

  it('refuses a member without a valid UAN and reports it', () => {
    const r = buildEcr(
      [
        { ...base, uan: '' },
        { ...base, uan: '123' },
      ],
      opts,
    );
    expect(r.lines).toHaveLength(0);
    expect(r.skipped).toHaveLength(2);
    expect(r.issues[0].level).toBe('error');
  });

  it('refuses a duplicate UAN', () => {
    const r = buildEcr([base, { ...base, name: 'Someone Else' }], opts);
    expect(r.lines).toHaveLength(1);
    expect(r.skipped[0].message).toMatch(/same UAN/);
  });

  it('warns when contributions do not match the statutory percentages', () => {
    const r = buildEcr(
      [{ ...base, epfContribution: 1700, epsContribution: 1000 }],
      opts,
    );
    expect(r.issues.some((i) => /12% of EPF wages/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /8.33%/.test(i.message))).toBe(true);
  });

  it('a full-LOP member is listed with zero wages and NCP days for the whole month', () => {
    const r = buildEcr(
      [
        {
          ...base,
          grossWages: 0,
          epfWages: 0,
          epfContribution: 0,
          epsContribution: 0,
          employerEpfShare: 0,
          ncpDays: 31,
        },
      ],
      opts,
    );
    expect(r.lines[0].split(ECR_SEPARATOR).slice(2)).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '31',
      '0',
    ]);
    expect(r.issues).toEqual([]);
  });
});
