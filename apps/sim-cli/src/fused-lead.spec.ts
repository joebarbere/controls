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
 * A frozen save holding a fused lead (F3.6 part 2, the save-format review): a test lead across the
 * stand-in's L1 and N fuses at copper's melting point, and its save, written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/fused-lead.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v3/ctrl/fused-lead-engine-7-catalog-2.ctrl
 *
 * carries the one non-initial lead end state (both ends `intermittentOpen`, for good) through the
 * container, the migration and the load check. The fixture-rebuild check in `sources.spec.ts`
 * rebuilds it from the scenario.
 */
export const FUSED_LEAD_HASH = '618b81edec473a7102bb4603a492870f58e5eaedea033c731de8eb9458860819';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/fused-lead.console');
const COPPER_MELT_K = 1357.77;

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [FUSED_LEAD_HASH] });
  return game;
}

const leadSim = (game: Game) => (game.materialisedWorld() as World).connections[0].sim;

describe('the fused-lead save (F3.6 part 2)', () => {
  it('the scenario fuses the lead: both ends open, insulation damaged, cooling from the melting point', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(100);
    const sim = leadSim(game);
    expect(sim).toMatchObject({
      endAState: 'intermittentOpen',
      endBState: 'intermittentOpen',
      insulationDamaged: true,
    });
    expect(sim['conductorTempK'] as number).toBeLessThan(COPPER_MELT_K);
  });

  it('its checked-in save loads continued, open, and runs on into the uninterrupted future', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('fused-lead'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(FUSED_LEAD_HASH);
    const sim = leadSim(loaded.game);
    expect(sim).toMatchObject({
      endAState: 'intermittentOpen',
      endBState: 'intermittentOpen',
      insulationDamaged: true,
    });
    expect(sim['conductorTempK'] as number).toBeLessThanOrEqual(COPPER_MELT_K);
    expect(loaded.game.netlistDump()).toContain('intermittent-open');
    const straight = await scenarioGame();
    for (const game of [straight, loaded.game]) game.advance(5000);
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
    expect(loaded.game.hash()).toBe(straight.hash());
    expect(leadSim(loaded.game)).toMatchObject({ endAState: 'intermittentOpen', endBState: 'intermittentOpen' });
  });
});
