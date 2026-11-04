// Purpose: The pure rules behind live tracking of field staff: what a phone may send, how a person's current status is
//   worked out, and how a day's points become a distance and a list of stops.
// Important: nothing here touches the database. Tracking runs only during a shift and only for people Admin / HR switched it
//   on for who consented; the service enforces that, this file only judges the points themselves.
export const TRACKING = {
  /** How often the phone samples while on shift. */
  intervalSeconds: 300,
  /** ...or sooner when the person has moved this far. */
  minDistanceMeters: 200,
  retentionDays: 60,
  /** No point for this long during a shift = Offline (about 4 missed samples). */
  offlineAfterMinutes: 20,
  /** A stop is staying within this radius for at least this long. */
  stopRadiusMeters: 100,
  stopMinMinutes: 10,
  movingSpeedMps: 1.0,
  /** Hops smaller than this are GPS jitter, not travel. */
  jitterMeters: 25,
  /** Faster than this (m/s, ~216 km/h) between two points is a glitch, not travel. */
  impossibleSpeedMps: 60,
  maxBatch: 100,
  /** A queued point older than this is not accepted. */
  maxAgeHours: 36,
  futureSkewMinutes: 5,
} as const;

/** What a company may change, and the range each value must stay in. */
export const TRACKING_LIMITS = {
  intervalSeconds: { min: 120, max: 1800 },
  minDistanceMeters: { min: 50, max: 1000 },
  retentionDays: { min: 7, max: 365 },
} as const;

export interface TrackingSettings {
  intervalSeconds: number;
  minDistanceMeters: number;
  retentionDays: number;
}

export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  intervalSeconds: TRACKING.intervalSeconds,
  minDistanceMeters: TRACKING.minDistanceMeters,
  retentionDays: TRACKING.retentionDays,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

/** A company's stored settings (anything missing or out of range falls back / is pulled into range). */
export function resolveTrackingSettings(raw: unknown): TrackingSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const L = TRACKING_LIMITS;
  return {
    intervalSeconds: clampInt(
      o.intervalSeconds,
      L.intervalSeconds.min,
      L.intervalSeconds.max,
      TRACKING.intervalSeconds,
    ),
    minDistanceMeters: clampInt(
      o.minDistanceMeters,
      L.minDistanceMeters.min,
      L.minDistanceMeters.max,
      TRACKING.minDistanceMeters,
    ),
    retentionDays: clampInt(
      o.retentionDays,
      L.retentionDays.min,
      L.retentionDays.max,
      TRACKING.retentionDays,
    ),
  };
}

/**
 * What an Admin / HR submits: every field must be a whole number inside its range, otherwise the problems are listed
 * (a save is refused rather than quietly adjusted).
 */
export function validateTrackingSettingsInput(raw: unknown): {
  settings?: TrackingSettings;
  errors: string[];
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const errors: string[] = [];
  const labels = {
    intervalSeconds: 'Sharing interval (seconds)',
    minDistanceMeters: 'Early-point distance (metres)',
    retentionDays: 'Keep points for (days)',
  } as const;
  const out: Record<string, number> = {};
  for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
    const v = o[key];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    const { min, max } = TRACKING_LIMITS[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      errors.push(
        `${labels[key]} must be a whole number from ${min} to ${max}.`,
      );
    } else out[key] = n;
  }
  return errors.length
    ? { errors }
    : { settings: out as unknown as TrackingSettings, errors };
}

