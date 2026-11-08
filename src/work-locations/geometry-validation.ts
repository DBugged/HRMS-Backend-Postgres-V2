import { FenceType } from '@prisma/client';

/**
 * Port of the old workLocationController.js's inline `validateGeometry()`
 * helper, extracted to a pure function so it's independently unit-testable
 * rather than only reachable through a live HTTP request.
 */

export interface GeometryInput {
  fenceType: FenceType;
  boundary?: { bounds?: unknown; vertices?: unknown } | null;
  latitude?: number | null;
  longitude?: number | null;
}

// Throws a plain Error with a user-facing message on invalid geometry;
// callers translate that into a 400 (see WorkLocationsService).
export function validateGeometry(input: GeometryInput): void {
  const { fenceType, boundary, latitude, longitude } = input;

  if (fenceType === FenceType.CIRCLE) {
    if (
      latitude == null ||
      longitude == null ||
      !Number.isFinite(Number(latitude)) ||
      !Number.isFinite(Number(longitude))
    ) {
      throw new Error(
        'Latitude and longitude are required for a circle geo-fence.',
      );
    }
    return;
  }

  if (fenceType === FenceType.RECTANGLE) {
    const bounds = boundary?.bounds;
    if (!isValidPointPair(bounds, 2)) {
      throw new Error(
        'Rectangle geo-fence requires two corner points ([[lat,lng],[lat,lng]]).',
      );
    }
    // Both corners on one line (or the same point) make a fence with no area, which nobody can be inside.
    const [a, b] = bounds;
    if (a[0] === b[0] || a[1] === b[1]) {
      throw new Error(
        'Rectangle geo-fence corners must differ in both latitude and longitude.',
      );
    }
    return;
  }

  // FenceType.POLYGON
  const vertices = boundary?.vertices;
  if (!isValidPointPair(vertices, 3, true)) {
    throw new Error(
      'Polygon geo-fence requires at least 3 vertices ([[lat,lng], ...]).',
    );
  }
  if (vertices.length > MAX_POLYGON_VERTICES) {
    throw new Error(
      `Polygon geo-fence can have at most ${MAX_POLYGON_VERTICES} vertices.`,
    );
  }
  // All points on one line enclose no area.
  if (polygonArea(vertices) === 0) {
    throw new Error('Polygon geo-fence vertices must enclose an area.');
  }
}

// A punch is compared with every vertex, so the number is capped (a drawn fence needs far fewer).
export const MAX_POLYGON_VERTICES = 200;

// Shoelace formula on [lat, lng]; only used to tell "has an area" from "does not", so the unit does not matter.
function polygonArea(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2) < 1e-12 ? 0 : Math.abs(sum / 2);
}

function isValidPointPair(
  value: unknown,
  minLength: number,
  atLeast = false,
): value is [number, number][] {
  if (!Array.isArray(value)) return false;
  if (atLeast ? value.length < minLength : value.length !== minLength) {
    return false;
  }
  // Each point is [latitude, longitude]: real numbers inside the valid ranges.
  return value.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      p.every(Number.isFinite) &&
      Math.abs(p[0]) <= 90 &&
      Math.abs(p[1]) <= 180,
  );
}
