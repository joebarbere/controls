import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import { ROUTING_PANEL_REFS, routingPanelBus, rowA, rowB } from '../../testing/routing-panel';
import { createWorldBus, createWorldRegistry } from '../session';
import type { Waypoint } from '../types';
import { autoRoute } from './auto-route';
import { proposeRoute } from './propose';
import { snapWaypoint } from './snap';

const at = (x: number, y: number, z: number) => ({ x, y, z });
const end = (entity: number, terminal: string) => ({ entity, terminal, termination: 'auto' as const });
const free = (x: number, y: number, z: number): Waypoint => ({
  kind: 'free',
  positionMm: at(x, y, z),
  entity: null,
  fixture: null,
  tool: null,
});

describe('proposeRoute (F3.2 part 3)', () => {
  it('without waypoints it is exactly autoRoute, marked auto', () => {
    const bus = routingPanelBus();
    const a = end(rowA(2), 'a');
    const b = end(rowB(2), 'b');
    const auto = autoRoute(bus.state, BUILTIN_CATALOG, a, b);
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, a, b, [])).toStrictEqual({ ...auto, auto: true });
    // A failure passes through unchanged.
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, a, a, [])).toStrictEqual(
      autoRoute(bus.state, BUILTIN_CATALOG, a, a),
    );
  });

  it('with the player’s waypoints: those waypoints, the default length of their points, and what wire.add accepts', () => {
    const bus = routingPanelBus();
    const a = end(rowA(0), 'a');
    const b = end(rowB(0), 'a');
    // Row A's a is at (23, 108, 30); row B's a at (323, 248, 30). Through D2 by two snapped waypoints.
    const w1 = snapWaypoint(bus.state, BUILTIN_CATALOG, at(23, 318, 33));
    const w2 = snapWaypoint(bus.state, BUILTIN_CATALOG, at(323, 322, 28));
    expect([w1.kind, w2.kind]).toStrictEqual(['duct', 'duct']);
    const proposal = proposeRoute(bus.state, BUILTIN_CATALOG, a, b, [w1, w2]);
    expect(proposal).toMatchObject({
      ok: true,
      auto: false,
      route: [w1, w2],
      points: [at(23, 108, 30), w1.positionMm, w2.positionMm, at(323, 248, 30)],
      floorMm: 212 + 300 + 72,
      lengthMm: 584 + Math.ceil((584 * 5) / 100),
    });
    if (!proposal.ok) throw new Error(proposal.message);
    const args = {
      ref: ROUTING_PANEL_REFS.wire,
      a,
      b,
      route: proposal.route,
      lengthMm: proposal.lengthMm,
      colour: { base: 'black', stripe: null },
      tool: ROUTING_PANEL_REFS.cutter,
    };
    expect(bus.exec('wire.add', args).ok).toBe(true);
  });

  it('auto: false with no waypoints proposes the direct line', () => {
    const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), createWorldRegistry());
    bus.exec('entity.place', { ref: ROUTING_PANEL_REFS.block, positionMm: at(0, 0, 0) });
    bus.exec('entity.place', { ref: ROUTING_PANEL_REFS.block, positionMm: at(100, 0, 0) });
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, end(1, 'a'), end(2, 'a'), [], { auto: false })).toMatchObject({
      ok: true,
      auto: false,
      route: [],
      floorMm: 100,
      lengthMm: 105,
    });
  });

  it('refuses what the command refuses: a body in the way, repeated points, a bad host, an end with no place', () => {
    const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), createWorldRegistry());
    const place = (x: number, y: number) =>
      bus.exec('entity.place', { ref: ROUTING_PANEL_REFS.block, positionMm: at(x, y, 0) });
    place(0, 0); // 1: a at (3, 48, 30)
    place(100, 0); // 2: a at (103, 48, 30)
    place(50, 20); // 3: in the way of the direct line
    const a = end(1, 'a');
    const b = end(2, 'a');
    const propose = (route: Waypoint[]) => proposeRoute(bus.state, BUILTIN_CATALOG, a, b, route);
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, a, b, [], { auto: false })).toMatchObject({
      ok: false,
      code: 'route-collides',
    });
    expect(propose([free(3, 98, 30), free(103, 98, 30)])).toMatchObject({ ok: true });
    expect(propose([free(3, 48, 30)])).toMatchObject({ ok: false, code: 'bad-waypoint' });
    expect(propose([{ ...free(3, 98, 30), entity: 999, kind: 'duct' }])).toMatchObject({
      ok: false,
      code: 'bad-waypoint',
    });
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, end(9, 'a'), b, [free(3, 98, 30)])).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, a, end(9, 'a'), [free(3, 98, 30)])).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(proposeRoute(bus.state, BUILTIN_CATALOG, a, a, [free(3, 98, 30)])).toMatchObject({
      ok: false,
      code: 'same-terminal',
    });
  });
});
