import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { createGame, type Game, loadGame, runConsoleScript } from '@controls/scripting-api';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { workshopWorld } from './testing/workshop';

/*
 * The protection scenario (F2.5 part 2, save-format review): a save holding a blown fuse, a part-melted
 * fuse and a tripped breaker, through `.ctrl` and the load check, not only through JSON. Its hashes
 * are pinned here; `fixtures/v2/ctrl/protection-engine-<N>.ctrl` is its save, written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/protection.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v2/ctrl/protection-engine-5.ctrl
 *
 * (a new fixture for a new engine, never a regenerated one). The fixture-rebuild check in
 * `sources.spec.ts` rebuilds it from the scenario.
 */
export const PROTECTION_HASH = 'ecbabf42dd94bc78853ca50cf0d6d62221dbfdb6b06a8967283ca4af0a9566bc';
export const PROTECTION_SNAPSHOT_HASH = 'd7e5ea9ff53ed10f543b605f2ec5f0309fd8fc3ff882174509940e4b9739d58c';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/protection.console');
const fixture = join(
  WORKSPACE_ROOT,
  `libs/domain/save-format/fixtures/v2/ctrl/protection-engine-${SIM_ENGINE_VERSION}.ctrl`,
);

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [PROTECTION_HASH] });
  return game;
}

const sim = (game: Game, id: number) => game.materialisedWorld().entities.find((e) => e.id === id)?.sim ?? {};

describe('the protection scenario (F2.5 part 2)', () => {
  it('saves a blown fuse, a part-melted fuse and a tripped breaker at its pinned hashes', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(2500);
    expect(game.hash()).toBe(PROTECTION_HASH);
    expect(game.snapshotHash()).toBe(PROTECTION_SNAPSHOT_HASH);
    expect(sim(game, 2)['blown']).toBe(true);
    const melting = sim(game, 5) as { blown: boolean; elementHeat: number; bodyHeat: number };
    expect(melting.blown).toBe(false);
    expect(melting.elementHeat + melting.bodyHeat).toBeGreaterThan(0.2);
    expect(melting.elementHeat + melting.bodyHeat).toBeLessThan(1);
    expect(sim(game, 8)['tripped']).toBe(true);
    expect(game.device(8)?.values).toMatchObject({ state: 'tripped', currentA: 0 });
  });

  it('its checked-in save loads as continued at the same hashes, and runs on into the same future', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(PROTECTION_HASH);
    expect(loaded.game.snapshotHash()).toBe(PROTECTION_SNAPSHOT_HASH);
    const straight = await scenarioGame();
    for (const game of [straight, loaded.game]) game.advance(20_000); // the second fuse melts
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
    expect(sim(loaded.game, 5)['blown']).toBe(true);
  });
});
