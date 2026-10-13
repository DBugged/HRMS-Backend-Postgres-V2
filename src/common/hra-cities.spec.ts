import {
  canonicalMetroCity,
  cityClassForCity,
  defaultHraPercent,
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

describe('city class for pay', () => {
  it('suggests METRO for the eight HRA cities, including their other names', () => {
    for (const name of [
      'Mumbai',
      'Bombay',
      'Delhi',
      'New Delhi',
      'Kolkata',
      'Calcutta',
      'Chennai',
      'Madras',
      'Bengaluru',
      'Bangalore',
      'Hyderabad',
      'Pune',
      'Poona',
      'Ahmedabad',
      '  pune  ',
      'BENGALURU',
    ]) {
      expect([name, cityClassForCity(name)]).toEqual([name, 'METRO']);
    }
  });

  it('suggests NON_METRO for any other city and when there is no city', () => {
    for (const name of [
      'Nashik',
      'Nagpur',
      'Jaipur',
      'Gurgaon',
      'Navi Mumbai ',
      '',
      null,
      undefined,
    ]) {
      expect([name, cityClassForCity(name)]).toEqual([name, 'NON_METRO']);
    }
  });

  it('reads the canonical city out of an alias', () => {
    expect(canonicalMetroCity('Bangalore')).toBe('Bengaluru');
    expect(canonicalMetroCity('Bombay')).toBe('Mumbai');
    expect(canonicalMetroCity('Satara')).toBeNull();
  });

  it('HRA is 50% of Basic in a metro, 40% elsewhere and none by default in a village', () => {
    expect(defaultHraPercent('METRO')).toBe(50);
    expect(defaultHraPercent('NON_METRO')).toBe(40);
    expect(defaultHraPercent('RURAL')).toBe(0);
  });
});
