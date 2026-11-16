import { createGame, type Game, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import type { World } from '@controls/world-model';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lampCircuit, { buildLampCircuit, LAMP_CIRCUIT_IDS } from '../scenarios/lamp-circuit';
import { WORKSPACE_ROOT } from './script-loader';
import { ACCEPTANCE_HASHES } from './testing/acceptance-hashes';
import { currentFixture } from './testing/fixtures';
import { JOURNEYMAN_WORKSHOP_ARGS, workshopWorldAt } from './testing/workshop';

/*
 * P3 phase acceptance: the lamp circuit, with real tool steps (D12), at Journeyman. The split-phase
 * stand-in supply feeds a DIN-rail panel (the 15 A breaker, terminal blocks); 14/2 NM-B is stapled down
 * stud 4 to a junction box with wire-nut splices and on, through stud 5, to a box holding the 120 V 60 W
 * lamp. `scenarios/lamp-circuit.ts` builds it as the mouse and the keyboard would (placements,
 * staples and the bore snapped, free conductors auto-routed), `scenarios/lamp-circuit.console` spells it
 * out; both log exactly the same entries and reach these hashes. Its save is the frozen fixture
 * `fixtures/v3/ctrl/lamp-circuit-engine-7-catalog-2.ctrl`, rebuilt by `sources.spec.ts`:
 *
 *   pnpm sim run apps/sim-cli/scenarios/lamp-circuit.console --world content/levels/workshop.json \
 *     --difficulty journeyman --save libs/domain/save-format/fixtures/v3/ctrl/lamp-circuit-engine-7-catalog-2.ctrl
 *
 * **The cross-runtime hook (PR B, `apps/game-e2e/src/wiring-acceptance.spec.ts` and `apps/desktop-e2e`):**
 * a New sandbox on the workshop at Journeyman with seed 0 that logs these entries (the console lines, or
 * the mouse and keyboard for some of them) must reach `LAMP_CIRCUIT_LIT_HASH` and
 * `LAMP_CIRCUIT_LIT_SNAPSHOT_HASH` after the breaker's 1.5 s, and `LAMP_CIRCUIT_HASH` and
 * `LAMP_CIRCUIT_SNAPSHOT_HASH` at the end, in Node and in Chromium's worker (both transports). The
 * values live in `apps/sim-cli/scenarios/acceptance-hashes.json` (read with `fs` by the e2e, as they
 * read the `.console` files; this spec checks every one); in the game, `world.hash` and the session
 * hook's `snapshotHash()` give what to compare. Change them together, never one: a difference in the
 * game is float drift between engines, not a golden to re-pin. A numeric change also bumps
 * `SIM_ENGINE_VERSION` (D8).
 */

/** `world.hash` with the lamp lit: 1.5 s after the breaker closed. */
export const LAMP_CIRCUIT_LIT_HASH = ACCEPTANCE_HASHES.lampCircuit.litHash;
export const LAMP_CIRCUIT_LIT_SNAPSHOT_HASH = ACCEPTANCE_HASHES.lampCircuit.litSnapshotHash;
/** `world.hash` at the end: 0.5 s after the breaker opened, the lamp out. */
export const LAMP_CIRCUIT_HASH = ACCEPTANCE_HASHES.lampCircuit.hash;
export const LAMP_CIRCUIT_SNAPSHOT_HASH = ACCEPTANCE_HASHES.lampCircuit.snapshotHash;

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const consoleFile = join(scenarios, 'lamp-circuit.console');
const ids = LAMP_CIRCUIT_IDS;

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

const journeymanGame = () => createGame({ world: workshopWorldAt('journeyman') });

/** The console file up to (and including) its `n`-th `world.hash` line (all of it for `Infinity`). */
async function consoleGame(hashes = Infinity): Promise<Game> {
  const lines = (await readFile(consoleFile, 'utf8')).split('\n');
  let seen = 0;
  const end = lines.findIndex((line) => line.startsWith('world.hash') && ++seen === hashes);
  const game = journeymanGame();
  const result = await runConsoleScript(game, (end < 0 ? lines : lines.slice(0, end + 1)).join('\n'));
  expect(result.ok).toBe(true);
  return game;
}

const lamp = (game: Game) => game.device(ids.lamp)?.values ?? {};
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-lamp-circuit-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the lamp circuit (P3 phase acceptance, D12)', () => {
  it('the script and the console file log exactly the same entries and reach the pinned hashes', async () => {
    const script = journeymanGame();
    lampCircuit(script);
    expect(script.hash()).toBe(LAMP_CIRCUIT_HASH);
    expect(script.snapshotHash()).toBe(LAMP_CIRCUIT_SNAPSHOT_HASH);
    const game = journeymanGame();
    const result = await runConsoleScript(game, await readFile(consoleFile, 'utf8'));
    expect(result).toMatchObject({ ok: true, output: [LAMP_CIRCUIT_LIT_HASH, LAMP_CIRCUIT_HASH] });
    expect(game.entries()).toStrictEqual(script.entries());
    expect(game.tick()).toBe(2000);
    expect(game.snapshotHash()).toBe(LAMP_CIRCUIT_SNAPSHOT_HASH);
    expect((game.world() as World).difficulty).toBe('journeyman');
  });

  it('every step is a logged command with its tool: knockouts, cables, jackets, strips, splices and torques', () => {
    const game = journeymanGame();
    lampCircuit(game);
    const entries = game.entries();
    const tool = (args: unknown) => (args as { tool: { id: string } }).tool.id;
    const count = (id: string) => entries.filter((e) => e.id === id).length;
    expect(count('entity.place')).toBe(12);
    // Knockouts and clamps: opened with the screwdriver's blade (a knockout is driven out).
    const opened = entries.filter((e) => e.id === 'enclosure.openEntry');
    expect(opened.map((e) => tool(e.args))).toStrictEqual(Array(5).fill('tool.veltmark-sd-2'));
    // Two cables cut with the diagonal cutters; jackets stripped with the NM stripper.
    const cables = entries.filter((e) => e.id === 'cable.add');
    expect(cables.map((e) => tool(e.args))).toStrictEqual(['tool.veltmark-dc-8', 'tool.veltmark-dc-8']);
    const strips = entries.filter((e) => e.id === 'cable.strip');
    expect(strips.map((e) => tool(e.args))).toStrictEqual(Array(4).fill('tool.veltmark-ws-nm12'));
    // The bore through stud 5 names its auger; staples within the NM support spacing.
    const run2 = (cables[1].args as { route: { kind: string; tool: { id: string } | null }[] }).route;
    expect(run2.map((w) => [w.kind, w.tool?.id ?? null])).toStrictEqual([
      ['staple', null],
      ['bore', 'tool.corriden-sa-12'],
      ['staple', null],
    ]);
    // Every termination is explicit (Journeyman: no 'auto'), stripped through the 14 AWG solid hole
    // of the right stripper (NM conductors with the NM stripper, THHN with the general one), torqued with
    // a torque driver where the method is a screw, twisted on by hand where it is a wire nut.
    type Landing = {
      method: string;
      strip: { tool: { id: string }; hole: string };
      clamp: { tool: { id: string } | null };
    };
    const landings = entries.flatMap((e): { landing: Landing | 'auto'; general: boolean }[] => {
      if (e.id === 'wire.land') {
        return [{ landing: (e.args as { at: { termination: Landing } }).at.termination, general: false }];
      }
      if (e.id !== 'wire.add') return [];
      const { a, b } = e.args as { a: { termination: Landing }; b: { termination: Landing } };
      return [a, b].map((end) => ({ landing: end.termination, general: true }));
    });
    expect(landings).toHaveLength(17); // the bare EGC's lamp-box end stays folded back
    for (const { landing, general } of landings) {
      if (landing === 'auto') throw new Error("an 'auto' termination at Journeyman");
      expect(landing.strip.hole).toBe('sol14');
      expect(landing.strip.tool.id).toBe(general ? 'tool.veltmark-ws-1018' : 'tool.veltmark-ws-nm12');
      if (landing.method === 'twistOn') expect(landing.clamp.tool).toBeNull();
      else {
        expect(landing.method).toBe('screw');
        expect(['tool.calderyn-ts-03', 'tool.calderyn-ts-15']).toContain(landing.clamp.tool?.id);
      }
    }
    // The stored outcomes: no nicks (the right hole), a torque wherever there is a screw.
    const world = game.world() as World;
    for (const c of world.connections) {
      for (const end of [c.a, c.b]) {
        const t = end?.termination;
        if (t === null || t === undefined) continue;
        expect(t).toMatchObject({ auto: false, nickedStrandFraction: 0 });
        expect(t.torqueNm === null).toBe(t.method === 'twistOn');
      }
    }
    // At Journeyman an 'auto' termination is refused for what it is (on a free terminal, the supply's
    // l2, so nothing else can refuse it), and the same landing with its steps spelled out is accepted.
    const spare = {
      ref: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
      b: null,
      route: [{ kind: 'free', positionMm: { x: -1250, y: 700, z: 300 }, entity: null, fixture: null, tool: null }],
      lengthMm: 500,
      colour: { base: 'red', stripe: null },
      tool: { id: 'tool.veltmark-dc-8', version: 1 },
    };
    const l2 = { entity: ids.supply, terminal: 'l2' };
    expect(game.exec('wire.add', { ...spare, a: { ...l2, termination: 'auto' } })).toMatchObject({
      ok: false,
      error: { code: 'termination-required' },
    });
    const explicit = {
      method: 'screw',
      strip: { tool: { id: 'tool.veltmark-ws-1018', version: 1 }, hole: 'sol14', lengthMm: 13 },
      accessory: null,
      clamp: { tool: { id: 'tool.calderyn-ts-15', version: 1 }, torqueNm: 4 },
    };
    expect(game.exec('wire.add', { ...spare, a: { ...l2, termination: explicit } }).ok).toBe(true);
    expect(game.exec('edit.undo', {}).ok).toBe(true); // the connection list below is the scenario's
    // The splices: black, white and bare joined in their own nut; the lamp on the black and the white.
    expect(world.connections.map((c) => [c.id, c.colour?.base, c.a?.entity ?? null, c.b?.entity ?? null])).toEqual([
      [1, 'black', ids.breaker, ids.tbLine],
      [2, 'black', ids.tbLine, ids.nutBlack],
      [3, 'white', ids.tbNeutral, ids.nutWhite],
      [4, 'bare', ids.tbGround, ids.nutBare],
      [5, 'black', ids.nutBlack, ids.lamp],
      [6, 'white', ids.nutWhite, ids.lamp],
      [7, 'bare', ids.nutBare, null],
      [8, 'black', ids.supply, ids.breaker],
      [9, 'white', ids.supply, ids.tbNeutral],
    ]);
  });

  it('breaker on: the lamp is lit at the hand-calculated current, its light inside the band; off: it goes out', async () => {
    const game = await consoleGame(1);
    expect(game.hash()).toBe(LAMP_CIRCUIT_LIT_HASH);
    expect(game.snapshotHash()).toBe(LAMP_CIRCUIT_LIT_SNAPSHOT_HASH);
    const lit = lamp(game);
    expect(lit['status']).toBe('solved');
    const across = game.probe(`${ids.lamp}:a`, `${ids.lamp}:b`);
    if (across.kind !== 'ac') throw new Error(across.kind);
    const v = across.rmsVolts;
    const amps = lit['currentA'] as number;
    // Hand calculation: lit at rated current within 0.5 %. The lamp's rated point is exact by
    // construction (R_r = V_r²/P_r = 240 Ω at 2700 K, so 0.5 A at 120 V), and the wiring drops only about
    // 54 mV (0.045 %), so V ≈ 119.95 V and I ≈ 0.4999 A. Near rated voltage an incandescent lamp's power
    // goes as V^1.6 (Fink and Beaty), so its current as V^0.6: 0.5 A × (V / 120 V)^0.6 = 0.49986 A, which
    // the check below agrees with; but 0.05 % off rated it can't tell that exponent from any other. The
    // off-nominal behaviour is P2's lamp goldens' job (`lamp-120v.spec.ts`, `lamp.spec.ts`: L ∝ V^3.4 from
    // 75 % to 115 % of rated voltage).
    const hand = 0.5 * Math.pow(v / 120, 0.6);
    expect(relative(amps, hand)).toBeLessThan(0.005);
    expect(relative(amps, 0.5)).toBeLessThan(0.005);
    // Ohm's law on the record (its resistance at its filament temperature) and the probe.
    expect(relative(v / (lit['resistanceOhm'] as number), amps)).toBeLessThan(1e-9);
    // L ∝ V^3.4 (Fink and Beaty); the model is within 4 % of it near rated voltage.
    expect(relative(lit['lightOutputRel'] as number, Math.pow(v / 120, 3.4))).toBeLessThan(0.04);
    expect(lit['lightOutputRel']).toBeGreaterThan(0.99);
    // The source by hand: the half winding's r = 10.304 mΩ, x = 20.608 mΩ (25 kVA, 2 %, X/R 2, half of
    // 0.02 × 240² / 25 000 = 46.08 mΩ). The lamp is resistive, so its current phasor lies along its
    // voltage; the terminal voltage is 120 V − I (r + jx).
    const unit = { re: across.re / v, im: across.im / v };
    const i = { re: amps * unit.re, im: amps * unit.im };
    const r = 0.010304;
    const x = 0.020608;
    const terminal = { re: 120 - (i.re * r - i.im * x), im: -(i.re * x + i.im * r) };
    const handTerminal = Math.hypot(terminal.re, terminal.im);
    const supply = game.probe(`${ids.supply}:l1`, `${ids.supply}:n`);
    if (supply.kind !== 'ac') throw new Error(supply.kind);
    expect(relative(120 - supply.rmsVolts, 120 - handTerminal)).toBeLessThan(0.005);
    // KVL round the loop: the supply's terminal voltage less the lamp's is every series drop the
    // records and the breaker show: wires 8, 1, 2, 5 (L) and 6, 3, 9 (N), their ends, and the breaker's
    // closed pole (10 mΩ).
    let drops = amps * 0.01;
    for (const id of [8, 1, 2, 5, 6, 3, 9]) {
      const rec = game.connection(id)?.values ?? {};
      expect(relative(rec['currentA'] as number, amps), `wire ${id}`).toBeLessThan(1e-6);
      drops += (rec['conductorDropV'] as number) + (rec['endADropV'] as number) + (rec['endBDropV'] as number);
    }
    expect(relative(drops, supply.rmsVolts - v)).toBeLessThan(0.005);
    // The bare EGCs carry nothing.
    expect(game.connection(4)?.values['currentA']).toBe(0);
    // Off: half a second later the lamp is out, under a display step.
    const rest = (await readFile(consoleFile, 'utf8')).split('\n');
    const first = rest.findIndex((line) => line.startsWith('world.hash'));
    expect(await runConsoleScript(game, rest.slice(first + 1).join('\n'))).toMatchObject({
      ok: true,
      output: [LAMP_CIRCUIT_HASH],
    });
    const out = lamp(game);
    expect(out).toMatchObject({ status: 'solved', powerW: 0, currentA: 0 });
    expect(out['lightOutputRel']).toBeLessThan(1 / 255);
  });

  it('sim run prints both hashes for the console file and the final one for the script; replay and a save reach them', () => {
    const save = join(dir, 'lamp-circuit.ctrl');
    const run = sim('run', consoleFile, ...JOURNEYMAN_WORKSHOP_ARGS, '--save', save);
    expect(run.stderr).toBe('');
    expect(run.stdout).toEqual([LAMP_CIRCUIT_LIT_HASH, LAMP_CIRCUIT_HASH, LAMP_CIRCUIT_HASH]);
    const script = sim(
      'run',
      join(scenarios, 'lamp-circuit.ts'),
      ...JOURNEYMAN_WORKSHOP_ARGS,
      '--expect',
      LAMP_CIRCUIT_HASH,
    );
    expect(script).toMatchObject({ status: 0, stderr: '' });
    expect(sim('replay', save, '--expect', LAMP_CIRCUIT_HASH)).toMatchObject({ status: 0, stderr: '' });
  });

  it('byte-identical snapshots across two runs and a replay, every 250 ms through the lit and dark phases', async () => {
    const run = () => {
      const game = journeymanGame();
      buildLampCircuit(game);
      game.execOrThrow('device.operate', { id: ids.breaker, control: 'on', value: true });
      const snapshots: Uint8Array[] = [];
      for (let t = 250; t <= 1500; t += 250) {
        game.advanceTo(t);
        snapshots.push(game.snapshot());
      }
      game.execOrThrow('device.operate', { id: ids.breaker, control: 'on', value: false });
      for (let t = 1750; t <= 2000; t += 250) {
        game.advanceTo(t);
        snapshots.push(game.snapshot());
      }
      return { game, snapshots };
    };
    const first = run();
    const second = run();
    expect(second.snapshots).toStrictEqual(first.snapshots);
    expect(second.game.hash()).toBe(first.game.hash());
    const replayed = replayGame(JSON.parse(JSON.stringify(first.game.replayLog())));
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.game.hash()).toBe(first.game.hash());
    expect(replayed.game.snapshotHash()).toBe(first.game.snapshotHash());
  });

  it("its checked-in save (this engine's and catalogue's) loads as continued and runs on identically", async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('lamp-circuit'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(LAMP_CIRCUIT_HASH);
    expect(loaded.game.snapshotHash()).toBe(LAMP_CIRCUIT_SNAPSHOT_HASH);
    // Close the breaker again on both: the warm filament's smaller inrush, and the same bytes.
    const straight = await consoleGame();
    for (const game of [straight, loaded.game]) {
      game.execOrThrow('device.operate', { id: ids.breaker, control: 'on', value: true });
      game.advance(300);
    }
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
  });
});
