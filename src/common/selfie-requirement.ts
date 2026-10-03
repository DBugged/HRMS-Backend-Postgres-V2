import { SelfieRequirement } from '@prisma/client';

// Whether an employee must take a selfie to check in/out — the one rule used
// by the punch endpoint and /auth/me (so the mobile app knows whether to open
// the camera). The employee's own setting wins; DEFAULT follows the org's
// "Require selfie at check-in / check-out" (Organization Settings > General
// Settings), where anything but an explicit `false` means required, so orgs
// that predate the setting keep requiring it.
export function isSelfieRequired(
  employeeSetting: SelfieRequirement | null | undefined,
  orgAttendancePrefs: unknown,
): boolean {
  if (employeeSetting === SelfieRequirement.REQUIRED) return true;
  if (employeeSetting === SelfieRequirement.NOT_REQUIRED) return false;
  const prefs = (orgAttendancePrefs ?? {}) as {
    requireSelfieForPunch?: unknown;
  };
  return prefs.requireSelfieForPunch !== false;
}
