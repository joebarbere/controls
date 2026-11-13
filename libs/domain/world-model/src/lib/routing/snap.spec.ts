import { BUILTIN_CATALOG } from '@controls/catalog';
import fc from 'fast-check';
import { racewayPanelBus, routingPanelBus } from '../../testing/routing-panel';
import { createWorldBus } from '../session';
import { connectorEntries, connectorEntry } from './connector-entry';
import { racewayPaths } from './raceways';
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

  it('captures a staple on a stud face and, given a bit, a bore at the stud’s mid-depth', () => {
    const world = { ...panel, fixtures: [studWall] };
    // The first stud's centre is 19 mm along the wall: (−2981, ·, −3000).
    expect(snapWaypoint(world, BUILTIN_CATALOG, at(-2975, 1203.6, -2990))).toStrictEqual({
      kind: 'staple',
      positionMm: at(-2981, 1204, -3000),
      entity: null,
      fixture: 'studs',
      tool: null,
    });
    expect(BORE_DEPTH_MM).toBe(44);
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

  it('always returns integer positions within the capture distance of the cursor (property)', () => {
    const coordinate = fc.integer({ min: -200, max: 900 });
    fc.assert(
      fc.property(fc.record({ x: coordinate, y: coordinate, z: fc.integer({ min: -50, max: 120 }) }), (cursor) => {
        const w = snapWaypoint(panel, BUILTIN_CATALOG, cursor);
        for (const v of Object.values(w.positionMm)) expect(Number.isSafeInteger(v)).toBe(true);
        const d = w.positionMm;
        const d2 = (d.x - cursor.x) ** 2 + (d.y - cursor.y) ** 2 + (d.z - cursor.z) ** 2;
        expect(d2).toBeLessThanOrEqual(40 * 40);
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
