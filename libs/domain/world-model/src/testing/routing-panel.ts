import { BUILTIN_CATALOG } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, type World } from '@controls/save-format';
import { autoRoute } from '../lib/routing/auto-route';
import { createWorldBus, createWorldRegistry } from '../lib/session';

/*
 * A TEST-ONLY routing panel on the real catalogue (F3.2 part 1, ADR 0017): free-standing 40 × 60 mm
 * ducts and 4 mm² screw terminal blocks, laid out so the auto-router uses every part of its search.
 *
 * - D1 (entity 1): a duct along +x from (0, 0, 0), cut to 600 mm: axis y = 20, z = 30, x 0 … 600.
 * - D2 (entity 2): the same at y = 300: axis y = 320.
 * - R (entity 3): a riser duct turned a quarter about +z (roll 90°) at (640, 0, 0), cut to 340 mm: its
 *   body is x 600 … 640, y 0 … 340, touching both ducts' ends; axis x = 620, z = 30.
 * - Row A (entities 4 … 13): blocks at x = 20 + 6k, y = 60 (terminal b at y = 60 faces D1, a at y = 108
 *   faces D2). Row B (14 … 23): x = 320 + 6k, y = 200 (b at 200, a at 248), clear of row A's columns.
 *
 * `ROUTING_PANEL_WIRES` are wired by `routingPanelBus(true)` with `autoRoute` and `'auto'` terminations
 * (Trainee), 14 AWG THHN cut by the 8 in diagonal cutters. Positions are integers; nothing is mounted,
 * so `entity.place` checks no overlap (no enclosure or mount is involved).
 */

export const ROUTING_PANEL_REFS = {
  duct: { id: 'duct.lattisby-40x60', version: 1 },
  block: { id: 'tb.quennick-st4', version: 1 },
  wire: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
  cutter: { id: 'tool.veltmark-dc-8', version: 1 },
} as const;

const Z = { yaw: 0, pitch: 0, roll: 0 };
const at = (x: number, y: number, z: number) => ({ x, y, z });

/** Row A's block k (0 … 9) and row B's. */
export const rowA = (k: number): number => 4 + k;
export const rowB = (k: number): number => 14 + k;

/** The panel's wires: [entity a, terminal a, entity b, terminal b] (see the module comment). */
export const ROUTING_PANEL_WIRES: readonly (readonly [number, string, number, string])[] = [
  [rowA(0), 'b', rowB(0), 'b'], // both into D1
  [rowA(1), 'a', rowB(1), 'a'], // both into D2
  [rowA(2), 'a', rowB(2), 'b'], // D2, the riser, D1
  [rowA(3), 'b', rowA(4), 'b'], // neighbours in D1
  [rowB(5), 'a', rowA(5), 'b'], // D2, the riser, D1
  [rowA(6), 'a', rowA(6), 'b'], // one block's two clamps, round through the riser
  [rowB(7), 'b', rowB(9), 'b'], // D1
  [rowA(8), 'a', rowB(8), 'a'], // D2
];

/** The panel's devices (and, with `wired`, its wires) on a Trainee world with seed 0. */
export function routingPanelBus(wired = false): CommandBus<World> {
  const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), createWorldRegistry());
  const run = (id: string, args: Record<string, unknown>) => {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`routingPanelBus: ${id} failed: ${result.error.message}`);
  };
  const { duct, block } = ROUTING_PANEL_REFS;
  run('entity.place', { ref: duct, positionMm: at(0, 0, 0), orientationMdeg: Z });
  run('entity.place', { ref: duct, positionMm: at(0, 300, 0), orientationMdeg: Z });
  run('entity.place', { ref: duct, positionMm: at(640, 0, 0), orientationMdeg: { yaw: 0, pitch: 0, roll: 90_000 } });
  run('raceway.cut', { id: 1, lengthMm: 600 });
  run('raceway.cut', { id: 2, lengthMm: 600 });
  run('raceway.cut', { id: 3, lengthMm: 340 });
  for (let k = 0; k < 10; k++)
    run('entity.place', { ref: block, positionMm: at(20 + 6 * k, 60, 0), orientationMdeg: Z });
  for (let k = 0; k < 10; k++)
    run('entity.place', { ref: block, positionMm: at(320 + 6 * k, 200, 0), orientationMdeg: Z });
  if (wired) {
    for (const [ea, ta, eb, tb] of ROUTING_PANEL_WIRES) {
      const a = { entity: ea, terminal: ta, termination: 'auto' as const };
      const b = { entity: eb, terminal: tb, termination: 'auto' as const };
      const routed = autoRoute(bus.state, BUILTIN_CATALOG, a, b);
      if (!routed.ok) throw new Error(`routingPanelBus: no route ${ea}:${ta} → ${eb}:${tb}: ${routed.message}`);
      run('wire.add', {
        ref: ROUTING_PANEL_REFS.wire,
        a,
        b,
        route: routed.route,
        lengthMm: routed.lengthMm,
        colour: { base: 'black', stripe: null },
        tool: ROUTING_PANEL_REFS.cutter,
      });
    }
  }
  bus.clearHistory();
  return bus;
}

/**
 * `apps/sim-cli/scenarios/raceway-panel.console`'s parts on an empty Trainee world (seed 0): the DIN
 * panel (1) at (−200, −200, 0), a 40 × 60 duct (2) on its backplate cut to 250 mm (axis y = 90,
 * z = 44, x −150 … 100), screw blocks (3, 4) at x = −69 and −63 and a ground block (5) on rail 1, a
 * spring-cage block (6), the 3/4 in connector (7) in the opened `ko-bottom-1`, a stick (8) cut to
 * 300 mm and an elbow (9).
 */
export function racewayPanelBus(): CommandBus<World> {
  const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), createWorldRegistry());
  const run = (id: string, args: Record<string, unknown>) => {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`racewayPanelBus: ${id} failed: ${result.error.message}`);
  };
  const ref = (id: string) => ({ id, version: 1 });
  const place = (id: string, x: number, y: number, z: number, roll = 0, mountedOn: object | null = null) =>
    run('entity.place', {
      ref: ref(id),
      positionMm: at(x, y, z),
      orientationMdeg: { yaw: 0, pitch: 0, roll },
      mountedOn,
    });
  place('panel.pellmoor-din-400x500', -200, -200, 0);
  place('duct.lattisby-40x60', -150, 70, 14, 0, { entity: 1, mount: 'plate' });
  run('raceway.cut', { id: 2, lengthMm: 250 });
  place('tb.quennick-st4', -69, 126, 22, 0, { entity: 1, mount: 'rail-1' });
  place('tb.quennick-st4', -63, 126, 22, 0, { entity: 1, mount: 'rail-1' });
  place('tb.quennick-pe4', -57, 126, 22, 0, { entity: 1, mount: 'rail-1' });
  place('tb.quennick-sc25', -45, 122, 22, 0, { entity: 1, mount: 'rail-1' });
  run('enclosure.openEntry', { id: 1, entry: 'ko-bottom-1', tool: ref('tool.veltmark-sd-2') });
  place('connector.stavenor-emt-075', -117, -200, 83, 270_000);
  place('emt.stavenor-075', -112, -225, 88, 270_000);
  run('raceway.cut', { id: 8, lengthMm: 300 });
  place('elbow.stavenor-emt-075', -88, -525, 88, 180_000);
  bus.clearHistory();
  return bus;
}
