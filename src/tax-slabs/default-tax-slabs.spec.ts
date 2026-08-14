import { TaxRegime } from '@prisma/client';
import { getDefaultTaxSlabConfig } from './default-tax-slabs';

describe('getDefaultTaxSlabConfig', () => {
  it.each([TaxRegime.OLD, TaxRegime.NEW])(
    '%s regime returns a well-formed shape',
    (regime) => {
      const config = getDefaultTaxSlabConfig(regime);
      expect(config.slabs.length).toBeGreaterThan(0);
      expect(config.slabs[config.slabs.length - 1].to).toBeNull();
      expect(config.surchargeSlabs.length).toBeGreaterThan(0);
      expect(config.standardDeduction).toBeGreaterThan(0);
      expect(config.cessRate).toBeGreaterThan(0);
    },
  );

  it('the old regime has a higher top surcharge band than the new regime', () => {
    const old = getDefaultTaxSlabConfig(TaxRegime.OLD);
    const neu = getDefaultTaxSlabConfig(TaxRegime.NEW);
    const oldTop = old.surchargeSlabs[old.surchargeSlabs.length - 1].rate;
    const newTop = neu.surchargeSlabs[neu.surchargeSlabs.length - 1].rate;
    expect(oldTop).toBeGreaterThan(newTop);
  });

  it('the new regime has a higher rebate limit than the old regime', () => {
    const old = getDefaultTaxSlabConfig(TaxRegime.OLD);
    const neu = getDefaultTaxSlabConfig(TaxRegime.NEW);
    expect(neu.rebate87ALimit).toBeGreaterThan(old.rebate87ALimit);
  });
});
