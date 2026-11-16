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
import { createGame, type Game, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import {
  asMadeContact,
  INSULATION_DAMAGE_MARGIN_K,
  OXIDATION_ONSET_K,
  SIM_ENGINE_VERSION,
  TERMINATION_OVERHEAT_RISE_K,
} from '@controls/sim-core';
import type { SimEvent } from '@controls/sim-protocol';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import badTermination, { buildBadTermination, LOOSE_TORQUE_NM } from '../scenarios/bad-termination';
import { LAMP_CIRCUIT_IDS } from '../scenarios/lamp-circuit';
import { WORKSPACE_ROOT } from './script-loader';
import { currentFixture } from './testing/fixtures';
import { workshopWorldAt } from './testing/workshop';

/*
 * P3 phase acceptance (ADR 0018 §7 and §12 golden 9): a bad termination is measurable and heats. The
 * lamp circuit (`lamp-circuit.console`, at Journeyman) with the breaker's load screw (wire 1, end a)
 * landed at 20 % of its marked 4 N·m, plus the D12 120 V 1500 W heater on the junction box's splices, for
 * 600 s with the breaker on. Its hashes are pinned here, and
 * `fixtures/v3/ctrl/bad-termination-engine-7-catalog-2.ctrl` is its save (replaced in place by the
 * acceptance PR: world v3 and engine 7 are provisional until v0.4.0), written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/bad-termination.console --world content/levels/workshop.json \
 *     --difficulty journeyman --save libs/domain/save-format/fixtures/v3/ctrl/bad-termination-engine-7-catalog-2.ctrl
 *
 * **Every expectation is derived from the built circuit's current** (ADR 0018 §7): the conductor's
 * steady state T_c is the §3.5 fixed point at that current, the hot spot's the two-node closed form
 *
 *   T_h = [I² (a (1 − α T₀) + b) + G_fin T_c + G_term T_a] / (G_fin + G_term − I² a α),
 *
 * with a and b the end's constriction and film parts from its achieved torque, G_fin = √(G′(T_c) k A),
 * G_term = 0.026 W/K; within 0.5 % of the rise.
 *
 * **The built circuit, by hand.** The heater is 120² / 1500 = 9.6 Ω and the lamp, hot, about 238.7 Ω
 * (240 Ω at 120 V, a little less at its 118.6 V); each with its own leads (the heater's 0.8 m of 14 AWG,
 * the lamp's 3.2 m of cable 2) and contacts, in parallel 9.2366 Ω. In series with them: the source's
 * half winding (10.304 + j20.608 mΩ), the breaker's closed pole (10 mΩ), 7.071 m of 14 AWG copper (wire
 * 8 1.363 m, the jumper 0.157 m, cable 1's black and white 2 × 2.303 m, wire 9 0.945 m; 8.2855 mΩ/m at
 * 20 °C, 4.5 % more at 304.6 K: 61.2 mΩ) and the contacts (the loose end 24.9 mΩ, nine more of 0.3–0.5
 * mΩ: 28.3 mΩ in all). R = 9.3465 Ω, X = 20.6 mΩ, so I = 120 / 9.3465 = 12.839 A. The engine solves
 * 12.8393 A: inside §7's 12.01–13.07 A window and next to its expected 12.8 A (the D12 content review's
 * 12.27 A assumed a 30 m run; the built run is 3.9 m of NM-B).
 *
 * **The loose end** draws 0.8127 N·m on the ±6 % driver (r = 0.2032, the clamp stream of termination 1
 * under seed 0), so a = 0.3/√0.4 = 0.4743 mΩ and b = 100 · (1 − 0.2032/0.4)² = 24.21 mΩ: at 12.839 A,
 * T_c ≈ 304.61 K and T_h ≈ 409.29 K, 16.1 K past the overheat threshold (393.15 K), 6.13 K past the
 * insulation-damage temperature (403.15 K) and 12.87 K short of the oxidation onset (422.15 K). So
 * `terminationOverheat` is raised and `insulationDamaged` set, each with at least 5 K to spare (the D12
 * content review's note: key the flag on the engine's own peak T_h, never a flag 0.03 A from its
 * threshold), and D stays 1: a steady state to compare against at 600 s.
 */
export const BAD_TERMINATION_HASH = '53c822210a1912b21d8e28f4e838296aaf7ac87c8c42434e3e5e6103f97d2de5';
export const BAD_TERMINATION_SNAPSHOT_HASH = 'b35794ea6f84fc9f11767cd3ea35988d4aa2b8a38d05c0f4d471a212fe6be8e1';

/**
 * `wire.info 1` (the jumper with the loose end) and `wire.info 2` (cable 1's black, a cable conductor
 * spliced in the junction box) at the end of the scenario: pinned in Node here and byte for byte in
 * Chromium by `apps/game-e2e/src/wire-info.spec.ts`. Re-pin with `pnpm nx test sim-cli -u` and review the
 * diff, never in the e2e alone.
 */
const WIRE_INFO_GOLDEN = join(import.meta.dirname, 'goldens/wire-info/bad-termination.txt');

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/bad-termination.console');
const TA = 293.15;
const T0 = 293.15;
const ALPHA = 0.00393;
const END_TICK = 600_000;
const LOOSE = 1;
const ids = LAMP_CIRCUIT_IDS;

const journeymanGame = () => createGame({ world: workshopWorldAt('journeyman') });

async function scenarioGame(events: SimEvent[] = []): Promise<Game> {
  const game = journeymanGame();
  game.on('sim', (event) => events.push(event));
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [BAD_TERMINATION_HASH] });
  return game;
}

