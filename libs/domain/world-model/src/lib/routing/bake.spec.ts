import { BUILTIN_CATALOG } from '@controls/catalog';
import { racewayPanelBus, routingPanelBus } from '../../testing/routing-panel';
import { bakeNodes, bakeWorldRoutes, centrelineHash } from './bake';
import { assignLanes } from './lanes';
import { elbowCentreline, racewayPaths } from './raceways';
import type { Connection, Waypoint, World } from '../types';

const at = (x: number, y: number, z: number) => ({ x, y, z });
const free = (x: number, y: number, z: number) => ({ p: at(x, y, z), host: null });
/** Point k of a baked route, in tenths of mm. */
const point = (points: readonly number[], k: number) => points.slice(3 * k, 3 * k + 3);

/** A pulled 14 AWG conductor with both ends free on `route` (built directly: the bake reads any world). */
function pulled(world: World, id: number, route: Waypoint[], lengthMm: number): Connection {
  return {
    id,
    ref: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
    a: null,
    b: null,
    cable: null,
    route,
    lengthMm,
    colour: { base: 'black', stripe: null },
    label: null,
    state: {},
    sim: {},
    extensions: {},
  };
}

describe('bakeNodes (ADR 0017: the analytic bake)', () => {
  it('a free span with spare length sags as a parabola of depth √(3 c e / 8), sampled every 15 mm', () => {
    // c = 300 mm, cut 1 mm long: e = 1 ≤ 1 % of c, all of it sag. h = √(3 · 300 · 1 / 8) = √112.5 = 10.6066 mm.
    const baked = bakeNodes('c1', [free(0, 0, 0), free(300, 0, 0)], 301);
    expect(baked.points.length / 3).toBe(21); // ⌈300 / 15⌉ = 20 segments
    expect(point(baked.points, 10)).toStrictEqual([1500, -106, 0]); // the middle, 10.6 mm down
    expect(point(baked.points, 1)).toStrictEqual([150, -20, 0]); // 4 h t(1 − t) at t = 1/20: 2.0153 mm
    expect(baked.coil).toBeNull();
  });

  it('every coordinate is an integer number of tenths of a millimetre (the 0.1 mm quantum)', () => {
    const baked = bakeNodes('c1', [free(0.04, 0, 0), free(123.456, 78.9, -0.06)], 160);
    for (const v of baked.points) expect(Number.isSafeInteger(v) && !Object.is(v, -0)).toBe(true);
    expect(point(baked.points, 0)).toStrictEqual([0, 0, 0]);
  });

  it('is taut when the cut length doesn’t exceed the drawn length; a lead-out never sags', () => {
    expect(bakeNodes('c1', [free(0, 0, 0), free(300, 0, 0)], 300).points).toStrictEqual([0, 0, 0, 3000, 0, 0]);
    expect(bakeNodes('c1', [free(0, 0, 0), free(300, 0, 0)], null).points).toStrictEqual([0, 0, 0, 3000, 0, 0]);
    const lead = bakeNodes('c1', [{ ...free(0, 0, 0), terminal: true }, free(0, 12, 0), free(300, 12, 0)], 400);
    expect(point(lead.points, 1)).toStrictEqual([0, 120, 0]);
  });

  it('a vertical span bows out along +z', () => {
    const baked = bakeNodes('c1', [free(0, 300, 0), free(0, 0, 0)], 301);
    expect(point(baked.points, 10)).toStrictEqual([0, 1500, 106]);
  });

  it('a run cut well long draws its spare as a coil at the middle of its longest free span', () => {
    // 2 m on a 300 mm span: 3 mm of sag, 1 697 mm left over (more than 20 % of the cut length).
    const baked = bakeNodes('c1', [free(0, 0, 0), free(300, 0, 0)], 2000);
    expect(baked.coil).toStrictEqual({ at: [1500, -184, 0], lengthTenths: 16970 });
    // 5 % over (the default slack) never coils, whatever the spans can show.
    expect(bakeNodes('c1', [free(0, 0, 0), free(300, 0, 0)], 315).coil).toBeNull();
  });
});

