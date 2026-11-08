import { FenceType } from '@prisma/client';
import { validateGeometry } from './geometry-validation';

describe('validateGeometry', () => {
  describe('CIRCLE', () => {
    it('passes with finite latitude/longitude', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.CIRCLE,
          latitude: 19.0,
          longitude: 72.8,
        }),
      ).not.toThrow();
    });

    it('throws when latitude/longitude are missing', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.CIRCLE,
          latitude: null,
          longitude: null,
        }),
      ).toThrow('Latitude and longitude are required for a circle geo-fence');
    });

    it('throws when latitude/longitude are non-finite', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.CIRCLE,
          latitude: Number.NaN,
          longitude: 72.8,
        }),
      ).toThrow(/circle geo-fence/);
    });
  });

  describe('RECTANGLE', () => {
    it('passes with two well-formed corner points', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.RECTANGLE,
          boundary: {
            bounds: [
              [19.0, 72.8],
              [19.2, 73.0],
            ],
          },
        }),
      ).not.toThrow();
    });

    it('throws when bounds has the wrong number of points', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.RECTANGLE,
          boundary: { bounds: [[19.0, 72.8]] },
        }),
      ).toThrow(/two corner points/);
    });

    it('throws when bounds is missing entirely', () => {
      expect(() =>
        validateGeometry({ fenceType: FenceType.RECTANGLE, boundary: null }),
      ).toThrow(/two corner points/);
    });
  });

  describe('POLYGON', () => {
    it('passes with at least 3 well-formed vertices', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: {
            vertices: [
              [19.0, 72.8],
              [19.0, 73.0],
              [19.2, 73.0],
            ],
          },
        }),
      ).not.toThrow();
    });

    it('throws with fewer than 3 vertices', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: {
            vertices: [
              [19.0, 72.8],
              [19.0, 73.0],
            ],
          },
        }),
      ).toThrow(/at least 3 vertices/);
    });
  });
  describe('ranges and shape', () => {
    it('rejects a polygon point that is not a real coordinate', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: {
            vertices: [
              [19.0, 72.8],
              [999, -5000],
              [19.2, 73.0],
            ],
          },
        }),
      ).toThrow(/at least 3 vertices/);
    });

    it('rejects a polygon whose points are all on one line', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: {
            vertices: [
              [19.0, 72.8],
              [19.1, 72.9],
              [19.2, 73.0],
            ],
          },
        }),
      ).toThrow(/enclose an area/);
    });

    it('rejects a polygon with too many vertices', () => {
      const vertices = Array.from({ length: 201 }, (_, i) => [
        19 + Math.cos(i) * 0.01,
        72.8 + Math.sin(i) * 0.01,
      ]);
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: { vertices },
        }),
      ).toThrow(/at most 200 vertices/);
    });

    it('accepts 200 vertices', () => {
      const vertices = Array.from({ length: 200 }, (_, i) => [
        19 + Math.cos(i) * 0.01,
        72.8 + Math.sin(i) * 0.01,
      ]);
      expect(() =>
        validateGeometry({
          fenceType: FenceType.POLYGON,
          boundary: { vertices },
        }),
      ).not.toThrow();
    });

    it('rejects a rectangle with no area', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.RECTANGLE,
          boundary: {
            bounds: [
              [19.0, 72.8],
              [19.0, 73.0],
            ],
          },
        }),
      ).toThrow(/differ in both latitude and longitude/);
    });

    it('rejects a rectangle corner outside the valid ranges', () => {
      expect(() =>
        validateGeometry({
          fenceType: FenceType.RECTANGLE,
          boundary: {
            bounds: [
              [19.0, 72.8],
              [95, 73.0],
            ],
          },
        }),
      ).toThrow(/two corner points/);
    });
  });
});
