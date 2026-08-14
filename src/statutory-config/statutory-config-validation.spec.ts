import { StatutoryModule } from '@prisma/client';
import {
  SEED_DEFAULTS,
  validateModuleConfig,
} from './statutory-config-validation';

describe('validateModuleConfig', () => {
  it('accepts the seed default config for every module', () => {
    for (const module of Object.values(StatutoryModule)) {
      expect(() =>
        validateModuleConfig(module, SEED_DEFAULTS[module].config),
      ).not.toThrow();
    }
  });

  describe('PF / ESI', () => {
    it('rejects an out-of-range rate', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PF, {
          employeeRate: 150,
          employerRate: 12,
          wageCeiling: 15000,
        }),
      ).toThrow(/employeeRate/);
    });

    it('rejects a negative wageCeiling', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.ESI, {
          employeeRate: 0.75,
          employerRate: 3.25,
          wageCeiling: -1,
        }),
      ).toThrow(/wageCeiling/);
    });
  });

  describe('PT', () => {
    it('rejects an empty slab array', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PT, { slabs: [] }),
      ).toThrow(/at least one slab/);
    });

    it('rejects a null upTo on a non-last slab', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PT, {
          slabs: [
            { upTo: null, amount: 0 },
            { upTo: 10000, amount: 200 },
          ],
        }),
      ).toThrow(/only the last slab/);
    });

    it('rejects non-ascending upTo values', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PT, {
          slabs: [
            { upTo: 10000, amount: 100 },
            { upTo: 5000, amount: 200 },
          ],
        }),
      ).toThrow(/ascending/);
    });

    it('rejects a duplicate upTo value', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PT, {
          slabs: [
            { upTo: 7500, amount: 0 },
            { upTo: 7500, amount: 175 },
          ],
        }),
      ).toThrow(/ascending/);
    });

    it('accepts a well-formed slab set', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PT, {
          slabs: [
            { upTo: 7500, amount: 0 },
            { upTo: 10000, amount: 175 },
            { upTo: null, amount: 200 },
          ],
        }),
      ).not.toThrow();
    });
  });

  describe('LWF', () => {
    it('rejects an out-of-range month', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.LWF, {
          employeeAmount: 25,
          employerAmount: 75,
          months: [13],
        }),
      ).toThrow(/months/);
    });
  });

  describe('payroll_calendar', () => {
    it('rejects a frequency other than monthly', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PAYROLL_CALENDAR, {
          frequency: 'weekly',
          processingDay: 0,
          paymentDay: 0,
        }),
      ).toThrow(/monthly/);
    });

    it('rejects an out-of-range processingDay', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.PAYROLL_CALENDAR, {
          frequency: 'monthly',
          processingDay: 32,
          paymentDay: 0,
        }),
      ).toThrow(/processingDay/);
    });
  });

  describe('rounding', () => {
    it('rejects an unknown rule', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.ROUNDING, {
          rule: 'ceil',
          decimals: 0,
        }),
      ).toThrow(/rule/);
    });

    it('rejects out-of-range decimals', () => {
      expect(() =>
        validateModuleConfig(StatutoryModule.ROUNDING, {
          rule: 'nearest',
          decimals: 5,
        }),
      ).toThrow(/decimals/);
    });
  });

  it('BONUS accepts an empty config', () => {
    expect(() => validateModuleConfig(StatutoryModule.BONUS, {})).not.toThrow();
  });

  it('rejects a non-object config', () => {
    expect(() => validateModuleConfig(StatutoryModule.PF, null)).toThrow(
      'config must be an object.',
    );
    expect(() => validateModuleConfig(StatutoryModule.PF, 'nope')).toThrow(
      'config must be an object.',
    );
  });
});
