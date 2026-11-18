import { NEC_REGION } from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey } from '@controls/world-model';
import { bankRig } from '../../../testing/breakers';
import { BUSBAR, engineBus, RHEOSTAT } from '../../../testing/engine';
import { GFCI_20, GFCI_SENSE_PARAMS, plugOnParams } from '../../../testing/plug-on';
import { SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import { TICK_S } from '../../engine/constants';
import type { CommandedContext } from '../../engine/device-model';
import { GFCI_TEST_HOLD_TICKS } from './constants';
import { gfciRateTable, gfciTripRate } from './gfci';
import { GFCI_BREAKER_MODEL } from './plug-on';

/*
 * The GFCI device logic (P4 D7, ADR 0021 part 2), shared by the GFCI breaker and (F4.1 part 2) the GFCI
 * receptacle, on the GFCI breaker. Hand calculations:
 *
 * - the region's Class A limit is t = (20 mA / I)^1.43 s for 6–264 mA, tabulated at 6, 10, 20, 30, 50,
 *   100, 150 and 264 mA (5.594, 2.695, 1.000, 0.560, 0.2697, 0.1001, 0.0561, 0.0250 s) and read as a
 *   rate 1/t, linear between the points. The rate is convex in I, so each chord lies above it: the
 *   model's time never exceeds the limit (checked against the power law, here only, with `Math.pow`);
 * - at a constant residual the breaker is open max(t_m, ⌊t(I) / 1 ms⌋) ticks after the excursion began:
 *   **10 mA → 2695 ticks** (a tabulated point), **100 mA → 100 ticks** (0.1001 s, the last whole tick
 *   inside it); above 264 mA the mechanism time alone, ⌈3 + 11 u⌉ ticks (3–14 ms), so a 9.6 Ω heater
 *   element faulted from hot to ground (≈ 12.3 A) trips well under 25 ms;
 * - **3 mA never trips** (below every drawn pickup, 4–6 mA);
 * - **the test button**: the held test resistor, 15 kΩ from the load-side hot to the pigtail, draws
 *   120 / 15000 = 8.0 mA of residual: rate 1/5.594 + (1/2.695 − 1/5.594)(2 / 4) = 0.17876 + 0.5 × 0.19230
 *   = 0.27491 /s, t = 3.6375 s, so the breaker opens about 3637 ticks after the press (the load drop
 *   lowers the residual a hair), cause `test`, inside the 5000-tick hold; at 85 % voltage (102 V) it
 *   draws 6.8 mA: rate 0.17876 + 0.2 × 0.19230 = 0.21722 /s, t = 4.6036 s, 4603 ticks, still inside.
 *
 * The circuit: the utility stand-in (1); the GFCI breaker (2) fed L1 → line, its pigtail to N; its load
 * through a rheostat (3) back to its load neutral; a second rheostat (4) from the load to N is the
 * ground fault, a path around the breaker's neutral (busbar links).
 */

const dt = TICK_S.value;
const P = { ...plugOnParams(20), ...GFCI_SENSE_PARAMS };
const TABLE = gfciRateTable(NEC_REGION.protection.gfci);
const PARTS = ['neutral', 'pole'];

/** The published power law the region's points were computed from (spec only: `Math.pow`). */
const powerLawS = (amps: number) => Math.pow(0.02 / amps, 1.43);

const mechanismOf = (seed: number, id: number) =>
  Math.ceil(3 + 11 * deriveStream(seed, entityPurposeStreamKey(id, 'gfciMechanism')).nextFloat());
const pickupOf = (seed: number, id: number) =>
  0.004 + 0.002 * deriveStream(seed, entityPurposeStreamKey(id, 'gfciPickup')).nextFloat();

/** Ticks to open at a constant residual `amps` (the model's rule). */
const expectedTicks = (amps: number, mechanism: number) => {
  const rate = gfciTripRate(TABLE, amps);
  return Math.max(mechanism, rate === Infinity ? 0 : Math.floor(1 / (rate * dt) + 1e-6));
};

/** A bank-level GFCI breaker at residual `amps` (the pole carries it; the neutral nothing). */
const residualRig = (amps: number, seed = 11, bag = {}) =>
  bankRig(GFCI_BREAKER_MODEL, P, PARTS, { seed, state: { on: true, test: 0 }, bag }).amps('pole', amps);

/** A bank-level GFCI breaker whose test is pressed at tick 0, its held resistor drawing `amps` of residual. */
function heldRig(amps: number) {
  const rig = residualRig(amps);
  rig.bank.commanded?.(0, { on: true, test: 1 }, rig.ctx as unknown as CommandedContext);
  expect(rig.bank.bag(0)['testHeldSinceTick']).toBe(0);
  return rig;
}

function gfciHost(seed = 11): SourceHost {
  const host = new SourceHost(engineBus(seed));
  host.place(UTILITY_SPLIT);
  host.place(GFCI_20);
  host.place(RHEOSTAT);
  host.place(RHEOSTAT);
  const link = (a: number, ta: string, b: number, tb: string) =>
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  link(1, 'l1', 2, 'line');
  link(2, 'pigtail', 1, 'n');
  link(2, 'load', 3, 'a');
  link(3, 'b', 2, 'loadNeutral');
  link(2, 'load', 4, 'a');
  link(4, 'b', 1, 'n');
  return host.operate(3, 'ohms', 12).operate(4, 'ohms', 1e7).operate(2, 'on', true);
}

/** |I| of entity `id`'s part `part`, 0 when absent. */
function partAmps(host: SourceHost, id: number, part: string): number {
  const branch = host.engine.netlist.branches.find(
    (b) => b.element.kind === 'entity' && b.element.entity === id && b.element.part === part,
  );
  if (branch === undefined) return 0;
  const s = host.engine.exportState().solution?.branches as number[];
  return Math.hypot(s[2 * branch.index], s[2 * branch.index + 1]);
}

/** The residual the breaker senses: |I_pole + I_neutral|. */
function residual(host: SourceHost): number {
  const s = host.engine.exportState().solution?.branches as number[];
  const at = (part: string) =>
    host.engine.netlist.branches.find(
      (b) => b.element.kind === 'entity' && b.element.entity === 2 && b.element.part === part,
    )?.index as number;
  const [p, n] = [at('pole'), at('neutral')];
  return Math.hypot(s[2 * p] + s[2 * n], s[2 * p + 1] + s[2 * n + 1]);
}

function ticksToTrip(host: SourceHost, limit: number) {
  const start = host.engine.tick;
  const seen = host.events.length;
  host.advance(limit);
  const event = host.events.slice(seen).find((e) => e.kind === 'tripped');
  return { ticks: event === undefined ? -1 : event.tick - start, cause: event?.detail['cause'] };
}

describe('the Class A limit as a rate table (D7)', () => {
  it('holds the pre-audit points, each within 0.15 % of the published curve', () => {
    expect([...TABLE.amps].map((a) => Math.round(a * 1e6) / 1e3)).toStrictEqual([6, 10, 20, 30, 50, 100, 150, 264]);
    TABLE.amps.forEach((a, k) => expect(Math.abs(1 / TABLE.rates[k] / powerLawS(a) - 1)).toBeLessThan(0.0015));
  });

  it('linear in rate never exceeds the limit between the points (linear in t would overshoot by up to 22 %)', () => {
    let worstLinearT = 0;
    for (let k = 0; k < TABLE.amps.length - 1; k++) {
      for (let f = 0.01; f < 1; f += 0.01) {
        const amps = TABLE.amps[k] + f * (TABLE.amps[k + 1] - TABLE.amps[k]);
        expect(1 / gfciTripRate(TABLE, amps)).toBeLessThanOrEqual(powerLawS(amps) * 1.0015);
        const tLinear = 1 / TABLE.rates[k] + f * (1 / TABLE.rates[k + 1] - 1 / TABLE.rates[k]);
        worstLinearT = Math.max(worstLinearT, tLinear / powerLawS(amps) - 1);
      }
    }
    expect(worstLinearT).toBeGreaterThan(0.2);
  });

  it('holds the first point’s rate below 6 mA (labelled) and is unbounded above 264 mA (the mechanism time alone)', () => {
    expect(gfciTripRate(TABLE, 0.0045)).toBe(TABLE.rates[0]);
    expect(gfciTripRate(TABLE, 0.264)).toBeCloseTo(1 / 0.025, 9);
    expect(gfciTripRate(TABLE, 0.2641)).toBe(Infinity);
  });
});

describe('the GFCI sensor (bank, exact residuals)', () => {
  it('draws its pickup inside 4–6 mA and its mechanism inside 3–14 ticks, each from its own stream', () => {
    for (const seed of [1, 2, 3, 11, 20261118]) {
      expect(pickupOf(seed, 2)).toBeGreaterThanOrEqual(0.004);
      expect(pickupOf(seed, 2)).toBeLessThan(0.006);
      expect(mechanismOf(seed, 2)).toBeGreaterThanOrEqual(3);
      expect(mechanismOf(seed, 2)).toBeLessThanOrEqual(14);
    }
  });

  it('never trips at 3 mA, for 60 s', () => {
    const rig = residualRig(0.003);
    expect(rig.runToTrip(60_000)).toBe(-1);
    expect(rig.bank.bag(0)).toMatchObject({ residualIntegral: 0, residualSinceTick: null, tripped: false });
  });

  it('opens at 10 mA after 2695 ticks (the 2.695 s point) and at 100 mA after 100 (inside 0.1001 s), cause groundFault', () => {
    for (const [amps, ticks] of [
      [0.01, 2695],
      [0.1, 100],
    ] as const) {
      expect(expectedTicks(amps, mechanismOf(11, 2))).toBe(ticks);
      const rig = residualRig(amps);
      expect(rig.runToTrip(10_000)).toBe(ticks);
      expect(rig.events.at(-1)?.cause).toBe('groundFault');
      expect(ticks * dt).toBeLessThanOrEqual(1 / gfciTripRate(TABLE, amps) + 1e-12);
    }
  });

  it('above 264 mA opens at the drawn mechanism time (3–14 ms), never a clamp at 25 ms', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rig = residualRig(12.3, seed);
      expect(rig.runToTrip(100)).toBe(mechanismOf(seed, 2));
    }
  });

  it('a residual just above its pickup trips on the first point’s rate (5.594 s); just below, never', () => {
    const pickup = pickupOf(11, 2);
    const above = residualRig(Math.min(0.006, pickup * 1.0001));
    expect(above.runToTrip(10_000)).toBe(5594);
    const below = residualRig(pickup * 0.9999);
    expect(below.runToTrip(10_000)).toBe(-1);
  });

  it('integrates Σ dt / t(I) for a varying residual, clamps it at 1, and forgets it the moment the residual falls below the pickup', () => {
    const rig = residualRig(0.02);
    for (let k = 0; k < 500; k++) rig.step();
    expect(rig.bank.bag(0)['residualIntegral'] as number).toBeCloseTo(0.5, 9);
    rig.amps('pole', 0.1);
    // 0.5 left at 1 / 0.1001 s per s: 50.05 ms, so it opens 50 ticks on (the last tick inside it).
    expect(rig.runToTrip(1000)).toBe(50);
    const forgetful = residualRig(0.02);
    for (let k = 0; k < 500; k++) forgetful.step();
    forgetful.amps('pole', 0.001).step();
    expect(forgetful.bank.bag(0)).toMatchObject({ residualIntegral: 0, residualSinceTick: null });
  });
});

