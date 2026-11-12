import {
  BUILTIN_CATALOG,
  conductanceToAirWPerMK,
  conductorPhysics,
  conductorResistanceOhm,
  conductorThermal,
  type DeviceDefinition,
  thermalConductivityWPerMK,
} from '@controls/catalog';
import type { World } from '@controls/save-format';
import { createGame, type Game, loadGame, runConsoleScript } from '@controls/scripting-api';
import {
  asMadeContact,
  OXIDATION_ONSET_K,
  SIM_ENGINE_VERSION,
  TERMINATION_OVERHEAT_RISE_K,
  INSULATION_DAMAGE_MARGIN_K,
} from '@controls/sim-core';
import type { SimEvent } from '@controls/sim-protocol';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { currentFixture } from './testing/fixtures';
import { workshopWorld } from './testing/workshop';

/*
 * The bad-termination scenario (F3.6 part 2, ADR 0018 §7 and §12 golden 9): a 20 %-torque breaker
 * screw on 14 AWG THHN carrying a 1.44 kW stand-in load for 600 s. Its hashes are pinned here, and
 * `fixtures/v3/ctrl/bad-termination-engine-7-catalog-2.ctrl` is its save (the engine-7 save with landed
 * conductors and non-null end keys the save-format review asked for), written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/bad-termination.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v3/ctrl/bad-termination-engine-7-catalog-2.ctrl
 *
 * **Every expectation is derived from the built circuit's current** (ADR 0018 §7), never asserted
 * unconditionally: the conductor's steady state T_c is the §3.5 fixed point at that current, the hot
 * spot's the two-node closed form
 *
 *   T_h = [I² (a (1 − α T₀) + b) + G_fin T_c + G_term T_a] / (G_fin + G_term − I² a α),
 *
 * with a and b the end's constriction and film parts from its achieved torque, G_fin = √(G′(T_c) k A),
 * G_term = 0.026 W/K; within 0.5 % of the rise. The stand-in resistor puts the current below §7's
 * 12.01–13.07 A window (about 11.8 A: 120 V over 10 Ω plus the source, the conductors, the contacts and
 * two test leads), so, as §7 provides, the acceptance is the steady comparison at the recorded D (1:
 * the hot spot stays below the oxidation onset), and whether `terminationOverheat` and
 * `insulationDamaged` happen follows from the computed T_h.
 */
export const BAD_TERMINATION_HASH = 'f630358e4fa9070416b89e27b7692165c8f89c92aebe7c2ee0cee02110488288';
export const BAD_TERMINATION_SNAPSHOT_HASH = 'aeb5eb4375e16e6a84af5a9205dc19aacd3ca3da872e64efeec0bacdba081439';

/**
 * `wire.info 2` (the loose conductor) and `wire.info 3` (a test lead) at the end of the scenario
 * (F3.6 part 3): pinned in Node here and byte for byte in Chromium by `apps/game-e2e/src/wire-info.spec.ts`.
 * Re-pin with `pnpm nx test sim-cli -u` and review the diff, never in the e2e alone.
 */
const WIRE_INFO_GOLDEN = join(import.meta.dirname, 'goldens/wire-info/bad-termination.txt');

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/bad-termination.console');
const TA = 293.15;
const T0 = 293.15;
const ALPHA = 0.00393;
const END_TICK = 600_000;

async function scenarioGame(events: SimEvent[] = []): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  game.on('sim', (event) => events.push(event));
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [BAD_TERMINATION_HASH] });
  return game;
}

const device = (id: string) => BUILTIN_CATALOG.device({ id, version: 1 }) as DeviceDefinition;
const connection = (world: World, id: number) => {
  const found = world.connections.find((c) => c.id === id);
  if (found === undefined) throw new Error(`connection ${id}`);
  return found;
};

