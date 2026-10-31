import { type AcSourceParams, BUILTIN_CATALOG, NEC_REGION, voltageBand } from '@controls/catalog';
import { BUSBAR, GENERATOR, RESISTOR_100, RESISTOR_12, ENGINE_TEST_CATALOG } from '../../../testing/engine';
import { SourceHost, UTILITY_208, UTILITY_480, UTILITY_SPLIT } from '../../../testing/sources';
import type { NetlistBranch } from '../../netlist/types';
import {
  boltedFaultCurrentA,
  GENERATOR_STUB_NAMEPLATE,
  ratedImpedance,
  splitPhaseWinding,
  threePhaseLineToLineV,
  threePhaseWinding,
  UTILITY_SPLIT_PHASE_MODEL,
} from './ac-source';
import { AcBranchValues } from '../../mna/ac-values';
import { deriveStream } from '@controls/world-model';

/*
 * The utility services and the generator stub (plan F2.4), headless: phasor sources behind an
 * impedance derived from kVA and %Z, at 60 Hz.
 *
 * Hand calculations (Z_base = V_LL² / S, |Z| = %Z · Z_base, R = |Z| / √(1 + (X/R)²), X = R · X/R):
 *
 * - split-phase 25 kVA, 2 %, X/R 2, 240 V: Z_base = 2.304 Ω, |Z| = 46.08 mΩ (the full winding),
 *   R = 20.6076 mΩ, X = 41.2152 mΩ; each half 10.3038 + j20.6076 mΩ. Bolted L1–L2: 240 / 0.04608 = 5208.3 A;
 * - 208Y/120, 150 kVA, 4 %, X/R 3: V_LL = 120 √3 = 207.846 V, Z_base = 0.288 Ω, |Z| = 11.52 mΩ per
 *   phase. Bolted three-phase: 120 / 0.01152 = 10 416.7 A;
 * - 480Y/277, 1000 kVA, 5.75 %, X/R 6: V_LL = 277 √3 = 479.778 V, Z_base = 0.230187 Ω,
 *   |Z| = 13.23575 mΩ. Bolted three-phase: 277 / 0.01323575 = 20 928 A;
 * - the generator stub, 7.5 kVA, 15 %, X/R 5, 240 V: Z_base = 7.68 Ω, |Z| = 1.152 Ω. Bolted L1–L2:
 *   240 / 1.152 = 208.3 A.
 *
 * A bolted fault is made with the test busbar link (1 mm of 1000 mm² copper, 17 nΩ, no contact
 * resistance), which moves the current by about 1e-6 of it, far inside 0.5 %.
 */

const params = (ref: { id: string; version: number }) =>
  ENGINE_TEST_CATALOG.device(ref)?.model.params as AcSourceParams;

/** A phasor's magnitude. */
const mag = (re: number, im: number) => Math.sqrt(re * re + im * im);

/** The phasor current of the branch `pick` chooses, from the solution record. */
function current(host: SourceHost, pick: (b: NetlistBranch) => boolean): [number, number] {
  const branch = host.engine.netlist.branches.find(pick);
  if (branch === undefined) throw new Error('no such branch');
  const s = host.engine.exportState().solution?.branches as number[];
  return [s[2 * branch.index], s[2 * branch.index + 1]];
}
const winding = (entity: number, part: string) => (b: NetlistBranch) =>
  b.element.kind === 'entity' && b.element.entity === entity && b.element.part === part;
const connection = (id: number) => (b: NetlistBranch) => b.element.kind === 'connection' && b.element.connection === id;

/** The RMS voltage between two terminals of an AC island. */
function rms(host: SourceHost, a: [number, string], b: [number, string]): number {
  const reading = host.engine.probe({ entity: a[0], terminal: a[1] }, { entity: b[0], terminal: b[1] });
  if (reading.kind !== 'ac') throw new Error(`expected an AC reading, got ${reading.kind}`);
  return reading.rmsVolts;
}

