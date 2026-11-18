import { BUILTIN_CATALOG, type BreakerParams, MODEL_KINDS, type PlugOnBreakerParams } from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey, entityStreamKey } from '@controls/world-model';
import { bankRig } from '../../../testing/breakers';
import { BUSBAR, engineBus, ENGINE_TEST_CATALOG, RHEOSTAT } from '../../../testing/engine';
import { AFCI_15, GFCI_20, PLUG_ON_15, PLUG_ON_20, PLUG_ON_2P_20, plugOnParams } from '../../../testing/plug-on';
import { BREAKER } from '../../../testing/protection';
import { SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import { TICK_S } from '../../engine/constants';
import { wiringGraph } from '../../netlist/wiring-graph';
import { PLUG_ON_1P_MODEL, PLUG_ON_2P_MODEL } from './plug-on';

/*
 * Breakers v2 (P4 D6, ADR 0021 part 2): the plug-on breakers' datasheet-style tests. Hand calculations
 * (the figures the ADR, the caveats and this header quote are computed by "the documented figures"):
 *
 * - **thermal**, the P2 bimetal law with τ = 60 s and k_u = 1.25 at any rating (the law is scale-free in
 *   I / I_n): t = −τ ln(1 − (k_u I_n / I)²), so
 *   135 %: −60 ln(1 − (1.25 / 1.35)²) = −60 ln(0.142661) = 116.84 s;
 *   200 %: −60 ln(1 − 0.390625) = 29.72 s;
 *   500 %: −60 ln(1 − 0.0625) = 3.872 s;
 *   10 ×: −60 ln(1 − 0.015625) = 0.9449 s (200 A on a 20 A breaker, still thermal: below the 240 A
 *   band). The read bands (ADR 0021 part 2, the pre-audit): 135 %: 30 s to 1 h; 200 %: 10 s to 2 min;
 *   500 %: 1 to 15 s; 10 ×: 0.45 to 1.1 s. At exactly k_u I_n (125 %) it never trips (θ → k_u² from
 *   below, the trip is θ ≥ k_u²);
 * - **magnetic**: each pole's pickup is 240 + 160 u A (u its stream's first output: the entity stream
 *   for pole 1, `:pickupL2` for pole 2); above it the breaker opens ⌈8 + 12 u′⌉ ticks after the first
 *   step that saw it (u′ the `:opening` stream's first output), whatever the current: at 25 × and 50 ×
 *   of a 20 A breaker (500 A, 1000 A) and 50 × of a 15 A one (750 A), cause `magnetic`;
 * - the frozen DIN entry's pickup is 8–12 × 15 A = 120–180 A; no plug-on band is ever a multiple.
 *
 * Every engine golden reads the current the circuit drew (a utility stand-in, the breaker, a rheostat;
 * busbar links), so it tests the model's timing, not the circuit's resistance.
 */

const dt = TICK_S.value;
const P15 = plugOnParams(15);
const P20 = plugOnParams(20);

/** The thermal trip time (s) at a constant `amps` from cold: −τ ln(1 − (k_u I_n / I)²). */
const thermalTripS = (p: PlugOnBreakerParams, amps: number) => {
  const a = (p.ultimateTripRatio * p.ratedCurrentA) / amps;
  return -p.thermalTimeConstantS * Math.log(1 - a * a);
};

const DOCUMENTED_THERMAL_S = { 1.35: 116.84, 2: 29.72, 5: 3.872, 10: 0.9449 } as const;
/** The read thermal bands (s), from the pre-audit (ADR 0021 part 2). */
const THERMAL_BAND_S = { 1.35: [30, 3600], 2: [10, 120], 5: [1, 15], 10: [0.45, 1.1] } as const;

const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

/** The pickup (A) of pole `pole` (1 or 2) of entity `id` under `seed`. */
const pickupOf = (p: PlugOnBreakerParams, seed: number, id: number, pole: 1 | 2 = 1) =>
  p.magneticPickupMinA +
  (p.magneticPickupMaxA - p.magneticPickupMinA) *
    (pole === 1
      ? deriveStream(seed, entityStreamKey(id))
      : deriveStream(seed, entityPurposeStreamKey(id, 'pickupL2'))
    ).nextFloat();
/** The opening time (ticks) of entity `id` under `seed`. */
const openingOf = (p: PlugOnBreakerParams, seed: number, id: number) =>
  Math.ceil(
    p.openingTimeMinMs +
      (p.openingTimeMaxMs - p.openingTimeMinMs) * deriveStream(seed, entityPurposeStreamKey(id, 'opening')).nextFloat(),
  );

/** The utility stand-in (1), L1 through the breaker `ref` (2, handle on) and a rheostat (3) at `ohms`, back to N. */
function feed(ref: typeof PLUG_ON_15, ohms: number, seed = 11): SourceHost {
  const host = new SourceHost(engineBus(seed));
  host.place(UTILITY_SPLIT);
  host.place(ref);
  host.place(RHEOSTAT);
  const link = (a: number, ta: string, b: number, tb: string) =>
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  link(1, 'l1', 2, 'line');
  link(2, 'load', 3, 'a');
  link(3, 'b', 1, 'n');
  return host.operate(3, 'ohms', ohms).operate(2, 'on', true);
}

/** The phasor magnitude of entity `id`'s branch of part `part`. */
function partAmps(host: SourceHost, id: number, part: string): number {
  const branch = host.engine.netlist.branches.find(
    (b) => b.element.kind === 'entity' && b.element.entity === id && b.element.part === part,
  );
  if (branch === undefined) return 0;
  const s = host.engine.exportState().solution?.branches as number[];
  return Math.hypot(s[2 * branch.index], s[2 * branch.index + 1]);
}

/** Ticks from now to the first `tripped` event within `limit` (−1: none), and the event. */
function ticksToTrip(host: SourceHost, limit: number) {
  const start = host.engine.tick;
  const seen = host.events.length;
  host.advance(limit);
  const event = host.events.slice(seen).find((e) => e.kind === 'tripped');
  return { ticks: event === undefined ? -1 : event.tick - start, cause: event?.detail['cause'] };
}

describe('the documented figures (computed, so the docs cannot drift)', () => {
  it('the thermal trip times at 135 %, 200 %, 500 % and 10 × are the law’s, inside the read bands', () => {
    for (const [k, t] of Object.entries(DOCUMENTED_THERMAL_S)) {
      const s = thermalTripS(P20, Number(k) * P20.ratedCurrentA);
      expect(Math.abs(s / t - 1), `${k}×`).toBeLessThan(5e-4);
      const [lo, hi] = THERMAL_BAND_S[k as unknown as keyof typeof THERMAL_BAND_S];
      expect(s, `${k}×`).toBeGreaterThan(lo);
      expect(s, `${k}×`).toBeLessThan(hi);
      // Scale-free: the 15 A breaker's times are the same.
      expect(thermalTripS(P15, Number(k) * 15)).toBeCloseTo(s, 9);
    }
    // 10 × of a 20 A breaker is below the instantaneous band: thermal.
    expect(10 * P20.ratedCurrentA).toBeLessThan(P20.magneticPickupMinA);
  });
});

describe('the thermal element (bank, exact currents)', () => {
  it.each([1.35, 2, 5, 10])(
    'trips thermally at %s × within 0.5 % of the law and inside its band (15 and 20 A)',
    (k) => {
      for (const p of [P15, P20]) {
        const rig = bankRig(PLUG_ON_1P_MODEL, p, ['pole']).amps('pole', k * p.ratedCurrentA);
        const ticks = rig.runToTrip(4_000_000);
        expect(rig.events.at(-1)?.cause).toBe('thermal');
        near(ticks * dt, thermalTripS(p, k * p.ratedCurrentA), 0.005);
        const [lo, hi] = THERMAL_BAND_S[k as keyof typeof THERMAL_BAND_S];
        expect(ticks * dt).toBeGreaterThan(lo);
        expect(ticks * dt).toBeLessThan(hi);
      }
    },
  );

  it('never trips at k_u I_n (125 %): θ approaches k_u² from below', () => {
    const rig = bankRig(PLUG_ON_1P_MODEL, P20, ['pole'], {
      bag: { thermal: 1.5625 * (1 - 1e-6), tripped: false, tripCause: null, magneticSinceTick: null },
    }).amps('pole', 1.25 * 20);
    expect(rig.runToTrip(600_000)).toBe(-1);
    expect(rig.bank.bag(0)['thermal'] as number).toBeLessThan(1.5625);
    expect(rig.bank.bag(0)['thermal'] as number).toBeGreaterThan(1.5625 * (1 - 2e-6));
  });

  it('an open breaker cools: its bimetal decays towards 0 and the magnetic excursion ends', () => {
    const rig = bankRig(PLUG_ON_1P_MODEL, P20, [], {
      state: { on: false },
      bag: { thermal: 1, tripped: false, tripCause: null, magneticSinceTick: 7 },
    });
    for (let k = 0; k < 60_000; k++) rig.step();
    near(rig.bank.bag(0)['thermal'] as number, Math.exp(-1), 1e-3);
    expect(rig.bank.bag(0)['magneticSinceTick']).toBeNull();
  });
});

describe('the magnetic element (opening after the drawn opening time, D6)', () => {
  it('draws each pickup inside the absolute 240–400 A band and the opening inside 8–20 ticks, from its own streams', () => {
    for (const seed of [1, 2, 3, 11, 20261118]) {
      for (const id of [2, 5, 9]) {
        const pickup1 = pickupOf(P20, seed, id);
        const pickup2 = pickupOf(P20, seed, id, 2);
        const opening = openingOf(P20, seed, id);
        for (const pickup of [pickup1, pickup2]) {
          expect(pickup).toBeGreaterThanOrEqual(240);
          expect(pickup).toBeLessThan(400);
        }
        expect(opening).toBeGreaterThanOrEqual(8);
        expect(opening).toBeLessThanOrEqual(20);
        // Just above the pickup it opens exactly `opening` ticks after the first step that saw it;
        // just below, nothing (the bimetal needs far longer).
        const above = bankRig(PLUG_ON_1P_MODEL, P20, ['pole'], { seed, entity: id }).amps('pole', pickup1 * 1.0001);
        expect(above.runToTrip(100)).toBe(opening);
        expect(above.events.at(-1)?.cause).toBe('magnetic');
        const below = bankRig(PLUG_ON_1P_MODEL, P20, ['pole'], { seed, entity: id }).amps('pole', pickup1 * 0.9999);
        expect(below.runToTrip(100)).toBe(-1);
        expect(below.bank.bag(0)['magneticSinceTick']).toBeNull();
      }
    }
  });

  it('a dip below the pickup ends the excursion: the window starts again', () => {
    const rig = bankRig(PLUG_ON_1P_MODEL, P20, ['pole'], { seed: 3 }).amps('pole', 600);
    const opening = openingOf(P20, 3, 2);
    for (let k = 0; k < opening - 2; k++) rig.step();
    expect(rig.bank.bag(0)['magneticSinceTick']).toBe(0);
    rig.amps('pole', 100).step();
    expect(rig.bank.bag(0)['magneticSinceTick']).toBeNull();
    rig.amps('pole', 600);
    expect(rig.runToTrip(100)).toBe(opening);
  });

  it.each([
    [PLUG_ON_20, 25, 0.2],
    [PLUG_ON_20, 50, 0.1],
    [PLUG_ON_15, 50, 0.14],
  ] as const)('%s at ≥ %s ×: magnetic, opening 8–20 ms after the fault (the drawn opening time)', (ref, k, ohms) => {
    const p = ref === PLUG_ON_15 ? P15 : P20;
    const host = feed(ref, 1000);
    host.advance(50);
    host.operate(3, 'ohms', ohms);
    expect(partAmps(host, 2, 'pole') / p.ratedCurrentA).toBeGreaterThanOrEqual(k);
    const { ticks, cause } = ticksToTrip(host, 100);
    expect(cause).toBe('magnetic');
    expect(ticks).toBe(openingOf(p, 11, 2));
    expect(ticks).toBeGreaterThanOrEqual(8);
    expect(ticks).toBeLessThanOrEqual(20);
    // Open: no pole, no current, and the cause is persisted with the trip.
    expect(partAmps(host, 2, 'pole')).toBe(0);
    expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'magnetic', magneticSinceTick: null });
  });

  it('10 × of a 20 A breaker (200 A) is thermal, in 0.45–1.1 s and within 0.5 % of the law at the drawn current', () => {
    const host = feed(PLUG_ON_20, 1000);
    host.advance(50);
    host.operate(3, 'ohms', 0.6);
    const amps = partAmps(host, 2, 'pole');
    expect(amps).toBeGreaterThan(190);
    expect(amps).toBeLessThan(240);
    const { ticks, cause } = ticksToTrip(host, 1500);
    expect(cause).toBe('thermal');
    near(ticks * dt, thermalTripS(P20, amps), 0.005);
    expect(ticks * dt).toBeGreaterThan(0.45);
    expect(ticks * dt).toBeLessThan(1.1);
  });

  it('a save inside the opening window opens at the same tick as the straight run (magneticSinceTick is persisted)', () => {
    const straight = feed(PLUG_ON_20, 1000);
    straight.advance(50);
    straight.operate(3, 'ohms', 0.2);
    straight.advance(4);
    expect(straight.sim(2)['magneticSinceTick']).toBe(50);
    const loaded = straight.reload();
    const a = ticksToTrip(straight, 100);
    const b = ticksToTrip(loaded, 100);
    expect(b).toStrictEqual(a);
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
  });
});

