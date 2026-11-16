/*
 * A conduit run for the fish tape specs (F3.4 part 2), as the `drill-and-pull` scenario starts it: the
 * DIN panel on the workshop's stud faces, its 3/4 in top drill site cut with the 1-1/8 in hole saw, a
 * 3/4 in connector in the new hole (entity 2, placed in it: `inEntry`), a stick up from it cut to 600 mm (entity 3), a 90° elbow
 * on its top turning towards +x (entity 4) and a second stick from the elbow cut to 400 mm (entity 5).
 * Positions are what `placeInWorld` gives (`apps/sim-cli/scenarios/drill-and-pull.ts`). Ports, world mm:
 *
 *   connector 2: (-880, 1300, 79) in the panel's `drill-top-1`, to (-880, 1325, 79)
 *   stick 3:     (-880, 1325, 79) to (-880, 1925, 79)
 *   elbow 4:     (-880, 1925, 79) to (-702, 2103, 79)
 *   stick 5:     (-702, 2103, 79) to (-302, 2103, 79)
 */

const ref = (id: string) => ({ id, version: 1 });
const ROLL = { yaw: 0, pitch: 0, roll: 90000 };

/** The world commands that build the run, in order (entity ids 1–5). */
export const PULL_RUN_STEPS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['entity.place', { ref: ref('panel.pellmoor-din-400x500'), positionMm: { x: -1010, y: 800, z: -21 } }],
  ['enclosure.openEntry', { id: 1, entry: 'drill-top-1', tool: ref('tool.corriden-hs-18') }],
  [
    'entity.place',
    {
      ref: ref('connector.stavenor-emt-075'),
      positionMm: { x: -863, y: 1300, z: 62 },
      orientationMdeg: ROLL,
      inEntry: { entity: 1, entry: 'drill-top-1' },
    },
  ],
  ['entity.place', { ref: ref('emt.stavenor-075'), positionMm: { x: -868, y: 1325, z: 67 }, orientationMdeg: ROLL }],
  ['raceway.cut', { id: 3, lengthMm: 600 }],
  ['entity.place', { ref: ref('elbow.stavenor-emt-075'), positionMm: { x: -892, y: 1925, z: 67 } }],
  ['entity.place', { ref: ref('emt.stavenor-075'), positionMm: { x: -702, y: 2091, z: 67 } }],
  ['raceway.cut', { id: 5, lengthMm: 400 }],
];

/** The Steel fish tape, 1/8 in x 50 ft. */
export const FISH_TAPE = ref('tool.veltmark-fr-1524');
/** 12 AWG solid THHN, made in black and white among others. */
export const THHN_12 = ref('conductor.tallowmere-thhn-12-solid');
