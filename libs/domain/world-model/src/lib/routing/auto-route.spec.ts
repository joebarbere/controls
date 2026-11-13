import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import { racewayPanelBus, ROUTING_PANEL_REFS, routingPanelBus, rowA, rowB } from '../../testing/routing-panel';
import { createWorldBus, createWorldRegistry } from '../session';
import { autoRoute, ductJunction } from './auto-route';
import { routeCollision } from './collide';
import { routeFloorMm } from './floor';
import { racewayPaths } from './raceways';

const at = (x: number, y: number, z: number) => ({ x, y, z });
const duct = (entity: number, x: number, y: number, z: number) => ({
  kind: 'duct',
  positionMm: at(x, y, z),
  entity,
  fixture: null,
  tool: null,
});
const end = (entity: number, terminal: string) => ({ entity, terminal, termination: 'auto' as const });

describe('autoRoute (ADR 0017)', () => {
  it('a hand-measured route: two screw blocks on rail 1 down into the duct below (raceway-panel)', () => {
    const bus = racewayPanelBus();
    // Block 3 (x = −69) and block 4 (x = −63): terminal b's entry (3, 0, 30) is at (−66, 126, 52) and
    // (−60, 126, 52), leaving along −y. The duct's axis is y = 90, z = 44 (its origin (−150, 70, 14)
    // plus (·, 20, 30)), so each drops straight down to (x, 90, 44): Δy 36, Δz 8, √1360 = 36.878 mm.
    // Measured: 36.878 + 6 + 36.878 = 79.757 mm, floor 80; default length 80 + ⌈5 % of 80⌉ = 84.
    const routed = autoRoute(bus.state, BUILTIN_CATALOG, end(3, 'b'), end(4, 'b'));
    expect(routed).toStrictEqual({
      ok: true,
      route: [duct(2, -66, 90, 44), duct(2, -60, 90, 44)],
      lengthMm: 84,
      floorMm: 80,
      points: [at(-66, 126, 52), at(-66, 90, 44), at(-60, 90, 44), at(-60, 126, 52)],
    });
    expect(Math.sqrt(36 * 36 + 8 * 8)).toBeCloseTo(36.878, 3);
    // The command takes exactly what the router proposed, and nothing shorter than the floor.
    const args = {
      ref: ROUTING_PANEL_REFS.wire,
      a: end(3, 'b'),
      b: end(4, 'b'),
      route: routed.ok ? routed.route : [],
      colour: { base: 'black', stripe: null },
      tool: ROUTING_PANEL_REFS.cutter,
    };
    expect(bus.exec('wire.add', { ...args, lengthMm: 79 })).toMatchObject({ ok: false, error: { code: 'too-short' } });
    expect(bus.exec('wire.add', { ...args, lengthMm: 84 }).ok).toBe(true);
  });

  it('enters the duct ahead of each terminal, and crosses between ducts through the riser', () => {
    const bus = routingPanelBus();
    // Row A's terminal a (y = 108, exit +y) goes up into D2 (axis y = 320) though D1 (y = 20) is nearer.
    const up = autoRoute(bus.state, BUILTIN_CATALOG, end(rowA(1), 'a'), end(rowB(1), 'a'));
    expect(up.ok && up.route).toStrictEqual([duct(2, 29, 320, 30), duct(2, 329, 320, 30)]);
    // a into D2, b into D1: along D2 to its end, across to the riser, down it, across to D1 and back.
    const round = autoRoute(bus.state, BUILTIN_CATALOG, end(rowA(2), 'a'), end(rowB(2), 'b'));
    expect(round.ok && round.route).toStrictEqual([
      duct(2, 35, 320, 30),
      duct(2, 600, 320, 30),
      duct(3, 620, 320, 30),
      duct(3, 620, 20, 30),
      duct(1, 600, 20, 30),
      duct(1, 335, 20, 30),
    ]);
    // The floor: 212 up, 565 along, 20 across, 300 down the riser, 20 across, 265 along, 180 down.
    expect(round.ok && round.floorMm).toBe(212 + 565 + 20 + 300 + 20 + 265 + 180);
    expect(round.ok && round.lengthMm).toBe(1562 + Math.ceil((1562 * 5) / 100));
  });

  it('every proposal is one the command accepts (the whole routing panel wires)', () => {
    const bus = routingPanelBus(true);
    expect(bus.state.connections).toHaveLength(8);
    for (const c of bus.state.connections) expect(c.route?.every((w) => w.kind === 'duct')).toBe(true);
  });

  it('with no duct: the direct line, else a lead-out from each terminal, else route-collides', () => {
    const registry = createWorldRegistry();
    const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), registry);
    const place = (x: number, y: number) =>
      bus.exec('entity.place', { ref: ROUTING_PANEL_REFS.block, positionMm: at(x, y, 0) });
    place(0, 0); // 1: b at (3, 0, 30), a at (3, 48, 30)
    place(100, 0); // 2
    expect(autoRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), end(2, 'a'))).toMatchObject({
      ok: true,
      route: [],
      floorMm: 100,
      lengthMm: 105,
    });
    // A block in the way (x 50 … 56) between the two a terminals: out 50 mm along +y and across.
    place(50, 20);
    const around = autoRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), end(2, 'a'));
    expect(around.ok && around.route.map((w) => [w.kind, w.positionMm])).toStrictEqual([
      ['free', at(3, 98, 30)],
      ['free', at(103, 98, 30)],
    ]);
    // A wall of blocks that also blocks the lead-outs.
    for (let y = 70; y < 200; y += 48) place(50, y);
    expect(autoRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), end(2, 'a'))).toMatchObject({
      ok: false,
      code: 'route-collides',
    });
    expect(autoRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), end(2, 'a'), { ducts: false })).toMatchObject({
      ok: false,
    });
  });

  it('reports the end that has no place', () => {
    const bus = routingPanelBus();
    const a = end(rowA(0), 'a');
    expect(autoRoute(bus.state, BUILTIN_CATALOG, a, end(999, 'a'))).toMatchObject({ ok: false, code: 'not-found' });
    expect(autoRoute(bus.state, BUILTIN_CATALOG, a, end(rowA(1), 'zz'))).toMatchObject({
      ok: false,
      code: 'unknown-terminal',
    });
    expect(
      autoRoute(bus.state, BUILTIN_CATALOG, a, { entity: rowA(1), terminal: 'a', termination: { method: 'twistOn' } }),
    ).toMatchObject({ ok: false, code: 'wrong-method' });
    expect(autoRoute(bus.state, BUILTIN_CATALOG, a, a)).toMatchObject({ ok: false, code: 'same-terminal' });
    expect(autoRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), a)).toMatchObject({
      ok: false,
      code: 'unknown-terminal',
    });
  });

  it('proposes the same route every time (pure)', () => {
    const bus = routingPanelBus();
    const once = autoRoute(bus.state, BUILTIN_CATALOG, end(rowB(5), 'a'), end(rowA(5), 'b'));
    expect(autoRoute(bus.state, BUILTIN_CATALOG, end(rowB(5), 'a'), end(rowA(5), 'b'))).toStrictEqual(once);
    expect(once.ok && routeFloorMm(once.points)).toBe(once.ok && once.floorMm);
  });
});