describe('reset and the cause', () => {
  it('a tripped breaker stays open with its handle on; off clears the trip and its cause, on closes it', () => {
    const host = feed(PLUG_ON_20, 1000);
    host.advance(10);
    host.operate(3, 'ohms', 0.1);
    host.advance(40);
    expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'magnetic' });
    host.operate(3, 'ohms', 12);
    host.advance(10);
    expect(partAmps(host, 2, 'pole')).toBe(0);
    host.operate(2, 'on', false);
    expect(host.sim(2)).toMatchObject({ tripped: false, tripCause: null });
    host.operate(2, 'on', true);
    near(partAmps(host, 2, 'pole'), 10, 0.01);
  });
});

describe('the two-pole breaker (a common trip)', () => {
  /** L1 and L2 through the 2-pole breaker (2) into rheostats 3 (from load1) and 4 (from load2), back to N. */
  function twoPole(ohms1: number, ohms2: number): SourceHost {
    const host = new SourceHost(engineBus(11));
    host.place(UTILITY_SPLIT);
    host.place(PLUG_ON_2P_20);
    host.place(RHEOSTAT);
    host.place(RHEOSTAT);
    const link = (a: number, ta: string, b: number, tb: string) =>
      host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
    link(1, 'l1', 2, 'line1');
    link(1, 'l2', 2, 'line2');
    link(2, 'load1', 3, 'a');
    link(2, 'load2', 4, 'a');
    link(3, 'b', 1, 'n');
    link(4, 'b', 1, 'n');
    return host.operate(3, 'ohms', ohms1).operate(4, 'ohms', ohms2).operate(2, 'on', true);
  }

  it('a fault on pole 2 opens both poles (magnetic, at the drawn opening time)', () => {
    const host = twoPole(12, 1000);
    host.advance(20);
    near(partAmps(host, 2, 'pole1'), 10, 0.01);
    host.operate(4, 'ohms', 0.15);
    expect(partAmps(host, 2, 'pole2')).toBeGreaterThan(pickupOf(P20, 11, 2, 2));
    const { ticks, cause } = ticksToTrip(host, 100);
    expect(cause).toBe('magnetic');
    expect(ticks).toBe(openingOf(P20, 11, 2));
    expect(partAmps(host, 2, 'pole1')).toBe(0);
    expect(partAmps(host, 2, 'pole2')).toBe(0);
    expect(host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === 2)).toBe(false);
  });

  it('an overload on pole 1 alone trips both thermally; pole 2’s own bimetal stays cool', () => {
    const host = twoPole(120 / 100, 12);
    const { ticks, cause } = ticksToTrip(host, 5000);
    expect(cause).toBe('thermal');
    expect(ticks).toBeGreaterThan(1000);
    expect(partAmps(host, 2, 'pole2')).toBe(0);
    const bag = host.sim(2);
    expect(bag['thermalL1'] as number).toBeGreaterThan(1.5);
    expect(bag['thermalL2'] as number).toBeLessThan(0.3);
  });

  it('pole 2 draws its own pickup from `entity:<id>:pickupL2` (bank)', () => {
    const p1 = pickupOf(P20, 11, 2, 1);
    const p2 = pickupOf(P20, 11, 2, 2);
    expect(p2).not.toBe(p1);
    const rig = bankRig(PLUG_ON_2P_MODEL, P20, ['pole1', 'pole2'])
      .amps('pole1', 0)
      .amps('pole2', p2 * 1.0001);
    expect(rig.runToTrip(100)).toBe(openingOf(P20, 11, 2));
    const below = bankRig(PLUG_ON_2P_MODEL, P20, ['pole1', 'pole2']).amps('pole2', p2 * 0.9999);
    expect(below.runToTrip(100)).toBe(-1);
  });
});

