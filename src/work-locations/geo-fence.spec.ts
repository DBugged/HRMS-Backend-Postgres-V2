import { FenceType } from '@prisma/client';
import {
  accuracyAllowanceMeters,
  deriveCircleSummary,
  distanceMeters,
  distanceOutsideFenceMeters,
  isInsideGeoFenceWithAccuracy,
  MAX_ACCURACY_ALLOWANCE_METERS,
  isInsideGeoFence,
  isPointInCircle,
  isPointInPolygon,
  isPointInRectangle,
} from './geo-fence';

// Mumbai office coordinates used throughout — arbitrary but realistic.
const OFFICE_LAT = 19.076;
const OFFICE_LNG = 72.8777;

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(OFFICE_LAT, OFFICE_LNG, OFFICE_LAT, OFFICE_LNG)).toBe(
      0,
    );
  });

  it('matches a known real-world distance (roughly)', () => {
    // Mumbai (19.076, 72.8777) to Pune (18.5204, 73.8567) is ~120km.
    const d = distanceMeters(19.076, 72.8777, 18.5204, 73.8567);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(130000);
  });
});

describe('isPointInCircle', () => {
  it('true when within the radius', () => {
    expect(
      isPointInCircle(OFFICE_LAT, OFFICE_LNG, OFFICE_LAT, OFFICE_LNG, 200),
    ).toBe(true);
  });

  it('false when outside the radius', () => {
    expect(isPointInCircle(19.2, 73.2, OFFICE_LAT, OFFICE_LNG, 200)).toBe(
      false,
    );
  });

  it('null when any input is non-finite (missing data, not "outside")', () => {
    expect(
      isPointInCircle(NaN, OFFICE_LNG, OFFICE_LAT, OFFICE_LNG, 200),
    ).toBeNull();
  });
});

describe('isPointInRectangle', () => {
  const bounds: [number, number][] = [
    [19.0, 72.8],
    [19.2, 73.0],
  ];

  it('true for a point inside the box, regardless of corner order', () => {
    expect(isPointInRectangle(19.1, 72.9, bounds)).toBe(true);
  });

  it('false for a point outside the box', () => {
    expect(isPointInRectangle(20.0, 72.9, bounds)).toBe(false);
  });

  it('null when bounds is missing or malformed', () => {
    expect(isPointInRectangle(19.1, 72.9, undefined)).toBeNull();
    expect(isPointInRectangle(19.1, 72.9, [[19.0, 72.8]])).toBeNull();
  });
});

describe('isPointInPolygon', () => {
  // A simple square: (19.0,72.8) -> (19.0,73.0) -> (19.2,73.0) -> (19.2,72.8)
  const vertices: [number, number][] = [
    [19.0, 72.8],
    [19.0, 73.0],
    [19.2, 73.0],
    [19.2, 72.8],
  ];

  it('true for a point inside the polygon', () => {
    expect(isPointInPolygon(19.1, 72.9, vertices)).toBe(true);
  });

  it('false for a point outside the polygon', () => {
    expect(isPointInPolygon(20.0, 72.9, vertices)).toBe(false);
  });

  it('null when fewer than 3 vertices are given', () => {
    expect(
      isPointInPolygon(19.1, 72.9, [
        [19.0, 72.8],
        [19.2, 73.0],
      ]),
    ).toBeNull();
  });
});

describe('isInsideGeoFence', () => {
  it('dispatches to circle logic by default', () => {
    const location = {
      fenceType: FenceType.CIRCLE,
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 200,
      boundary: null,
    };
    expect(isInsideGeoFence(OFFICE_LAT, OFFICE_LNG, location)).toBe(true);
  });

  it('dispatches to rectangle logic', () => {
    const location = {
      fenceType: FenceType.RECTANGLE,
      latitude: 19.1,
      longitude: 72.9,
      radiusMeters: 200,
      boundary: {
        bounds: [
          [19.0, 72.8],
          [19.2, 73.0],
        ],
      },
    };
    expect(isInsideGeoFence(19.1, 72.9, location)).toBe(true);
    expect(isInsideGeoFence(20.0, 72.9, location)).toBe(false);
  });

  it('dispatches to polygon logic', () => {
    const location = {
      fenceType: FenceType.POLYGON,
      latitude: 19.1,
      longitude: 72.9,
      radiusMeters: 200,
      boundary: {
        vertices: [
          [19.0, 72.8],
          [19.0, 73.0],
          [19.2, 73.0],
          [19.2, 72.8],
        ],
      },
    };
    expect(isInsideGeoFence(19.1, 72.9, location)).toBe(true);
  });

  it('null when the work location itself is missing', () => {
    expect(isInsideGeoFence(19.1, 72.9, null)).toBeNull();
  });

  it('null when the point is missing/non-finite', () => {
    const location = {
      fenceType: FenceType.CIRCLE,
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 200,
      boundary: null,
    };
    expect(isInsideGeoFence(NaN, 72.9, location)).toBeNull();
  });
});

