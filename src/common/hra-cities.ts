// Purpose: The cities that count as "metro" for the HRA exemption (50% of Basic instead of 40%).
// Important: Income-tax Rules, 2026 (from 1-Apr-2026) widened the list from four cities to eight. A declaration
//   records the employee's CITY, and "metro" is derived from it here — not self-ticked.
export const HRA_METRO_CITIES = [
  'Mumbai',
  'Delhi',
  'Chennai',
  'Kolkata',
  'Hyderabad',
  'Bengaluru',
  'Pune',
  'Ahmedabad',
] as const;

// What a declaration may carry as its city: one of the metro cities, or OTHER for any non-metro city.
export const HRA_CITY_OPTIONS = [...HRA_METRO_CITIES, 'OTHER'] as const;

export function isMetroCity(city: string | null | undefined): boolean {
  return (HRA_METRO_CITIES as readonly string[]).includes(city ?? '');
}
