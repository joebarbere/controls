import { BUILTIN_CATALOG } from '@controls/catalog';
import fc from 'fast-check';
import { racewayPanelBus, routingPanelBus } from '../../testing/routing-panel';
import { createWorldBus } from '../session';
import { connectorEntries, connectorEntry } from './connector-entry';
import { nearestOnAxis, racewayPaths } from './raceways';
import { BORE_DEPTH_MM, snapWaypoint } from './snap';

const at = (x: number, y: number, z: number) => ({ x, y, z });
const BIT = { id: 'tool.test-bit-19', version: 1 };
const studWall = {
  id: 'studs',
  ref: { id: 'prop.stud-wall', version: 1 },
  transform: { positionMm: at(-3000, 0, -3000), orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
  extensions: {},
};

describe('snapWaypoint (ADR 0017)', () => {
  const panel = routingPanelBus().state;
  const raceways = racewayPanelBus().state;

  it('captures the nearest point of a duct’s axis, else stays free at the rounded cursor', () => {
    expect(snapWaypoint(panel, BUILTIN_CATALOG, at(123.4, 35, 40))).toStrictEqual({
      kind: 'duct',
      positionMm: at(123, 20, 30),
      entity: 1,
      fixture: null,
      tool: null,
    });
    // Past the end of D1 and nearer the riser's axis (x = 620).
    expect(snapWaypoint(panel, BUILTIN_CATALOG, at(615, 150, 30))).toMatchObject({
      entity: 3,
      positionMm: at(620, 150, 30),
    });
    expect(snapWaypoint(panel, BUILTIN_CATALOG, at(300, 170.6, 30))).toStrictEqual({
      kind: 'free',
      positionMm: at(300, 171, 30),
      entity: null,
      fixture: null,
      tool: null,
    });
    expect(snapWaypoint(panel, BUILTIN_CATALOG, at(123, 35, 40), { kinds: ['conduit'] }).kind).toBe('free');
    expect(snapWaypoint(panel, BUILTIN_CATALOG, at(123, 80, 30), { captureMm: 70 })).toMatchObject({ entity: 1 });
  });

  it('captures a conduit stick’s axis, and an elbow at its nearer port', () => {
    // The stick (8) runs down from (−100, −225, 100) to (−100, −525, 100).
    expect(snapWaypoint(raceways, BUILTIN_CATALOG, at(-90, -400, 95))).toMatchObject({
      kind: 'conduit',
      entity: 8,
      positionMm: at(-100, -400, 100),
    });
    const elbow = racewayPaths(raceways, BUILTIN_CATALOG).find((p) => p.entity === 9);
    const b = elbow?.b ?? at(0, 0, 0);
    expect(snapWaypoint(raceways, BUILTIN_CATALOG, at(b.x + 5, b.y - 5, b.z))).toMatchObject({
      kind: 'conduit',
      entity: 9,
      positionMm: b,
    });
    // At the joint, the stick's end and the elbow's port coincide: the lower id (the stick) wins the tie.
    expect(snapWaypoint(raceways, BUILTIN_CATALOG, at(-100, -527, 100))).toMatchObject({
      entity: 8,
      positionMm: at(-100, -525, 100),
    });
  });

  it('captures a staple on the stud side facing the cursor, set back to mid-depth, and a bore on the stud axis', () => {
    const world = { ...panel, fixtures: [studWall] };
    expect(BORE_DEPTH_MM).toBe(44);
    // The first stud's centre is 19 mm along the wall (x = −2981); its sides are 20 mm either way
    // (half of 38.1 rounded up, as snapToWallStuds sets boxes against studs), 44 mm behind the face.
    expect(snapWaypoint(world, BUILTIN_CATALOG, at(-2965, 1203.6, -3040))).toStrictEqual({
      kind: 'staple',
      positionMm: at(-2961, 1204, -3044),
      entity: null,
      fixture: 'studs',
      tool: null,
    });
    // Left of the end stud, its left side would be outside the wall: the right side is used.
    expect(snapWaypoint(world, BUILTIN_CATALOG, at(-2995, 1204, -3040)).positionMm).toStrictEqual(
      at(-2961, 1204, -3044),
    );
    // The second stud (u = round(19 + 406.4) = 425, x = −2575), approached from its left.
    expect(snapWaypoint(world, BUILTIN_CATALOG, at(-2590, 500, -3040)).positionMm).toStrictEqual(at(-2595, 500, -3044));
    const bore = snapWaypoint(world, BUILTIN_CATALOG, at(-2981, 1204, -3040), { kinds: ['bore'], boreTool: BIT });
    expect(bore).toStrictEqual({
      kind: 'bore',
      positionMm: at(-2981, 1204, -3044),
      entity: null,
      fixture: 'studs',
      tool: BIT,
    });
    // No bit, no bore.
    expect(snapWaypoint(world, BUILTIN_CATALOG, at(-2981, 1204, -3040), { kinds: ['bore'] }).kind).toBe('free');
  });

  it('gives integer points within the capture distance, a captured one on its host’s axis (property)', () => {
    // Fractional cursors as a ray hit gives them, mostly near a duct (mapped draws, never filtered).
    const paths = racewayPaths(panel, BUILTIN_CATALOG);
    const offset = fc.double({ min: -45, max: 45, noNaN: true });
    const near = fc
      .record({
        i: fc.integer({ min: 0, max: paths.length - 1 }),
        t: fc.double({ min: 0, max: 1, noNaN: true }),
        dx: offset,
        dy: offset,
        dz: offset,
      })
      .map(({ i, t, dx, dy, dz }) => {
        const { a, b } = paths[i];
        return { x: a.x + (b.x - a.x) * t + dx, y: a.y + (b.y - a.y) * t + dy, z: a.z + (b.z - a.z) * t + dz };
      });
    const anywhere = fc.record({
      x: fc.double({ min: -200, max: 900, noNaN: true }),
      y: fc.double({ min: -200, max: 900, noNaN: true }),
      z: fc.double({ min: -50, max: 120, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.oneof({ arbitrary: near, weight: 4 }, { arbitrary: anywhere, weight: 1 }), (cursor) => {
        const w = snapWaypoint(panel, BUILTIN_CATALOG, cursor);
        for (const v of Object.values(w.positionMm)) expect(Number.isSafeInteger(v) && !Object.is(v, -0)).toBe(true);
        const d = w.positionMm;
        const r = { x: Math.round(cursor.x) + 0, y: Math.round(cursor.y) + 0, z: Math.round(cursor.z) + 0 };
        expect((d.x - r.x) ** 2 + (d.y - r.y) ** 2 + (d.z - r.z) ** 2).toBeLessThanOrEqual(40 * 40);
        if (w.kind === 'duct') {
          const host = paths.find((p) => p.entity === w.entity);
          expect(host && nearestOnAxis(host, d).d2).toBe(0);
        } else {
          expect(w).toMatchObject({ kind: 'free', positionMm: r });
        }
        expect(snapWaypoint(panel, BUILTIN_CATALOG, cursor)).toStrictEqual(w);
      }),
    );
  });
});

describe('connectorEntry (ADR 0017: derived, never stored)', () => {
  it('a connector snapped into an open entry of its size is in it', () => {
    expect(connectorEntries(racewayPanelBus().state, BUILTIN_CATALOG)).toStrictEqual([
      { connector: 7, enclosure: 1, entry: 'ko-bottom-1' },
    ]);
  });

  it('(a) two connectors on one entry: the lowest id is in it, the other in none', () => {
    const bus = racewayPanelBus();
    const place = bus.exec('entity.place', {
      ref: { id: 'connector.stavenor-emt-075', version: 1 },
      positionMm: at(-117, -200, 83),
      orientationMdeg: { yaw: 0, pitch: 0, roll: 270_000 },
    });
    expect(place.ok).toBe(true);
    expect(connectorEntry(bus.state, BUILTIN_CATALOG, 7)).toMatchObject({ entry: 'ko-bottom-1' });
    expect(connectorEntry(bus.state, BUILTIN_CATALOG, 10)).toBeNull();
  });

  it('(b) at a closed entry, or one of another trade size: in none', () => {
    const bus = racewayPanelBus();
    // ko-bottom-2 (3/4 in, closed) at (0, −200, −100) + ... : the same connector moved 100 mm along x.
    expect(
      bus.exec('entity.place', {
        ref: { id: 'connector.stavenor-emt-075', version: 1 },
        positionMm: at(-17, -200, 83),
        orientationMdeg: { yaw: 0, pitch: 0, roll: 270_000 },
      }).ok,
    ).toBe(true);
    expect(connectorEntry(bus.state, BUILTIN_CATALOG, 10)).toBeNull();
    // A 1/2 in connector in the open 3/4 in knockout: its body is 2 mm thinner, so its port sits elsewhere
    // unless forced there; force it by placing its entry port exactly on the entry point.
    const half = { id: 'connector.stavenor-emt-050', version: 1 };
    const device = BUILTIN_CATALOG.device(half);
    const r = (device?.sizeMm?.depthMm ?? 0) / 2;
    expect(
      bus.exec('entity.place', {
        ref: half,
        positionMm: at(-100 - r, -200, 100 - r),
        orientationMdeg: { yaw: 0, pitch: 0, roll: 270_000 },
      }).ok,
    ).toBe(true);
    expect(connectorEntry(bus.state, BUILTIN_CATALOG, 11)).toBeNull();
    expect(connectorEntry(bus.state, BUILTIN_CATALOG, 7)).toMatchObject({ entry: 'ko-bottom-1' });
  });

  it('(c) an enclosure moved away from its connector: in none', () => {
    const bus = racewayPanelBus();
    const moved = { ...bus.state, entities: bus.state.entities.filter((e) => e.id === 1 || e.id === 7) };
    const lone = createWorldBus(moved);
    expect(connectorEntry(lone.state, BUILTIN_CATALOG, 7)).toMatchObject({ entry: 'ko-bottom-1' });
    expect(lone.exec('entity.move', { id: 1, positionMm: at(-200, -200, 500) }).ok).toBe(true);
    expect(connectorEntry(lone.state, BUILTIN_CATALOG, 7)).toBeNull();
    expect(connectorEntry(lone.state, BUILTIN_CATALOG, 1)).toBeNull(); // not a connector
  });
});
