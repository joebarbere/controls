import type { Game } from '@controls/scripting-api';

/*
 * The P1 four-surface scenario as a TypeScript script (plan F1.6, phase acceptance): place, move,
 * rotate and delete props with undo and redo. `four-surface.console` is the same scenario as console
 * lines, and `apps/sim-cli/src/four-surface.spec.ts` checks every headless driver reaches the same
 * `world.hash` (FOUR_SURFACE_HASH). The game-e2e mouse, palette and console drivers (F1.3, F1.5,
 * F1.7) must reach that hash too.
 *
 *   pnpm sim run apps/sim-cli/scenarios/four-surface.ts
 */
export default function fourSurface(game: Game): void {
  const crate = { id: 'prop.crate', version: 1 };
  const spool = { id: 'prop.spool', version: 1 };

  const placed = game.execOrThrow('entity.place', { ref: crate, positionMm: { x: 100, y: 0, z: -200 } });
  game.execOrThrow('entity.place', { ref: spool, positionMm: { x: 400, y: 0, z: -200 } });
  game.execOrThrow('entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } });
  game.execOrThrow('entity.rotate', { id: 2, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } });
  game.execOrThrow('view.resetLayout');
  game.execOrThrow('entity.delete', { id: 1 });
  game.execOrThrow('edit.undo'); // the crate comes back with the same id
  game.execOrThrow('entity.delete', { id: 2 });
  game.execOrThrow('edit.undo');
  game.execOrThrow('edit.redo'); // the spool is deleted again

  // A failing command changes nothing and isn't logged.
  const missing = game.exec('entity.move', { id: 99, positionMm: { x: 0, y: 0, z: 0 } });
  if (missing.ok) throw new Error('moving a missing entity should fail');

  const ids = game.world().entities.map((entity) => entity.id);
  if (ids.join() !== '1') throw new Error(`expected only entity 1 to remain, found [${ids.join()}]`);
  if (placed.seq !== 0 || game.entries().length !== 10) throw new Error('unexpected replay log');
}
