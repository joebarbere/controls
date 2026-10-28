import type { Game } from '@controls/scripting-api';
import { placeOnTargets, worldSnapTargets, type CatalogRef, type Vec3Mm } from '@controls/world-model';

/*
 * The F1.7 mouse scenario as a script that snaps exactly as the mouse does: it aims at the same
 * cursor points as `apps/game-e2e/src/placement.spec.ts` and lets `placeOnTargets` (the maths behind
 * the renderer's ghost) choose the target and the snapped position. It must reach the same
 * `world.hash` as `mouse-place-move-delete.console`, which spells the positions out.
 *
 *   pnpm sim run apps/sim-cli/scenarios/mouse-place-move-delete.ts --world content/levels/workshop.json
 */
export default function mousePlaceMoveDelete(game: Game): void {
  // Snap against the world the script was given (the workshop): the same targets the renderer uses.
  const targets = worldSnapTargets(game.world());
  const box: CatalogRef = { id: 'prop.box', version: 1 };
  const crate: CatalogRef = { id: 'prop.crate', version: 1 };
  const at = (ref: CatalogRef, cursor: Vec3Mm, keepOrientation = false) => {
    const orientationMdeg = keepOrientation ? { yaw: 0, pitch: 0, roll: 0 } : undefined;
    const placed = placeOnTargets(ref, cursor, targets, { orientationMdeg });
    if (!placed.ok) throw new Error(`no snap at ${JSON.stringify(cursor)}: ${placed.reason}`);
    return placed;
  };

  game.execOrThrow('toolbelt.select', { slot: 1 });
  const first = at(box, { x: -150, y: 300, z: 0 });
  game.execOrThrow('entity.place', { ref: box, positionMm: first.positionMm, orientationMdeg: first.orientationMdeg });
  game.execOrThrow('toolbelt.select', { slot: 2 });
  const second = at(crate, { x: 100, y: -200, z: 0 });
  game.execOrThrow('entity.place', {
    ref: crate,
    positionMm: second.positionMm,
    orientationMdeg: second.orientationMdeg,
  });
  const moved = at(box, { x: -10, y: 150, z: 7 }, true); // onto DIN rail 1
  game.execOrThrow('entity.move', { id: 1, positionMm: moved.positionMm });
  game.execOrThrow('entity.delete', { id: 2 });
}
