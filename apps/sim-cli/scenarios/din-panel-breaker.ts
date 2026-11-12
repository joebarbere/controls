import type { Game } from '@controls/scripting-api';
import { placeInWorld, worldSnapTargets, type CatalogRef, type Vec3Mm } from '@controls/world-model';

/*
 * F3.5 part 1: the DIN panel and the 15 A breaker placed the way the mouse and the keyboard reticle
 * place them. It aims at the cursor points `apps/game-e2e/src/enclosures.spec.ts` aims at and lets
 * `placeInWorld` (the maths behind the renderer's ghost) choose the target, the snapped position and
 * the mount. It must reach the same `world.hash` as `din-panel-breaker.console`, which spells it out.
 *
 *   pnpm sim run apps/sim-cli/scenarios/din-panel-breaker.ts --world content/levels/workshop.json
 */
export default function dinPanelBreaker(game: Game): void {
  const panel: CatalogRef = { id: 'panel.pellmoor-din-400x500', version: 1 };
  const breaker: CatalogRef = { id: 'breaker.saltmere-1p-15a', version: 1 };
  const place = (ref: CatalogRef, cursor: Vec3Mm) => {
    const world = game.world();
    const placed = placeInWorld(world, ref, cursor, worldSnapTargets(world));
    if (!placed.ok) throw new Error(`no placement at ${JSON.stringify(cursor)}: ${placed.reason}`);
    const { positionMm, orientationMdeg, mountedOn } = placed;
    game.execOrThrow('entity.place', { ref, positionMm, orientationMdeg, mountedOn });
  };

  // Key 4, then a click on the backplate at (0, 50): the panel lands at (-200, -200, 0).
  game.execOrThrow('toolbelt.select', { slot: 4 });
  place(panel, { x: 0, y: 50, z: 0 });
  // Escape, focus DIN rail 1 (the reticle is the view centre, (0, 150)), key 5, Enter: the reticle is on
  // the panel's rail 1, whose centreline is at y = 150, so the breaker clips on there.
  game.execOrThrow('view.focus', { target: 'din-rail-1' });
  game.execOrThrow('toolbelt.select', { slot: 5 });
  place(breaker, { x: 0, y: 150, z: 23 });
  // A click further left on the same rail: a second breaker.
  place(breaker, { x: -100, y: 150, z: 23 });
}
