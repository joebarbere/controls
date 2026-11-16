import fc from 'fast-check';
import {
  autoWireArgs,
  BIT,
  BIT_29,
  BIT_38,
  CABLE,
  CUTTER,
  freeAt,
  PUNCH,
  STRIPPER,
  WIRING_TEST_CATALOG,
  wiringBench,
} from '../../testing';
import { BORE_DEPTH_MM, snapWaypoint } from '../routing/snap';
import { WALL_STUD_DEPTH } from '../snap/constants';
import type { Waypoint } from '../types';
import { checkTool } from './checks';
import {
  BORE_EDGE_MIN,
  BORED_HOLE_MAX,
  boreEdgeDistanceMm,
  boreNeedsNailPlate,
  boredHoleTooLarge,
  enclosureOnStudWall,
  inFraming,
  maxStripAtBoxMm,
  MIN_SHEATH_IN_BOX,
  NM_SUPPORT_SPACING,
  supportGap,
} from './framing';

/*
 * Cable in framing (F3.2 part 4): NM support spacing (NFPA 70 Art. 334.30 by number), the bored-hole
 * limit (IRC R602.6 by number) and the edge distance of a bore (NFPA 70 Art. 300.4(A)(1) by number).
 */

const refused = (code: string) => ({ ok: false, error: { code } });
const wp = (kind: Waypoint['kind'], y: number): Pick<Waypoint, 'kind' | 'positionMm'> => ({
  kind,
  positionMm: { x: 0, y, z: 0 },
});
const box = (y: number) => ({ x: 0, y, z: 0 });

describe('the sourced constants', () => {
  it('are exact inch conversions of the cited values, each with its source', () => {
    expect(NM_SUPPORT_SPACING.fromBoxMm).toBeCloseTo(12 * 25.4, 9);
    expect(NM_SUPPORT_SPACING.betweenMm).toBeCloseTo(54 * 25.4, 9);
    expect(NM_SUPPORT_SPACING.kind).toBe('real-world');
    expect(NM_SUPPORT_SPACING.source).toContain('Art. 334.30');
    expect(BORE_EDGE_MIN.valueMm).toBeCloseTo(1.25 * 25.4, 9);
    expect(BORE_EDGE_MIN.source).toContain('Art. 300.4(A)(1)');
    expect(BORED_HOLE_MAX.valueMm).toBeCloseTo((WALL_STUD_DEPTH.valueMm * 40) / 100, 9);
    expect(BORED_HOLE_MAX.source).toContain('R602.6');
    expect(BORED_HOLE_MAX.source).toContain('doubled');
    expect(MIN_SHEATH_IN_BOX.valueMm).toBeCloseTo(0.25 * 25.4, 9);
    expect(MIN_SHEATH_IN_BOX.source).toContain('Art. 314.17');
    expect(NM_SUPPORT_SPACING.source).toContain('not vertical');
  });
});

