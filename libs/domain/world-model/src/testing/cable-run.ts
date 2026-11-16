import { BUILTIN_CATALOG } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '../lib/session';

/*
 * TEST-ONLY: a 14/2 NM-B cable from a 2-gang box's top clamp to a DIN panel's bottom knockout on the
 * built-in catalogue, at Trainee (so `'auto'` terminations land), for the renderer's cable specs
 * (F3.2 part 4). The box (entity 1) is at (0, 0, 0), its top clamp at (28, 92, 40); the panel
 * (entity 2) at (-100, 500, -60), its `ko-bottom-2` at (100, 500, 40); two feed-through blocks and a
 * ground block (entities 3–5) on the panel's lower rail, at x = 97, 103, 109. The cable runs through
 * two free waypoints, 200 mm tails at the box and 300 mm at the panel.
 */

const ref = (id: string) => ({ id, version: 1 });
const free = (x: number, y: number, z: number) => ({
  kind: 'free' as const,
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});

/** How far the cable run is taken. */
export interface CableRunOptions {
  /** Jacket stripped at the box (end a) and the panel (end b), mm (default none). */
  readonly strip?: { readonly a: number; readonly b: number };
  /** Land the black, white and bare conductors on blocks 3, 4, 5 at the panel (needs `strip.b`). */
  readonly land?: boolean;
  readonly label?: string | null;
}

/** The cable-run bus (see the module comment). Throws if a step is refused. */
export function cableRunBus(options: CableRunOptions = {}): CommandBus<World> {
  const bus = createWorldBus(
    createWorld({ seed: 3, difficulty: 'trainee' }),
    createWorldRegistry({ catalog: BUILTIN_CATALOG }),
  );
  const screwdriver = ref('tool.veltmark-sd-2');
  const stripper = ref('tool.veltmark-ws-nm12');
  const block = (id: string, x: number) => ({
    ref: ref(id),
    positionMm: { x, y: 651, z: -38 },
    mountedOn: { entity: 2, mount: 'rail-2' },
  });
  const steps: [string, Record<string, unknown>][] = [
    ['entity.place', { ref: ref('box.tinmoor-2g-nm'), positionMm: { x: 0, y: 0, z: 0 } }],
    ['enclosure.openEntry', { id: 1, entry: 'clamp-top-1', tool: screwdriver }],
    ['entity.place', { ref: ref('panel.pellmoor-din-400x500'), positionMm: { x: -100, y: 500, z: -60 } }],
    ['enclosure.openEntry', { id: 2, entry: 'ko-bottom-2', tool: screwdriver }],
    ['entity.place', block('tb.quennick-st4', 97)],
    ['entity.place', block('tb.quennick-st4', 103)],
    ['entity.place', block('tb.quennick-pe4', 109)],
    [
      'cable.add',
      {
        ref: ref('cable.sorrelby-nmb-14-2'),
        a: { entity: 1, entry: 'clamp-top-1' },
        b: { entity: 2, entry: 'ko-bottom-2' },
        route: [free(28, 250, 40), free(100, 350, 40)],
        lengthMm: 960,
        tailsMm: { a: 200, b: 300 },
        tool: ref('tool.veltmark-dc-8'),
      },
    ],
  ];
  if (options.strip) {
    steps.push(['cable.strip', { id: 1, end: 'a', jacketMm: options.strip.a, tool: stripper }]);
    steps.push(['cable.strip', { id: 1, end: 'b', jacketMm: options.strip.b, tool: stripper }]);
  }
  if (options.land) {
    for (const [wire, entity] of [
      [1, 3],
      [2, 4],
      [3, 5],
    ]) {
      steps.push(['wire.land', { id: wire, end: 'b', at: { entity, terminal: 'b', termination: 'auto' } }]);
    }
  }
  if (options.label) steps.push(['wire.label', { id: 1, text: options.label, tool: ref('tool.penmarrow-lp-12') }]);
  for (const [id, args] of steps) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`cableRunBus: ${id} refused: ${result.error.message}`);
  }
  bus.clearHistory();
  return bus;
}
