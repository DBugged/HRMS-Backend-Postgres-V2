import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

// Marks a route as reachable by a user who still has
// User.mustChangePassword = true — the explicit opt-out from
// PasswordRotationGuard. Deliberately tiny: only what the force-password-
// change screen itself needs to render and submit. Anything else stays
// blocked until the temporary password has actually been rotated.
export const AllowPendingPasswordChange = () =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
