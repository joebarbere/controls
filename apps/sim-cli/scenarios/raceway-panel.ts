import type { Game } from '@controls/scripting-api';
import { placeInWorld, worldSnapTargets, type CatalogRef, type Vec3Mm } from '@controls/world-model';

/*
 * F3.5 part 2: wire duct, DIN terminal blocks and an EMT-lite run on the DIN panel, placed the way
 * the mouse places them: `placeInWorld` (the maths behind the renderer's ghost) chooses the target,
 * the snapped position, the turn and the mount for each cursor point. It must reach the same
 * `world.hash` as `raceway-panel.console`, which spells every entry out.
 *
 *   pnpm sim run apps/sim-cli/scenarios/raceway-panel.ts --world content/levels/workshop.json
 */
export default function racewayPanel(game: Game): void {
  const ref = (id: string): CatalogRef => ({ id, version: 1 });
  const place = (part: CatalogRef, cursor: Vec3Mm) => {
    const world = game.world();
    const placed = placeInWorld(world, part, cursor, worldSnapTargets(world));
    if (!placed.ok) throw new Error(`no placement for ${part.id} at ${JSON.stringify(cursor)}: ${placed.reason}`);
    const { positionMm, orientationMdeg, mountedOn } = placed;
    game.execOrThrow('entity.place', { ref: part, positionMm, orientationMdeg, mountedOn });
  };

  // The panel on the workshop backplate (entity 1, at (-200, -200, 0)).
  place(ref('panel.pellmoor-din-400x500'), { x: 0, y: 50, z: 0 });
  // A 40 × 60 duct on its backplate between the rails (entity 2), cut to 250 mm, cover on.
  place(ref('duct.lattisby-40x60'), { x: 0, y: 90, z: 14 });
  game.execOrThrow('raceway.cut', { id: 2, lengthMm: 250 });
  // Two screw feed-through blocks, a ground block and a spring-cage block on rail 1 (entities 3–6).
  place(ref('tb.quennick-st4'), { x: -65, y: 150, z: 22 });
  place(ref('tb.quennick-st4'), { x: -59, y: 150, z: 22 });
  place(ref('tb.quennick-pe4'), { x: -53, y: 150, z: 22 });
  place(ref('tb.quennick-sc25'), { x: -45, y: 150, z: 22 });
  // Knock out the 3/4 in bottom knockout and run EMT down from it: a connector (7), a stick (8) cut
  // to 300 mm, and an elbow (9) on the stick's free end.
  game.execOrThrow('enclosure.openEntry', { id: 1, entry: 'ko-bottom-1', tool: ref('tool.veltmark-sd-2') });
  place(ref('connector.stavenor-emt-075'), { x: -95, y: -205, z: 100 });
  place(ref('emt.stavenor-075'), { x: -100, y: -250, z: 100 });
  game.execOrThrow('raceway.cut', { id: 8, lengthMm: 300 });
  place(ref('elbow.stavenor-emt-075'), { x: -100, y: -540, z: 100 });
  game.execOrThrow('device.operate', { id: 2, control: 'coverOn', value: true });
}
