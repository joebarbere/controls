import { BUILTIN_CATALOG } from '@controls/catalog';
import { BARE, CABLE, CUTTER, freeAt, STRIPPER, WIRE, WIRING_TEST_CATALOG, wiringBench } from '../../testing';
import { laneSizeTenths, strandedDiameterFactor } from './lanes';
import { bakeCableEnds, cableFaceAxis, fanAxis } from './tails';

/*
 * Cable ends (F3.2 part 4): the jacket stub into the box and each conductor's tail, baked from the
 * world, never stored. Over the TEST-ONLY wiring bench: a 14/2-with-ground test cable from box 5's top
 * entry (25, 75, 2030), inward −y, to a free end.
 */

const ROUTE = [freeAt(25, 500, 2030), freeAt(500, 500, 1000)];

function benchWithCable() {
  const bus = wiringBench();
  const added = bus.exec('cable.add', {
    ref: CABLE,
    a: { entity: 5, entry: 'top' },
    b: null,
    route: ROUTE,
    lengthMm: 2000,
    tailsMm: { a: 200, b: 0 },
    tool: CUTTER,
  });
  expect(added.ok).toBe(true);
  return bus;
}

describe('bakeCableEnds', () => {
  it('draws the whole tail as jacket while nothing is stripped, and no conductor tails', () => {
    const bus = benchWithCable();
    expect(bakeCableEnds(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([
      { cable: 1, end: 'a', jacket: [250, 750, 20300, 250, -1250, 20300], tails: [] },
      { cable: 1, end: 'b', jacket: [], tails: [] },
    ]);
  });

  it('ends the jacket where the strip begins; stubs fan across the entry and a landed tail runs to its terminal', () => {
    const bus = benchWithCable();
    bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: STRIPPER });
    expect(
      bus.exec('wire.land', { id: 3, end: 'a', at: { entity: 5, terminal: 'ground', termination: 'auto' } }).ok,
    ).toBe(true);
    const [a] = bakeCableEnds(bus.state, WIRING_TEST_CATALOG);
    // The jacket: 50 mm in from the entry, to (25, 25, 2030).
    expect(a.jacket).toStrictEqual([250, 750, 20300, 250, 250, 20300]);
    // Three conductors fanned along +x (the entry is along y), one diameter apart, centred.
    const w = laneSizeTenths(WIRING_TEST_CATALOG, 'conductor', WIRE).width;
    const g = laneSizeTenths(WIRING_TEST_CATALOG, 'conductor', BARE).width;
    const span = 2 * w + g;
    const x0 = 250 + Math.round(-span / 2 + w / 2);
    const x1 = 250 + Math.round(-span / 2 + w + w / 2);
    const x2 = 250 + Math.round(-span / 2 + 2 * w + g / 2);
    expect(a.tails).toStrictEqual([
      { connection: 1, conductor: 0, landed: false, points: [x0, 250, 20300, x0, -1250, 20300] },
      { connection: 2, conductor: 1, landed: false, points: [x1, 250, 20300, x1, -1250, 20300] },
      // The bare EGC to the box's ground screw (10, 0, 2005), through its 12 mm lead-out along +z.
      { connection: 3, conductor: 2, landed: true, points: [x2, 250, 20300, 100, 0, 20170, 100, 0, 20050] },
    ]);
    expect(x0).toBeLessThan(x1);
    expect(x1).toBeLessThan(x2);
  });

  it('draws a landed conductor at a free cable end from the rest waypoint', () => {
    const bus = wiringBench();
    // End b is free, resting at (-100, 0, 2005), 110 mm from box 5's ground screw (10, 0, 2005).
    const added = bus.exec('cable.add', {
      ref: CABLE,
      a: { entity: 5, entry: 'top' },
      b: null,
      route: [freeAt(25, 500, 2030), freeAt(-100, 0, 2005)],
      lengthMm: 2000,
      tailsMm: { a: 200, b: 150 },
      tool: CUTTER,
    });
    expect(added.ok).toBe(true);
    expect(bakeCableEnds(bus.state, WIRING_TEST_CATALOG)[1]).toStrictEqual({
      cable: 1,
      end: 'b',
      jacket: [],
      tails: [],
    });
    bus.exec('cable.strip', { id: 1, end: 'b', jacketMm: 150, tool: STRIPPER });
    const land = bus.exec('wire.land', { id: 3, end: 'b', at: { entity: 5, terminal: 'ground', termination: 'auto' } });
    expect(land.ok).toBe(true);
    expect(bakeCableEnds(bus.state, WIRING_TEST_CATALOG)[1]).toStrictEqual({
      cable: 1,
      end: 'b',
      jacket: [],
      tails: [{ connection: 3, conductor: 2, landed: true, points: [-1000, 0, 20050, 100, 0, 20170, 100, 0, 20050] }],
    });
  });

  it('is a pure function of the world (same input, same output; nothing stored)', () => {
    const bus = benchWithCable();
    bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 120, tool: STRIPPER });
    const before = JSON.stringify(bus.state);
    expect(bakeCableEnds(bus.state, WIRING_TEST_CATALOG)).toStrictEqual(bakeCableEnds(bus.state, WIRING_TEST_CATALOG));
    expect(JSON.stringify(bus.state)).toBe(before);
  });

  it("the face axis is the stud wall's u axis, turned with the wall (realism F2)", () => {
    const studs = (yaw: number) => ({
      ...wiringBench('trainee', 7, { studWall: true }).state.fixtures[0],
      transform: { positionMm: { x: -3000, y: 0, z: -3000 }, orientationMdeg: { yaw, pitch: 0, roll: 0 } },
    });
    const staple = {
      kind: 'staple' as const,
      positionMm: { x: 0, y: 0, z: 0 },
      entity: null,
      fixture: 'studs',
      tool: null,
    };
    expect(cableFaceAxis({ fixtures: [studs(0)] }, { route: [staple] })).toStrictEqual({ x: 1, y: 0, z: 0 });
    expect(Math.abs(cableFaceAxis({ fixtures: [studs(90_000)] }, { route: [staple] })?.z ?? 0)).toBe(1);
    expect(cableFaceAxis({ fixtures: [studs(0)] }, { route: [{ ...staple, kind: 'free', fixture: null }] })).toBeNull();
    // Vertical entries fan across the face axis's perpendicular: along z on a wall whose u is x.
    expect(fanAxis({ x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 })).toStrictEqual({ x: 0, y: 0, z: 1 });
  });

  it('fans across the entry: +z for an entry along x, +x otherwise', () => {
    expect(fanAxis({ x: -1, y: 0, z: 0 })).toStrictEqual({ x: 0, y: 0, z: 1 });
    expect(fanAxis({ x: 0, y: -1, z: 0 })).toStrictEqual({ x: 1, y: 0, z: 0 });
    expect(fanAxis({ x: 0, y: 0, z: 1 })).toStrictEqual({ x: 1, y: 0, z: 0 });
  });
});