describe('ductJunction', () => {
  const paths = racewayPaths(routingPanelBus().state, BUILTIN_CATALOG);
  const [d1, d2, riser] = paths;

  it('crossing axes: each clamped to the other', () => {
    expect(ductJunction(d1, riser)).toStrictEqual([at(600, 20, 30), at(620, 20, 30)]);
    expect(ductJunction(riser, d2)).toStrictEqual([at(620, 320, 30), at(600, 320, 30)]);
  });

  it('parallel axes: the middle of their overlap, or their nearest ends', () => {
    expect(ductJunction(d1, d2)).toStrictEqual([at(300, 20, 30), at(300, 320, 30)]);
    const shifted = { ...d2, a: at(700, 320, 30), b: at(900, 320, 30) };
    expect(ductJunction(d1, shifted)).toStrictEqual([at(600, 20, 30), at(700, 320, 30)]);
    expect(ductJunction(shifted, d1)).toStrictEqual([at(700, 320, 30), at(600, 20, 30)]);
  });
});

describe('routeCollision (route-collides, ADR 0017)', () => {
  const box = { min: at(0, 0, 0), max: at(10, 10, 10) };
  const p = (x: number, entity: number | null = null) => ({ positionMm: at(x, 5, 5), entity });

  it('names the first segment through a body, and skips the bodies at a segment’s own ends', () => {
    expect(routeCollision([p(-20), p(-10), p(20)], [{ entity: 7, box }])).toStrictEqual({ segment: 2, entity: 7 });
    expect(routeCollision([p(-20), p(-10), p(20, 7)], [{ entity: 7, box }])).toBeNull();
    expect(routeCollision([p(-20), p(-10)], [{ entity: 7, box }])).toBeNull();
    expect(routeCollision([p(-20), p(20)], [])).toBeNull();
  });
});
