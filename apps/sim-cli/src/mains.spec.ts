import { createGame, type Game, runConsoleScript } from '@controls/scripting-api';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { workshopWorld } from './testing/workshop';

/*
 * The mains scenario (F2.4 part 2): a split-phase utility service behind its R + jωL, with
 * near-bolted faults through test leads (L1–N and L1–L2), not loads. Its two hashes are pinned here **and** in `apps/game-e2e/src/sim-engine.spec.ts`,
 * which runs the same console file with the engine in the page: D6's cross-runtime check of the series
 * inductance's phasors (Node's V8 against Chromium's).
 */
export const MAINS_HASH = '9d4d91f1172c61bfadb578c2bebfd63938261a07326820dbf43f8fb931c2cc8b';
export const MAINS_SNAPSHOT_HASH = '3283a86c3478dff172fb2ea286970803496055710dc9d3e66824c08f43205a62';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/mains.console');

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [MAINS_HASH] });
  return game;
}

describe('the mains scenario (F2.4 part 2)', () => {
  it('reaches its pinned hashes, with L1, L2 and N carrying different phasor currents', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(100);
    expect(game.hash()).toBe(MAINS_HASH);
    expect(game.snapshotHash()).toBe(MAINS_SNAPSHOT_HASH);
    const l1n = game.probe('1:l1', '1:n');
    const l2n = game.probe('1:l2', '1:n');
    if (l1n.kind !== 'ac' || l2n.kind !== 'ac') throw new Error('expected AC readings');
    // L1 is loaded by both leads, so it sags more than L2; both below the 120 V open-circuit EMF.
    expect(l1n.rmsVolts).toBeLessThan(l2n.rmsVolts);
    expect(l2n.rmsVolts).toBeLessThan(120);
    expect(game.islands()).toMatchObject([{ kind: 'ac', status: 'solved' }]);
  });
});
