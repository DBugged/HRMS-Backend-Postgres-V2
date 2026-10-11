// Purpose: Guards three input-handling fixes: NUL characters, person-name length and the grant-request status filter.
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { containsNul } from './request-sanity.interceptor';
import { isValidPersonName } from './person-name';
import { QueryGrantRequestsDto } from '../leave-grants/dto/leave-grant.dto';

describe('containsNul', () => {
  it('finds a NUL in strings, nested values and keys', () => {
    expect(containsNul('abc\u0000')).toBe(true);
    expect(containsNul({ a: ['x', { b: 'y\u0000z' }] })).toBe(true);
    expect(containsNul({ 'k\u0000': 1 })).toBe(true);
  });
  it('is false for ordinary data', () => {
    expect(containsNul({ a: 'abc', b: [1, 'two'], c: null })).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });
});

describe('person name', () => {
  it('needs at least 2 characters', () => {
    expect(isValidPersonName('A')).toBe(false);
    expect(isValidPersonName(' A ')).toBe(false);
    expect(isValidPersonName('Li')).toBe(true);
    expect(isValidPersonName("D'Souza-Rao Jr.")).toBe(true);
    expect(isValidPersonName('A'.repeat(101))).toBe(false);
    expect(isValidPersonName('<b>X</b>')).toBe(false);
  });
});

describe('grant request status filter', () => {
  const errors = (status: string) =>
    validate(plainToInstance(QueryGrantRequestsDto, { status })).then((e) =>
      e.map((x) => x.property),
    );
  it('accepts the real statuses and rejects anything else with a validation error', async () => {
    expect(await errors('PENDING')).toEqual([]);
    expect(await errors('abc')).toContain('status');
    expect(await errors('0')).toContain('status');
  });
});
