// Purpose: The cities that count as "metro" for the HRA exemption (50% of Basic instead of 40%).
// Important: Until 31-Mar-2026 only four cities were metro for HRA; the Income-tax Rules, 2026 (from 1-Apr-2026,
//   i.e. tax year 2026-27 onward) widened the list to eight. The list therefore depends on the tax year: a
//   2025-26 declaration with Pune is NOT metro. A declaration records the employee's CITY, and "metro" is derived
//   from it here — not self-ticked.
export const HRA_METRO_CITIES_UNTIL_2025_26 = [
  'Mumbai',
  'Delhi',
  'Chennai',
  'Kolkata',
] as const;

export const HRA_METRO_CITIES = [
  ...HRA_METRO_CITIES_UNTIL_2025_26,
  'Hyderabad',
  'Bengaluru',
  'Pune',
  'Ahmedabad',
] as const;

// What a declaration may carry as its city: one of the metro cities, or OTHER for any non-metro city.
export const HRA_CITY_OPTIONS = [...HRA_METRO_CITIES, 'OTHER'] as const;

// "2026-27" and later use the eight-city list; earlier years the original four. No year = the current rule.
export function metroCitiesFor(
  financialYear?: string | null,
): readonly string[] {
  const start = Number((financialYear ?? '').slice(0, 4));
  return Number.isFinite(start) && start > 0 && start < 2026
    ? HRA_METRO_CITIES_UNTIL_2025_26
    : HRA_METRO_CITIES;
}

export function isMetroCity(
  city: string | null | undefined,
  financialYear?: string | null,
): boolean {
  return metroCitiesFor(financialYear).includes(city ?? '');
}

// How a place is classed for pay: METRO (the eight HRA cities, HRA 50% of Basic), NON_METRO (any other city, 40%) or
// RURAL (a village or rural area - chosen by hand, never guessed from a name).
export type CityClassName = 'METRO' | 'NON_METRO' | 'RURAL';

// Names a city is also known by. Compared in lower case with spaces and punctuation ignored.
const CITY_ALIASES: Record<string, (typeof HRA_METRO_CITIES)[number]> = {
  bombay: 'Mumbai',
  newdelhi: 'Delhi',
  nctdelhi: 'Delhi',
  calcutta: 'Kolkata',
  madras: 'Chennai',
  bangalore: 'Bengaluru',
  bengaluru: 'Bengaluru',
  poona: 'Pune',
  hyderabad: 'Hyderabad',
  ahmedabad: 'Ahmedabad',
  amdavad: 'Ahmedabad',
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** The metro city a name refers to (Bangalore -> Bengaluru), or null when it is not one of the eight. */
export function canonicalMetroCity(
  city: string | null | undefined,
): (typeof HRA_METRO_CITIES)[number] | null {
  const key = squash(city ?? '');
  if (!key) return null;
  const alias = CITY_ALIASES[key];
  if (alias) return alias;
  return HRA_METRO_CITIES.find((m) => squash(m) === key) ?? null;
}

/** The class a city name suggests: METRO for the eight, otherwise NON_METRO. RURAL is only ever set by hand. */
export function cityClassForCity(
  city: string | null | undefined,
): CityClassName {
  return canonicalMetroCity(city) ? 'METRO' : 'NON_METRO';
}

/**
 * The HRA percentage of Basic that goes with a class: 50% in a metro city, 40% elsewhere. A rural place gets no HRA by
 * default (0): employers there usually pay none, and it can still be switched on by hand.
 */
export function defaultHraPercent(cityClass: CityClassName): number {
  if (cityClass === 'METRO') return 50;
  if (cityClass === 'NON_METRO') return 40;
  return 0;
}