/** The hand calculation (ADR 0018 §3.5) for conductor `id` at current `amps`: T_c, and each landed end's T_h and R_end. */
function handCalculation(world: World, id: number, amps: number) {
  const thhn = conductorPhysics(BUILTIN_CATALOG, device('conductor.tallowmere-thhn-14-solid'));
  if (thhn === undefined) throw new Error('THHN');
  const thermal = conductorThermal(thhn);
  const i2 = amps * amps;
  // T_c: the scalar fixed point T_c = T_a + I² R′(T_c) / G′(T_c), iterated to 10⁻¹² K (a spreadsheet's job).
  let tc = TA + 10;
  for (let k = 0; k < 200; k++) {
    const next = TA + (i2 * conductorResistanceOhm(thhn, 1000, tc)) / conductanceToAirWPerMK(thermal, tc, TA);
    if (Math.abs(next - tc) < 1e-12) break;
    tc = next;
  }
  const g = conductanceToAirWPerMK(thermal, tc, TA);
  const fin = Math.sqrt(g * thermalConductivityWPerMK(thhn) * thhn.areaM2);
  const ends = (['a', 'b'] as const).map((side) => {
    const end = connection(world, id)[side];
    if (end?.termination == null) throw new Error('landed');
    const entity = world.entities.find((e) => e.id === end.entity);
    const spec = BUILTIN_CATALOG.device(entity?.ref ?? { id: '', version: 0 })
      ?.terminals.find((t) => t.id === end.terminal)
      ?.methods.find((m) => m.method === end.termination?.method);
    if (spec === undefined) throw new Error('spec');
    const { constrictionOhm: a, filmOhm: b } = asMadeContact(
      { termination: end.termination, spec, landedCount: 1 },
      thhn,
    );
    const gTerm = spec.heatPathWPerK;
    const th = (i2 * (a * (1 - ALPHA * T0) + b) + fin * tc + gTerm * TA) / (fin + gTerm - i2 * a * ALPHA);
    return { th, rEnd: a * (1 + ALPHA * (th - T0)) + b, torqueNm: end.termination.torqueNm };
  });
  return { tc, ends };
}

const riseError = (actual: number, expected: number) => Math.abs(actual - expected) / (expected - TA);