describe('bores', () => {
  it('a centred 1 in bit leaves exactly 31.75 mm (44.45 − 12.7): no plate; anything wider needs one (realism F3)', () => {
    // The stored bore waypoint is at the rounded 44 mm; the edge distance is the drilled hole's.
    expect(BORE_DEPTH_MM).toBe(44);
    expect(boreEdgeDistanceMm(25.4)).toBe(31.75);
    expect(boreNeedsNailPlate(25.4)).toBe(false);
    expect(boreNeedsNailPlate(25.401)).toBe(true);
    expect(boreNeedsNailPlate(28.575)).toBe(true); // 1-1/8 in: 30.1625 mm left
    expect(boreNeedsNailPlate(19)).toBe(false);
  });

  it('the bored-hole limit caps which bits checkTool(…, bore) accepts', () => {
    expect(boredHoleTooLarge(35.56)).toBe(false);
    expect(boredHoleTooLarge(38.1)).toBe(true);
    expect(checkTool(WIRING_TEST_CATALOG, BIT, 'bore').ok).toBe(true);
    expect(checkTool(WIRING_TEST_CATALOG, BIT_29, 'bore').ok).toBe(true); // allowed; the plate is a warning
    expect(checkTool(WIRING_TEST_CATALOG, BIT_38, 'bore')).toMatchObject({
      ok: false,
      code: 'beyond-tool-capacity',
    });
  });

  it('snapWaypoint proposes no bore with a bit the catalogue knows is over the limit (guardian 6)', () => {
    const bus = wiringBench('trainee', 7, { studWall: true });
    const at = { x: -2981, y: 1000, z: -3044 };
    expect(snapWaypoint(bus.state, WIRING_TEST_CATALOG, at, { kinds: ['bore'], boreTool: BIT_38 }).kind).toBe('free');
    expect(snapWaypoint(bus.state, WIRING_TEST_CATALOG, at, { kinds: ['bore'], boreTool: BIT_29 }).kind).toBe('bore');
  });

  it('wire.add refuses a bore with a bit over the limit too (guardian 5)', () => {
    const bus = wiringBench('trainee', 7, { studWall: true });
    const bore = (tool: typeof BIT) => ({
      kind: 'bore' as const,
      positionMm: { x: -2981, y: 1000, z: -3044 },
      entity: null,
      fixture: 'studs',
      tool,
    });
    const args = (tool: typeof BIT) =>
      autoWireArgs({ route: [freeAt(50, 500, 300), bore(tool), freeAt(1070, 500, 300)], lengthMm: 20_000 });
    expect(bus.exec('wire.add', args(BIT_38))).toMatchObject(refused('beyond-tool-capacity'));
    expect(bus.exec('wire.add', args(BIT_29)).ok).toBe(true);
  });

  it('a route bored with a bit over the limit is refused; one that needs a plate is not', () => {
    const bus = wiringBench('trainee', 7, { studWall: true });
    const studs = { kinds: ['bore'] as const };
    const bore = (tool: typeof BIT) =>
      snapWaypoint(bus.state, WIRING_TEST_CATALOG, { x: -2981, y: 1000, z: -3044 }, { ...studs, boreTool: tool });
    const args = (tool: typeof BIT) => ({
      ref: CABLE,
      a: null,
      b: null,
      route: [freeAt(-2981, 1000, -2800), bore(tool), freeAt(-2981, 1000, -3300)],
      lengthMm: 1000,
      tailsMm: { a: 0, b: 0 },
      tool: CUTTER,
    });
    const oversized = { ...bore(BIT_29), tool: BIT_38 }; // spelled out: the snapper won't propose it
    expect(
      bus.exec('cable.add', { ...args(BIT_29), route: [args(BIT_29).route[0], oversized, args(BIT_29).route[2]] }),
    ).toMatchObject(refused('beyond-tool-capacity'));
    expect(bus.exec('cable.add', args(BIT_29)).ok).toBe(true);
  });
});

