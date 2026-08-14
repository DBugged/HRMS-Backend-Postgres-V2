import { calculateEmi } from './loan-math';

describe('calculateEmi', () => {
  it('computes a flat principal/tenure split when interestRate is 0', () => {
    expect(calculateEmi(120000, 0, 12)).toBe(10000);
  });

  it('rounds the flat split', () => {
    expect(calculateEmi(100000, 0, 3)).toBe(33333);
  });

  it('computes a reducing-balance EMI for a positive interest rate', () => {
    // 100000 principal, 12% annual, 12 months -> standard EMI ~8885.
    expect(calculateEmi(100000, 12, 12)).toBe(8885);
  });

  it('a higher interest rate produces a higher EMI for the same principal/tenure', () => {
    const low = calculateEmi(100000, 8, 24);
    const high = calculateEmi(100000, 18, 24);
    expect(high).toBeGreaterThan(low);
  });
});
