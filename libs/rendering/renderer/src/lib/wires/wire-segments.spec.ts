import fc from 'fast-check';
import { BUILTIN_CATALOG } from '@controls/catalog';
import {
  coilDrawnTurns,
  coilPolylineMm,
  COIL_DIAMETER_MM,
  COIL_MAX_DRAWN_TURNS,
  COIL_SEGMENTS_PER_TURN,
  forEachRouteSegment,
  halfAt,
  polylineLengthMm,
  SLEEVE_OFFSET_MM,
  sleevePlacements,
} from './wire-segments';
import {
  BARE_LOOK,
  cableAppearance,
  colourHex,
  conductorAppearance,
  DEFAULT_LOOK_FINISH,
  hexString,
  lookFinish,
  UNKNOWN_LOOK,
  UNKNOWN_WIRE_COLOUR,
} from './wire-looks';

/** An L-shaped route in tenths: 100 mm along +x, then 50 mm along +y. */
const L = [0, 0, 0, 1000, 0, 0, 1000, 500, 0];

describe('wire segments', () => {
  it('turns a baked polyline (tenths) into mm segments, each with the half of the route it is in', () => {
    const seen: number[][] = [];
    const n = forEachRouteSegment(L, (ax, ay, az, bx, by, bz, half) => seen.push([ax, ay, az, bx, by, bz, half]));
    expect(n).toBe(2);
    expect(seen).toStrictEqual([
      [0, 0, 0, 100, 0, 0, 0], // its midpoint is 50 mm along, before the half (75 mm)
      [100, 0, 0, 100, 50, 0, 1],
    ]);
    expect(polylineLengthMm(L)).toBe(150);
    expect(forEachRouteSegment([5, 5, 5], () => expect.fail('no segment'))).toBe(0);
  });

  it('property: segments are contiguous, as many as the links, and the halves run a then b', () => {
    const point = fc.tuple(
      fc.integer({ min: -5000, max: 5000 }),
      fc.integer({ min: -5000, max: 5000 }),
      fc.integer({ min: -5000, max: 5000 }),
    );
    fc.assert(
      fc.property(fc.array(point, { minLength: 2, maxLength: 40 }), (points) => {
        const flat = points.flat();
        const halves: number[] = [];
        let last: number[] | null = null;
        let total = 0;
        const n = forEachRouteSegment(flat, (ax, ay, az, bx, by, bz, half) => {
          if (last) expect([ax, ay, az]).toStrictEqual(last);
          last = [bx, by, bz];
          halves.push(half);
          total += Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);
        });
        expect(n).toBe(points.length - 1);
        expect(last).toStrictEqual(points[points.length - 1].map((v) => v / 10));
        expect(total).toBeCloseTo(polylineLengthMm(flat), 6);
        // Never b before a.
        expect(halves.join('')).toMatch(/^0*1*$/);
      }),
    );
  });

  it('finds the half of the route a point is in (a coil hangs in one half)', () => {
    expect(halfAt(L, [200, 0, 0])).toBe(0); // 20 mm along of 150
    expect(halfAt(L, [1000, 0, 0])).toBe(1); // the corner, 100 mm along
    expect(halfAt(L, [1000, 450, 0])).toBe(1);
    expect(halfAt([0, 0, 0, 1000, 0, 0, 2000, 0, 0], [900, 0, 0])).toBe(1); // nearest vertex exactly half way: b
  });

  it('draws a coil as rings from its hanging point, at most three turns', () => {
    const short = { at: [1000, 2000, 300] as const, lengthTenths: 10 };
    expect(coilDrawnTurns(short)).toBe(1);
    const long = { at: [1000, 2000, 300] as const, lengthTenths: 300_000 };
    expect(coilDrawnTurns(long)).toBe(COIL_MAX_DRAWN_TURNS);
    const two = { at: [0, 0, 0] as const, lengthTenths: Math.ceil(2 * Math.PI * COIL_DIAMETER_MM * 10) };
    expect(coilDrawnTurns(two)).toBe(2);
    const ring = coilPolylineMm(short, 2);
    expect(ring).toHaveLength(3 * (COIL_SEGMENTS_PER_TURN + 1));
    // Starts at the hanging point and comes back round to it, one wire diameter further along +z.
    expect(ring.slice(0, 3)).toStrictEqual([100, 200, 30]);
    const end = ring.slice(-3);
    expect(end[0]).toBeCloseTo(100, 9);
    expect(end[1]).toBeCloseTo(200, 9);
    expect(end[2]).toBeCloseTo(32, 9);
    // The ring hangs below it: its lowest point a coil diameter down.
    expect(Math.min(...ring.filter((_, i) => i % 3 === 1))).toBeCloseTo(200 - COIL_DIAMETER_MM, 9);
  });

  it('puts a sleeve 25 mm in from each end, along the route, at most a third of the way on a short one', () => {
    const [a, b] = sleevePlacements(L);
    expect(a.at).toStrictEqual([SLEEVE_OFFSET_MM, 0, 0]);
    expect(a.direction).toStrictEqual([1, 0, 0]);
    expect(b.at).toStrictEqual([100, 50 - SLEEVE_OFFSET_MM, 0]);
    expect(b.direction).toStrictEqual([0, -1, 0]); // walking in from end b
    const short = sleevePlacements([0, 0, 0, 300, 0, 0]);
    expect(short.map((s) => s.at[0])).toStrictEqual([10, 20]);
    expect(sleevePlacements([1, 2, 3])).toStrictEqual([]);
  });
});