/** The scenario built with the load screw at `torqueNm` and the breaker on, at tick 0. */
function builtGame(torqueNm: number = LOOSE_TORQUE_NM): Game {
  const game = journeymanGame();
  buildBadTermination(game, torqueNm);
  game.execOrThrow('device.operate', { id: ids.breaker, control: 'on', value: true });
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
  const ref = connection(world, id).ref;
  const physics = conductorPhysics(BUILTIN_CATALOG, device(ref.id));
  if (physics === undefined) throw new Error(ref.id);
  const thermal = conductorThermal(physics);
  const i2 = amps * amps;
  // T_c: the scalar fixed point T_c = T_a + I² R′(T_c) / G′(T_c), iterated to 10⁻¹² K (a spreadsheet's job).
  let tc = TA + 10;
  for (let k = 0; k < 200; k++) {
    const next = TA + (i2 * conductorResistanceOhm(physics, 1000, tc)) / conductanceToAirWPerMK(thermal, tc, TA);
    if (Math.abs(next - tc) < 1e-12) break;
    tc = next;
  }
  const g = conductanceToAirWPerMK(thermal, tc, TA);
  const fin = Math.sqrt(g * thermalConductivityWPerMK(physics) * physics.areaM2);
  const ends = (['a', 'b'] as const).map((side) => {
    const end = connection(world, id)[side];
    if (end?.termination == null) throw new Error('landed');
    const entity = world.entities.find((e) => e.id === end.entity);
    const spec = BUILTIN_CATALOG.device(entity?.ref ?? { id: '', version: 0 })
      ?.terminals.find((t) => t.id === end.terminal)
      ?.methods.find((m) => m.method === end.termination?.method);
    if (spec === undefined) throw new Error('spec');
    const landedCount = world.connections.filter((c) =>
      [c.a, c.b].some((e) => e?.entity === end.entity && e.terminal === end.terminal && e.termination !== null),
    ).length;
    const { constrictionOhm: a, filmOhm: b } = asMadeContact(
      { termination: end.termination, spec, landedCount },
      physics,
    );
    const gTerm = spec.heatPathWPerK;
    const th = (i2 * (a * (1 - ALPHA * T0) + b) + fin * tc + gTerm * TA) / (fin + gTerm - i2 * a * ALPHA);
    return { th, rEnd: a * (1 + ALPHA * (th - T0)) + b, torqueNm: end.termination.torqueNm };
  });
  return { tc, ends };
}

const riseError = (actual: number, expected: number) => Math.abs(actual - expected) / (expected - TA);
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