describe('the GFCI breaker in a circuit', () => {
  it('a 12 kΩ ground fault (≈ 10 mA) trips it inside the limit at the drawn residual; the load sees 0 V after', () => {
    const host = gfciHost();
    host.advance(20);
    expect(residual(host)).toBeLessThan(0.0001);
    host.operate(4, 'ohms', 12_000);
    const amps = residual(host);
    expect(amps).toBeGreaterThan(0.0099);
    expect(amps).toBeLessThan(0.01);
    const { ticks, cause } = ticksToTrip(host, 4000);
    expect(cause).toBe('groundFault');
    expect(ticks).toBe(expectedTicks(amps, mechanismOf(11, 2)));
    expect(ticks * dt).toBeLessThanOrEqual(1 / gfciTripRate(TABLE, amps));
    expect(partAmps(host, 3, 'element')).toBe(0);
    expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'groundFault', residualIntegral: 0 });
  });

  it('a 9.6 Ω heater element from hot to ground (≈ 12.3 A) trips at the mechanism time, under 25 ms; its 20 A pole stays cool', () => {
    for (const seed of [1, 2, 3]) {
      const host = gfciHost(seed);
      host.operate(3, 'ohms', 1e6);
      host.advance(10);
      host.operate(4, 'ohms', 9.6);
      expect(residual(host)).toBeGreaterThan(12);
      const { ticks, cause } = ticksToTrip(host, 100);
      expect(cause).toBe('groundFault');
      expect(ticks).toBe(mechanismOf(seed, 2));
      expect(ticks).toBeLessThan(25);
      expect(host.sim(2)['thermal'] as number).toBeLessThan(1);
    }
  });

  it('the test button injects its residual through the 15 kΩ resistor: cause test after about 3637 ticks; the handle resets it', () => {
    const host = gfciHost();
    host.advance(20);
    host.exec('device.press', { id: 2, control: 'test' });
    expect(host.sim(2)['testHeldSinceTick']).toBe(20);
    const amps = residual(host);
    expect(Math.abs(amps / (120 / 15_000) - 1)).toBeLessThan(0.002);
    const { ticks, cause } = ticksToTrip(host, GFCI_TEST_HOLD_TICKS.value);
    expect(cause).toBe('test');
    // The residual moves a hair over 3.6 s as the circuit settles, so the hand count is good to a tick.
    expect(Math.abs(ticks - expectedTicks(amps, mechanismOf(11, 2)))).toBeLessThanOrEqual(1);
    expect(ticks).toBeGreaterThanOrEqual(3630);
    expect(ticks).toBeLessThanOrEqual(3645);
    // The trip lets the test go; the resistor is out of the netlist.
    expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'test', testHeldSinceTick: null });
    expect(partAmps(host, 2, 'test')).toBe(0);
    host.operate(2, 'on', false).operate(2, 'on', true);
    expect(host.sim(2)).toMatchObject({ tripped: false, tripCause: null });
    expect(ticksToTrip(host, 3000).ticks).toBe(-1);
    near10A(host);
  });

  it('the hold covers the limit at 85 % voltage: 15 kΩ at 102 V draws 6.8 mA, a 4.60 s limit, inside 5000 ticks (bank)', () => {
    expect(1 / gfciTripRate(TABLE, 102 / 15_000)).toBeCloseTo(4.6036, 3);
    const rig = heldRig(102 / 15_000);
    const ticks = rig.runToTrip(GFCI_TEST_HOLD_TICKS.value);
    expect(ticks).toBe(4603);
    expect(rig.events.at(-1)?.cause).toBe('test');
  });

  it('a trip on the very step the hold lets go is still a test trip (the cause is the hold over that step)', () => {
    // A residual whose limit is 5.00025 s: open 5000 ticks after the press, the hold's last step.
    const r0 = TABLE.rates[0];
    const r1 = TABLE.rates[1];
    const amps = TABLE.amps[0] + ((1 / 5.00025 - r0) * (TABLE.amps[1] - TABLE.amps[0])) / (r1 - r0);
    expect(expectedTicks(amps, 14)).toBe(GFCI_TEST_HOLD_TICKS.value);
    const rig = heldRig(amps);
    expect(rig.runToTrip(GFCI_TEST_HOLD_TICKS.value + 10)).toBe(GFCI_TEST_HOLD_TICKS.value);
    expect(rig.events.at(-1)?.cause).toBe('test');
    expect(rig.bank.bag(0)['testHeldSinceTick']).toBeNull();
  });

  it('a test pressed with the handle off holds its resistor for GFCI_TEST_HOLD_TICKS, then lets go; nothing trips', () => {
    const host = gfciHost();
    host.operate(2, 'on', false);
    host.advance(5);
    host.exec('device.press', { id: 2, control: 'test' });
    const held = (h: SourceHost) =>
      h.engine.netlist.branches.some(
        (b) => b.element.kind === 'entity' && b.element.entity === 2 && b.element.part === 'test',
      );
    expect(held(host)).toBe(true);
    host.advance(GFCI_TEST_HOLD_TICKS.value - 1);
    expect(held(host)).toBe(true);
    host.advance(1);
    expect(held(host)).toBe(false);
    expect(host.sim(2)).toMatchObject({ testHeldSinceTick: null, tripped: false });
    expect(host.events.some((e) => e.kind === 'tripped')).toBe(false);
  });

  it('undoing a press presses nothing; redoing it presses again (ADR 0019: undo never rewinds the simulator)', () => {
    const host = gfciHost();
    host.operate(2, 'on', false);
    host.exec('device.press', { id: 2, control: 'test' });
    host.advance(GFCI_TEST_HOLD_TICKS.value + 5);
    expect(host.sim(2)['testHeldSinceTick']).toBeNull();
    host.exec('edit.undo', {});
    expect(host.sim(2)['testHeldSinceTick']).toBeNull();
    host.exec('edit.redo', {});
    expect(host.sim(2)['testHeldSinceTick']).toBe(host.engine.tick);
  });

  it('a save inside the mechanism window (the integral already at 1) opens at the same tick as the straight run', () => {
    const straight = gfciHost(2);
    straight.advance(10);
    straight.operate(4, 'ohms', 9.6);
    straight.advance(1);
    expect(straight.sim(2)).toMatchObject({ residualIntegral: 1, residualSinceTick: 10, tripped: false });
    const loaded = straight.reload();
    expect(ticksToTrip(loaded, 50)).toStrictEqual(ticksToTrip(straight, 50));
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
  });
});

/** The load (12 Ω) draws its 10 A again after a reset. */
function near10A(host: SourceHost): void {
  expect(Math.abs(partAmps(host, 3, 'element') / 10 - 1)).toBeLessThan(0.01);
}
