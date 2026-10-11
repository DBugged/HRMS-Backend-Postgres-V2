import {
  computeStatutoryBonus,
  effectiveBonusCeiling,
  type BonusMonthInput,
} from './statutory-bonus';

const year = (basicDa: number, n = 12): BonusMonthInput[] =>
  Array.from({ length: n }, (_, i) => ({
    month: ((i + 3) % 12) + 1,
    year: 2026,
    basicDaEarned: basicDa,
    payableDays: 30,
    totalDays: 30,
  }));
const cfg = { rate: 8.33, eligibilityCeiling: 21000, calculationCeiling: 7000 };

describe('effectiveBonusCeiling', () => {
  it('is never below 7,000', () => {
    expect(effectiveBonusCeiling(5000)).toBe(7000);
  });
  it('is the higher of the configured ceiling and the minimum wage', () => {
    expect(effectiveBonusCeiling(7000, 14500)).toBe(14500);
    expect(effectiveBonusCeiling(16000, 14500)).toBe(16000);
  });
});

describe('computeStatutoryBonus', () => {
  it('caps the base at 7,000 a month when no minimum wage is set', () => {
    const r = computeStatutoryBonus(year(15000), cfg);
    expect(r.baseWages).toBe(84000);
    expect(r.bonus).toBe(Math.round(84000 * 0.0833));
  });

  it('uses the minimum wage when it is higher than 7,000', () => {
    const r = computeStatutoryBonus(year(15000), { ...cfg, minimumWage: 14500 });
    expect(r.baseWages).toBe(174000);
    expect(r.bonus).toBe(Math.round(174000 * 0.0833));
  });

  it('pays on actual wages when below the ceiling', () => {
    const r = computeStatutoryBonus(year(9000), { ...cfg, minimumWage: 14500 });
    expect(r.baseWages).toBe(108000);
  });

  it('excludes months where the monthly rate is above the eligibility ceiling', () => {
    const months = [...year(15000, 6), ...year(25000, 6)];
    const r = computeStatutoryBonus(months, { ...cfg, minimumWage: 14500 });
    expect(r.eligibleMonths).toBe(6);
    expect(r.baseWages).toBe(6 * 14500);
  });

  it('is not eligible when every month is above the ceiling', () => {
    const r = computeStatutoryBonus(year(30000), cfg);
    expect(r.eligible).toBe(false);
    expect(r.bonus).toBe(0);
  });

  it('judges eligibility on the full-month rate, not a part month', () => {
    // 15 days of a 30,000 monthly wage earns 15,000 - still above the ceiling.
    const r = computeStatutoryBonus(
      [{ month: 4, year: 2026, basicDaEarned: 15000, payableDays: 15, totalDays: 30 }],
      cfg,
    );
    expect(r.eligible).toBe(false);
  });

  it('prorates the cap for a part month', () => {
    const r = computeStatutoryBonus(
      [{ month: 4, year: 2026, basicDaEarned: 10000, payableDays: 15, totalDays: 30 }],
      { ...cfg, minimumWage: 14500 },
    );
    // Rate 20,000 is above 21,000? No - 20,000 <= 21,000; base capped at 14,500 * 15/30.
    expect(r.eligible).toBe(false); // fewer than 30 days
    const full = computeStatutoryBonus(
      [
        { month: 4, year: 2026, basicDaEarned: 10000, payableDays: 15, totalDays: 30 },
        { month: 5, year: 2026, basicDaEarned: 20000, payableDays: 30, totalDays: 31 },
      ],
      { ...cfg, minimumWage: 14500 },
    );
    expect(full.eligible).toBe(true);
    expect(full.baseWages).toBe(Math.round(7250 + Math.min(20000, 14500 * (30 / 31))));
  });

  it('requires at least 30 days worked in the year', () => {
    const r = computeStatutoryBonus(
      [{ month: 4, year: 2026, basicDaEarned: 5000, payableDays: 20, totalDays: 30 }],
      cfg,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/fewer than 30 days/);
  });

  it('pays at least 100', () => {
    const r = computeStatutoryBonus(
      [{ month: 4, year: 2026, basicDaEarned: 1000, payableDays: 30, totalDays: 30 }],
      cfg,
    );
    expect(r.eligible).toBe(true);
    expect(r.bonus).toBe(100);
  });
});