describe('the bad-termination scenario (P3 phase acceptance, ADR 0018 §7)', () => {
  it('reaches its pinned hashes; the script and the console file log the same entries; the current is in §7’s window', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(END_TICK);
    expect(game.hash()).toBe(BAD_TERMINATION_HASH);
    expect(game.snapshotHash()).toBe(BAD_TERMINATION_SNAPSHOT_HASH);
    const script = journeymanGame();
    badTermination(script);
    expect(script.entries()).toStrictEqual(game.entries());
    expect(script.hash()).toBe(BAD_TERMINATION_HASH);
    // The lamp circuit's entries with the one torque changed, then the heater and its two leads.
    expect(
      game
        .entries()
        .map((e) => e.id)
        .slice(-5),
    ).toStrictEqual(['entity.place', 'wire.add', 'wire.add', 'device.operate', 'sim.step']);
    // The built current: the lamp and the heater through the loose screw, inside §7's window.
    const amps = game.connection(LOOSE)?.values['currentA'] as number;
    expect(amps).toBeGreaterThan(12.01);
    expect(amps).toBeLessThan(13.07);
    // KCL at the junction box's black nut: the lamp's and the heater's currents add up to the feed's.
    const lampAmps = game.device(ids.lamp)?.values['currentA'] as number;
    const heaterAmps = game.device(13)?.values['currentA'] as number;
    expect(relative(heaterAmps, (game.device(13)?.values['voltageV'] as number) / 9.6)).toBeLessThan(1e-9);
    // Lamp and heater are both resistive, so their phasors are in phase: magnitudes add.
    expect(relative(lampAmps + heaterAmps, amps)).toBeLessThan(1e-6);
  });

  it('the hot spot, the conductors and the drops are the hand calculation at the built current', async () => {
    const game = await scenarioGame();
    const world = game.materialisedWorld() as World;
    const amps = game.connection(LOOSE)?.values['currentA'] as number;
    const bad = handCalculation(world, LOOSE, amps);
    // The loose end: 20 % of 4 N·m on the ±6 % torque driver.
    expect(bad.ends[0].torqueNm as number).toBeGreaterThan(0.8 * 0.94);
    expect(bad.ends[0].torqueNm as number).toBeLessThan(0.8 * 1.06);
    const sim = connection(world, LOOSE).sim;
    expect(riseError(sim['conductorTempK'] as number, bad.tc)).toBeLessThan(0.005);
    expect(riseError(sim['endATempK'] as number, bad.ends[0].th)).toBeLessThan(0.005);
    expect(riseError(sim['endBTempK'] as number, bad.ends[1].th)).toBeLessThan(0.005);
    // A good end elsewhere on the path: the supply's L1 conductor (wire 8) at the breaker's line screw.
    const line = handCalculation(world, 8, amps);
    expect(riseError(connection(world, 8).sim['endBTempK'] as number, line.ends[1].th)).toBeLessThan(0.005);
    // Below the oxidation onset, so no degradation: the steady state is at D = 1.
    expect(bad.ends[0].th).toBeLessThan(OXIDATION_ONSET_K.value - 5);
    expect(sim['endADegradation']).toBe(1);
    expect(sim['endAState']).toBe('ok');
    // The acceptance's margin (ADR 0018 §7): the loose end at least 50 K above its conductor.
    expect((sim['endATempK'] as number) - (sim['conductorTempK'] as number)).toBeGreaterThanOrEqual(50);
  });

  it("the connection record: the loose end's drop is I × R_contact within 0.5 %, at least 10× the same end's in the good circuit", async () => {
    const game = await scenarioGame();
    const world = game.materialisedWorld() as World;
    const amps = game.connection(LOOSE)?.values['currentA'] as number;
    const bad = handCalculation(world, LOOSE, amps);
    const record = game.connection(LOOSE);
    if (record === null) throw new Error('the loose conductor has a record');
    const v = record.values;
    expect(v).toMatchObject({ status: 'solved', endAState: 'ok', endBState: 'ok', insulationDamaged: 'yes' });
    // The engine's end drop against the hand calculation's I × R_contact (R at the computed T_h).
    const handDrop = amps * bad.ends[0].rEnd;
    expect(relative(v['endADropV'] as number, handDrop)).toBeLessThan(0.005);
    expect(relative(v['endAContactOhm'] as number, bad.ends[0].rEnd)).toBeLessThan(0.005);
    // The same end in the good circuit (the lamp circuit's 4 N·m, plus the heater, 600 s on).
    const good = builtGame(4);
    good.advanceTo(END_TICK);
    const goodEnd = good.connection(LOOSE)?.values ?? {};
    const goodWorld = good.materialisedWorld() as World;
    const goodAmps = goodEnd['currentA'] as number;
    const goodHand = handCalculation(goodWorld, LOOSE, goodAmps);
    expect(relative(goodEnd['endADropV'] as number, goodAmps * goodHand.ends[0].rEnd)).toBeLessThan(0.005);
    expect((v['endADropV'] as number) / (goodEnd['endADropV'] as number)).toBeGreaterThanOrEqual(10);
    // And against the jumper's own good end at the line block, from the record alone.
    expect((v['endADropV'] as number) / (v['endBDropV'] as number)).toBeGreaterThanOrEqual(10);
    // Temperatures are own state: the record holds the bag's values exactly.
    const sim = connection(world, LOOSE).sim;
    expect(v['endATempK']).toBe(sim['endATempK']);
    expect(v['conductorTempK']).toBe(sim['conductorTempK']);
    // The drops add up to the terminal-to-terminal voltage (|V(load) − V(line block a)|).
    const reading = game.probe(`${ids.breaker}:load`, `${ids.tbLine}:a`);
    if (reading.kind !== 'ac') throw new Error(`an AC reading, got ${reading.kind}`);
    const sum = (v['conductorDropV'] as number) + (v['endADropV'] as number) + (v['endBDropV'] as number);
    expect(relative(sum, reading.rmsVolts)).toBeLessThan(1e-9);
  });

  it('terminationOverheat is raised once, unconditionally, where the hot spot passes T_a + 100 K; insulationDamaged follows the peak T_h with ≥ 5 K to spare', async () => {
    const events: SimEvent[] = [];
    const game = await scenarioGame(events);
    const threshold = TA + TERMINATION_OVERHEAT_RISE_K.value;
    const overheat = events.filter((e) => e.kind === 'terminationOverheat');
    expect(overheat).toHaveLength(1);
    expect(overheat[0]).toMatchObject({ entity: null, entities: [], connection: LOOSE, end: 'a' });
    // Its tick is the state after the cadence step that crossed: below the threshold a tick before
    // (the previous step's state), at or above it at the event's tick, and the event's temperature.
    const { tick } = overheat[0];
    expect(tick % 10).toBe(1);
    const stepped = builtGame();
    stepped.advanceTo(tick - 1);
    expect(stepped.connection(LOOSE)?.values['endATempK'] as number).toBeLessThan(threshold);
    stepped.advanceTo(tick);
    const crossed = stepped.connection(LOOSE)?.values['endATempK'] as number;
    expect(crossed).toBeGreaterThanOrEqual(threshold);
    expect(overheat[0].detail['temperatureK']).toBe(crossed);
    // insulationDamaged: keyed on the engine's own peak T_h against the 90 °C rating + 40 K (403.15 K),
    // with at least 5 K either way (ADR 0018 §6; the D12 content review's note). The hot spot rises
    // monotonically to its steady state (sampled every second), so the peak is the last value.
    const damageK = 363.15 + INSULATION_DAMAGE_MARGIN_K.value;
    let peak = 0;
    let previous = 0;
    const samples: number[] = [];
    for (let t = tick; t < END_TICK; t += 1000) samples.push(t);
    samples.push(END_TICK);
    for (const t of samples) {
      stepped.advanceTo(t);
      const th = stepped.connection(LOOSE)?.values['endATempK'] as number;
      expect(th).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = th;
      peak = Math.max(peak, th);
    }
    expect(stepped.hash()).toBe(game.hash());
    expect(Math.abs(peak - damageK)).toBeGreaterThanOrEqual(5);
    const damaged = peak >= damageK;
    expect(damaged).toBe(true); // 409.29 K: 6.13 K past it
    const flagged = events.filter((e) => e.kind === 'insulationDamaged');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ connection: LOOSE, end: 'a' });
    expect(flagged[0].detail['temperatureK'] as number).toBeGreaterThanOrEqual(damageK);
    expect(connection(game.materialisedWorld() as World, LOOSE).sim['insulationDamaged']).toBe(true);
    // No other connection overheats or is damaged.
    expect(events.filter((e) => e.kind === 'terminationOverheat' || e.kind === 'insulationDamaged')).toHaveLength(2);
  });

  it('wire.info prints the records: the golden text, the same from a console line as from Game.wireInfo', async () => {
    const game = await scenarioGame();
    const text = `${game.wireInfo(1)}${game.wireInfo(2)}`;
    await expect(text).toMatchFileSnapshot(WIRE_INFO_GOLDEN);
    expect(text).toMatch(/end a ok, contact 0\.0249\d+ Ω at 409\.\d+ K, drop 0\.31\d+ V/); // the loose end
    expect(text).toContain('insulation damaged');
    const { output } = await runConsoleScript(game, 'wire.info 1\nwire.info --id 2\n');
    expect(`${output.join('\n')}\n`).toBe(text);
    expect(game.hash()).toBe(BAD_TERMINATION_HASH); // read-only
  });

  it('its checked-in save (engine 7, landed conductors, non-null end keys) loads as continued and runs on identically', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('bad-termination'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(BAD_TERMINATION_HASH);
    expect(loaded.game.snapshotHash()).toBe(BAD_TERMINATION_SNAPSHOT_HASH);
    const sim = connection(loaded.game.materialisedWorld() as World, LOOSE).sim;
    expect(sim['endATerminationId']).not.toBeNull();
    expect(sim['endATempK']).not.toBeNull();
    expect(sim['endADegradation']).toBe(1);
    expect(sim['insulationDamaged']).toBe(true);
    const straight = await scenarioGame();
    for (const game of [straight, loaded.game]) game.advance(5000);
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
  });
});

