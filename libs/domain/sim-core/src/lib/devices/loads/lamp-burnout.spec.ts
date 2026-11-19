import { LAMP_FILAMENT_MAX_K, type LampIncandescentParams } from '@controls/catalog';
import { AC_SOURCE, end } from '../../../testing/bench';
import { ENGINE_TEST_CATALOG } from '../../../testing/engine';
import { A19_60W, A19_100W, acSourceAt, socket } from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import { DEVICE_NETLIST_MODELS } from '../../netlist/models';
import { LAMP_AMBIENT_K, LAMP_BURNOUT_K, lampConductionFraction, lampResistanceOhm } from './lamp';
import { tungstenResistivity } from './tungsten';

/*
 * The lamp's burnout (P4 F4.1 part 1; ADR 0019's sticky `burnedOut`): "`burnedOut` set once at the
 * sourced temperature and never cleared" (plan F4.1).
 *
 * Hand calculation of the steady filament temperature against voltage, for the 60 W A19 test bulb (the
 * P3 120 V filament: 240 Ω hot at 2700 K, f = 0.05). At steady state V² / R(T) = k (T⁴ − T_a⁴) + G (T − T_a)
 * with R(T) = 240 · ρ(T) / ρ(2700 K); bisecting it (as `steadyK` below does with the model's own table):
 * 2763 K at 127.2 V (1.06 ×, ANSI C84.1 Range B's top), 3166 K at 180 V (1.5 ×), 3200 K at 184.93 V
 * (1.541 ×) and 3299 K at 200 V (1.67 ×: a lost neutral's high leg, F4.4). So `LAMP_BURNOUT_K` (3200 K)
 * is never reached inside Range B, and is at 200 V.
 */

const params = ENGINE_TEST_CATALOG.device(A19_60W)?.model.params as LampIncandescentParams;

/** The model's steady filament temperature at `volts` (K), bisected on its own heat balance. */
function steadyK(p: LampIncandescentParams, volts: number): number {
  const ta = LAMP_AMBIENT_K.value;
  const tr = p.filamentRatedTempK;
  const f = lampConductionFraction(p);
  const ratedOhm = (p.ratedVoltageV * p.ratedVoltageV) / p.ratedPowerW;
  const span = tr ** 4 - ta ** 4;
  const k = ((1 - f) * p.ratedPowerW) / span;
  const g = (f * p.ratedPowerW) / (tr - ta);
  let lo = ta;
  let hi = LAMP_FILAMENT_MAX_K;
  for (let i = 0; i < 100; i++) {
    const t = (lo + hi) / 2;
    const net =
      (volts * volts) / lampResistanceOhm(ratedOhm, tungstenResistivity(tr), t) - k * (t ** 4 - ta ** 4) - g * (t - ta);
    if (net > 0) lo = t;
    else hi = t;
  }
  return lo;
}

/** A lampholder with `bulb` across `source`; the bulb's id. */
function lit(source: { id: string; version: number }, bulb = A19_60W): { host: SourceHost; bulb: number } {
  const host = new SourceHost();
  const s = host.place(source);
  const { holder, bulb: id } = socket(host, bulb);
  host.lead(s, 'l', holder, 'hot').lead(holder, 'neutral', s, 'n');
  return { host, bulb: id };
}

const filament = (host: SourceHost, bulb: number) =>
  host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === bulb);