describe('wire looks', () => {
  it('a conductor looks like its insulation, coloured by its base colour, as wide as its lane', () => {
    const thhn = conductorAppearance(
      BUILTIN_CATALOG,
      { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
      {
        base: 'red',
        stripe: null,
      },
    );
    expect(thhn).toStrictEqual({ look: 'thhnThwn2', colour: 0xc62828, diameterMm: 2.6 });
    const bare = conductorAppearance(
      BUILTIN_CATALOG,
      { id: 'conductor.sorrelby-bare-12-solid', version: 1 },
      {
        base: 'bare',
        stripe: null,
      },
    );
    expect(bare.look).toBe(BARE_LOOK);
    expect(hexString(bare.colour)).toBe('#b87333');
    const unknown = conductorAppearance(BUILTIN_CATALOG, { id: 'conductor.nope', version: 1 }, null);
    expect(unknown).toMatchObject({ look: UNKNOWN_LOOK, colour: UNKNOWN_WIRE_COLOUR });
  });

  it('a cable looks like its jacket, round at the mean of its width and height', () => {
    const nm = cableAppearance(BUILTIN_CATALOG, { id: 'cable.sorrelby-nmb-12-2', version: 1 });
    expect(nm.look).toBe('nmbJacket');
    expect(hexString(nm.colour)).toBe('#f2c200');
    expect(nm.diameterMm).toBeCloseTo((10.2 + 5.1) / 2, 9); // the lane's tenths: 102 × 51
    expect(cableAppearance(BUILTIN_CATALOG, { id: 'cable.nope', version: 1 }).look).toBe(UNKNOWN_LOOK);
  });

  it('colours and finishes are display-only lookups with a fallback', () => {
    expect(colourHex(BUILTIN_CATALOG, 'green')).toBe(0x2e7d32);
    expect(colourHex(BUILTIN_CATALOG, 'chartreuse')).toBe(UNKNOWN_WIRE_COLOUR);
    expect(colourHex(BUILTIN_CATALOG, null)).toBe(UNKNOWN_WIRE_COLOUR);
    expect(hexString(0x00ff00)).toBe('#00ff00');
    expect(lookFinish('bare').metalness).toBeGreaterThan(0.5);
    expect(lookFinish('somethingNew')).toBe(DEFAULT_LOOK_FINISH);
    expect(lookFinish('constructor')).toBe(DEFAULT_LOOK_FINISH); // never a prototype key
  });
});
