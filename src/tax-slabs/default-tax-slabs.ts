import { TaxRegime } from '@prisma/client';

/**
 * Static reference dataset ported verbatim from the old backend's
 * `utils/defaultTaxSlabs.js` — the current government slab structure
 * (FY2025-26/26-27 per Budget 2025), used only as a starting point an org
 * can fully override via TaxSlabsService.upsert. Not itself persisted
 * anywhere; `GET /tax-slabs/defaults` returns this directly.
 */

export interface SlabBand {
  from: number;
  to: number | null;
  rate: number;
}

export interface DefaultTaxSlabConfig {
  slabs: SlabBand[];
  standardDeduction: number;
  cessRate: number;
  surchargeSlabs: SlabBand[];
  rebate87ALimit: number;
  rebate87AAmount: number;
}

const NEW_REGIME: DefaultTaxSlabConfig = {
  slabs: [
    { from: 0, to: 400000, rate: 0 },
    { from: 400000, to: 800000, rate: 5 },
    { from: 800000, to: 1200000, rate: 10 },
    { from: 1200000, to: 1600000, rate: 15 },
    { from: 1600000, to: 2000000, rate: 20 },
    { from: 2000000, to: 2400000, rate: 25 },
    { from: 2400000, to: null, rate: 30 },
  ],
  standardDeduction: 75000,
  cessRate: 4,
  surchargeSlabs: [
    { from: 5000000, to: 10000000, rate: 10 },
    { from: 10000000, to: 20000000, rate: 15 },
    { from: 20000000, to: null, rate: 25 },
  ],
  rebate87ALimit: 1200000,
  rebate87AAmount: 60000,
};

const OLD_REGIME: DefaultTaxSlabConfig = {
  slabs: [
    { from: 0, to: 250000, rate: 0 },
    { from: 250000, to: 500000, rate: 5 },
    { from: 500000, to: 1000000, rate: 20 },
    { from: 1000000, to: null, rate: 30 },
  ],
  standardDeduction: 50000,
  cessRate: 4,
  surchargeSlabs: [
    { from: 5000000, to: 10000000, rate: 10 },
    { from: 10000000, to: 20000000, rate: 15 },
    { from: 20000000, to: 50000000, rate: 25 },
    { from: 50000000, to: null, rate: 37 },
  ],
  rebate87ALimit: 500000,
  rebate87AAmount: 12500,
};

export function getDefaultTaxSlabConfig(
  regime: TaxRegime,
): DefaultTaxSlabConfig {
  return regime === TaxRegime.OLD ? OLD_REGIME : NEW_REGIME;
}