describe('lamp burnout (ADR 0019 `burnedOut`)', () => {
  it('the threshold is reachable (below the model’s clamp) and lies between Range B and a lost neutral', () => {
    expect(LAMP_BURNOUT_K.value).toBe(3200);
    expect(LAMP_BURNOUT_K.value).toBeLessThan(LAMP_FILAMENT_MAX_K);
    expect(LAMP_BURNOUT_K.kind).toBe('game-design');
    expect(steadyK(params, 127.2)).toBeCloseTo(2763, 0);
    expect(steadyK(params, 180)).toBeCloseTo(3166, 0);
    expect(steadyK(params, 200)).toBeCloseTo(3299, 0);
    expect(steadyK(params, 184.9)).toBeLessThan(LAMP_BURNOUT_K.value);
    expect(steadyK(params, 185)).toBeGreaterThan(LAMP_BURNOUT_K.value);
  });

  it('at 200 V it burns out at the step its filament first reaches 3200 K, and the filament leaves the netlist', () => {
    const { host, bulb } = lit(acSourceAt(200));
    const hash = host.engine.netlist.topologyHash;
    let previous = host.sim(bulb)['filamentTempK'] as number;
    let burned = -1;
    for (let t = 0; t < 1000 && burned < 0; t++) {
      host.advance(1);
      const sim = host.sim(bulb);
      if (sim['burnedOut'] === true) {
        burned = host.engine.tick;
        // Set by the step that took the filament to the threshold, not before.
        expect(previous).toBeLessThan(LAMP_BURNOUT_K.value);
        expect(sim['filamentTempK'] as number).toBeGreaterThanOrEqual(LAMP_BURNOUT_K.value);
      } else {
        expect(sim['filamentTempK'] as number).toBeLessThan(LAMP_BURNOUT_K.value);
        previous = sim['filamentTempK'] as number;
      }
    }
    // Inrush then a few time constants (τ = 30 ms): well inside the first second.
    expect(burned).toBeGreaterThan(10);
    expect(burned).toBeLessThan(500);
    // Protocol 8's event, once, stamped with the step's end (the state it describes): the burnout tick.
    const burnouts = host.events.filter((e) => e.kind === 'lampBurnout');
    expect(burnouts).toHaveLength(1);
    expect(burnouts[0]).toMatchObject({ tick: burned, entity: bulb });
    expect(burnouts[0].detail['filamentTempK']).toBe(host.sim(bulb)['filamentTempK']);
    // The topology moved at once (recompiled and re-solved within the step): no filament, no current.
    expect(filament(host, bulb)).toBe(false);
    expect(host.engine.netlist.topologyHash).not.toBe(hash);
    expect(host.engine.lastSolveTick).toBe(burned);
    const record = host.record(bulb);
    expect(record['powerW']).toBe(0);
    expect(record['currentA']).toBe(0);
    expect(record['burnedOut']).toBe('yes');
    // The whole 200 V now stands across the open filament (a reading: both screws on the source's island).
    expect(record['status']).toBe('solved');
    expect(Math.abs((record['voltageV'] as number) / 200 - 1)).toBeLessThan(1e-6);
  });

  it('is never cleared: it cools to ambient dark, survives a save and load, and a healthy voltage never relights it', () => {
    const { host, bulb } = lit(acSourceAt(200));
    host.advance(600);
    expect(host.sim(bulb)['burnedOut']).toBe(true);
    host.advance(15_000);
    expect(host.sim(bulb)['filamentTempK'] as number).toBeLessThan(LAMP_AMBIENT_K.value + 1);
    expect(host.record(bulb)['lightOutputRel']).toBeLessThan(1e-9);
    const reloaded = host.reload();
    expect(reloaded.sim(bulb)['burnedOut']).toBe(true);
    expect(filament(reloaded, bulb)).toBe(false);
    // Rewired onto a 120 V source: still open.
    const s = reloaded.place(AC_SOURCE);
    for (const c of reloaded.bus.state.connections.map((x) => x.id)) reloaded.exec('lead.disconnect', { id: c });
    const holder = bulb - 1;
    reloaded.lead(s, 'l', holder, 'hot').lead(holder, 'neutral', s, 'n').advance(1000);
    expect(reloaded.sim(bulb)['burnedOut']).toBe(true);
    expect(filament(reloaded, bulb)).toBe(false);
    // Undo and redo never rewind the simulator (the P2 breaker rule).
    reloaded.exec('edit.undo', {}).exec('edit.undo', {}).exec('edit.redo', {}).advance(10);
    expect(reloaded.sim(bulb)['burnedOut']).toBe(true);
  });

  it('inside ANSI C84.1 Range B (127 V) and at 1.5 × (180 V) it never burns out, however long', () => {
    for (const [volts, bulbRef] of [
      [127, A19_60W],
      [127, A19_100W],
    ] as const) {
      const { host, bulb } = lit(acSourceAt(volts), bulbRef);
      host.advance(3000);
      expect(host.sim(bulb)['burnedOut']).toBe(false);
      expect(filament(host, bulb)).toBe(true);
      expect(Math.abs((host.sim(bulb)['filamentTempK'] as number) - steadyK(params, volts * (1 - 1e-3)))).toBeLessThan(
        5,
      );
    }
    expect(steadyK(params, 180)).toBeLessThan(LAMP_BURNOUT_K.value);
  });

  it('a burned-out lamp’s netlist model has no element; its wiring view keeps the filament', () => {
    const model = DEVICE_NETLIST_MODELS['lamp.incandescent'];
    expect(model.simTopologyKeys).toStrictEqual(['burnedOut']);
    const input = (burnedOut: boolean) => ({
      params: { ratedPowerW: 60, ratedVoltageV: 120 },
      state: {},
      sim: { burnedOut },
    });
    expect(model.topology(input(true))).toStrictEqual({ joins: [], elements: [] });
    expect(model.topology(input(false)).elements.map((e) => e.part)).toStrictEqual(['filament']);
    expect(model.wiring).toBeUndefined();
  });

  it('a burned-out lamp off any circuit writes an unsolved voltage', () => {
    const host = new SourceHost();
    const id = host.place(A19_60W);
    const world = host.bus.state;
    const entities = world.entities.map((e) => (e.id === id ? { ...e, sim: { ...e.sim, burnedOut: true } } : e));
    const withSim = host.withSim(id, entities[0].sim);
    withSim.advance(5);
    const record = withSim.record(id);
    expect(record['status']).toBe('unsolved');
    expect(record['voltageV']).toBe(0);
    expect(withSim.engine.probe(end(id, 'a'), end(id, 'b')).kind).toBe('floating');
  });
});