describe('bakeWorldRoutes', () => {
  it('draws runs along a duct taut on their lane, and the spans to the terminals free', () => {
    const bus = routingPanelBus(true);
    const baked = bakeWorldRoutes(bus.state, BUILTIN_CATALOG);
    expect(baked.routes.map((r) => r.owner)).toStrictEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    // c1: row A block 0's b (23, 60, 30), its lead-out 12 mm down, its D1 lane (floor corner), along D1,
    // up out of it to row B block 0's lead-out and terminal. The lane offset makes the drawn path longer
    // than the cut length, so nothing sags.
    expect(baked.routes[0]).toStrictEqual({
      owner: 'c1',
      points: [230, 600, 300, 230, 480, 300, 230, 33, 33, 3230, 33, 33, 3230, 1880, 300, 3230, 2000, 300],
      coil: null,
    });
  });

  it('draws an elbow’s legs and arc between two conduit waypoints on it, and runs inside conduit taut', () => {
    const bus = racewayPanelBus();
    const paths = racewayPaths(bus.state, BUILTIN_CATALOG);
    const stick = paths.find((p) => p.modelKind === 'raceway.conduit');
    const elbow = paths.find((p) => p.modelKind === 'raceway.conduitElbow');
    expect(elbow?.straight).toBe(false);
    expect(elbow?.centreline).toHaveLength(9);
    expect(elbow?.centreline[0]).toStrictEqual(elbow?.a);
    expect(elbow?.centreline.at(-1)).toStrictEqual(elbow?.b);
    expect(stick?.b).toStrictEqual(elbow?.a); // the elbow sits on the stick's end
    const hosted = (entity: number, p: { x: number; y: number; z: number }) => ({
      kind: 'conduit' as const,
      positionMm: p,
      entity,
      fixture: null,
      tool: null,
    });
    const route = [
      { kind: 'free' as const, positionMm: at(-100, -150, 100), entity: null, fixture: null, tool: null },
      hosted(8, stick?.a ?? at(0, 0, 0)),
      hosted(9, elbow?.a ?? at(0, 0, 0)),
      hosted(9, elbow?.b ?? at(0, 0, 0)),
      { kind: 'free' as const, positionMm: at(0, -700, 100), entity: null, fixture: null, tool: null },
    ];
    const world = { ...bus.state, connections: [pulled(bus.state, 1, route, 1000)], nextConnectionId: 2 };
    const [baked] = bakeWorldRoutes(world, BUILTIN_CATALOG).routes;
    // A lone conductor's lane is the tube's axis, and inside the conduit the run is taut: from the
    // stick's entry end the baked points are exactly the stick's far end (the elbow's near port), the
    // elbow's seven arc points and its far port, with no sag sample in between.
    const q = (c: { x: number; y: number; z: number }) => [c.x, c.y, c.z].map((v) => Math.round(v * 10) + 0);
    const inside = [stick?.a, ...(elbow?.centreline ?? [])].map((c) => q(c ?? at(0, 0, 0)));
    const points = Array.from({ length: baked.points.length / 3 }, (_, k) => point(baked.points, k));
    const from = points.findIndex((p) => p.join() === inside[0].join());
    expect(from).toBeGreaterThan(0); // after the free span's sag samples
    expect(points.slice(from, from + inside.length)).toStrictEqual(inside);
  });

  it('a tube stacks its occupants about its axis, centred', () => {
    const bus = racewayPanelBus();
    const paths = racewayPaths(bus.state, BUILTIN_CATALOG);
    const stick = paths.find((p) => p.modelKind === 'raceway.conduit');
    const route = [
      { kind: 'free' as const, positionMm: at(-100, -150, 100), entity: null, fixture: null, tool: null },
      { kind: 'conduit' as const, positionMm: stick?.a ?? at(0, 0, 0), entity: 8, fixture: null, tool: null },
      { kind: 'free' as const, positionMm: at(0, -700, 100), entity: null, fixture: null, tool: null },
    ];
    const world = {
      ...bus.state,
      connections: [1, 2, 3].map((id) => pulled(bus.state, id, route, 1000)),
      nextConnectionId: 4,
    };
    const lanes = assignLanes(world, BUILTIN_CATALOG, paths).get(8);
    // Three 2.6 mm lanes, 7.8 mm in all: centred, −3.9 … 3.9 mm, along the stick's own +z.
    expect([...(lanes ?? [])]).toStrictEqual([
      ['c1', { across: 0, up: -26 }],
      ['c2', { across: 0, up: 0 }],
      ['c3', { across: 0, up: 26 }],
    ]);
  });

  it('elbowCentreline: legs and a quarter circle from literal cosines', () => {
    const line = elbowCentreline(12, 30, 100);
    expect(line[0]).toStrictEqual(at(12, 0, 12));
    expect(line[1]).toStrictEqual(at(12, 30, 12));
    expect(line[7]).toStrictEqual(at(112, 130, 12));
    expect(line[8]).toStrictEqual(at(142, 130, 12));
    expect(elbowCentreline(12, 0, 100)).toHaveLength(7); // a bare quarter circle: no repeated ends
  });

  it('is a pure function of the world: the same world bakes to the same hash', () => {
    const one = centrelineHash(bakeWorldRoutes(routingPanelBus(true).state, BUILTIN_CATALOG));
    expect(centrelineHash(bakeWorldRoutes(routingPanelBus(true).state, BUILTIN_CATALOG))).toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });
});