describe('stranded conductor diameters (laneSizeTenths, the #111 follow-up)', () => {
  it('a concentric bundle is (2k + 1)/√n times the solid diameter of the same area', () => {
    expect(strandedDiameterFactor(1)).toBe(1);
    expect(strandedDiameterFactor(7)).toBeCloseTo(3 / Math.sqrt(7), 12);
    expect(strandedDiameterFactor(19)).toBeCloseTo(5 / Math.sqrt(19), 12);
    expect(strandedDiameterFactor(37)).toBeCloseTo(7 / Math.sqrt(37), 12);
    expect(strandedDiameterFactor(3)).toBe(strandedDiameterFactor(7));
    // Bunched counts (MTW's 16 and 26 strands) are capped at the 7-strand factor (realism F5).
    expect(strandedDiameterFactor(16)).toBe(strandedDiameterFactor(7));
    expect(strandedDiameterFactor(26)).toBe(strandedDiameterFactor(7));
  });

  it('a stranded THHN is drawn wider than the solid one of the same AWG, by its metal only', () => {
    const solid = laneSizeTenths(BUILTIN_CATALOG, 'conductor', {
      id: 'conductor.tallowmere-thhn-14-solid',
      version: 1,
    });
    const stranded = laneSizeTenths(BUILTIN_CATALOG, 'conductor', {
      id: 'conductor.tallowmere-thhn-14-stranded',
      version: 1,
    });
    expect(stranded.width).toBeGreaterThan(solid.width);
    // 14 AWG is 1.628 mm solid; 7 strands sit 3/√7 of that, about 0.22 mm wider.
    expect(stranded.width - solid.width).toBeGreaterThanOrEqual(2);
    expect(stranded.width - solid.width).toBeLessThanOrEqual(3);
  });
});
