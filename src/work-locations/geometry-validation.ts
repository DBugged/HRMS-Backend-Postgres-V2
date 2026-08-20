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
    return;
  }

  // FenceType.POLYGON
  const vertices = boundary?.vertices;
  if (!isValidPointPair(vertices, 3, true)) {
    throw new Error(
      'Polygon geo-fence requires at least 3 vertices ([[lat,lng], ...]).',
    );
  }
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
  return value.every(
    (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
  );
}
