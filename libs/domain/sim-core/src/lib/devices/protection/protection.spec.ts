import { BUILTIN_CATALOG, type BreakerParams, type FuseParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { deriveStream, entityStreamKey } from '@controls/world-model';
import { BATTERY } from '../../../testing/bench';
import { BUSBAR, engineBus, OPAQUE, RHEOSTAT } from '../../../testing/engine';
import { BREAKER, FUSE_1A } from '../../../testing/protection';
import { BENCH_SUPPLY, SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import type { LayerContext } from '../../engine/device-model';
import { TICK_S } from '../../engine/constants';
import { BREAKER_MODEL, BREAKER_OUTPUT } from './breaker';
import { FUSE_OUTPUT, fuseElementTimeConstantS } from './fuse';

/*
 * The fuse and the thermal-magnetic breaker (plan F2.5 part 2). Hand calculations (the figures the
 * docs quote are computed by the "documented figures" test below, so they can't drift):
 *
 * - the fuse (1 A, melting I²t 0.7 A²s, I_min = 1.2 A, a fast element w = 0.3 of the rise in a slow
 *   body of τ_b = 10 s): τ_e = w / (I_min² / I²t − (1 − w) / τ_b) = 0.3 / (2.05714 − 0.07) = 0.15097 s.
 *   At a constant current I it melts when w x² (1 − e^(−t/τ_e)) + (1 − w) x² (1 − e^(−t/τ_b)) = 1,
 *   x = I / I_min (solved by bisection here): 12.05 s at 1.35 A, 0.908 s at 2 A, 0.1072 s at 3 A,
 *   7.16 ms at 10 A (0.1072 s at 3 A); never at or below 1.2 A (110 % is carried);
 * - the breaker (15 A, τ 60 s, k_u 1.25): a thermal trip after t = −60 ln(1 − (1.25 · 15 / I)²):
 *   116.84 s at 135 % (in `apps/sim-cli/src/breaker-curve.spec.ts`: 117 000 ticks are too slow under
 *   coverage), 29.72 s at 200 %, 3.872 s at 500 %; never below 125 %. The magnetic pickup is drawn per
 *   breaker as 120 + 60 u A, u the first draw of its entity's stream (8–12 × 15 A).
 *
 * Every current is the one the circuit draws (read from its solve), so the goldens test the model's
 * timing, not the circuit's resistance. Euler at the 1 ms tick: within 0.5 % of the analytic times.
 */

const fuse = BUILTIN_CATALOG.device(FUSE_1A)?.model.params as FuseParams;
const breaker = BUILTIN_CATALOG.device(BREAKER)?.model.params as BreakerParams;
const dt = TICK_S.value;
const fuseMinA = fuse.ratedCurrentA * fuse.minimumFusingRatio;
const tauE = fuseElementTimeConstantS(fuse);

/** The two-body fuse's melt time (s) at a constant current `amps` from cold, or Infinity (bisection). */
function fuseMeltTime(amps: number): number {
  const x2 = (amps / fuseMinA) ** 2;
  const w = fuse.elementFraction;
  const heat = (t: number) =>
    w * x2 * (1 - Math.exp(-t / tauE)) + (1 - w) * x2 * (1 - Math.exp(-t / fuse.bodyTimeConstantS));
  if (x2 <= 1) return Infinity;
  let [lo, hi] = [0, 1e6];
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (heat(mid) < 1) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The breaker's thermal trip time (s) at a constant current `amps` from cold: −τ ln(1 − (k_u I_n / I)²). */
const breakerTripTime = (amps: number) => {
  const a = (breaker.ultimateTripRatio * breaker.ratedCurrentA) / amps;
  return -breaker.thermalTimeConstantS * Math.log(1 - a * a);
};

/** The figures the plan, the architecture page, the caveats and this file's header quote. */
const DOCUMENTED = {
  fuseElementTauS: 0.151,
  fuseMeltS: { 1.35: 12.05, 2: 0.908, 3: 0.1072, 10: 0.00716 },
  breakerTripS: { 1.35: 116.84, 2: 29.72, 5: 3.872 },
} as const;

/** A bench supply (1) in its current limit at `amps` through the fuse (2), shorted by busbar links. */
function fuseAt(amps: number): SourceHost {
  const host = new SourceHost();
  host.place(BENCH_SUPPLY);
  host.place(FUSE_1A);
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
  return host.operate(1, 'setpointV', 5).operate(1, 'currentLimitA', amps).operate(1, 'outputOn', true);
}

/**
 * A 120 V split-phase service (1), L1 through the breaker (2, handle on) and a rheostat (3) set for
 * `amps`, back to N. Busbar links, so the rheostat and the source set the current.
 */
function breakerAt(amps: number, seed = 11): SourceHost {
  const host = new SourceHost(engineBus(seed));
  host.place(UTILITY_SPLIT);
  host.place(BREAKER);
  host.place(RHEOSTAT);
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l1' }, b: { entity: 2, terminal: 'line' } });
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 2, terminal: 'load' }, b: { entity: 3, terminal: 'a' } });
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'n' } });
  // Less the pole's 10 mΩ, so the rheostat sets the current.
  return host.operate(3, 'ohms', 120 / amps - breaker.contactResistanceOhm).operate(2, 'on', true);
}

