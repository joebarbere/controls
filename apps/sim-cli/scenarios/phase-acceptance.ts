import type { Game } from '@controls/scripting-api';
import { placeOnTargets, worldSnapTargets, type CatalogRef, type Vec3Mm } from '@controls/world-model';

/*
 * The P1 phase-acceptance scenario as a script (plan, Phase acceptance): place, move and delete
 * with undo and redo. It aims at the same cursor points as the mouse driver in
 * `apps/game-e2e/src/phase-acceptance.spec.ts` and snaps with `placeOnTargets` (the maths behind the
 * renderer's ghost), so it must log exactly what `phase-acceptance.console` spells out and reach
 * the same `world.hash` (PHASE_ACCEPTANCE_HASH).
 *
 *   pnpm sim run apps/sim-cli/scenarios/phase-acceptance.ts --world content/levels/workshop.json
 */
export default function phaseAcceptance(game: Game): void {
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
  game.execOrThrow('edit.undo'); // the crate comes back with the same id
  game.execOrThrow('edit.redo'); // and goes again
  game.execOrThrow('edit.undo'); // and comes back for good

  const ids = game.world().entities.map((entity) => entity.id);
  if (ids.join() !== '1,2') throw new Error(`expected entities 1 and 2, found [${ids.join()}]`);
}