describe('supportGap (NM support spacing)', () => {
  it('is null for a run that is not in framing (no staple or bore), however long', () => {
    expect(inFraming([wp('free', 0), wp('duct', 5000)])).toBe(false);
    expect(supportGap(box(0), [wp('free', 5000), wp('duct', 10_000)], box(20_000))).toBeNull();
  });

  it('measures from a box to the first support, between supports, and from the last support to a box', () => {
    // A straight run up y from a box entry at y = 0.
    expect(supportGap(box(0), [wp('staple', 304), wp('staple', 1675)], box(1979))).toBeNull();
    expect(supportGap(box(0), [wp('staple', 305)], null)).toMatchObject({ where: 'from-box-a', waypoint: 0 });
    expect(supportGap(box(0), [wp('staple', 300), wp('staple', 1672)], null)).toMatchObject({
      where: 'between',
      waypoint: 1,
      distanceMm: 1372,
    });
    expect(supportGap(box(0), [wp('staple', 300)], box(605))).toMatchObject({ where: 'from-box-b', waypoint: 0 });
    // A free waypoint isn't a support: the distance runs on through it.
    expect(supportGap(box(0), [wp('free', 200), wp('staple', 310)], null)).toMatchObject({ where: 'from-box-a' });
    // Bores and ducts break the spans between supports...
    expect(supportGap(box(0), [wp('staple', 300), wp('bore', 1600), wp('duct', 2900)], null)).toBeNull();
  });

  it('only a staple secures the cable near a box: a bore or a duct there is a gap (realism F1, Art. 334.30(A))', () => {
    expect(supportGap(box(0), [wp('bore', 300), wp('duct', 1600), wp('staple', 2900)], null)).toMatchObject({
      where: 'from-box-a',
      waypoint: 2,
      distanceMm: 2900,
    });
    expect(supportGap(box(0), [wp('staple', 300), wp('bore', 1000)], box(1200))).toMatchObject({
      where: 'from-box-b',
      waypoint: 0,
      distanceMm: 900,
    });
    // Framing with no staple at all: each box end is a gap.
    expect(supportGap(box(0), [wp('bore', 100)], box(200))).toMatchObject({ where: 'from-box-a', waypoint: -1 });
    // A run between two boxes on a stud wall is framing even with free waypoints only.
    expect(supportGap(box(0), [wp('free', 100)], box(2000))).toBeNull();
    expect(supportGap(box(0), [wp('free', 100)], box(2000), { framing: true })).toMatchObject({ where: 'from-box-a' });
  });

  it('a free end is not a box: the run from it to the first support is not checked', () => {
    expect(supportGap(null, [wp('free', 0), wp('staple', 3000)], null)).toBeNull();
  });

  it('property: a straight stapled run passes exactly when every gap is within its limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 400 }),
        fc.array(fc.integer({ min: 1, max: 1500 }), { minLength: 1, maxLength: 12 }),
        fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }),
        (first, gaps, last) => {
          let y = first;
          const route = [wp('staple', y)];
          for (const g of gaps.slice(1)) {
            y += g;
            route.push(wp('staple', y));
          }
          const end = last === null ? null : box(y + last);
          const ok =
            first <= NM_SUPPORT_SPACING.fromBoxMm &&
            gaps.slice(1).every((g) => g <= NM_SUPPORT_SPACING.betweenMm) &&
            (last === null || last <= NM_SUPPORT_SPACING.fromBoxMm);
          expect(supportGap(box(0), route, end) === null).toBe(ok);
        },
      ),
    );
  });
});

describe('the minimum sheath inside a box (realism F7, Art. 314.17)', () => {
  it('cable.strip leaves at least 6.35 mm of jacket past a box entry, never at a free end', () => {
    expect(maxStripAtBoxMm(200)).toBe(193);
    expect(maxStripAtBoxMm(7)).toBe(0);
    const bus = wiringBench();
    const added = bus.exec('cable.add', {
      ref: CABLE,
      a: { entity: 5, entry: 'top' },
      b: null,
      route: [freeAt(25, 500, 2030), freeAt(500, 500, 1000)],
      lengthMm: 2000,
      tailsMm: { a: 200, b: 100 },
      tool: CUTTER,
    });
    expect(added.ok).toBe(true);
    const strip = (end: 'a' | 'b', jacketMm: number) =>
      bus.exec('cable.strip', { id: 1, end, jacketMm, tool: STRIPPER });
    expect(strip('a', 194)).toMatchObject(refused('strip-too-long'));
    expect(strip('a', 193).ok).toBe(true);
    expect(strip('b', 100).ok).toBe(true); // a free end has no box
  });
});