/** Lets `limit` ticks pass and returns how many ticks after the start the first `kind` event came (−1: none). */
function ticksTo(host: SourceHost, kind: 'blown' | 'tripped', limit: number): number {
  const start = host.engine.tick;
  const seen = host.events.length;
  host.advance(limit);
  const event = host.events.slice(seen).find((e) => e.kind === kind);
  return event === undefined ? -1 : event.tick - start;
}

/** A breaker's pickup from its seeded stream: 120 + 60 u A (8–12 × 15 A), u its stream's first draw. */
const pickupOf = (seed: number, id: number) =>
  breaker.ratedCurrentA *
  (breaker.magneticTripMinRatio +
    (breaker.magneticTripMaxRatio - breaker.magneticTripMinRatio) *
      deriveStream(seed, entityStreamKey(id)).nextFloat());

describe('the documented figures (realism review: computed, so the docs cannot drift)', () => {
  it('match the models: the fuse element time constant, melt times and breaker trip times', () => {
    expect(tauE).toBeCloseTo(DOCUMENTED.fuseElementTauS, 3);
    for (const [k, t] of Object.entries(DOCUMENTED.fuseMeltS)) {
      expect(Math.abs(fuseMeltTime(Number(k) * fuse.ratedCurrentA) / t - 1), `fuse ${k}×`).toBeLessThan(0.002);
    }
    for (const [k, t] of Object.entries(DOCUMENTED.breakerTripS)) {
      expect(Math.abs(breakerTripTime(Number(k) * breaker.ratedCurrentA) / t - 1), `breaker ${k}×`).toBeLessThan(5e-4);
    }
    // The two-body integral is the datasheet's melting I²t.
    const w = fuse.elementFraction;
    expect((fuseMinA * fuseMinA) / (w / tauE + (1 - w) / fuse.bodyTimeConstantS)).toBeCloseTo(fuse.meltingI2tA2s, 12);
    expect(fuseMeltTime(1.1)).toBe(Infinity);
  });
});

