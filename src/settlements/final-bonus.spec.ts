import {
  bonusMonthFromRun,
  bonusPaidIn,
  finalStatutoryBonus,
} from './final-bonus';

const config = {
  rate: 8.33,
  eligibilityCeiling: 21000,
  calculationCeiling: 7000,
};
const month = (m: number, basicDaEarned = 15000) => ({
  month: m,
  year: 2026,
  basicDaEarned,
  payableDays: 30,
  totalDays: 30,
});

describe('statutory bonus on exit', () => {
  it('is the bonus for the months worked, on the capped base', () => {
    // 6 months x min(15,000, 7,000) = 42,000 x 8.33% = 3,499
    const r = finalStatutoryBonus({
      months: [4, 5, 6, 7, 8, 9].map((m) => month(m)),
      config,
      alreadyPaid: 0,
    });
    expect(r).toMatchObject({ eligible: true, due: 3499, payable: 3499 });
  });

  it('subtracts what the year already paid, never going below zero', () => {
    const months = [4, 5, 6, 7, 8, 9].map((m) => month(m));
    expect(
      finalStatutoryBonus({ months, config, alreadyPaid: 1000 }).payable,
    ).toBe(2499);
    expect(
      finalStatutoryBonus({ months, config, alreadyPaid: 9000 }).payable,
    ).toBe(0);
  });

  it('is nothing below 30 days worked in the year or above the eligibility ceiling', () => {
    const few = finalStatutoryBonus({
      months: [{ ...month(9), payableDays: 12 }],
      config,
      alreadyPaid: 0,
    });
    expect(few).toMatchObject({ eligible: false, payable: 0 });
    const high = finalStatutoryBonus({
      months: [4, 5, 6].map((m) => month(m, 50000)),
      config,
      alreadyPaid: 0,
    });
    expect(high).toMatchObject({ eligible: false, payable: 0 });
  });

  it('reads Basic + DA and payable days from a run, and sums BONUS lines', () => {
    const run = {
      month: 9,
      year: 2026,
      earnings: [
        { code: 'BASIC', amount: 10000 },
        { code: 'DA', amount: 2000 },
        { code: 'HRA', amount: 4000 },
        { code: 'BONUS', amount: 800 },
      ],
      attendanceSummary: { payableDays: 28, totalDaysInMonth: 30 },
    };
    expect(bonusMonthFromRun(run)).toEqual({
      month: 9,
      year: 2026,
      basicDaEarned: 12000,
      payableDays: 28,
      totalDays: 30,
    });
    expect(
      bonusPaidIn([run, { earnings: [{ code: 'BONUS', amount: 200 }] }]),
    ).toBe(1000);
  });
});
