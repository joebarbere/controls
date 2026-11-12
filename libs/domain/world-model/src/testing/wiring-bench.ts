import { createWorld, type Difficulty, type World } from '@controls/save-format';
import type { CommandBus } from '@controls/commands';
import { createWorldBus, createWorldRegistry } from '../lib/session';
import { WIRING_TEST_CATALOG } from './wiring-catalog';
import { at, BLOCK, BOX, BREAKER, CUTTER, PANEL, PUNCH, SPLIT, STRIPPER, TORQUE } from './wired-world';

/*
 * A TEST-ONLY wiring bench over `WIRING_TEST_CATALOG`, built with commands from an empty world: the
 * split-phase stand-in supply (1) at the origin, a DIN panel (2) at x = 1000 with the 15 A breaker (3)
 * at the start of its rail and a terminal block (4) 100 mm along it, and a 1-gang box (5) at z = 2000
 * with both entries opened. World points (integer mm) the specs use are listed below.
 */

/** Terminal entry points on the bench (world mm). */
export const BENCH_POINTS = {
  l1: at(50, 250, 200),
  l2: at(250, 250, 200),
  n: at(150, 250, 200),
  line: at(1070, 390, 120),
  load: at(1070, 300, 120),
  block1: at(1155, 360, 130),
  block2: at(1165, 360, 130),
  block2Spring: at(1165, 360, 140),
  boxGround: at(10, 0, 2005),
  boxTop: at(25, 75, 2030),
  boxKo1: at(25, 0, 2030),
};

/** A free waypoint. */
export const freeAt = (x: number, y: number, z: number) => ({
  kind: 'free' as const,
  positionMm: at(x, y, z),
  entity: null,
  fixture: null,
  tool: null,
});

/** A route from L1 up, across and down to the breaker's line screw, clear of every body (floor 1 501 mm). */
export const L1_TO_LINE_ROUTE = [freeAt(50, 500, 300), freeAt(1070, 500, 300)];

/** An explicit screw termination with the test stripper's 14 AWG solid hole and the torque driver at `torqueNm`. */
export function screwTermination(torqueNm = 4, hole = 'h14s', lengthMm = 13) {
  return {
    method: 'screw',
    strip: { tool: STRIPPER, hole, lengthMm },
    accessory: null,
    clamp: { tool: TORQUE, torqueNm },
  };
}

/** The bench at `difficulty` (default Trainee, where `'auto'` terminations are allowed), with `seed`. */
export function wiringBench(difficulty: Difficulty = 'trainee', seed = 7): CommandBus<World> {
  const bus = createWorldBus(createWorld({ seed, difficulty }), createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
  const steps: [string, Record<string, unknown>][] = [
    ['entity.place', { ref: SPLIT, positionMm: at(0, 0, 0) }],
    ['entity.place', { ref: PANEL, positionMm: at(1000, 0, 0) }],
    ['entity.place', { ref: BREAKER, positionMm: at(1050, 300, 100), mountedOn: { entity: 2, mount: 'rail-1' } }],
    ['entity.place', { ref: BLOCK, positionMm: at(1150, 300, 100), mountedOn: { entity: 2, mount: 'rail-1' } }],
    ['entity.place', { ref: BOX, positionMm: at(0, 0, 2000) }],
    ['enclosure.openEntry', { id: 5, entry: 'top', tool: TORQUE }],
    ['enclosure.openEntry', { id: 5, entry: 'ko1', tool: PUNCH }],
  ];
  for (const [id, args] of steps) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`wiringBench: ${id} failed: ${result.error.message}`);
  }
  bus.clearHistory();
  return bus;
}

/** `wire.add` args from L1 to the breaker's line screw with `'auto'` terminations (Trainee). */
export function autoWireArgs(overrides: Record<string, unknown> = {}) {
  return {
    ref: { id: 'conductor.test-14', version: 1 },
    a: { entity: 1, terminal: 'l1', termination: 'auto' },
    b: { entity: 3, terminal: 'line', termination: 'auto' },
    route: L1_TO_LINE_ROUTE,
    lengthMm: 2000,
    colour: { base: 'black', stripe: null },
    tool: CUTTER,
    ...overrides,
  };
}