describe('bad-termination determinism (P3 phase acceptance)', () => {
  it('byte-identical snapshots across two runs and a replay, every 30 s', () => {
    const run = () => {
      const game = builtGame();
      const snapshots: Uint8Array[] = [];
      for (let t = 30_000; t <= 120_000; t += 30_000) {
        game.advanceTo(t);
        snapshots.push(game.snapshot());
      }
      return { game, snapshots };
    };
    const first = run();
    const second = run();
    expect(second.snapshots).toStrictEqual(first.snapshots);
    const replayed = replayGame(JSON.parse(JSON.stringify(first.game.replayLog())));
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.game.hash()).toBe(first.game.hash());
    expect(replayed.game.snapshotHash()).toBe(first.game.snapshotHash());
  });

  it('save mid-run with hot terminations and a degrading contact, load, advance to T2 = straight to T2 (scenario)', () => {
    // 0.5 N·m (12.5 %): the loose end passes the oxidation onset within the first minute and degrades.
    const t1 = 60_000;
    const t2 = 120_000;
    const saved = builtGame(0.5);
    saved.advanceTo(t1);
    const atSave = connection(saved.materialisedWorld() as World, LOOSE).sim;
    expect(atSave['endATempK'] as number).toBeGreaterThan(OXIDATION_ONSET_K.value);
    expect(atSave['endADegradation'] as number).toBeGreaterThan(1);
    const loaded = loadGame(saved.save());
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.snapshotHash()).toBe(saved.snapshotHash());
    loaded.game.advanceTo(t2);
    const straight = builtGame(0.5);
    straight.advanceTo(t2);
    expect(loaded.game.snapshot()).toStrictEqual(straight.snapshot());
    expect(loaded.game.hash()).toBe(straight.hash());
    const atEnd = connection(straight.materialisedWorld() as World, LOOSE).sim;
    expect(atEnd['endADegradation'] as number).toBeGreaterThan(atSave['endADegradation'] as number);
  });

  it('save at T1, load, advance to T2 = straight to T2, for any loose torque in the driver’s range (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 120 }),
        fc.integer({ min: 1, max: 90 }),
        fc.integer({ min: 1, max: 60 }),
        (centiNm, t1s, extra) => {
          const torque = centiNm / 100;
          const t1 = t1s * 1000 + (t1s % 7); // not only on whole seconds or cadence ticks
          const t2 = t1 + extra * 1000;
          const saved = builtGame(torque);
          saved.advanceTo(t1);
          const loaded = loadGame(saved.save());
          if (!loaded.ok) throw new Error(loaded.error.message);
          loaded.game.advanceTo(t2);
          const straight = builtGame(torque);
          straight.advanceTo(t2);
          expect(loaded.game.snapshot()).toStrictEqual(straight.snapshot());
          expect(loaded.game.hash()).toBe(straight.hash());
        },
      ),
      { numRuns: 8, seed: 0x3c0d },
    );
  });
});
