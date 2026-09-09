import { calculateEmi, payoffAmount, splitRepayment } from './loan-math';

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

describe('splitRepayment', () => {
  it('takes this month’s interest first, and only the rest reduces principal', () => {
    // 100,000 @ 12% p.a. -> 1% a month -> 1,000 interest in month 1.
    const { interestComponent, principalComponent } = splitRepayment(
      8885,
      100000,
      12,
    );
    expect(interestComponent).toBe(1000);
    expect(principalComponent).toBe(7885);
  });

  it('charges no interest on a zero-rate loan (every ADVANCE)', () => {
    const { interestComponent, principalComponent } = splitRepayment(
      10000,
      50000,
      0,
    );
    expect(interestComponent).toBe(0);
    expect(principalComponent).toBe(10000);
  });

  it('never repays more principal than is outstanding', () => {
    const { interestComponent, principalComponent } = splitRepayment(
      9000,
      5000,
      12,
    );
    expect(interestComponent).toBe(50);
    expect(principalComponent).toBe(5000);
  });

  it('puts everything to interest when the payment does not even cover it', () => {
    const { interestComponent, principalComponent } = splitRepayment(
      400,
      100000,
      12,
    );
    expect(interestComponent).toBe(400);
    expect(principalComponent).toBe(0);
  });
});

describe('payoffAmount', () => {
  it('is the balance plus the month’s interest', () => {
    expect(payoffAmount(5000, 12)).toBe(5050);
  });

  it('is just the balance for a zero-rate loan', () => {
    expect(payoffAmount(5000, 0)).toBe(5000);
  });
});

// The regression this whole split exists for: the old
// `principal = min(amount, balance)` decremented the balance by the whole
// EMI, so the loan closed early and every rupee of interest was written off.
describe('a full 12-month schedule at 12% p.a.', () => {
  const PRINCIPAL = 100000;
  const RATE = 12;
  const TENURE = 12;

  it('collects the scheduled interest and closes in exactly the tenure', () => {
    const emi = calculateEmi(PRINCIPAL, RATE, TENURE);
    let balance = PRINCIPAL;
    let totalInterest = 0;
    let months = 0;

    while (balance > 0 && months < 60) {
      const due = Math.min(emi, payoffAmount(balance, RATE));
      const { interestComponent, principalComponent } = splitRepayment(
        due,
        balance,
        RATE,
      );
      totalInterest += interestComponent;
      balance = Math.round((balance - principalComponent) * 100) / 100;
      months += 1;
    }

    expect(months).toBe(TENURE);
    expect(balance).toBe(0);
    // ~6,620 of interest that the old code silently forgave.
    expect(totalInterest).toBeGreaterThan(6500);
    expect(totalInterest).toBeLessThan(6700);
  });
});
