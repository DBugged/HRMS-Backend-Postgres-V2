import { SelfieRequirement } from '@prisma/client';
import { isSelfieRequired } from './selfie-requirement';

describe('isSelfieRequired', () => {
  const orgOn = { requireSelfieForPunch: true };
  const orgOff = { requireSelfieForPunch: false };

  it('DEFAULT follows the org setting', () => {
    expect(isSelfieRequired(SelfieRequirement.DEFAULT, orgOn)).toBe(true);
    expect(isSelfieRequired(SelfieRequirement.DEFAULT, orgOff)).toBe(false);
  });

  it('an unset org setting means required (orgs that predate it)', () => {
    expect(isSelfieRequired(SelfieRequirement.DEFAULT, {})).toBe(true);
    expect(isSelfieRequired(undefined, null)).toBe(true);
  });

  it('REQUIRED / NOT_REQUIRED override the org either way', () => {
    expect(isSelfieRequired(SelfieRequirement.REQUIRED, orgOff)).toBe(true);
    expect(isSelfieRequired(SelfieRequirement.NOT_REQUIRED, orgOn)).toBe(false);
  });
});