describe('the frozen DIN entry’s band is never carried into plug-on entries', () => {
  it('the DIN breaker keeps its 8–12 × band; the plug-on kinds have no ratio fields and an absolute band above it', () => {
    const din = BUILTIN_CATALOG.device(BREAKER)?.model.params as BreakerParams;
    expect([din.magneticTripMinRatio, din.magneticTripMaxRatio]).toStrictEqual([8, 12]);
    for (const kind of ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.gfci1p', 'breaker.afci1p']) {
      const shape = Object.keys((MODEL_KINDS[kind].params as unknown as { def: { shape?: object } }).def.shape ?? {});
      expect(shape, kind).toContain('magneticPickupMinA');
      for (const banned of ['magneticTripMinRatio', 'magneticTripMaxRatio']) expect(shape, kind).not.toContain(banned);
    }
    for (const ref of [PLUG_ON_15, PLUG_ON_20, PLUG_ON_2P_20]) {
      const p = ENGINE_TEST_CATALOG.device(ref)?.model.params as PlugOnBreakerParams;
      expect([p.magneticPickupMinA, p.magneticPickupMaxA]).toStrictEqual([240, 400]);
      // Not the DIN band at the entry's rating.
      expect([p.magneticPickupMinA, p.magneticPickupMaxA]).not.toStrictEqual([
        din.magneticTripMinRatio * p.ratedCurrentA,
        din.magneticTripMaxRatio * p.ratedCurrentA,
      ]);
      expect(p.magneticPickupMaxA).toBeGreaterThan(din.magneticTripMaxRatio * p.ratedCurrentA);
    }
  });
});

