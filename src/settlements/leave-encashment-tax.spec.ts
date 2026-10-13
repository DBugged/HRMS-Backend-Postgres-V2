import {
  LEAVE_ENCASHMENT_EXEMPTION_CAP,
  leaveEncashmentExemption,
} from './leave-encashment-tax';

describe('leave encashment exemption (s.10(10AA))', () => {
  it('is the whole amount when it is below every limit', () => {
    expect(
      leaveEncashmentExemption({
        amount: 10000,
        basicPlusDaMonthly: 30000,
        yearsOfService: 4,
      }),
    ).toBe(10000);
  });

  it('is capped at ten months of basic + DA', () => {
    expect(
      leaveEncashmentExemption({
        amount: 500000,
        basicPlusDaMonthly: 30000,
        yearsOfService: 20,
      }),
    ).toBe(300000);
  });

  it('is capped at 30 days per completed year of service', () => {
    // 2 completed years -> 60 days = 2 months of basic + DA.
    expect(
      leaveEncashmentExemption({
        amount: 90000,
        basicPlusDaMonthly: 30000,
        yearsOfService: 2.9,
      }),
    ).toBe(60000);
  });

  it('never exceeds the Rs 25 lakh ceiling', () => {
    expect(
      leaveEncashmentExemption({
        amount: 9000000,
        basicPlusDaMonthly: 900000,
        yearsOfService: 30,
      }),
    ).toBe(LEAVE_ENCASHMENT_EXEMPTION_CAP);
  });

  it('is nothing for no amount or no salary', () => {
    expect(
      leaveEncashmentExemption({
        amount: 0,
        basicPlusDaMonthly: 1,
        yearsOfService: 5,
      }),
    ).toBe(0);
    expect(
      leaveEncashmentExemption({
        amount: 1,
        basicPlusDaMonthly: 0,
        yearsOfService: 5,
      }),
    ).toBe(0);
  });
});
