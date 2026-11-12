import type { CommandBus } from '@controls/commands';
import { createWorld, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import { CUTTER, WIRING_TEST_CATALOG } from '@controls/world-model/testing';

/*
 * Wired benches for the conductor netlist specs (F3.1): the built-in conductor entries landed with
 * `wire.add` over world-model's TEST-ONLY wiring catalogue (the built-in devices and conductors plus
 * its test tools, since no real cutter exists before F3.4). Trainee difficulty, so ends land `'auto'`.
 * Specs only; excluded from the lib build.
 */

export const THHN_14_SOLID = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
export const DIN_PSU_24V = { id: 'supply.railwick-din-24v-5a', version: 1 };
export const BREAKER_15A = { id: 'breaker.saltmere-1p-15a', version: 1 };
export const SPLIT_PHASE = { id: 'utility.larkmoor-split-phase-25kva', version: 1 };
export const RESISTOR_10R = { id: 'resistor.orrinwood-10r-10w', version: 1 };
export const TEST_LEAD = { id: 'lead.quillfern-test-1m', version: 1 };

/** A Trainee world bus over `WIRING_TEST_CATALOG`. */
export function wiredBus(seed = 7): CommandBus<World> {
  return createWorldBus(
    createWorld({ seed, difficulty: 'trainee' }),
    createWorldRegistry({ catalog: WIRING_TEST_CATALOG }),
  );
}

/** A free waypoint at (x, y, z) mm. */
export const free = (x: number, y: number, z: number) => ({
  kind: 'free' as const,
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});

/** `wire.add` args for `ref` from `a` to `b` (each `[entity, terminal]`), both ends `'auto'`, cut with the test cutter. */
export function wireArgs(
  ref: { id: string; version: number },
  a: [number, string],
  b: [number, string],
  route: ReturnType<typeof free>[],
  lengthMm: number,
) {
  return {
    ref,
    a: { entity: a[0], terminal: a[1], termination: 'auto' },
    b: { entity: b[0], terminal: b[1], termination: 'auto' },
    route,
    lengthMm,
    colour: { base: 'black', stripe: null },
    tool: CUTTER,
  };
}
