import type { CommandBus } from '@controls/commands';
import { createWorld, type Difficulty, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '../lib/session';
import { orientationForAxes } from '../lib/snap/quarter-turn';
import { RESIDENTIAL, RESIDENTIAL_TEST_CATALOG } from './residential-catalog';
import { at, CUTTER, LEAD, WIRE } from './wired-world';

/*
 * A TEST-ONLY residential bench over `RESIDENTIAL_TEST_CATALOG`, built with commands from an empty world
 * (Trainee, seed 7): a duplex receptacle (1) at the origin, a kettle (2) at x = 600 and a 1-15P lamp (3)
 * at x = −600 (both within their 1000 mm cords of it), a four-space load centre (4) at x = 5000 with a
 * one-pole plug-on breaker (5) on space 1 (left column, stab 0), a GFCI receptacle (6) at x = 3000, a
 * three-way switch (7) at x = 3500, a sealed device (8) at x = 4000, a free 14 AWG conductor (wire 1)
 * and a test lead (connection 2) between the three-way and the sealed device's reachable terminal.
 */

/** The orientation of a device on the load centre's bus columns (its +x along −y, its front +z). */
export const BUS_ORIENTATION = orientationForAxes({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }) as NonNullable<
  ReturnType<typeof orientationForAxes>
>;

/** The world position of stab `index` of the bench panel's `column` (`left` or `right`). */
export const benchStabMm = (column: 'left' | 'right', index: number) =>
  at(5000 + (column === 'left' ? 0 : 40), 100 - 25 * index, 0);

/** The bench's commands, in order (also what a console file or a script logs to build it). */
export const RESIDENTIAL_BENCH_STEPS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['entity.place', { ref: RESIDENTIAL.duplex, positionMm: at(0, 0, 0) }],
  ['entity.place', { ref: RESIDENTIAL.kettle, positionMm: at(600, 0, 0) }],
  ['entity.place', { ref: RESIDENTIAL.lamp, positionMm: at(-600, 0, 0) }],
  ['entity.place', { ref: RESIDENTIAL.panel, positionMm: at(5000, 0, 0) }],
  [
    'entity.place',
    {
      ref: RESIDENTIAL.breaker1p,
      positionMm: benchStabMm('left', 0),
      orientationMdeg: BUS_ORIENTATION,
      mountedOn: { entity: 4, mount: 'left' },
    },
  ],
  ['entity.place', { ref: RESIDENTIAL.gfci, positionMm: at(3000, 0, 0) }],
  ['entity.place', { ref: RESIDENTIAL.threeWay, positionMm: at(3500, 0, 0) }],
  ['entity.place', { ref: RESIDENTIAL.sealed, positionMm: at(4000, 0, 0) }],
  [
    'wire.add',
    {
      ref: WIRE,
      a: null,
      b: null,
      route: [
        { kind: 'free', positionMm: at(0, 1000, 0), entity: null, fixture: null, tool: null },
        { kind: 'free', positionMm: at(1000, 1000, 0), entity: null, fixture: null, tool: null },
      ],
      lengthMm: 1200,
      colour: { base: 'white', stripe: null },
      tool: CUTTER,
    },
  ],
  ['lead.connect', { ref: LEAD, a: { entity: 7, terminal: 'a' }, b: { entity: 8, terminal: 'b' } }],
];

/** The bench at `difficulty` (default Trainee), with `seed`, its history cleared. */
export function residentialBench(difficulty: Difficulty = 'trainee', seed = 7): CommandBus<World> {
  const bus = createWorldBus(
    createWorld({ seed, difficulty }),
    createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG }),
  );
  for (const [id, args] of RESIDENTIAL_BENCH_STEPS) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`residentialBench: ${id} failed: ${result.error.message}`);
  }
  bus.clearHistory();
  return bus;
}
