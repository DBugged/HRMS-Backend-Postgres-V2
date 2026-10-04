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
