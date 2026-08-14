import { PayrollSettings, StatutoryModule } from '@prisma/client';
import { applyStatutoryOverrides } from './statutory-overlay';

function baseSettings(
  overrides: Partial<PayrollSettings> = {},
): PayrollSettings {
  return {
    id: 's1',
    organizationId: 'org1',
    financialYearStartMonth: 4,
    processingDay: 0,
    paymentDay: 0,
    currency: 'INR',
    currencySymbol: '₹',
    roundingRule: 'nearest',
    roundingDecimals: 0,
    pfEnabled: false,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    npsEnabled: false,
    gratuityEnabled: false,
    bonusEnabled: false,
    incomeTaxEnabled: true,
    employerInsuranceEnabled: false,
    pfEmployeeRate: 12,
    pfEmployerRate: 12,
    pfWageCeiling: 15000,
    esiEmployeeRate: 0.75,
    esiEmployerRate: 3.25,
    esiWageCeiling: 21000,
    ptSlabs: [{ upTo: 7500, amount: 0 }],
    lwfEmployeeAmount: 25,
    lwfEmployerAmount: 75,
    npsEmployerRate: 10,
    gratuityRate: 4.81,
    compOffExpiryDays: 90,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('applyStatutoryOverrides', () => {
  it('leaves fields untouched when a module has no version yet', () => {
    const result = applyStatutoryOverrides(baseSettings(), {});
    expect(result.pfEmployeeRate).toBe(12);
    expect(result.pfEnabled).toBe(false);
    expect(result.lwfMonths).toEqual([6, 12]);
  });

  it('overlays PF fields when a PF version exists', () => {
    const result = applyStatutoryOverrides(baseSettings(), {
      [StatutoryModule.PF]: {
        config: { employeeRate: 10, employerRate: 10, wageCeiling: 25000 },
        isEnabled: true,
      },
    });
    expect(result.pfEmployeeRate).toBe(10);
    expect(result.pfEmployerRate).toBe(10);
    expect(result.pfWageCeiling).toBe(25000);
    expect(result.pfEnabled).toBe(true);
  });

  it('overlays LWF months from the version instead of the [6,12] default', () => {
    const result = applyStatutoryOverrides(baseSettings(), {
      [StatutoryModule.LWF]: {
        config: { employeeAmount: 20, employerAmount: 60, months: [3, 9] },
        isEnabled: true,
      },
    });
    expect(result.lwfMonths).toEqual([3, 9]);
    expect(result.lwfEmployeeAmount).toBe(20);
  });

  it('overlays rounding and payroll_calendar fields', () => {
    const result = applyStatutoryOverrides(baseSettings(), {
      [StatutoryModule.ROUNDING]: {
        config: { rule: 'up', decimals: 2 },
        isEnabled: true,
      },
      [StatutoryModule.PAYROLL_CALENDAR]: {
        config: { frequency: 'monthly', processingDay: 25, paymentDay: 1 },
        isEnabled: true,
      },
    });
    expect(result.roundingRule).toBe('up');
    expect(result.roundingDecimals).toBe(2);
    expect(result.processingDay).toBe(25);
    expect(result.paymentDay).toBe(1);
    expect(result.payrollFrequency).toBe('monthly');
  });

  it('BONUS overlay only affects isEnabled (no config fields)', () => {
    const result = applyStatutoryOverrides(baseSettings(), {
      [StatutoryModule.BONUS]: { config: {}, isEnabled: true },
    });
    expect(result.bonusEnabled).toBe(true);
  });
});