describe('AC source impedance from kVA and %Z (hand calculations)', () => {
  it('the split-phase service: 46.08 mΩ full winding at X/R 2, half to each line', () => {
    const p = params(UTILITY_SPLIT);
    expect(p).toStrictEqual({ ratedKva: 25, percentImpedance: 2, xOverR: 2, lineToNeutralV: 120 });
    const z = ratedImpedance(p, 240);
    expect(z.z).toBeCloseTo(0.04608, 12);
    expect(z.r).toBeCloseTo(0.0206076, 7);
    expect(z.x).toBeCloseTo(0.0412152, 7);
    const half = splitPhaseWinding(p, 60);
    expect(half.ohms).toBeCloseTo(z.r / 2, 15);
    expect(half.henries * 2 * Math.PI * 60).toBeCloseTo(z.x / 2, 15);
    expect(half.magnitudeOhm).toBeCloseTo(0.02304, 12);
    expect(boltedFaultCurrentA(p, 1)).toBeCloseTo(5208.333, 3);
  });

  it('three-phase services: per-phase impedance on the √3 V_LN base, never the 208 or 480 name', () => {
    const p208 = params(UTILITY_208);
    const p480 = params(UTILITY_480);
    expect(threePhaseLineToLineV(p208)).toBe(Math.sqrt(3) * 120);
    expect(threePhaseLineToLineV(p208)).toBeCloseTo(207.846, 3);
    expect(threePhaseLineToLineV(p480)).toBeCloseTo(479.778, 3);
    expect(threePhaseWinding(p208, 60).magnitudeOhm).toBeCloseTo(0.01152, 12);
    expect(threePhaseWinding(p480, 60).magnitudeOhm).toBeCloseTo(0.01323575, 8);
    expect(boltedFaultCurrentA(p208, 3)).toBeCloseTo(10416.667, 3);
    expect(boltedFaultCurrentA(p480, 3)).toBeCloseTo(20928, 0);
  });

  it('the generator stub has its sourced nameplate: 7.5 kVA, 120/240 V, 15 %, X/R 5', () => {
    expect(params(GENERATOR)).toStrictEqual({ ratedKva: 7.5, lineToNeutralV: 120, percentImpedance: 15, xOverR: 5 });
    for (const constant of Object.values(GENERATOR_STUB_NAMEPLATE)) expect(constant.source.length).toBeGreaterThan(40);
    expect(boltedFaultCurrentA(params(GENERATOR), 1)).toBeCloseTo(208.333, 3);
    // Not placeable: no built-in catalogue entry has the stub's kind.
    expect(BUILTIN_CATALOG.devices.some((d) => d.model.kind === 'generator.portable')).toBe(false);
  });
});

describe('the region frequency reaches the bank (SimDevice.frequencyHz)', () => {
  it('at 50 Hz a winding gets L = X / (2π · 50), so ωL is the rated X / 2 again', () => {
    const p = params(UTILITY_SPLIT);
    const { x } = ratedImpedance(p, 240);
    const bank = UTILITY_SPLIT_PHASE_MODEL.bank([
      { entity: 1, params: p, bag: {}, branches: [0, 1], frequencyHz: 50, stream: () => deriveStream(0, 'x') },
    ]);
    const values = new AcBranchValues(2);
    const branch = (index: number, part: string): NetlistBranch => ({
      index,
      element: { kind: 'entity', entity: 1, part },
      kind: 'vsource',
      model: 'utility.splitPhase',
      source: 'ac',
      a: 0,
      b: index + 1,
      island: 0,
      values: {},
    });
    expect(bank.acValue?.(0, branch(0, 'l1'), values)).toBe(true);
    expect(bank.acValue?.(0, branch(1, 'l2'), values)).toBe(true);
    for (const b of [0, 1]) expect(values.seriesHenries[b] * 2 * Math.PI * 50).toBeCloseTo(x / 2, 15);
    expect(values.seriesHenries[0]).toBeCloseTo(splitPhaseWinding(p, 60).henries * (60 / 50), 15);
    expect([values.emfRe[1], values.emfIm[1]]).toStrictEqual([-120, 0]); // L2 at 180°
  });
});

describe('the split-phase service in the engine', () => {
  it('has L1, L2 and N as separate nodes: 120 V each to N, 180° apart, 240 V across the lines', () => {
    const host = new SourceHost();
    host.place(UTILITY_SPLIT);
    const nodes = new Set(
      ['l1', 'l2', 'n'].map(
        (t) => host.engine.netlist.nodes.find((n) => n.members.some((m) => m.terminal === t))?.index,
      ),
    );
    expect(nodes.size).toBe(3);
    expect(host.engine.islands()[0]).toMatchObject({ kind: 'ac', status: 'solved' });
    expect(rms(host, [1, 'l1'], [1, 'n'])).toBeCloseTo(120, 9);
    expect(rms(host, [1, 'l2'], [1, 'n'])).toBeCloseTo(120, 9);
    expect(rms(host, [1, 'l1'], [1, 'l2'])).toBeCloseTo(240, 9);
  });

  it('a bolted L1–L2 fault draws V / |Z| within 0.5 % (5.2 kA)', () => {
    const host = new SourceHost();
    host.place(UTILITY_SPLIT);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l1' }, b: { entity: 1, terminal: 'l2' } });
    const i = current(host, connection(1));
    const expected = boltedFaultCurrentA(params(UTILITY_SPLIT), 1);
    expect(Math.abs(mag(...i) / expected - 1)).toBeLessThan(0.005);
    expect(Math.abs(mag(...i) / expected - 1)).toBeLessThan(1e-5); // the busbar's 17 nΩ is all that differs
    // The current lags: the fault current's angle is the impedance's, X/R = 2 (tan φ = 2).
    expect(-i[1] / i[0]).toBeCloseTo(2, 4);
  });

  it('an unbalanced load: the neutral carries the phasor sum of the line currents', () => {
    // 12 Ω from L1 to N and 100 Ω from L2 to N: 10 A and 1.2 A, opposite in phase, so N carries the
    // difference, about 8.8 A.
    const host = new SourceHost();
    host.place(UTILITY_SPLIT);
    host.place(RESISTOR_12);
    host.place(RESISTOR_100);
    host.lead(1, 'l1', 2, 'a').lead(1, 'l2', 3, 'a');
    host.lead(2, 'b', 3, 'b'); // a common neutral bar at the loads
    host.lead(3, 'b', 1, 'n'); // the neutral back to the service
    const i1 = current(host, winding(1, 'l1'));
    const i2 = current(host, winding(1, 'l2'));
    const neutral = current(host, connection(4));
    // KCL at N: the neutral lead returns what the two windings send out.
    expect(neutral[0]).toBeCloseTo(i1[0] + i2[0], 9);
    expect(neutral[1]).toBeCloseTo(i1[1] + i2[1], 9);
    expect(mag(...neutral)).toBeGreaterThan(8.5);
    expect(mag(...neutral)).toBeLessThan(9);
  });

  it('under a 10 A load the service voltage stays inside ANSI C84.1 Range A', () => {
    const host = new SourceHost();
    host.place(UTILITY_SPLIT);
    host.place(RESISTOR_12);
    host.lead(1, 'l1', 2, 'a').lead(2, 'b', 1, 'n');
    const [low, high] = voltageBand(NEC_REGION.voltageRanges.serviceA, 120);
    const v = rms(host, [1, 'l1'], [1, 'n']);
    expect(v).toBeLessThan(120);
    expect(v).toBeGreaterThan(low);
    expect(v).toBeLessThan(high);
  });

  it('the generator stub behaves as a split-phase source behind its nameplate impedance (208 A bolted)', () => {
    const host = new SourceHost();
    host.place(GENERATOR);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l1' }, b: { entity: 1, terminal: 'l2' } });
    expect(Math.abs(mag(...current(host, connection(1))) / 208.3333 - 1)).toBeLessThan(0.005);
  });
});

