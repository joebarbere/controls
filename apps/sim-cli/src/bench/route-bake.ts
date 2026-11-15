import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld, type World } from '@controls/save-format';
import {
  autoRoute,
  type BakedWorld,
  bakeWorldRoutes,
  centrelineHash,
  createWorldBus,
  createWorldRegistry,
} from '@controls/world-model';

/*
 * `route-bake-500-wires` (plan P3 "Budgets", F3.2 part 1, ADR 0017): the analytic bake (D5) of a panel
 * with 500 routed wires, what loading such a save or rebuilding its wires costs: every raceway's axis,
 * every duct lane, and every conductor's quantised centreline (`bakeWorldRoutes`). The centreline hash
 * is the case's untimed checksum, so a run can't skip the work. ADR 0010's Verlet bake took about 8 ms a wire (about 4 s for 500).
 *
 * The panel (built untimed, once, with real commands at Trainee): {@link ROUTE_BAKE_ROWS} rows of
 * {@link ROUTE_BAKE_BLOCKS} 4 mm² screw blocks at a 6 mm pitch, a 40 × 60 duct under each row and one
 * over the top row, all joined by a riser duct at their right-hand end. Wire i runs from block i's top
 * clamp (into the duct above its row) to block (7i + 13) mod n's bottom clamp (into the duct below its
 * row), so every clamp holds one conductor and most wires cross rows through the riser; each route is
 * `autoRoute`'s, each length its default. Deterministic: no randomness.
 */

export const ROUTE_BAKE_ROWS = 10;
export const ROUTE_BAKE_BLOCKS = 50;
/** The smoke run's panel: one row of 50, so `sim bench --smoke` stays cheap (it proves the case runs). */
export const ROUTE_BAKE_SMOKE_ROWS = 1;

const DUCT = { id: 'duct.lattisby-40x60', version: 1 };
const BLOCK = { id: 'tb.quennick-st4', version: 1 };
const WIRE = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const CUTTER = { id: 'tool.veltmark-dc-8', version: 1 };
const Z = { yaw: 0, pitch: 0, roll: 0 };
const ROW_PITCH = 150;
const DUCT_LENGTH = 320;

/** The panel with `rows` rows of {@link ROUTE_BAKE_BLOCKS} blocks and one wire per block. */
export function buildRouteBakePanel(rows = ROUTE_BAKE_ROWS): World {
  const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'trainee' }), createWorldRegistry());
  const run = (id: string, args: Record<string, unknown>) => {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`route-bake panel: ${id} failed: ${result.error.message}`);
  };
  const at = (x: number, y: number, z: number) => ({ x, y, z });
  // Ducts 1 … rows + 1: under each row and over the top one; then the riser touching all their ends.
  for (let r = 0; r <= rows; r++) {
    run('entity.place', { ref: DUCT, positionMm: at(0, ROW_PITCH * r, 0), orientationMdeg: Z });
    run('raceway.cut', { id: r + 1, lengthMm: DUCT_LENGTH });
  }
  run('entity.place', {
    ref: DUCT,
    positionMm: at(DUCT_LENGTH + 40, 0, 0),
    orientationMdeg: { yaw: 0, pitch: 0, roll: 90_000 },
  });
  run('raceway.cut', { id: rows + 2, lengthMm: ROW_PITCH * rows + 40 });
  const first = rows + 3;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < ROUTE_BAKE_BLOCKS; k++) {
      run('entity.place', { ref: BLOCK, positionMm: at(10 + 6 * k, ROW_PITCH * r + 60, 0), orientationMdeg: Z });
    }
  }
  const n = rows * ROUTE_BAKE_BLOCKS;
  for (let i = 0; i < n; i++) {
    const a = { entity: first + i, terminal: 'a', termination: 'auto' as const };
    const b = { entity: first + ((7 * i + 13) % n), terminal: 'b', termination: 'auto' as const };
    const routed = autoRoute(bus.state, BUILTIN_CATALOG, a, b);
    if (!routed.ok) throw new Error(`route-bake panel: wire ${i}: ${routed.message}`);
    run('wire.add', {
      ref: WIRE,
      a,
      b,
      route: routed.route,
      lengthMm: routed.lengthMm,
      colour: { base: 'black', stripe: null },
      tool: CUTTER,
    });
  }
  return bus.state;
}

/** The timed work: bake every route (`bakeWorldRoutes`), as a load does. */
export function bakeRoutes(world: World): BakedWorld {
  return bakeWorldRoutes(world, BUILTIN_CATALOG);
}

/** A bake's checksum: its route count, its point count and its centreline hash. */
export function bakeChecksum(baked: BakedWorld): string {
  let points = 0;
  for (const route of baked.routes) points += route.points.length / 3;
  return `${baked.routes.length}:${points}:${centrelineHash(baked)}`;
}
