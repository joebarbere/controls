import { BUILTIN_CATALOG, type BreakerParams, type FuseParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { BATTERY } from '../../../testing/bench';
import { BUSBAR, engineBus, OPAQUE, RHEOSTAT } from '../../../testing/engine';
import { BREAKER, FUSE_1A } from '../../../testing/protection';
import { BENCH_SUPPLY, SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import { TICK_S } from '../../engine/constants';
import { BREAKER_OUTPUT } from './breaker';
import { FUSE_OUTPUT } from './fuse';

/*
 * The fuse and the thermal-magnetic breaker (plan F2.5 part 2). Hand calculations:
 *
 * - the fuse (1 A, melting I²t 0.7 A²s, I_min = 1.2 A): τ = 0.7 / 1.2² = 0.48611 s. At a constant
 *   current I > I_min it melts after t = −τ ln(1 − (1.2 / I)²): 0.756 s at 1.35 A, 0.217 s at 2 A,
 *   0.0919 s at 3 A; never at or below 1.2 A. At 10 A, 7.06 ms (∫I² dt = 0.706 A²s, the lag's 0.9 %
 *   above the adiabatic 0.7);
 * - the breaker (15 A, τ 60 s, k_u 1.25): a thermal trip after t = −60 ln(1 − (1.25 · 15 / I)²):
 *   116.8 s at 135 % (in `apps/sim-cli/src/breaker-curve.spec.ts`: 117 000 ticks are too slow under
 *   coverage), 29.8 s at 200 %, 3.87 s at 500 %; never at or below 125 %. The magnetic pickup is
 *   drawn per breaker in 8–12 × 15 A = 120–180 A.
 *
 * Every current is the one the circuit draws (read from its solve), so the goldens test the model's
 * timing, not the circuit's resistance. Euler at the 1 ms tick: within 0.5 % of the analytic times.
 */

const fuse = BUILTIN_CATALOG.device(FUSE_1A)?.model.params as FuseParams;
const breaker = BUILTIN_CATALOG.device(BREAKER)?.model.params as BreakerParams;
const dt = TICK_S.value;
const fuseMinA = fuse.ratedCurrentA * fuse.minimumFusingRatio;
const fuseTau = fuse.meltingI2tA2s / (fuseMinA * fuseMinA);

/** The time for a first-order lag (time constant τ) from 0 towards x² to reach a²: −τ ln(1 − (a / x)²). */
const lagTime = (tau: number, a: number, x: number) => -tau * Math.log(1 - (a / x) * (a / x));

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
  return host.operate(3, 'ohms', 120 / amps).operate(2, 'on', true);
}

/** Lets `limit` ticks pass and returns how many ticks after the start the first `kind` event came (−1: none). */
function ticksTo(host: SourceHost, kind: 'blown' | 'tripped', limit: number): number {
  const start = host.engine.tick;
  const seen = host.events.length;
  host.advance(limit);
  const event = host.events.slice(seen).find((e) => e.kind === kind);
  return event === undefined ? -1 : event.tick - start;
}

describe('the fuse (golden)', () => {
  it('publishes a valid record; it starts intact and cold, and carries its current through a branch', () => {
    expect(deviceOutputSchemaProblems(FUSE_OUTPUT)).toStrictEqual([]);
    const host = fuseAt(0.5);
    expect(host.sim(2)).toStrictEqual({ blown: false, meltFraction: 0 });
    const record = host.record(2);
    expect(record).toMatchObject({ state: 'intact', status: 'solved', meltFraction: 0 });
    expect(Math.abs((record['currentA'] as number) / 0.5 - 1)).toBeLessThan(1e-3);
  });

  it.each([1.35, 2, 3])('melts at %s × its rating at the analytic time, −τ ln(1 − (I_min / I)²), within 0.5 %', (k) => {
    const host = fuseAt(k * fuse.ratedCurrentA);
    const amps = host.record(2)['currentA'] as number;
    expect(Math.abs(amps / k - 1)).toBeLessThan(1e-3);
    const expected = lagTime(fuseTau, fuseMinA, amps) / dt;
    const ticks = ticksTo(host, 'blown', 2000);
    expect(Math.abs(ticks - expected) / expected).toBeLessThan(0.005);
    // The fictional datasheet's band (catalogue `opening-time-band`): within 1 h at 135 %, 5 s at 200 %.
    expect(ticks * dt).toBeLessThan(k < 2 ? 3600 : 5);
  });

  it('carries 115 % of its rating indefinitely, settling at (I / I_min)² of its melt', () => {
    const host = fuseAt(1.15 * fuse.ratedCurrentA);
    host.advance(5000); // about 10 τ
    expect(host.sim(2)['blown']).toBe(false);
    expect(host.sim(2)['meltFraction']).toBeCloseTo((1.15 / 1.2) ** 2, 3);
  });

  it('at 10 × its rating it melts in 1 to 20 ms (the band), when ∫I² dt is within a tick of the melting I²t', () => {
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
    expect(Math.abs(ticks - lagTime(fuseTau, fuseMinA, amps) / dt)).toBeLessThanOrEqual(1);
    expect(amps * amps * ticks * dt).toBeGreaterThan(fuse.meltingI2tA2s);
    expect(amps * amps * (ticks - 1) * dt).toBeLessThan(fuse.meltingI2tA2s * 1.01);
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
    expect(host.sim(2)).toStrictEqual({ blown: true, meltFraction: 1 });
    expect(host.record(2)).toMatchObject({ state: 'blown', currentA: 0, status: 'solved' });
    expect(host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === 2)).toBe(false);
    // It stays blown: across time, a reload, and a delete undone (the engine's tombstone).
    host.advance(1000);
    expect(host.reload().sim(2)['blown']).toBe(true);
    host.exec('entity.delete', { id: 2 }).exec('edit.undo');
    expect(host.sim(2)['blown']).toBe(true);
    // Replacing it (P2): delete it and place a new one, which starts intact.
    host.exec('entity.delete', { id: 2 });
    const fresh = host.place(FUSE_1A);
    expect(host.sim(fresh)).toStrictEqual({ blown: false, meltFraction: 0 });
  });

  it('cools when its current drops, and a frozen island neither heats nor cools it', () => {
    const host = fuseAt(1.5 * fuse.ratedCurrentA);
    host.advance(100);
    const warm = host.sim(2)['meltFraction'] as number;
    expect(warm).toBeGreaterThan(0.1);
    host.operate(1, 'currentLimitA', 0.1).advance(1000);
    expect(host.sim(2)['meltFraction']).toBeLessThan(warm / 4);
    const frozen = fuseAt(1.5 * fuse.ratedCurrentA).advance(100);
    const id = frozen.place(OPAQUE);
    frozen.lead(id, 'a', 2, 'a').lead(id, 'b', 2, 'b');
    const before = frozen.sim(2)['meltFraction'];
    frozen.advance(500);
    expect(frozen.sim(2)['meltFraction']).toBe(before);
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
      const expected =
        lagTime(breaker.thermalTimeConstantS, breaker.ultimateTripRatio * breaker.ratedCurrentA, amps) / dt;
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

  it('never trips at its rating or just under its ultimate trip ratio: θ settles at (I / I_n)² below k_u²', () => {
    const host = breakerAt(1.2 * breaker.ratedCurrentA);
    host.advance(20_000);
    expect(host.sim(2)['tripped']).toBe(false);
    const theta = host.sim(2)['thermal'] as number;
    const settle = 1.44 * (1 - Math.exp(-20 / breaker.thermalTimeConstantS));
    expect(Math.abs(theta / settle - 1)).toBeLessThan(0.01);
  });

  it('trips magnetically within the tick above its pickup, which each breaker draws from its own stream in 8–12 ×', () => {
    const pickups = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => breakerAt(10, seed).record(2)['magneticPickupA'] as number);
    for (const p of pickups) {
      expect(p).toBeGreaterThanOrEqual(8 * 15);
      expect(p).toBeLessThanOrEqual(12 * 15);
    }
    expect(new Set(pickups).size).toBe(pickups.length);
    expect(breakerAt(10, 3).record(2)['magneticPickupA']).toBe(pickups[2]); // reproducible per entity and seed
    const host = breakerAt(13 * breaker.ratedCurrentA);
    host.advance(1);
    expect(host.events.filter((e) => e.kind === 'tripped')).toMatchObject([
      { entity: 2, tick: 1, detail: { cause: 'magnetic' } },
    ]);
    expect(host.record(2)).toMatchObject({ state: 'tripped', currentA: 0 });
    // Its pickup survives a reload (drawn again from the same stream).
    expect(host.reload().record(2)['magneticPickupA']).toBe(host.record(2)['magneticPickupA']);
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