describe('the fuse (golden)', () => {
  it('publishes a valid record; it starts intact and cold, and carries its current through a branch', () => {
    expect(deviceOutputSchemaProblems(FUSE_OUTPUT)).toStrictEqual([]);
    const host = fuseAt(0.5);
    expect(host.sim(2)).toStrictEqual({ blown: false, bodyHeat: 0, elementHeat: 0 });
    const record = host.record(2);
    expect(record).toMatchObject({ state: 'intact', status: 'solved', meltFraction: 0 });
    expect(Math.abs((record['currentA'] as number) / 0.5 - 1)).toBeLessThan(1e-3);
  });

  it.each([
    [1.35, 1, 3600],
    [2, 0.1, 5],
    [3, 0.01, 5],
  ])('melts at %s × its rating at the two-body time within 0.5 %, inside its band (%s s to %s s)', (k, lo, hi) => {
    const host = fuseAt(k * fuse.ratedCurrentA);
    const amps = host.record(2)['currentA'] as number;
    expect(Math.abs(amps / k - 1)).toBeLessThan(1e-3);
    const expected = fuseMeltTime(amps) / dt;
    const ticks = ticksTo(host, 'blown', Math.ceil(expected * 1.1));
    expect(Math.abs(ticks - expected) / expected).toBeLessThan(0.005);
    expect(ticks * dt).toBeGreaterThan(lo);
    expect(ticks * dt).toBeLessThan(hi);
  });

  it('carries 110 % of its rating indefinitely (the band), settling at (I / I_min)² of its melt', () => {
    const host = fuseAt(1.1 * fuse.ratedCurrentA);
    host.advance(60_000); // 6 body time constants
    expect(host.sim(2)['blown']).toBe(false);
    const sim = host.sim(2) as { elementHeat: number; bodyHeat: number };
    expect(sim.elementHeat + sim.bodyHeat).toBeCloseTo(
      (1.1 / 1.2) ** 2 * (1 - (1 - fuse.elementFraction) * Math.exp(-6)),
      3,
    );
  });

  it('at 10 × its rating it melts in 1 to 20 ms (the band), when ∫I² dt is within two ticks of the melting I²t', () => {
    // A battery through the fuse and a rheostat set for 10 A (1.29 Ω less the leads' and cell's 0.15 Ω).
    const host = new SourceHost();
    host.place(BATTERY);
    host.place(FUSE_1A);
    host.place(RHEOSTAT);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 3, 'a').lead(3, 'b', 1, 'neg');
    host.operate(3, 'ohms', 1.29 - 0.023 - 3 * 0.0411 - 0.1);
    const amps = host.record(2)['currentA'] as number;
    expect(amps).toBeGreaterThan(9);
    const ticks = ticksTo(host, 'blown', 100);
    expect(ticks).toBeGreaterThanOrEqual(1);
    expect(ticks).toBeLessThanOrEqual(20);
    expect(Math.abs(ticks - fuseMeltTime(amps) / dt)).toBeLessThanOrEqual(1);
    expect(amps * amps * ticks * dt).toBeGreaterThan(fuse.meltingI2tA2s);
    expect(amps * amps * (ticks - 2) * dt).toBeLessThan(fuse.meltingI2tA2s * 1.01);
  });

  it('a bolted short blows it in the first tick: the topology changes, re-solves in the same tick, and raises blown', () => {
    const host = new SourceHost();
    host.place(BATTERY);
    host.place(FUSE_1A);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
    expect(host.record(2)['currentA']).toBeGreaterThan(50);
    const layerSolves = host.engine.stats.layerSolves;
    host.advance(1);
    expect(host.events.filter((e) => e.kind === 'blown')).toMatchObject([{ kind: 'blown', entity: 2, tick: 1 }]);
    expect(host.engine.stats.layerSolves).toBe(layerSolves + 1);
    expect(host.engine.lastSolveTick).toBe(1);
    expect(host.sim(2)['blown']).toBe(true);
    expect(host.record(2)).toMatchObject({ state: 'blown', currentA: 0, status: 'solved', meltFraction: 1 });
    expect(host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === 2)).toBe(false);
    // It stays blown: across time, a reload, and a delete undone (the engine's tombstone).
    host.advance(1000);
    expect(host.reload().sim(2)['blown']).toBe(true);
    host.exec('entity.delete', { id: 2 }).exec('edit.undo');
    expect(host.sim(2)['blown']).toBe(true);
    // Replacing it (P2): delete it and place a new one, which starts intact.
    host.exec('entity.delete', { id: 2 });
    const fresh = host.place(FUSE_1A);
    expect(host.sim(fresh)).toStrictEqual({ blown: false, bodyHeat: 0, elementHeat: 0 });
  });

  it('a reload mid-melt at 135 % blows at exactly the tick the straight run does (both bodies are in the bag)', () => {
    const straight = fuseAt(1.35 * fuse.ratedCurrentA).advance(5003);
    const loaded = straight.reload();
    expect(loaded.sim(2)).toStrictEqual(straight.sim(2));
    expect((straight.sim(2) as { bodyHeat: number }).bodyHeat).toBeGreaterThan(0.3);
    expect(ticksTo(loaded, 'blown', 9000)).toBe(ticksTo(straight, 'blown', 9000));
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
  });

  it('cools when its current drops, and a frozen island neither heats nor cools it', () => {
    const host = fuseAt(1.5 * fuse.ratedCurrentA);
    host.advance(500);
    const melt = () => host.record(2)['meltFraction'] as number;
    const warm = melt();
    expect(warm).toBeGreaterThan(0.2);
    host.operate(1, 'currentLimitA', 0.1).advance(1000);
    expect(melt()).toBeLessThan(warm * 0.8); // the element cools fast, the body slowly
    const frozen = fuseAt(1.5 * fuse.ratedCurrentA).advance(100);
    const id = frozen.place(OPAQUE);
    frozen.lead(id, 'a', 2, 'a').lead(id, 'b', 2, 'b');
    const before = frozen.sim(2);
    frozen.advance(500);
    expect(frozen.sim(2)).toStrictEqual(before);
    expect(frozen.record(2)).toMatchObject({ status: 'unsolved', currentA: 0 });
  });
});

