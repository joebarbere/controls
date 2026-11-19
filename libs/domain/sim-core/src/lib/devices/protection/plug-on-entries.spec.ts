import {
  BUILTIN_CATALOG,
  type DeviceDefinition,
  type GfciBreakerParams,
  GfciBreakerParams as GfciBreakerParamsSchema,
  type PlugOnBreakerParams,
  PlugOnBreakerParams as PlugOnBreakerParamsSchema,
} from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey, entityStreamKey } from '@controls/world-model';
import { bankRig } from '../../../testing/breakers';
import { BUSBAR, engineBus, RHEOSTAT } from '../../../testing/engine';
import { SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import { TICK_S } from '../../engine/constants';
import { GFCI_TEST_HOLD_TICKS } from './constants';
import { AFCI_BREAKER_MODEL, GFCI_BREAKER_MODEL, PLUG_ON_1P_MODEL, PLUG_ON_2P_MODEL } from './plug-on';

/*
 * The shipped plug-on breaker entries (P4 F4.2 part 2, content PR 14): every Saltmere plug-on, GFCI and
 * AFCI breaker on the engine, against its own sourced bands. Hand calculations:
 *
 * - **thermal**, the P2 bimetal law at every rating (τ 60 s, k_u 1.25; scale-free in I / I_n):
 *   t = −τ ln(1 − (k_u I_n / I)²): 116.84 s at 135 %, 29.72 s at 200 %, 3.872 s at 500 %, 0.9449 s at
 *   10 ×. The read bands: 15 and 20 A, the pre-audit's (135 %: 30 s–1 h; 200 %: 10 s–2 min; 500 %:
 *   1–15 s; 10 ×: 0.45–1.1 s); 30–50 A, read for these entries from one maker's 30–40 A and 50–70 A
 *   curve sheets (135 %: about 45 s–8 min; 200 %: about 10 s–1 min; 500 %: about 1.3–5 s; log-axis
 *   readings, about ±15 %). 500 % is below every band's pickup (75–250 A against 240–350 A), and 10 ×
 *   only on 15 and 20 A (150 and 200 A against 240 A); at 10 × of 30 A and up the pickup band begins;
 * - **magnetic**: each pole's pickup is min + (max − min) u (u its stream's first output); above it the
 *   breaker opens ⌈8 + 12 u′⌉ ticks after the first step that saw it, cause `magnetic`, whatever the
 *   bimetal does meanwhile (ADR 0021 part 2, correction). The faults: a 0.2 Ω load on the 25 kVA
 *   stand-in draws about 120 / (0.2 + 0.0146) ≈ 560 A on 15 and 20 A (above 400 A), a 0.05 Ω one
 *   about 1.9 kA on 30–50 A (above ≤ 1000 A); and a bolted 1 mΩ fault, about
 *   120 / (0.0146 + 0.001 + pole + stab) ≈ 4.9 kA on 15 A (9.1 mΩ) to 6.9 kA on 50 A (1.8 mΩ), above
 *   the shipped service's ≈ 1.6 kA at the meter. There the bimetal law's time, ≈ τ (k_u I_n / I)²,
 *   is under 1 ms (15 A at 4.9 kA: 60 × (18.75 / 4900)² ≈ 0.88 ms): it crosses its trip point long
 *   before the 8 ms floor, and the breaker still opens at the drawn opening, magnetic;
 * - **pole loss at the rating**, I_n² × (pole + stab contact): 15 A: 225 × 9.1 mΩ = 2.0475 W; 20 A:
 *   400 × 5.1 mΩ = 2.04 W; 30 A: 900 × 4.1 mΩ = 3.69 W; 40 A: 1600 × 2.5 mΩ = 4.0 W; 50 A:
 *   2500 × 1.8 mΩ = 4.5 W (the anchors: about 2.2 W for a 20 A residential AFCI; about 2.5, 2.8, 3.8,
 *   4.0, 4.5 W per pole at 16, 20, 32, 40, 50 A for DIN-rail breakers);
 * - **the GFCI test**: 15 kΩ at 120 V is 8.0 mA of residual, a rate of 0.17876 + 0.5 × 0.19230 =
 *   0.27491 /s on the Class A table, so about 3637 ticks; at 85 % voltage (102 V) 6.8 mA, 4.60 s, both
 *   inside the 5000-tick hold.
 */

const dt = TICK_S.value;
const KINDS = ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.gfci1p', 'breaker.afci1p'];
const ENTRIES = BUILTIN_CATALOG.devices.filter((d) => KINDS.includes(d.model.kind));
const ref = (d: DeviceDefinition) => ({ id: d.id, version: d.version });
const params = (d: DeviceDefinition): PlugOnBreakerParams => d.model.params as PlugOnBreakerParams;
const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

const thermalTripS = (p: PlugOnBreakerParams, amps: number) => {
  const a = (p.ultimateTripRatio * p.ratedCurrentA) / amps;
  return -p.thermalTimeConstantS * Math.log(1 - a * a);
};

/** The read thermal bands (s) by multiple of the rating, for 15–20 A and for 30–50 A. */
const BANDS_15_20: Record<number, [number, number]> = { 1.35: [30, 3600], 2: [10, 120], 5: [1, 15], 10: [0.45, 1.1] };
const BANDS_30_50: Record<number, [number, number]> = { 1.35: [45, 480], 2: [10, 60], 5: [1.3, 5] };

/** The instantaneous bands (A) each rating's entries carry, as sourced. */
const PICKUP_BANDS: Record<number, [number, number]> = {
  15: [240, 400],
  20: [240, 400],
  30: [300, 950],
  40: [300, 950],
  50: [350, 930],
};

/**
 * The read maximum-clearing times (s) of the 30–40 A and 50–70 A sheets at 15, 20 and 25 × (rounded up
 * a little from the log-axis readings, 300 dpi): each rating's own curve. `instantaneous` where the curve
 * has already fallen to its one-cycle floor (40 A from about 25 ×, 50 A from about 18.7 ×), where only
 * the magnetic element may clear: the multiple must be above the band's top.
 *
 * The bimetal law against them: 15 × 0.4181 s, 20 × 0.2348 s, 25 × 0.1502 s (−60 ln(1 − (1.25 / m)²)).
 * Where the law meets each curve sets the band's top: about 32.3 × (969 A) for 30 A, 23.8 × (953 A) for
 * 40 A and 18.7 × (935 A) for 50 A, rounded down to 950, 950 and 930 A.
 */
const MAX_CLEARING_S: Record<number, Record<number, number | 'instantaneous'>> = {
  30: { 15: 0.56, 20: 0.34, 25: 0.22 },
  40: { 15: 0.56, 20: 0.31, 25: 'instantaneous' },
  50: { 15: 0.63, 20: 'instantaneous', 25: 'instantaneous' },
};

/** A fault just above the rating's band (see the header). */
const faultOhms = (p: PlugOnBreakerParams) => (p.ratedCurrentA <= 20 ? 0.2 : 0.05);
/** A bolted fault (1 mΩ): several kA, where the bimetal law alone would cross in under 1 ms. */
const BOLTED_OHMS = 0.001;
/** Each fault and the least current (A) it must draw: above the band's top, and bolted above the service's 1.6 kA. */
const faults = (p: PlugOnBreakerParams): [string, number, number][] => [
  ['above the band', faultOhms(p), p.magneticPickupMaxA],
  ['bolted', BOLTED_OHMS, 4000],
];

const openingOf = (p: PlugOnBreakerParams, seed: number, id: number) =>
  Math.ceil(
    p.openingTimeMinMs +
      (p.openingTimeMaxMs - p.openingTimeMinMs) * deriveStream(seed, entityPurposeStreamKey(id, 'opening')).nextFloat(),
  );
const pickupOf = (p: PlugOnBreakerParams, seed: number, id: number) =>
  p.magneticPickupMinA +
  (p.magneticPickupMaxA - p.magneticPickupMinA) * deriveStream(seed, entityStreamKey(id)).nextFloat();

function partAmps(host: SourceHost, id: number, part: string): number {
  const branch = host.engine.netlist.branches.find(
    (b) => b.element.kind === 'entity' && b.element.entity === id && b.element.part === part,
  );
  if (branch === undefined) return 0;
  const s = host.engine.exportState().solution?.branches as number[];
  return Math.hypot(s[2 * branch.index], s[2 * branch.index + 1]);
}

function ticksToTrip(host: SourceHost, limit: number) {
  const start = host.engine.tick;
  const seen = host.events.length;
  host.advance(limit);
  const event = host.events.slice(seen).find((e) => e.kind === 'tripped');
  return { ticks: event === undefined ? -1 : event.tick - start, cause: event?.detail['cause'] };
}

/** The 25 kVA stand-in (1), the breaker `d` (2) and rheostats (3, and 4 for a second pole or a ground fault). */
function bench(d: DeviceDefinition, seed = 11): SourceHost {
  const host = new SourceHost(engineBus(seed));
  host.place(UTILITY_SPLIT);
  host.place(ref(d));
  host.place(RHEOSTAT);
  host.place(RHEOSTAT);
  const link = (a: number, ta: string, b: number, tb: string) =>
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  if (d.model.kind === 'breaker.plugOn2p') {
    link(1, 'l1', 2, 'line1');
    link(1, 'l2', 2, 'line2');
    link(2, 'load1', 3, 'a');
    link(3, 'b', 1, 'n');
    link(2, 'load2', 4, 'a');
    link(4, 'b', 1, 'n');
  } else if (d.model.kind === 'breaker.plugOn1p') {
    link(1, 'l1', 2, 'line');
    link(2, 'load', 3, 'a');
    link(3, 'b', 1, 'n');
    link(2, 'load', 4, 'a');
    link(4, 'b', 1, 'n');
  } else {
    link(1, 'l1', 2, 'line');
    link(2, 'pigtail', 1, 'n');
    link(2, 'load', 3, 'a');
    link(3, 'b', 2, 'loadNeutral');
    // Rheostat 4 from the load side's neutral to the source neutral: in parallel with the pigtail path,
    // a negligible share at 10 MΩ (no residual), a ground fault when lowered.
    link(2, 'load', 4, 'a');
    link(4, 'b', 1, 'n');
  }
  return host.operate(3, 'ohms', 1000).operate(4, 'ohms', 1e7).operate(2, 'on', true);
}

describe('the shipped plug-on breaker entries (P4 F4.2 part 2)', () => {
  it('are 15–50 A one- and two-pole, GFCI and AFCI 15 and 20 A, all Saltmere, all parsing as their kind', () => {
    expect(ENTRIES.map((d) => `${d.id}@${d.version} ${d.model.kind}`)).toStrictEqual([
      'breaker.saltmere-afci-15a@1 breaker.afci1p',
      'breaker.saltmere-afci-20a@1 breaker.afci1p',
      'breaker.saltmere-gfci-15a@1 breaker.gfci1p',
      'breaker.saltmere-gfci-20a@1 breaker.gfci1p',
      'breaker.saltmere-po1-15a@1 breaker.plugOn1p',
      'breaker.saltmere-po1-20a@1 breaker.plugOn1p',
      'breaker.saltmere-po1-30a@1 breaker.plugOn1p',
      'breaker.saltmere-po1-40a@1 breaker.plugOn1p',
      'breaker.saltmere-po1-50a@1 breaker.plugOn1p',
      'breaker.saltmere-po2-15a@1 breaker.plugOn2p',
      'breaker.saltmere-po2-20a@1 breaker.plugOn2p',
      'breaker.saltmere-po2-30a@1 breaker.plugOn2p',
      'breaker.saltmere-po2-40a@1 breaker.plugOn2p',
      'breaker.saltmere-po2-50a@1 breaker.plugOn2p',
    ]);
    for (const d of ENTRIES) {
      const schema = d.model.kind === 'breaker.gfci1p' ? GfciBreakerParamsSchema : PlugOnBreakerParamsSchema;
      expect(schema.safeParse(d.model.params).success, d.id).toBe(true);
      expect(d.brand).toBe('Saltmere');
    }
  });

  it('carry the sourced absolute pickup bands, the vetted 8–20 ms opening and the P2 bimetal law', () => {
    for (const d of ENTRIES) {
      const p = params(d);
      expect([d.id, p.magneticPickupMinA, p.magneticPickupMaxA]).toStrictEqual([
        d.id,
        ...PICKUP_BANDS[p.ratedCurrentA],
      ]);
      expect([p.openingTimeMinMs, p.openingTimeMaxMs, p.thermalTimeConstantS, p.ultimateTripRatio]).toStrictEqual([
        8, 20, 60, 1.25,
      ]);
      // Never a multiple of the rating's DIN band (8–12 ×): the band's bottom is above k_u I_n and,
      // for every rating, above 5 × (thermal at 500 %).
      expect(p.magneticPickupMinA).toBeGreaterThan(5 * p.ratedCurrentA);
    }
  });

  it('dissipate the anchored loss at their rating: I_n² × (pole + 0.1 mΩ stab jaw)', () => {
    const want: Record<number, number> = { 15: 2.0475, 20: 2.04, 30: 3.69, 40: 4.0, 50: 4.5 };
    for (const d of ENTRIES) {
      const p = params(d);
      const stab = d.mounts[0].contacts[0].contactOhm;
      expect(stab).toBe(0.0001);
      near(p.ratedCurrentA * p.ratedCurrentA * (p.contactResistanceOhm + stab), want[p.ratedCurrentA], 1e-9);
    }
  });

  it.each(ENTRIES.map((d) => [d.id, d] as const))(
    '%s trips thermally within 0.5 % of the law and inside its read bands (bank)',
    (_, d) => {
      const p = params(d);
      const bands = p.ratedCurrentA <= 20 ? BANDS_15_20 : BANDS_30_50;
      const model =
        d.model.kind === 'breaker.plugOn2p'
          ? PLUG_ON_2P_MODEL
          : d.model.kind === 'breaker.gfci1p'
            ? GFCI_BREAKER_MODEL
            : d.model.kind === 'breaker.afci1p'
              ? AFCI_BREAKER_MODEL
              : PLUG_ON_1P_MODEL;
      const parts = d.model.kind === 'breaker.plugOn2p' ? ['pole1', 'pole2'] : ['pole'];
      const sensing = d.model.kind === 'breaker.gfci1p' || d.model.kind === 'breaker.afci1p';
      for (const [k, [lo, hi]] of Object.entries(bands)) {
        const amps = Number(k) * p.ratedCurrentA;
        expect(amps).toBeLessThan(p.magneticPickupMinA);
        const rig = bankRig(model, d.model.params as Record<string, number>, sensing ? ['neutral', ...parts] : parts, {
          state: sensing ? { on: true, test: 0 } : { on: true },
        }).amps(parts[0], amps);
        // A GFCI's neutral returns the pole's current, so it senses no residual.
        if (d.model.kind === 'breaker.gfci1p') rig.amps('neutral', -amps);
        const ticks = rig.runToTrip(4_000_000);
        expect(rig.events.at(-1)?.cause, `${k}×`).toBe('thermal');
        near(ticks * dt, thermalTripS(p, amps), 0.005);
        expect(ticks * dt, `${k}×`).toBeGreaterThan(lo);
        expect(ticks * dt, `${k}×`).toBeLessThan(hi);
      }
    },
  );

  it('30–50 A: the bimetal law stays under each rating’s read maximum-clearing curve at 15, 20 and 25 × wherever it can act', () => {
    for (const d of ENTRIES.filter((x) => params(x).ratedCurrentA >= 30)) {
      const p = params(d);
      for (const [m, bound] of Object.entries(MAX_CLEARING_S[p.ratedCurrentA])) {
        const amps = Number(m) * p.ratedCurrentA;
        if (bound === 'instantaneous') {
          // Every drawn pickup is below this current, so the magnetic element always clears it.
          expect(amps, `${d.id} ${m}×`).toBeGreaterThan(p.magneticPickupMaxA);
        } else {
          expect(thermalTripS(p, amps), `${d.id} ${m}×`).toBeLessThan(bound);
        }
      }
      // At the band's top the law is still under the curve where the curve is read (30 A: 31.7 ×,
      // 0.0933 s, against the curve's ~0.10 s at 32 ×).
      if (p.ratedCurrentA === 30) expect(thermalTripS(p, p.magneticPickupMaxA)).toBeLessThan(0.1);
    }
  });

  it.each(ENTRIES.map((d) => [d.id, d] as const))(
    '%s at its band’s edges: 0.98 × the bottom never trips magnetically; between a drawn pickup and the top always does',
    (_, d) => {
      const p = params(d);
      const model =
        d.model.kind === 'breaker.plugOn2p'
          ? PLUG_ON_2P_MODEL
          : d.model.kind === 'breaker.gfci1p'
            ? GFCI_BREAKER_MODEL
            : d.model.kind === 'breaker.afci1p'
              ? AFCI_BREAKER_MODEL
              : PLUG_ON_1P_MODEL;
      const pole = d.model.kind === 'breaker.plugOn2p' ? 'pole1' : 'pole';
      const sensing = d.model.kind === 'breaker.gfci1p' || d.model.kind === 'breaker.afci1p';
      const parts = d.model.kind === 'breaker.plugOn2p' ? ['pole1', 'pole2'] : sensing ? ['neutral', 'pole'] : ['pole'];
      const rig = (seed: number, amps: number) => {
        const r = bankRig(model, d.model.params as Record<string, number>, parts, {
          seed,
          state: sensing ? { on: true, test: 0 } : { on: true },
        }).amps(pole, amps);
        return sensing ? r.amps('neutral', -amps) : r;
      };
      // Below the band: nothing within 100 ticks (the bimetal needs far longer: ≥ 0.38 s, 15 A at 0.98 × 240 A).
      const below = rig(11, 0.98 * p.magneticPickupMinA);
      expect(below.runToTrip(100)).toBe(-1);
      expect(below.bank.bag(0)['magneticSinceTick']).toBeNull();
      // A seed whose drawn pickup lies inside the band, and a current halfway from it to the top.
      const seed = [1, 2, 3, 5, 7, 11, 13].find((s) => {
        const pickup = pickupOf(p, s, 2);
        return pickup > p.magneticPickupMinA && pickup < p.magneticPickupMaxA - 10;
      }) as number;
      const pickup = pickupOf(p, seed, 2);
      const inside = rig(seed, (pickup + p.magneticPickupMaxA) / 2);
      expect(inside.runToTrip(100)).toBe(openingOf(p, seed, 2));
      expect(inside.events.at(-1)?.cause).toBe('magnetic');
    },
  );

  it.each(ENTRIES.filter((d) => d.model.kind === 'breaker.plugOn1p').map((d) => [d.id, d] as const))(
    '%s, a fault above its band and a bolted one on the bench: magnetic, opening 8–20 ms after the fault',
    (_, d) => {
      const p = params(d);
      for (const [label, ohms, least] of faults(p)) {
        const host = bench(d);
        host.advance(20);
        host.operate(3, 'ohms', ohms);
        expect(partAmps(host, 2, 'pole'), label).toBeGreaterThan(least);
        const { ticks, cause } = ticksToTrip(host, 100);
        expect(cause, label).toBe('magnetic');
        expect(ticks, label).toBe(openingOf(p, 11, 2));
        expect(ticks).toBeGreaterThanOrEqual(8);
        expect(ticks).toBeLessThanOrEqual(20);
        expect(partAmps(host, 2, 'pole')).toBe(0);
        expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'magnetic' });
      }
      // The pickup it drew is inside the entry's band.
      const pickup = pickupOf(p, 11, 2);
      expect(pickup).toBeGreaterThanOrEqual(p.magneticPickupMinA);
      expect(pickup).toBeLessThan(p.magneticPickupMaxA);
    },
  );

  it.each(ENTRIES.filter((d) => d.model.kind === 'breaker.plugOn2p').map((d) => [d.id, d] as const))(
    '%s: a fault above its band or a bolted one on its second pole opens both (a common trip, magnetic)',
    (_, d) => {
      const p = params(d);
      for (const [label, ohms, least] of faults(p)) {
        const host = bench(d);
        host.operate(3, 'ohms', 12);
        host.advance(20);
        near(partAmps(host, 2, 'pole1'), 10, 0.02);
        host.operate(4, 'ohms', ohms);
        expect(partAmps(host, 2, 'pole2'), label).toBeGreaterThan(least);
        const { ticks, cause } = ticksToTrip(host, 100);
        expect(cause, label).toBe('magnetic');
        expect(ticks, label).toBe(openingOf(p, 11, 2));
        expect(partAmps(host, 2, 'pole1')).toBe(0);
        expect(partAmps(host, 2, 'pole2')).toBe(0);
      }
    },
  );

  it.each(
    ENTRIES.filter((d) => d.model.kind === 'breaker.gfci1p' || d.model.kind === 'breaker.afci1p').map(
      (d) => [d.id, d] as const,
    ),
  )('%s, a bolted line-to-neutral fault on its load: magnetic at the drawn opening (no residual, no arc)', (_, d) => {
    const p = params(d);
    const host = bench(d);
    host.advance(20);
    host.operate(3, 'ohms', BOLTED_OHMS);
    expect(partAmps(host, 2, 'pole')).toBeGreaterThan(4000);
    const { ticks, cause } = ticksToTrip(host, 100);
    expect(cause).toBe('magnetic');
    expect(ticks).toBe(openingOf(p, 11, 2));
    expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'magnetic' });
  });

  it.each(ENTRIES.filter((d) => d.model.kind === 'breaker.gfci1p').map((d) => [d.id, d] as const))(
    '%s: its 15 kΩ test resistor trips it, cause test, about 3637 ticks after the press, inside the hold',
    (_, d) => {
      const p = d.model.params as GfciBreakerParams;
      expect(p.testResistanceOhm).toBe(15_000);
      expect([p.residualPickupMinA, p.residualPickupMaxA, p.mechanismTimeMinMs, p.mechanismTimeMaxMs]).toStrictEqual([
        0.004, 0.006, 3, 14,
      ]);
      const host = bench(d);
      host.operate(3, 'ohms', 12);
      host.advance(20);
      host.exec('device.press', { id: 2, control: 'test' });
      const { ticks, cause } = ticksToTrip(host, GFCI_TEST_HOLD_TICKS.value);
      expect(cause).toBe('test');
      expect(ticks).toBeGreaterThanOrEqual(3630);
      expect(ticks).toBeLessThanOrEqual(3645);
      expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'test', testHeldSinceTick: null });
    },
  );

  it.each(ENTRIES.filter((d) => d.model.kind === 'breaker.gfci1p').map((d) => [d.id, d] as const))(
    '%s: a 12 kΩ ground fault (≈ 10 mA) trips it as a ground fault inside the Class A limit (2.695 s)',
    (_, d) => {
      const host = bench(d);
      host.operate(3, 'ohms', 12);
      host.advance(20);
      host.operate(4, 'ohms', 12_000);
      const { ticks, cause } = ticksToTrip(host, 4000);
      expect(cause).toBe('groundFault');
      expect(ticks).toBeGreaterThan(0);
      expect(ticks * dt).toBeLessThanOrEqual(2.695 * 1.01);
    },
  );

  it.each(ENTRIES.filter((d) => d.model.kind === 'breaker.afci1p').map((d) => [d.id, d] as const))(
    '%s: closed and powered, its test button trips it at once, cause test',
    (_, d) => {
      const host = bench(d);
      host.operate(3, 'ohms', 12);
      host.advance(20);
      const seen = host.events.length;
      host.exec('device.press', { id: 2, control: 'test' });
      const event = host.events.slice(seen).find((e) => e.kind === 'tripped');
      expect(event?.detail['cause']).toBe('test');
      expect(event?.tick).toBe(host.engine.tick);
      expect(host.sim(2)).toMatchObject({ tripped: true, tripCause: 'test' });
    },
  );
});
