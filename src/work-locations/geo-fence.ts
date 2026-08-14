import { FenceType } from '@prisma/client';

/**
 * Geo-fence geometry helpers, direct port of the old backend's
 * `utils/geoFence.js`. Shared by WorkLocations (config, this module) and
 * Attendance (validation, Batch 6 — not built yet). Three fence types:
 * CIRCLE (legacy — center + radiusMeters), RECTANGLE (two corner points,
 * axis-aligned lat/lng box), and POLYGON (unlimited vertices).
 *
 * Pure functions, no Prisma/NestJS dependency — unit-tested directly
 * against plain numbers/objects, same reasoning as evaluateTenantScope.
 */

const EARTH_RADIUS_METERS = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns null (not false) when there isn't enough data to evaluate —
// callers must treat null as "unknown", not "outside".
export function isPointInCircle(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  radiusMeters: number,
): boolean | null {
  if (![lat, lng, centerLat, centerLng, radiusMeters].every(Number.isFinite)) {
    return null;
  }
  return distanceMeters(lat, lng, centerLat, centerLng) <= radiusMeters;
}

// bounds: [[latA, lngA], [latB, lngB]] — any two opposite corners of an
// axis-aligned box.
export function isPointInRectangle(
  lat: number,
  lng: number,
  bounds: [number, number][] | undefined | null,
): boolean | null {
  if (!Array.isArray(bounds) || bounds.length !== 2) return null;
  const [[latA, lngA], [latB, lngB]] = bounds;
  if (![lat, lng, latA, lngA, latB, lngB].every(Number.isFinite)) return null;
  const minLat = Math.min(latA, latB);
  const maxLat = Math.max(latA, latB);
  const minLng = Math.min(lngA, lngB);
  const maxLng = Math.max(lngA, lngB);
  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
}

// vertices: [[lat, lng], ...] (>= 3). Standard ray-casting point-in-polygon
// test.
export function isPointInPolygon(
  lat: number,
  lng: number,
  vertices: [number, number][] | undefined | null,
): boolean | null {
  if (!Array.isArray(vertices) || vertices.length < 3) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [latI, lngI] = vertices[i];
    const [latJ, lngJ] = vertices[j];
    const intersect =
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (intersect) inside = !inside;
  }
  return inside;
}

export interface GeoFenceable {
  fenceType: FenceType;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  // Prisma's generated JsonValue type doesn't know the shape we store here
  // (see the `boundary` field's doc comment on the WorkLocation model) —
  // callers pass the raw Prisma row through and this function casts
  // internally rather than forcing every call site to.
  boundary: unknown;
}

// Dispatches on workLocation.fenceType. Returns null when there isn't
// enough data to evaluate (missing point or malformed/incomplete geometry)
// rather than guessing.
export function isInsideGeoFence(
  lat: number,
  lng: number,
  workLocation: GeoFenceable | null | undefined,
): boolean | null {
  if (!workLocation || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const type = workLocation.fenceType || FenceType.CIRCLE;
  const boundary = workLocation.boundary as
    | { bounds?: [number, number][]; vertices?: [number, number][] }
    | null
    | undefined;
  if (type === FenceType.RECTANGLE) {
    return isPointInRectangle(lat, lng, boundary?.bounds);
  }
  if (type === FenceType.POLYGON) {
    return isPointInPolygon(lat, lng, boundary?.vertices);
  }
  return isPointInCircle(
    lat,
    lng,
    workLocation.latitude,
    workLocation.longitude,
    workLocation.radiusMeters,
  );
}

export interface CircleSummary {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

// Derives a legacy-compatible centroid + bounding radius for rectangle/
// polygon fences so latitude/longitude/radiusMeters always describe a
// sensible equivalent circle. Circle fences pass their own values straight
// through unchanged.
export function deriveCircleSummary(
  fenceType: FenceType,
  boundary:
    | { bounds?: [number, number][]; vertices?: [number, number][] }
    | null
    | undefined,
  fallbackLat: number,
  fallbackLng: number,
  fallbackRadius: number,
): CircleSummary {
  if (fenceType === FenceType.RECTANGLE && boundary?.bounds?.length === 2) {
    const [[latA, lngA], [latB, lngB]] = boundary.bounds;
    const centerLat = (latA + latB) / 2;
    const centerLng = (lngA + lngB) / 2;
    return {
      latitude: centerLat,
      longitude: centerLng,
      radiusMeters: Math.max(
        Math.round(distanceMeters(centerLat, centerLng, latA, lngA)),
        1,
      ),
    };
  }
  if (
    fenceType === FenceType.POLYGON &&
    boundary?.vertices &&
    boundary.vertices.length >= 3
  ) {
    const vertices = boundary.vertices;
    const centerLat = vertices.reduce((s, v) => s + v[0], 0) / vertices.length;
    const centerLng = vertices.reduce((s, v) => s + v[1], 0) / vertices.length;
    const radius = Math.max(
      ...vertices.map((v) => distanceMeters(centerLat, centerLng, v[0], v[1])),
    );
    return {
      latitude: centerLat,
      longitude: centerLng,
      radiusMeters: Math.max(Math.round(radius), 1),
    };
  }
  return {
    latitude: Number(fallbackLat),
    longitude: Number(fallbackLng),
    radiusMeters: Number(fallbackRadius) || 200,
  };
}