describe('the thermal-magnetic breaker (golden)', () => {
  it('publishes a valid record; a new breaker is off and open, and closes with its handle on', () => {
    expect(deviceOutputSchemaProblems(BREAKER_OUTPUT)).toStrictEqual([]);
    const host = breakerAt(10);
    expect(host.record(2)).toMatchObject({ state: 'on', status: 'solved', thermalFraction: 0 });
    expect(Math.abs((host.record(2)['currentA'] as number) / 10 - 1)).toBeLessThan(0.01);
    host.operate(2, 'on', false);
    expect(host.record(2)).toMatchObject({ state: 'off', currentA: 0, status: 'solved' });
  });

  it.each([2, 5])(
    'trips thermally at %s × its rating at −τ ln(1 − (k_u I_n / I)²), within 0.5 %, inside the band',
    (k) => {
      const host = breakerAt(k * breaker.ratedCurrentA);
      const amps = host.record(2)['currentA'] as number;
      expect(Math.abs(amps / (k * breaker.ratedCurrentA) - 1)).toBeLessThan(0.01);
      const expected = breakerTripTime(amps) / dt;
      const ticks = ticksTo(host, 'tripped', 40_000);
      expect(Math.abs(ticks - expected) / expected).toBeLessThan(0.005);
      expect(host.events.filter((e) => e.kind === 'tripped')).toMatchObject([
        { entity: 2, detail: { cause: 'thermal' } },
      ]);
      // The fictional datasheet's band (catalogue `trip-curve-band`): 200 %: 10 s to 2 min; 500 %: 1 to 15 s.
      const [lo, hi] = k === 2 ? [10, 120] : [1, 15];
      expect(ticks * dt).toBeGreaterThan(lo);
      expect(ticks * dt).toBeLessThan(hi);
    },
  );

  it('a reload at 15 003 ticks into a 2 × overload trips at exactly the tick the straight run does', () => {
    const straight = breakerAt(2 * breaker.ratedCurrentA).advance(15_003);
    const loaded = straight.reload();
    expect(ticksTo(loaded, 'tripped', 20_000)).toBe(ticksTo(straight, 'tripped', 20_000));
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
  });

  it('settled at 120 % it never trips: θ stays at (I / I_n)² = 1.44, below k_u² = 1.5625', () => {
    const settled = breakerAt(1.2 * breaker.ratedCurrentA).withSim(2, { thermal: 1.44, tripped: false });
    settled.advance(20_000);
    expect(settled.sim(2)['tripped']).toBe(false);
    expect(settled.sim(2)['thermal'] as number).toBeCloseTo(1.44, 2);
  });

  it('at exactly 125 % it never trips: the trip is θ ≥ k_u², and θ approaches (I / I_n)² from below', () => {
    // The layer itself, on an exact current (a circuit's is only good to its solve): 18.75 A.
    const bank = BREAKER_MODEL.bank([
      {
        entity: 2,
        params: breaker,
        bag: { thermal: 1.5625 * (1 - 1e-6), tripped: false }, // a part-way-settled start, to keep the run short
        state: { on: true },
        branches: [0],
        frequencyHz: 60,
        stream: () => deriveStream(11, entityStreamKey(2)),
      },
    ]);
    const events: string[] = [];
    const ctx = {
      tick: 0,
      dtS: dt,
      netlist: { branches: [{ island: 0 }], islands: [{ kind: 'dc' }] },
      solution: { branches: Float64Array.of(1.25 * 15, 0), nodes: new Float64Array(2) },
      islandReadable: () => true,
      islandStatus: () => 'solved',
      emit: (kind: string) => events.push(kind),
    } as unknown as LayerContext;
    // (18.75 / 15)² rounds to exactly k_u² here; θ_{n+1} = θ + a (x² − θ) stays below x² from below.
    expect(18.75 * 18.75 * (1 / (15 * 15))).toBe(1.5625);
    for (let t = 0; t < 600_000; t++) bank.protection?.(ctx); // ten time constants
    expect(events).toStrictEqual([]);
    expect(bank.bag(0)['thermal'] as number).toBeLessThan(1.5625);
    expect(bank.bag(0)['thermal'] as number).toBeGreaterThan(1.5625 * (1 - 1e-9));
    // One ulp more current trips it.
    (ctx.solution.branches as Float64Array)[0] = 18.76;
    for (let t = 0; t < 100_000 && events.length === 0; t++) bank.protection?.(ctx);
    expect(events).toStrictEqual(['tripped']);
  });

  it('trips magnetically within the tick above its pickup, 120 + 60 u A from its own stream (exact)', () => {
    expect(breakerAt(10).record(2)['magneticPickupA']).toBe(pickupOf(11, 2));
    expect(pickupOf(11, 2)).toBe(131.1838614474982); // the pinned value for seed 11, entity 2
    const pickups = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => breakerAt(10, seed).record(2)['magneticPickupA'] as number);
    pickups.forEach((p, i) => expect(p).toBe(pickupOf(i + 1, 2)));
    expect(new Set(pickups).size).toBe(pickups.length);
    const host = breakerAt(13 * breaker.ratedCurrentA);
    host.advance(1);
    expect(host.events.filter((e) => e.kind === 'tripped')).toMatchObject([
      { entity: 2, tick: 1, detail: { cause: 'magnetic' } },
    ]);
    expect(host.record(2)).toMatchObject({ state: 'tripped', currentA: 0 });
    expect(host.reload().record(2)['magneticPickupA']).toBe(host.record(2)['magneticPickupA']);
  });

  it('two breakers in one world draw their own pickups; deleting the first leaves the second', () => {
    const host = breakerAt(10);
    const second = host.place(BREAKER);
    expect(host.record(2)['magneticPickupA']).toBe(pickupOf(11, 2));
    expect(host.record(second)['magneticPickupA']).toBe(pickupOf(11, second));
    expect(pickupOf(11, 2)).not.toBe(pickupOf(11, second));
    host.exec('entity.delete', { id: 2 });
    expect(host.record(second)['magneticPickupA']).toBe(pickupOf(11, second));
  });

  it('after a trip the handle must go off, then on: on again alone does nothing, off resets, on closes', () => {
    const host = breakerAt(13 * breaker.ratedCurrentA).advance(1);
    expect(host.sim(2)['tripped']).toBe(true);
    host.operate(2, 'on', true); // the handle is already on: still tripped
    expect(host.record(2)).toMatchObject({ state: 'tripped', currentA: 0 });
    host.operate(3, 'ohms', 120 / 10).operate(2, 'on', false);
    expect(host.sim(2)['tripped']).toBe(false);
    expect(host.record(2)).toMatchObject({ state: 'off', currentA: 0 });
    host.operate(2, 'on', true);
    expect(host.record(2)['state']).toBe('on');
    expect(host.record(2)['currentA']).toBeGreaterThan(9);
    // Off and on at the same tick resets too (the sim resolves the handle at each command).
    const same = breakerAt(13 * breaker.ratedCurrentA).advance(1);
    same.operate(3, 'ohms', 12).operate(2, 'on', false).operate(2, 'on', true);
    expect(same.record(2)).toMatchObject({ state: 'on', status: 'solved' });
  });

  it('undoing the handle-off after a trip leaves the breaker reset: the handle is back on, and it closes', () => {
    const host = breakerAt(13 * breaker.ratedCurrentA).advance(1);
    host.operate(3, 'ohms', 12).operate(2, 'on', false);
    expect(host.record(2)['state']).toBe('off');
    host.exec('edit.undo'); // the handle goes back on; the reset the sim resolved stays
    expect(host.bus.state.entities.find((e) => e.id === 2)?.state['on']).toBe(true);
    expect(host.record(2)).toMatchObject({ state: 'on', status: 'solved' });
    expect(host.record(2)['currentA']).toBeGreaterThan(9);
  });

  it('a save holding tripped with the handle off starts reset (S6); the commanded hook is idempotent (S7)', () => {
    const off = breakerAt(10).operate(2, 'on', false).withSim(2, { thermal: 0.5, tripped: true });
    expect(off.sim(2)).toStrictEqual({ thermal: 0.5, tripped: false });
    const host = breakerAt(13 * breaker.ratedCurrentA).advance(1);
    const bag = host.sim(2);
    host.operate(2, 'on', true).operate(2, 'on', true); // the same handle twice: nothing more happens
    expect(host.sim(2)).toStrictEqual(bag);
    host.operate(3, 'ohms', 12).operate(2, 'on', false).operate(2, 'on', false);
    expect(host.sim(2)['tripped']).toBe(false);
  });

  it('cools while open, and a frozen island neither heats nor cools it', () => {
    const host = breakerAt(3 * breaker.ratedCurrentA).advance(5000);
    const warm = host.sim(2)['thermal'] as number;
    host.operate(2, 'on', false).advance(30_000);
    expect(host.sim(2)['thermal']).toBeCloseTo(warm * Math.exp(-30 / breaker.thermalTimeConstantS), 2);
    const frozen = breakerAt(3 * breaker.ratedCurrentA).advance(1000);
    const id = frozen.place(OPAQUE);
    frozen.lead(id, 'a', 3, 'a').lead(id, 'b', 3, 'b');
    const before = frozen.sim(2)['thermal'];
    frozen.advance(500);
    expect(frozen.sim(2)['thermal']).toBe(before);
  });
});
