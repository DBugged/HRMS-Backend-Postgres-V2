// Purpose: Single shared implementation of the "strip sensitive fields + sign asset URLs" projection used
// wherever a User record leaves employees.service.ts / employee-profile.service.ts as an API response.
// Was previously duplicated (with drifting behavior) between those two files — see the incident referenced
// below — so both now import this one copy instead of keeping their own.
// Important: employees.service.ts's copy supported role-based masking of sensitive personal-data fields
// (for a MANAGER viewing someone else) via the `mask` param; employee-profile.service.ts's copy never had
// that param since its callers are always self-or-HR (mask is always false there). The two copies had
// already drifted once before — employee-profile.service.ts's copy briefly shipped without profileImage
// signing, which made the profile photo appear to vanish right after Save Profile. This merged copy carries
// the union of both: profileImage signing (always) and personalData masking (opt-in via `mask`, default false).
import { User } from '@prisma/client';
import { signFileToken, SESSION_ASSET_TTL_SECONDS } from '../files/file-token';
import { signPersonalDataFileUrls } from './personal-data';
import { maskPersonalData } from './personal-data-mask';

export function toSafe(user: User, mask = false) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarding the hash + reset-token fields deliberately
  const { password, resetPasswordToken, resetPasswordExpires, ...safe } = user;
  if (safe.profileImage) {
    // Held in AuthContext for the whole session, not re-fetched on every
    // navigation — see SESSION_ASSET_TTL_SECONDS' comment.
    safe.profileImage = `/files/${signFileToken(safe.organizationId, safe.profileImage, SESSION_ASSET_TTL_SECONDS)}`;
  }
  if (safe.personalData && typeof safe.personalData === 'object') {
    safe.personalData = signPersonalDataFileUrls(
      mask
        ? maskPersonalData(safe.personalData as Record<string, unknown>)
        : (safe.personalData as Record<string, unknown>),
      safe.organizationId,
    ) as unknown as User['personalData'];
  }
  return safe;
}