describe('the three-phase services in the engine', () => {
  it.each([
    [UTILITY_208, 120],
    [UTILITY_480, 277],
  ])('%o: line-to-line is √3 × line-to-neutral (by sqrt), every pair', (ref, vln) => {
    const host = new SourceHost();
    host.place(ref);
    for (const line of ['l1', 'l2', 'l3']) expect(rms(host, [1, line], [1, 'n'])).toBeCloseTo(vln, 9);
    // Phase sequence L1, L2, L3: L2 lags L1 by 120° (−120°), L3 leads it (+120°), from exact constants.
    const phasor = (line: string) => {
      const r = host.engine.probe({ entity: 1, terminal: line }, { entity: 1, terminal: 'n' });
      return r.kind === 'ac' ? [r.re, r.im] : [NaN, NaN];
    };
    const near = ([re, im]: number[], [wr, wi]: number[]) => Math.abs(re - wr) + Math.abs(im - wi) < 1e-9;
    expect(near(phasor('l1'), [vln, 0])).toBe(true);
    expect(near(phasor('l2'), [-vln / 2, -vln * (Math.sqrt(3) / 2)])).toBe(true);
    expect(near(phasor('l3'), [-vln / 2, vln * (Math.sqrt(3) / 2)])).toBe(true);
    for (const [a, b] of [
      ['l1', 'l2'],
      ['l2', 'l3'],
      ['l3', 'l1'],
    ]) {
      const ll = rms(host, [1, a], [1, b]);
      expect(Math.abs(ll / (Math.sqrt(3) * rms(host, [1, a], [1, 'n'])) - 1)).toBeLessThan(1e-12);
    }
  });

  it.each([
    [UTILITY_208, 10416.667],
    [UTILITY_480, 20928],
  ])('%o: a bolted three-phase fault draws V_LN / |Z| within 0.5 %', (ref, expected) => {
    const host = new SourceHost();
    host.place(ref);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l1' }, b: { entity: 1, terminal: 'l2' } });
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l2' }, b: { entity: 1, terminal: 'l3' } });
    for (const line of ['l1', 'l2', 'l3']) {
      expect(Math.abs(mag(...current(host, winding(1, line))) / expected - 1)).toBeLessThan(0.005);
    }
  });

  it('a balanced wye load: the neutral current is about 0', () => {
    // 12 Ω from each line to a star point joined by busbar links, the star point to N: 10 A per phase,
    // 120° apart, so N carries their phasor sum, 0 but for the leads' and links' rounding.
    const host = new SourceHost();
    host.place(UTILITY_208);
    for (let k = 0; k < 3; k++) host.place(RESISTOR_12);
    host.lead(1, 'l1', 2, 'a').lead(1, 'l2', 3, 'a').lead(1, 'l3', 4, 'a');
    const busbar = (a: number, ta: string, b: number, tb: string) =>
      host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
    busbar(2, 'b', 3, 'b');
    busbar(3, 'b', 4, 'b');
    busbar(4, 'b', 1, 'n');
    const phase = mag(...current(host, winding(1, 'l1')));
    expect(phase).toBeGreaterThan(9.9);
    expect(phase).toBeLessThan(10);
    const neutral = mag(...current(host, connection(6)));
    // The star links (17 nΩ against 12 Ω) unbalance the phases by about 1e-9.
    expect(neutral).toBeLessThan(1e-6 * phase);
  });
});
