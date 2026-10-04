import { HRA_CITY_OPTIONS, HRA_METRO_CITIES, isMetroCity } from './hra-cities';

describe('hra-cities', () => {
  it('has the eight metro cities of the Income-tax Rules, 2026', () => {
    expect([...HRA_METRO_CITIES].sort()).toEqual([
      'Ahmedabad',
      'Bengaluru',
      'Chennai',
      'Delhi',
      'Hyderabad',
      'Kolkata',
      'Mumbai',
      'Pune',
    ]);
  });

  it('derives metro from the city, never from anything else', () => {
    expect(isMetroCity('Pune')).toBe(true);
    expect(isMetroCity('Nagpur')).toBe(false);
    expect(isMetroCity('OTHER')).toBe(false);
    expect(isMetroCity('')).toBe(false);
    expect(isMetroCity(undefined)).toBe(false);
  });

  it('offers OTHER for every non-metro city', () => {
    expect(HRA_CITY_OPTIONS).toContain('OTHER');
    expect(HRA_CITY_OPTIONS).toHaveLength(HRA_METRO_CITIES.length + 1);
  });
});