describe('the bad-termination scenario (F3.6 part 2, ADR 0018 §7)', () => {
  it('reaches its pinned hashes; the hot spot, the conductors and the drops are the hand calculation at the built current', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(END_TICK);
    expect(game.hash()).toBe(BAD_TERMINATION_HASH);
    expect(game.snapshotHash()).toBe(BAD_TERMINATION_SNAPSHOT_HASH);
    const world = game.materialisedWorld() as World;
    const amps = game.device(4)?.values['currentA'] as number;
    // The built current: 120 V over the stand-in's 10 Ω and the rest, below §7's window (reported).
    expect(amps).toBeGreaterThan(11.5);
    expect(amps).toBeLessThan(12.01);
    const bad = handCalculation(world, 2, amps);
    const good = handCalculation(world, 1, amps);
    // The loose end: 20 % of 4 N·m on the ±6 % torque driver.
    expect(bad.ends[0].torqueNm as number).toBeGreaterThan(0.8 * 0.94);
    expect(bad.ends[0].torqueNm as number).toBeLessThan(0.8 * 1.06);
    const sim = connection(world, 2).sim;
    expect(riseError(sim['conductorTempK'] as number, bad.tc)).toBeLessThan(0.005);
    expect(riseError(sim['endATempK'] as number, bad.ends[0].th)).toBeLessThan(0.005);
    expect(riseError(sim['endBTempK'] as number, bad.ends[1].th)).toBeLessThan(0.005);
    const goodSim = connection(world, 1).sim;
    expect(riseError(goodSim['endBTempK'] as number, good.ends[1].th)).toBeLessThan(0.005);
    // Below the oxidation onset, so no degradation: the comparison is at D = 1 (§7's fallback).
    expect(bad.ends[0].th).toBeLessThan(OXIDATION_ONSET_K.value);
    expect(sim['endADegradation']).toBe(1);
    expect(sim['endAState']).toBe('ok');
    // The acceptance: the loose end at least 50 K above its conductor, its drop at least 10× a good end's.
    expect((sim['endATempK'] as number) - (sim['conductorTempK'] as number)).toBeGreaterThanOrEqual(50);
    const ratio = bad.ends[0].rEnd / good.ends[1].rEnd;
    expect(ratio).toBeGreaterThanOrEqual(10);
    // The insulation flag follows from the computed hot spot (set only at the rating + 40 K, 403.15 K).
    expect(sim['insulationDamaged']).toBe(bad.ends[0].th >= 363.15 + INSULATION_DAMAGE_MARGIN_K.value);
  });

  it("the connection record (protocol 7): the loose end's drop is I × R_contact within 0.5 %, at least 10× a good end's", async () => {
    const game = await scenarioGame();
    const world = game.materialisedWorld() as World;
    const amps = game.device(4)?.values['currentA'] as number;
    const bad = handCalculation(world, 2, amps);
    const record = game.connection(2);
    const good = game.connection(1);
    if (record === null || good === null) throw new Error('both conductors have records');
    const v = record.values;
    expect(v).toMatchObject({ status: 'solved', endAState: 'ok', endBState: 'ok', insulationDamaged: 'no' });
    // Series: the conductor carries the resistor's current (the solve's rounding).
    expect(Math.abs((v['currentA'] as number) - amps) / amps).toBeLessThan(1e-9);
    // The engine's end drop against the hand calculation's I × R_contact (R at the computed T_h).
    const handDrop = amps * bad.ends[0].rEnd;
    expect(Math.abs((v['endADropV'] as number) - handDrop) / handDrop).toBeLessThan(0.005);
    expect(Math.abs((v['endAContactOhm'] as number) - bad.ends[0].rEnd) / bad.ends[0].rEnd).toBeLessThan(0.005);
    // The acceptance's 10×, from the records alone: the loose end against conductor 1's good end at the breaker.
    expect((v['endADropV'] as number) / (good.values['endBDropV'] as number)).toBeGreaterThanOrEqual(10);
    // Temperatures are own state: the record holds the bag's values exactly.
    const sim = connection(world, 2).sim;
    expect(v['endATempK']).toBe(sim['endATempK']);
    expect(v['conductorTempK']).toBe(sim['conductorTempK']);
    // The drops add up to the terminal-to-terminal voltage (an AC island: |V(load) − V(nut)|).
    const reading = game.probe('2:load', '3:splice');
    if (reading.kind !== 'ac') throw new Error(`an AC reading, got ${reading.kind}`);
    const sum = (v['conductorDropV'] as number) + (v['endADropV'] as number) + (v['endBDropV'] as number);
    expect(Math.abs(sum - reading.rmsVolts) / reading.rmsVolts).toBeLessThan(1e-12);
  });

  it('raises terminationOverheat (a protocol 7 sim event) once, at the step where the hot spot passes T_a + 100 K', async () => {
    const events: SimEvent[] = [];
    const game = await scenarioGame(events);
    const amps = game.device(4)?.values['currentA'] as number;
    const bad = handCalculation(game.materialisedWorld() as World, 2, amps);
    const threshold = TA + TERMINATION_OVERHEAT_RISE_K.value;
    // Unconditional (realism review R1 notes): the computed steady hot spot is past the threshold.
    expect(bad.ends[0].th).toBeGreaterThanOrEqual(threshold);
    expect(events.filter((e) => e.kind === 'insulationDamaged')).toHaveLength(0);
    const overheat = events.filter((e) => e.kind === 'terminationOverheat');
    expect(overheat).toHaveLength(1);
    expect(overheat[0]).toMatchObject({ entity: null, entities: [], connection: 2, end: 'a' });
    // Its tick is the state after the cadence step that crossed: below the threshold a tick before
    // (the previous step's state), at or above it at the event's tick, and the event's temperature.
    const { tick } = overheat[0];
    expect(tick % 10).toBe(1);
    const commands = (await readFile(scenario, 'utf8')).replace(/^sim\.step.*$/m, '').replace(/^world\.hash$/m, '');
    const stepped = createGame({ world: workshopWorld() });
    expect(await runConsoleScript(stepped, commands)).toMatchObject({ ok: true });
    stepped.advanceTo(tick - 1);
    expect(stepped.connection(2)?.values['endATempK'] as number).toBeLessThan(threshold);
    stepped.advanceTo(tick);
    const crossed = stepped.connection(2)?.values['endATempK'] as number;
    expect(crossed).toBeGreaterThanOrEqual(threshold);
    expect(overheat[0].detail['temperatureK']).toBe(crossed);
  });

  it('wire.info prints the records: the golden text, the same from a console line as from Game.wireInfo', async () => {
    const game = await scenarioGame();
    const text = `${game.wireInfo(2)}${game.wireInfo(3)}`;
    await expect(text).toMatchFileSnapshot(WIRE_INFO_GOLDEN);
    expect(text).toContain('end a ok, contact 0.0254515 Ω at 393.822 K, drop 0.300478 V'); // the loose end
    const { output } = await runConsoleScript(game, 'wire.info 2\nwire.info --id 3\n');
    expect(`${output.join('\n')}\n`).toBe(text);
    expect(game.hash()).toBe(BAD_TERMINATION_HASH); // read-only
  });

  it('its checked-in save (engine 7, landed conductors, non-null end keys) loads as continued and runs on identically', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('bad-termination'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(BAD_TERMINATION_HASH);
    const sim = connection(loaded.game.materialisedWorld() as World, 2).sim;
    expect(sim['endATerminationId']).not.toBeNull();
    expect(sim['endATempK']).not.toBeNull();
    expect(sim['endADegradation']).toBe(1);
    const straight = await scenarioGame();
    for (const game of [straight, loaded.game]) game.advance(5000);
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
  });
});