describe('cable.add and cable.reroute in framing (staple-spacing)', () => {
  // A box (entity 6) against the bench's stud wall, its top entry at (-2930, 375, -3044), and
  // staples on stud 0's side face (x = -2961, mid-depth z = -3044), snapped as the mouse snaps them.
  function framed() {
    const bus = wiringBench('trainee', 7, { studWall: true });
    const place = bus.exec('entity.place', {
      ref: { id: 'box.test-1gang', version: 1 },
      positionMm: { x: -2955, y: 300, z: -3074 },
    });
    expect(place.ok).toBe(true);
    expect(
      bus.exec('enclosure.openEntry', { id: 6, entry: 'top', tool: { id: 'tool.test-screwdriver', version: 1 } }).ok,
    ).toBe(true);
    const staple = (y: number) =>
      snapWaypoint(bus.state, WIRING_TEST_CATALOG, { x: -2961, y, z: -3044 }, { kinds: ['staple'] });
    const args = (ys: number[]) => ({
      ref: CABLE,
      a: { entity: 6, entry: 'top' },
      b: null,
      route: [...ys.map(staple), freeAt(-2961, ys[ys.length - 1] + 200, -3044)],
      lengthMm: 3000,
      tailsMm: { a: 200, b: 0 },
      tool: CUTTER,
    });
    return { bus, staple, args };
  }

  it('accepts a run stapled within 304.8 mm of the box and every 1371.6 mm, and refuses a longer gap', () => {
    const { bus, staple, args } = framed();
    expect(staple(600)).toMatchObject({ kind: 'staple', fixture: 'studs', positionMm: { x: -2961, y: 600, z: -3044 } });
    // The entry is at (-2930, 375): the first staple 227 mm away (√(31² + 225²)), then 1300 mm.
    expect(bus.exec('cable.add', args([700, 1900]))).toMatchObject(refused('staple-spacing')); // 326 mm from the box
    expect(bus.exec('cable.add', args([600, 2000]))).toMatchObject(refused('staple-spacing')); // 1400 mm between
    expect(bus.exec('cable.add', args([600, 1900])).ok).toBe(true);
    // A reroute is held to the same rule.
    const ok = args([600, 1900]).route;
    const far = [ok[0], staple(2000), freeAt(-2961, 2200, -3044)];
    expect(bus.exec('cable.reroute', { id: 1, route: far })).toMatchObject(refused('staple-spacing'));
    const near = [ok[0], staple(1800), freeAt(-2961, 2000, -3044)];
    expect(bus.exec('cable.reroute', { id: 1, route: near }).ok).toBe(true);
  });

  it('a box-to-box run on the stud wall is framing even through free waypoints only (realism F4)', () => {
    const { bus, staple } = framed();
    bus.exec('entity.place', {
      ref: { id: 'box.test-1gang', version: 1 },
      positionMm: { x: -2955, y: 2200, z: -3074 },
    });
    bus.exec('enclosure.openEntry', { id: 7, entry: 'ko1', tool: PUNCH });
    const base = {
      ref: CABLE,
      a: { entity: 6, entry: 'top' },
      b: { entity: 7, entry: 'ko1' },
      lengthMm: 3000,
      tailsMm: { a: 200, b: 200 },
      tool: CUTTER,
    };
    expect(enclosureOnStudWall(bus.state, WIRING_TEST_CATALOG, 6)).toBe(true);
    expect(enclosureOnStudWall(bus.state, WIRING_TEST_CATALOG, 5)).toBe(false); // the bench box, far off
    expect(bus.exec('cable.add', { ...base, route: [freeAt(-2930, 1300, -3044)] })).toMatchObject(
      refused('staple-spacing'),
    );
    expect(bus.exec('cable.add', { ...base, route: [staple(600), staple(1900)] }).ok).toBe(true);
  });

  it('checks the last support to a box end too', () => {
    const { bus, staple } = framed();
    bus.exec('entity.place', {
      ref: { id: 'box.test-1gang', version: 1 },
      positionMm: { x: -2955, y: 2200, z: -3074 },
    });
    bus.exec('enclosure.openEntry', { id: 7, entry: 'ko1', tool: PUNCH });
    // Box 7's bottom knockout is at (-2930, 2200, -3044).
    const args = (ys: number[]) => ({
      ref: CABLE,
      a: { entity: 6, entry: 'top' },
      b: { entity: 7, entry: 'ko1' },
      route: ys.map(staple),
      lengthMm: 3000,
      tailsMm: { a: 200, b: 200 },
      tool: CUTTER,
    });
    expect(bus.exec('cable.add', args([600, 1850]))).toMatchObject(refused('staple-spacing')); // 351 mm to box 7
    expect(bus.exec('cable.add', args([600, 1900])).ok).toBe(true);
    // Stripping and landing work as before at both ends.
    expect(bus.exec('cable.strip', { id: 1, end: 'b', jacketMm: 150, tool: STRIPPER }).ok).toBe(true);
  });
});