describe('wiringGraph passes through every breakers-v2 kind, closed or intact (ADR 0021 §6)', () => {
  it('line → load (and a sensing breaker’s pigtail → load neutral) are joined whatever the handle or a trip; never hot to neutral', () => {
    const cases: [typeof PLUG_ON_20, boolean, Record<string, unknown>][] = [
      [PLUG_ON_20, false, {}],
      [PLUG_ON_2P_20, true, { tripped: true, tripCause: 'magnetic' }],
      [GFCI_20, false, { testHeldSinceTick: 4 }],
      [AFCI_15, true, { tripped: true, tripCause: 'arcFault' }],
    ];
    for (const [ref, on, sim] of cases) {
      const bus = engineBus(11);
      bus.exec('entity.place', { ref, positionMm: { x: 0, y: 0, z: 0 } });
      bus.exec('device.operate', { id: 1, control: 'on', value: on });
      const world = bus.state;
      const patched = {
        ...world,
        entities: world.entities.map((e) => ({ ...e, sim: { ...e.sim, ...sim } as typeof e.sim })),
      };
      const graph = wiringGraph(patched, ENGINE_TEST_CATALOG);
      const t = (terminal: string) => ({ entity: 1, terminal });
      if (ref === PLUG_ON_2P_20) {
        expect(graph.joined(t('line1'), t('load1'))).toBe(true);
        expect(graph.joined(t('line2'), t('load2'))).toBe(true);
        expect(graph.joined(t('line1'), t('line2'))).toBe(false);
      } else {
        expect(graph.joined(t('line'), t('load')), ref.id).toBe(true);
      }
      if (ref === GFCI_20 || ref === AFCI_15) {
        expect(graph.joined(t('pigtail'), t('loadNeutral')), ref.id).toBe(true);
        // The held test resistor is never a wiring path.
        expect(graph.joined(t('load'), t('pigtail')), ref.id).toBe(false);
      }
    }
  });
});
