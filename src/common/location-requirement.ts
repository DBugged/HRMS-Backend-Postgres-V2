import { LocationRequirement } from '@prisma/client';

// What location a check-in/out needs - the one rule used by the punch endpoint and /auth/me (so the mobile app knows
// whether to read the GPS at all):
//   ENFORCED    - location is read and, when a work location is assigned, the person must be inside it
//   RECORD_ONLY - location is read and stored but never blocks a punch (field staff)
//   NOT_NEEDED  - no location is taken at all (a selfie alone)
// The employee's own setting wins; DEFAULT follows the organization's attendance prefs (`locationMode`). Anything
// unset or unrecognised is ENFORCED, so organizations that predate the setting keep exactly today's behaviour.
export type LocationMode = 'ENFORCED' | 'RECORD_ONLY' | 'NOT_NEEDED';

export const LOCATION_MODES: LocationMode[] = [
  'ENFORCED',
  'RECORD_ONLY',
  'NOT_NEEDED',
];

export function resolveLocationMode(
  employeeSetting: LocationRequirement | null | undefined,
  orgAttendancePrefs: unknown,
): LocationMode {
  if (
    employeeSetting === LocationRequirement.ENFORCED ||
    employeeSetting === LocationRequirement.RECORD_ONLY ||
    employeeSetting === LocationRequirement.NOT_NEEDED
  ) {
    return employeeSetting;
  }
  const prefs = (orgAttendancePrefs ?? {}) as { locationMode?: unknown };
  return LOCATION_MODES.includes(prefs.locationMode as LocationMode)
    ? (prefs.locationMode as LocationMode)
    : 'ENFORCED';
}
