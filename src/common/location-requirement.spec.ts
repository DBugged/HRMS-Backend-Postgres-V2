import { LocationRequirement } from '@prisma/client';
import { resolveLocationMode } from './location-requirement';

describe('resolveLocationMode', () => {
  it("an employee's own setting wins over the organization's", () => {
    expect(resolveLocationMode(LocationRequirement.NOT_NEEDED, { locationMode: 'ENFORCED' })).toBe('NOT_NEEDED');
    expect(resolveLocationMode(LocationRequirement.RECORD_ONLY, { locationMode: 'NOT_NEEDED' })).toBe('RECORD_ONLY');
    expect(resolveLocationMode(LocationRequirement.ENFORCED, { locationMode: 'NOT_NEEDED' })).toBe('ENFORCED');
  });

  it('DEFAULT follows the organization, and falls back to ENFORCED when unset or unknown', () => {
    expect(resolveLocationMode(LocationRequirement.DEFAULT, { locationMode: 'RECORD_ONLY' })).toBe('RECORD_ONLY');
    expect(resolveLocationMode(LocationRequirement.DEFAULT, {})).toBe('ENFORCED');
    expect(resolveLocationMode(LocationRequirement.DEFAULT, null)).toBe('ENFORCED');
    expect(resolveLocationMode(undefined, { locationMode: 'SOMETHING_ELSE' })).toBe('ENFORCED');
  });
});
