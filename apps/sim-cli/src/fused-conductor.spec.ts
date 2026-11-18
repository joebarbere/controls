import type { World } from '@controls/save-format';
import { createGame, type Game, loadGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { currentFixture } from './testing/fixtures';
import { workshopWorld } from './testing/workshop';

/*
 * A frozen save holding a fused conductor whose two ends were re-made (ADR 0018, the sticky fused
 * conductor; the save-format review's F3): 14 AWG THHN across the stand-in's L1 and N fuses, cools for a
 * minute, and both ends are unlanded and landed again (new terminations 3 and 4, D = 1, `ok`). Its save,
 * written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/fused-conductor.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v4/ctrl/fused-conductor-engine-8-catalog-3.ctrl
 *
 * carries `fused: true` with `ok` ends through the container, the migration and the load check, and
 * loads open. The fixture-rebuild check in `sources.spec.ts` rebuilds it from the scenario.
 */
export const FUSED_CONDUCTOR_HASH = '4fdad66a97eb648253adb5e264d090e0c0f12ca8855bf8789c83eb308bd9711d';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/fused-conductor.console');

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [FUSED_CONDUCTOR_HASH] });
  return game;
}

const wireSim = (game: Game) => (game.materialisedWorld() as World).connections[0].sim;
const REMADE = {
  fused: true,
  endATerminationId: 3,
  endBTerminationId: 4,
  endADegradation: 1,
  endBDegradation: 1,
  endAState: 'ok',
  endBState: 'ok',
};

/** Open, not netlisted, 0 A, the body's gap a reading (both ends closed). */
function expectOpen(game: Game): void {
  const record = game.connection(1);
  expect(record?.values['status']).toBe('open');
  expect(record?.values['conductorState']).toBe('open');
  expect(record?.values['currentA']).toBe(0);
  expect(game.netlistDump()).toContain('intermittent-open');
}

describe('the fused-conductor save (ADR 0018, the sticky fused conductor)', () => {
  it('the scenario fuses the conductor and re-makes both ends: fused, `ok` ends, still open', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(61_000);
    expect(wireSim(game)).toMatchObject(REMADE);
    expectOpen(game);
    expect(game.wireInfo(1)).toContain('conductor open (fused)');
  });

  it('its checked-in save loads continued, open, and runs on into the uninterrupted future', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('fused-conductor'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(FUSED_CONDUCTOR_HASH);
    expect(wireSim(loaded.game)).toMatchObject(REMADE);
    expectOpen(loaded.game);
    const straight = await scenarioGame();
    for (const game of [straight, loaded.game]) game.advance(5000);
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
    expect(loaded.game.hash()).toBe(straight.hash());
    expect(wireSim(loaded.game)).toMatchObject(REMADE);
    expectOpen(loaded.game);
  });
});
