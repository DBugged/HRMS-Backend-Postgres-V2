import {
  HRA_CITY_OPTIONS,
  HRA_METRO_CITIES,
  isMetroCity,
  metroCitiesFor,
} from './hra-cities';

describe('HRA metro cities by tax year', () => {
  it('uses the original four cities before 2026-27', () => {
    expect(metroCitiesFor('2025-26')).toEqual([
      'Mumbai',
      'Delhi',
      'Chennai',
      'Kolkata',
    ]);
    expect(isMetroCity('Mumbai', '2025-26')).toBe(true);
    expect(isMetroCity('Pune', '2025-26')).toBe(false);
    expect(isMetroCity('Bengaluru', '2024-25')).toBe(false);
  });

  it('uses the eight cities from 2026-27 (Income-tax Rules, 2026)', () => {
    for (const city of [
      'Mumbai',
      'Delhi',
      'Chennai',
      'Kolkata',
      'Hyderabad',
      'Bengaluru',
      'Pune',
      'Ahmedabad',
    ]) {
      expect(isMetroCity(city, '2026-27')).toBe(true);
    }
    expect(isMetroCity('Jaipur', '2026-27')).toBe(false);
    expect(isMetroCity('OTHER', '2026-27')).toBe(false);
    expect(isMetroCity('Pune', '2027-28')).toBe(true);
  });

  it('with no year, applies the current rule', () => {
    expect(isMetroCity('Pune')).toBe(true);
  });
});

// Original checks (kept): the eight-city list, derivation from the city alone, and the OTHER option.
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