/** A person is Offline after missing about four samples (never sooner than the original 20 minutes). */
export function offlineAfterMinutesFor(intervalSeconds: number): number {
  return Math.max(
    TRACKING.offlineAfterMinutes,
    Math.ceil((intervalSeconds * 4) / 60),
  );
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export interface RawPing {
  recordedAt?: unknown;
  kind?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  accuracyMeters?: unknown;
  speedMps?: unknown;
  batteryPercent?: unknown;
  isMock?: unknown;
}

export interface CleanPing {
  recordedAt: Date;
  kind: 'POINT' | 'LOCATION_OFF';
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  speedMps: number | null;
  batteryPercent: number | null;
  isMock: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** One point from the phone as a clean row, or the reason it is refused. */
export function cleanPing(
  raw: RawPing,
  now: Date,
): { ok: true; ping: CleanPing } | { ok: false; reason: string } {
  const at =
    typeof raw.recordedAt === 'string' || typeof raw.recordedAt === 'number'
      ? new Date(raw.recordedAt)
      : null;
  if (!at || Number.isNaN(at.getTime()))
    return { ok: false, reason: 'bad time' };
  if (at.getTime() > now.getTime() + TRACKING.futureSkewMinutes * 60_000)
    return { ok: false, reason: 'in the future' };
  if (at.getTime() < now.getTime() - TRACKING.maxAgeHours * 3_600_000)
    return { ok: false, reason: 'too old' };
  const kind = raw.kind === 'LOCATION_OFF' ? 'LOCATION_OFF' : 'POINT';
  const battery = num(raw.batteryPercent);
  const common = {
    recordedAt: at,
    kind,
    batteryPercent:
      battery === null ? null : Math.max(0, Math.min(100, Math.round(battery))),
    isMock: raw.isMock === true,
  } as const;
  if (kind === 'LOCATION_OFF') {
    return {
      ok: true,
      ping: {
        ...common,
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        speedMps: null,
      },
    };
  }
  const lat = num(raw.latitude);
  const lng = num(raw.longitude);
  if (
    lat === null ||
    lng === null ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return { ok: false, reason: 'bad coordinates' };
  }
  // 0,0 is what a phone reports before it has a fix.
  if (lat === 0 && lng === 0) return { ok: false, reason: 'no fix' };
  const acc = num(raw.accuracyMeters);
  const speed = num(raw.speedMps);
  return {
    ok: true,
    ping: {
      ...common,
      latitude: lat,
      longitude: lng,
      accuracyMeters: acc !== null && acc >= 0 ? acc : null,
      speedMps: speed !== null && speed >= 0 ? speed : null,
    },
  };
}

export type TrackingStatus =
  | 'OFF_SHIFT'
  | 'NO_DATA'
  | 'LOCATION_OFF'
  | 'OFFLINE'
  | 'MOVING'
  | 'STATIONARY';

export interface StatusInput {
  /** The company's Offline threshold; defaults to the built-in one. */
  offlineAfterMinutes?: number;
  onShift: boolean;
  now: Date;
  /** The newest record of any kind (a LOCATION_OFF marker counts). */
  last: { kind: string; recordedAt: Date } | null;
  /** The two newest POINTs (newest first), to tell moving from stationary. */
  points: {
    latitude: number;
    longitude: number;
    recordedAt: Date;
    speedMps: number | null;
  }[];
}

export function deriveStatus(i: StatusInput): TrackingStatus {
  if (!i.onShift) return 'OFF_SHIFT';
  if (!i.last) return 'NO_DATA';
  if (i.last.kind === 'LOCATION_OFF') return 'LOCATION_OFF';
  const ageMin = (i.now.getTime() - i.last.recordedAt.getTime()) / 60_000;
  if (ageMin > (i.offlineAfterMinutes ?? TRACKING.offlineAfterMinutes))
    return 'OFFLINE';
  const [a, b] = i.points;
  if (a && (a.speedMps ?? 0) >= TRACKING.movingSpeedMps) return 'MOVING';
  if (a && b && haversineMeters(a, b) > TRACKING.stopRadiusMeters)
    return 'MOVING';
  return 'STATIONARY';
}

export interface RoutePoint extends GeoPoint {
  recordedAt: Date;
  accuracyMeters?: number | null;
}

export interface Stop {
  latitude: number;
  longitude: number;
  from: Date;
  to: Date;
  minutes: number;
}

/** Distance travelled (jitter and impossible jumps ignored) and the places the person stayed. Points must be oldest first. */
export function summarizeRoute(points: RoutePoint[]): {
  distanceMeters: number;
  stops: Stop[];
} {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineMeters(points[i - 1], points[i]);
    const dt =
      (points[i].recordedAt.getTime() - points[i - 1].recordedAt.getTime()) /
      1000;
    if (d < TRACKING.jitterMeters) continue;
    if (dt > 0 && d / dt > TRACKING.impossibleSpeedMps) continue;
    distance += d;
  }
  const stops: Stop[] = [];
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (
      j + 1 < points.length &&
      haversineMeters(points[i], points[j + 1]) <= TRACKING.stopRadiusMeters
    )
      j++;
    const minutes =
      (points[j].recordedAt.getTime() - points[i].recordedAt.getTime()) /
      60_000;
    if (j > i && minutes >= TRACKING.stopMinMinutes) {
      const slice = points.slice(i, j + 1);
      stops.push({
        latitude: slice.reduce((s, p) => s + p.latitude, 0) / slice.length,
        longitude: slice.reduce((s, p) => s + p.longitude, 0) / slice.length,
        from: points[i].recordedAt,
        to: points[j].recordedAt,
        minutes: Math.round(minutes),
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { distanceMeters: Math.round(distance), stops };
}
