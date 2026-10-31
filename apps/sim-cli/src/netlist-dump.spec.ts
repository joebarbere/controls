import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * `netlist.dump` goldens (plan F2.6): the text a `netlist.dump` line prints at the end of each bench
 * scenario, headless. The goldens live in `src/goldens/netlist-dump/<scenario>.txt`, and
 * `apps/game-e2e/src/netlist-dump.spec.ts` asserts the same files byte for byte from the game's
 * console (the sim worker's export, dumped on the page's main thread in Chromium). A golden moves
 * when the scenario, the netlist compiler, the solution record or a nominal band changes: re-pin it
 * with `pnpm nx test sim-cli -u` and review the diff. F2.5's `bench-lamp` scenario adds its golden
 * when it lands.
 */

const SCENARIOS = ['bench-leads', 'sim-step', 'sources', 'mains'] as const;
const goldenPath = (scenario: string) => join(import.meta.dirname, 'goldens/netlist-dump', `${scenario}.txt`);
const scenarioPath = (scenario: string) => join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios', `${scenario}.console`);

async function dumpAfter(scenario: string): Promise<string> {
  const game = createGame({ world: workshopWorld() });
  const ran = await runConsoleScript(game, await readFile(scenarioPath(scenario), 'utf8'));
  if (!ran.ok) throw new Error(`${scenario}: ${ran.error.message}`);
  return game.netlistDump();
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-netlist-dump-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('netlist.dump goldens', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario}: the dump at the end of the scenario`, async () => {
      await expect(await dumpAfter(scenario)).toMatchFileSnapshot(goldenPath(scenario));
    });
  }

  it('a netlist.dump line prints the same lines as Game.netlistDump, and changes no hash', async () => {
    const game = createGame({ world: workshopWorld() });
    const text = `${await readFile(scenarioPath('sim-step'), 'utf8')}netlist.dump\nworld.hash\n`;
    const ran = await runConsoleScript(game, text);
    expect(ran.ok).toBe(true);
    const golden = readFileSync(goldenPath('sim-step'), 'utf8');
    const [before, ...rest] = ran.output;
    expect(rest.at(-1)).toBe(before); // world.hash before and after the dump
    expect(`${rest.slice(0, -1).join('\n')}\n`).toBe(golden);
    expect(game.entries().map((e) => e.id)).not.toContain('netlist.dump'); // never logged
  });

  it('`sim run` prints it on stdout (data only)', async () => {
    const file = join(dir, 'mains-dump.console');
    await writeFile(file, `${await readFile(scenarioPath('mains'), 'utf8')}netlist.dump\n`);
    const result = spawnSync(
      process.execPath,
      [join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs'), 'run', file, '--world', WORKSHOP_LEVEL],
      { cwd: WORKSPACE_ROOT, env: { ...process.env, INIT_CWD: WORKSPACE_ROOT }, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n');
    // The scenario's own world.hash, then the dump, then run's closing world.hash.
    expect(`${lines.slice(1, -2).join('\n')}\n`).toBe(readFileSync(goldenPath('mains'), 'utf8'));
  });

  it('takes no arguments', async () => {
    const game = createGame({ world: workshopWorld() });
    expect(await runConsoleScript(game, 'netlist.dump now')).toMatchObject({
      ok: false,
      error: { kind: 'parse', lineNumber: 1, column: 14, message: 'netlist.dump takes no arguments' },
    });
  });

  it('of the workshop level alone: no circuit, no solution', () => {
    const lines = createGame({ world: workshopWorld() }).netlistDump().split('\n');
    expect(lines).toEqual([
      'netlist.dump tick 0',
      'netlist 0 nodes, 0 branches, 0 islands',
      expect.stringMatching(/^topology [0-9a-f]{64}$/),
      'solution none',
      '',
    ]);
  });
});
