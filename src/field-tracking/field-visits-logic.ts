// Purpose: The pure rules for client visits of field employees: is a check-in at the client, what a visit may contain, and
//   the totals shown on the report.
// Important: no database here. A check-in is never refused for being far from the client (a client's pin is often rough); it is
//   recorded with the distance and flagged "outside range" so a manager can see it.
import { haversineMeters } from './field-tracking-logic';

export const VISIT = {
  defaultRadiusMeters: 150,
  minRadiusMeters: 50,
  maxRadiusMeters: 1000,
  /** A poor GPS fix may still count as being at the client, by up to this much of its own reported error. */
  accuracyAllowanceMeters: 100,
  /** A visit still checked in after this long is closed by the nightly job. */
  staleCheckInHours: 20,
  maxRangeDays: 62,
  maxAheadDays: 90,
} as const;

export interface ClientPlace {
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
}

/** How far the phone was from the client, and whether that is inside the radius (null when the client has no location). */
export function assessCheckIn(
  client: ClientPlace,
  at: { latitude: number; longitude: number; accuracyMeters?: number | null },
): { distanceMeters: number | null; withinRange: boolean | null } {
  if (client.latitude === null || client.longitude === null)
    return { distanceMeters: null, withinRange: null };
  const d = haversineMeters(
    { latitude: client.latitude, longitude: client.longitude },
    at,
  );
  const allowance = Math.min(
    Math.max(at.accuracyMeters ?? 0, 0),
    VISIT.accuracyAllowanceMeters,
  );
  return {
    distanceMeters: Math.round(d),
    withinRange: d <= client.radiusMeters + allowance,
  };
}

export function visitMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

export interface VisitInput {
  clientName?: unknown;
  address?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  radiusMeters?: unknown;
  purpose?: unknown;
}

export interface CleanVisit {
  clientName: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
  purpose: string;
}

const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

/** The visit's own fields, cleaned, or the reason they are not acceptable. */
export function cleanVisitInput(
  raw: VisitInput,
): { ok: true; value: CleanVisit } | { ok: false; reason: string } {
  const clientName = text(raw.clientName, 120);
  if (!clientName)
    return { ok: false, reason: 'Enter the client or place to visit.' };
  const hasLat =
    raw.latitude !== undefined && raw.latitude !== null && raw.latitude !== '';
  const hasLng =
    raw.longitude !== undefined &&
    raw.longitude !== null &&
    raw.longitude !== '';
  if (hasLat !== hasLng)
    return {
      ok: false,
      reason: 'Give both the latitude and the longitude, or neither.',
    };
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (hasLat && hasLng) {
    latitude = Number(raw.latitude);
    longitude = Number(raw.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return { ok: false, reason: 'The location is not valid.' };
    }
  }
  const radius =
    raw.radiusMeters === undefined ||
    raw.radiusMeters === null ||
    raw.radiusMeters === ''
      ? VISIT.defaultRadiusMeters
      : Number(raw.radiusMeters);
  if (
    !Number.isInteger(radius) ||
    radius < VISIT.minRadiusMeters ||
    radius > VISIT.maxRadiusMeters
  ) {
    return {
      ok: false,
      reason: `The allowed distance must be between ${VISIT.minRadiusMeters} and ${VISIT.maxRadiusMeters} metres.`,
    };
  }
  return {
    ok: true,
    value: {
      clientName,
      address: text(raw.address, 300),
      latitude,
      longitude,
      radiusMeters: radius,
      purpose: text(raw.purpose, 500),
    },
  };
}

export interface VisitForTotals {
  status: string;
  durationMinutes: number | null;
  checkInWithinRange: boolean | null;
}

export function summarizeVisits(visits: VisitForTotals[]) {
  const count = (s: string) => visits.filter((v) => v.status === s).length;
  return {
    planned: count('PLANNED'),
    checkedIn: count('CHECKED_IN'),
    completed: count('COMPLETED'),
    missed: count('MISSED'),
    cancelled: count('CANCELLED'),
    outsideRange: visits.filter((v) => v.checkInWithinRange === false).length,
    minutesAtClients: visits.reduce((s, v) => s + (v.durationMinutes ?? 0), 0),
  };
}

/** YYYY-MM-DD plus n days (calendar arithmetic only). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}