describe('deriveCircleSummary', () => {
  it('passes circle values straight through', () => {
    const summary = deriveCircleSummary(
      FenceType.CIRCLE,
      null,
      OFFICE_LAT,
      OFFICE_LNG,
      150,
    );
    expect(summary).toEqual({
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 150,
    });
  });

  it('derives a centroid + bounding radius for a rectangle', () => {
    const summary = deriveCircleSummary(
      FenceType.RECTANGLE,
      {
        bounds: [
          [19.0, 72.8],
          [19.2, 73.0],
        ],
      },
      0,
      0,
      200,
    );
    expect(summary.latitude).toBeCloseTo(19.1, 5);
    expect(summary.longitude).toBeCloseTo(72.9, 5);
    expect(summary.radiusMeters).toBeGreaterThan(0);
  });

  it('derives a centroid + bounding radius for a polygon', () => {
    const summary = deriveCircleSummary(
      FenceType.POLYGON,
      {
        vertices: [
          [19.0, 72.8],
          [19.0, 73.0],
          [19.2, 73.0],
          [19.2, 72.8],
        ],
      },
      0,
      0,
      200,
    );
    expect(summary.latitude).toBeCloseTo(19.1, 5);
    expect(summary.longitude).toBeCloseTo(72.9, 5);
    expect(summary.radiusMeters).toBeGreaterThan(0);
  });

  it('falls back to given values when geometry is incomplete', () => {
    const summary = deriveCircleSummary(
      FenceType.RECTANGLE,
      null,
      OFFICE_LAT,
      OFFICE_LNG,
      0,
    );
    expect(summary).toEqual({
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 200,
    });
  });
});

describe('accuracy allowance', () => {
  // A point `m` metres north of the office (1 deg latitude ~ 111,195 m).
  const north = (m: number) => OFFICE_LAT + m / 111195;
  const circle = {
    fenceType: FenceType.CIRCLE,
    latitude: OFFICE_LAT,
    longitude: OFFICE_LNG,
    radiusMeters: 200,
    boundary: null,
  };

  it('caps the allowance and ignores a missing or invalid accuracy', () => {
    expect(accuracyAllowanceMeters(undefined)).toBe(0);
    expect(accuracyAllowanceMeters(-5)).toBe(0);
    expect(accuracyAllowanceMeters('abc')).toBe(0);
    expect(accuracyAllowanceMeters(30)).toBe(30);
    expect(accuracyAllowanceMeters(900)).toBe(MAX_ACCURACY_ALLOWANCE_METERS);
  });

  it('accepts a point just outside a circle only when the reading is that imprecise', () => {
    const p = north(215); // ~15 m outside the 200 m radius
    expect(isInsideGeoFence(p, OFFICE_LNG, circle)).toBe(false);
    expect(isInsideGeoFenceWithAccuracy(p, OFFICE_LNG, circle)).toBe(false);
    expect(isInsideGeoFenceWithAccuracy(p, OFFICE_LNG, circle, 10)).toBe(false);
    expect(isInsideGeoFenceWithAccuracy(p, OFFICE_LNG, circle, 20)).toBe(true);
  });

  it('never widens the fence beyond the cap, however poor the fix', () => {
    const p = north(200 + MAX_ACCURACY_ALLOWANCE_METERS + 30);
    expect(isInsideGeoFenceWithAccuracy(p, OFFICE_LNG, circle, 5000)).toBe(false);
  });

  it('measures the distance to the nearest edge of a rectangle and a polygon', () => {
    const deg = 100 / 111195; // ~100 m
    const rect = {
      fenceType: FenceType.RECTANGLE,
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 1,
      boundary: {
        bounds: [
          [OFFICE_LAT, OFFICE_LNG],
          [OFFICE_LAT + deg, OFFICE_LNG + deg],
        ],
      },
    };
    const outside = distanceOutsideFenceMeters(OFFICE_LAT + deg + 20 / 111195, OFFICE_LNG + deg / 2, rect);
    expect(outside).not.toBeNull();
    expect(outside as number).toBeGreaterThan(18);
    expect(outside as number).toBeLessThan(22);
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT + deg + 20 / 111195, OFFICE_LNG + deg / 2, rect, 25)).toBe(true);
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT + deg / 2, OFFICE_LNG + deg / 2, rect)).toBe(true);

    const poly = {
      fenceType: FenceType.POLYGON,
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 1,
      boundary: {
        vertices: [
          [OFFICE_LAT, OFFICE_LNG],
          [OFFICE_LAT + deg, OFFICE_LNG],
          [OFFICE_LAT + deg, OFFICE_LNG + deg],
        ],
      },
    };
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT + deg / 2, OFFICE_LNG + deg / 4, poly)).toBe(true);
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT - 15 / 111195, OFFICE_LNG, poly, 20)).toBe(true);
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT - 80 / 111195, OFFICE_LNG, poly, 20)).toBe(false);
  });

  it('stays null (unknown) when the geometry is incomplete', () => {
    const broken = { ...circle, fenceType: FenceType.POLYGON, boundary: { vertices: [[1, 2]] } };
    expect(isInsideGeoFenceWithAccuracy(OFFICE_LAT, OFFICE_LNG, broken, 30)).toBeNull();
  });
});
