import type { DimmerParams } from '@controls/catalog';
import { AC_SOURCE, end } from '../../../testing/bench';
import { AC_SOURCE_OHMS, BUSBAR, ENGINE_TEST_CATALOG, RESISTOR_100 } from '../../../testing/engine';
import { A19_60W, acSourceAt, DIMMER, socket } from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import { AcBranchValues } from '../../mna/ac-values';
import type { NetlistBranch } from '../../netlist/types';
import { DEVICE_NETLIST_MODELS } from '../../netlist/models';
import {
  DIMMER_DC_ON_OHM,
  DIMMER_FIRING_ANGLE_MAX_DEG,
  DIMMER_FIRING_ANGLE_MIN_DEG,
  DIMMER_RMS_CURVE,
} from './constants';
import { DIMMER_MODEL, dimmerReactanceRatio, dimmerRmsFraction } from './dimmer';

/*
 * The dimmer's goldens (plan F4.1 part 1, D10): "the dimmer's RMS fraction at 0.25, 0.5 and 0.75 against
 * its tabulated curve within 0.5 %, its own dissipation exactly 0".
 *
 * Hand calculation. The curve's points are the RMS of a forward-phase-cut sine,
 * f(α) = √(1 − α/π + sin 2α / (2π)), at α = 150° − 120° · level:
 *
 * - level 0.25: α = 120°, f = √(1 − 2/3 + sin 240° / (2π)) = √(0.333333 − 0.137832) = 0.442155;
 * - level 0.5:  α = 90°,  f = √(1 − 1/2 + 0) = 0.707107;
 * - level 0.75: α = 60°,  f = √(1 − 1/3 + sin 120° / (2π)) = √(0.666667 + 0.137832) = 0.896939.
 *
 * The bench: two copies of one circuit on two 120 V test sources (0.1 Ω each), a 100 Ω test resistor
 * across each through 17 nΩ busbar links, one of them through the dimmer. Undimmed, the resistor sees
 * 120 · 100 / 100.1 = 119.880 V; dimmed, the model chooses X = c · R_th with c = √(1/k² − 1) and
 * R_th = 100.1 Ω (plus the links), so it sees k · 119.880 V:
 *
 * - 0.25: c = 2.028561, X = 203.059 Ω, V_R = 53.006 V;
 * - 0.5:  c = 1,        X = 100.100 Ω, V_R = 84.768 V;
 * - 0.75: c = 0.492960, X = 49.345 Ω,  V_R = 107.525 V.
 *
 * Its dissipation is exactly 0: its stamp is an inductor (no resistance), so P = I² · 0.
 */

const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** Two circuits: source 1 → dimmer 2 → resistor 3 → source 1; source 4 → resistor 5 → source 4. */
function bench(source: { id: string; version: number } = AC_SOURCE): {
  host: SourceHost;
  dimmer: number;
  dimmed: number;
  plain: number;
} {
  const host = new SourceHost();
  const s1 = host.place(source);
  const dimmer = host.place(DIMMER);
  const dimmed = host.place(RESISTOR_100);
  const s2 = host.place(source);
  const plain = host.place(RESISTOR_100);
  const bar = (a: number, ta: string, b: number, tb: string) =>
    host.exec('lead.connect', { ref: BUSBAR, a: end(a, ta), b: end(b, tb) });
  bar(s1, 'l', dimmer, 'line');
  bar(dimmer, 'load', dimmed, 'a');
  bar(dimmed, 'b', s1, 'n');
  bar(s2, 'l', plain, 'a');
  bar(plain, 'b', s2, 'n');
  host.operate(dimmer, 'on', true);
  return { host, dimmer, dimmed, plain };
}

/** The RMS voltage across `entity`'s `a`–`b` (an AC probe). */
function rms(host: SourceHost, entity: number, a = 'a', b = 'b'): number {
  const reading = host.engine.probe(end(entity, a), end(entity, b));
  if (reading.kind !== 'ac') throw new Error(`expected an AC reading, got ${reading.kind}`);
  return reading.rmsVolts;
}

/** The phasor V(line) − V(load) across the dimmer and its current, and the island's last iterations. */
function dimmerPhasors(host: SourceHost, dimmer: number) {
  const reading = host.engine.probe(end(dimmer, 'line'), end(dimmer, 'load'));
  if (reading.kind !== 'ac') throw new Error('expected an AC reading');
  const branch = host.engine.netlist.branches.find(
    (b) => b.element.kind === 'entity' && b.element.entity === dimmer,
  ) as NetlistBranch;
  const solution = host.engine.exportState().solution as { branches: number[] };
  return {
    vRe: reading.re,
    vIm: reading.im,
    iRe: solution.branches[2 * branch.index],
    iIm: solution.branches[2 * branch.index + 1],
    iterations: host.engine.islands().find((island) => island.index === branch.island)?.iterations ?? 0,
  };
}

describe('the dimmer curve (D10)', () => {
  it('each tabulated point is the RMS of the phase-cut sine at its firing angle (recomputed with Math.sin)', () => {
    const fractions = DIMMER_RMS_CURVE.fractions;
    expect(fractions).toHaveLength(DIMMER_RMS_CURVE.levels + 1);
    for (let i = 0; i <= DIMMER_RMS_CURVE.levels; i++) {
      const level = i / DIMMER_RMS_CURVE.levels;
      const degrees =
        DIMMER_FIRING_ANGLE_MAX_DEG.value -
        (DIMMER_FIRING_ANGLE_MAX_DEG.value - DIMMER_FIRING_ANGLE_MIN_DEG.value) * level;
      const alpha = (degrees * Math.PI) / 180;
      const exact = Math.sqrt(1 - alpha / Math.PI + Math.sin(2 * alpha) / (2 * Math.PI));
      expect(Math.abs(fractions[i] - exact)).toBeLessThan(5e-10);
      expect(dimmerRmsFraction(level)).toBe(fractions[i]);
    }
    // Monotone, and inside (0, 1): the reactance ratio is finite and positive at every level.
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    expect(dimmerReactanceRatio(1)).toBeGreaterThan(0);
    expect(Number.isFinite(dimmerReactanceRatio(0))).toBe(true);
  });

  it('the hand values at 0.25, 0.5 and 0.75; linear between points and clamped outside 0–1', () => {
    expect(rel(dimmerRmsFraction(0.25), 0.442155)).toBeLessThan(1e-6);
    expect(rel(dimmerRmsFraction(0.5), 0.707107)).toBeLessThan(1e-6);
    expect(rel(dimmerRmsFraction(0.75), 0.896939)).toBeLessThan(1e-6);
    expect(rel(dimmerReactanceRatio(0.25), 2.028561)).toBeLessThan(1e-6);
    expect(rel(dimmerReactanceRatio(0.5), 1)).toBeLessThan(1e-9);
    expect(rel(dimmerReactanceRatio(0.75), 0.49296)).toBeLessThan(1e-5);
    const mid = (DIMMER_RMS_CURVE.fractions[10] + DIMMER_RMS_CURVE.fractions[11]) / 2;
    expect(rel(dimmerRmsFraction(0.525), mid)).toBeLessThan(1e-12);
    expect(dimmerRmsFraction(-1)).toBe(DIMMER_RMS_CURVE.fractions[0]);
    expect(dimmerRmsFraction(2)).toBe(DIMMER_RMS_CURVE.fractions[20]);
  });
});

describe('the dimmer on a bench circuit (F4.1 part 1 golden)', () => {
  it.each([
    [0.25, 53.006],
    [0.5, 84.768],
    [0.75, 107.525],
  ])('at level %s the load sees its curve’s RMS fraction within 0.5 % (hand: %s V)', (level, handVolts) => {
    const { host, dimmer, dimmed, plain } = bench();
    host.operate(dimmer, 'level', level).advance(25);
    const undimmed = rms(host, plain);
    expect(rel(undimmed, (120 * 100) / (100 + AC_SOURCE_OHMS))).toBeLessThan(1e-6);
    const fraction = rms(host, dimmed) / undimmed;
    expect(rel(fraction, dimmerRmsFraction(level))).toBeLessThan(0.005);
    // In fact far inside: the fit is exact for a resistive circuit, up to its tolerance (0.1 % of X,
    // at most 0.1 % × (1 − k²) of the fraction).
    expect(rel(fraction, dimmerRmsFraction(level))).toBeLessThan(1e-3);
    expect(rel(rms(host, dimmed), handVolts)).toBeLessThan(1e-3);
  });

  it('dissipates exactly nothing: an inductor stamp, and P = Re(V · conj(I)) at rounding level', () => {
    const { host, dimmer } = bench();
    host.operate(dimmer, 'level', 0.5).advance(25);
    const { vRe, vIm, iRe, iIm } = dimmerPhasors(host, dimmer);
    const p = vRe * iRe + vIm * iIm;
    const s = Math.sqrt((vRe * vRe + vIm * vIm) * (iRe * iRe + iIm * iIm));
    expect(s).toBeGreaterThan(50);
    expect(Math.abs(p) / s).toBeLessThan(1e-9);
    // The model's own stamp, through a hand-built bank: an inductor, so its resistance is exactly 0.
    const bank = DIMMER_MODEL.bank([
      {
        entity: 2,
        params: { ratedVoltageV: 120, ratedPowerW: 600 } satisfies DimmerParams,
        bag: {},
        state: { on: true, level: 0.5 },
        branches: [0],
        frequencyHz: 60,
        stream: () => {
          throw new Error('the dimmer draws nothing');
        },
      } as never,
    ]);
    const values = new AcBranchValues(1);
    const branch = { index: 0, island: 0, a: 0, b: 1, values: { level: 0.5 } } as unknown as NetlistBranch;
    bank.acIterate?.(0, branch, null, values, 0);
    expect(values.stamp(0)).toBe('inductor');
    expect(values.henries[0]).toBeGreaterThan(0);
  });

  it('settles in two phasor solves on a steady circuit, at most three from a cold start; a level change is a value change', () => {
    const { host, dimmer } = bench();
    // The `on` command was a topology change: a cold start (near short, then the rated-voltage guess,
    // then the fit). Here the guess is already the fit (the source is the dimmer's rated 120 V), so two.
    expect(dimmerPhasors(host, dimmer).iterations).toBeLessThanOrEqual(3);
    host.advance(25);
    expect(dimmerPhasors(host, dimmer).iterations).toBe(2);
    const hash = host.engine.netlist.topologyHash;
    const tick = host.engine.tick;
    host.operate(dimmer, 'level', 0.3);
    expect(host.engine.netlist.topologyHash).toBe(hash);
    expect(host.engine.lastSolveTick).toBe(tick);
  });

  it('from a cold start on a supply that isn’t its rated voltage: guess, fit, check (three solves), on the curve', () => {
    const { host, dimmer, dimmed, plain } = bench(acSourceAt(100));
    host.operate(dimmer, 'level', 0.25);
    // A level change is a value change, so the warm start is kept, but it was fitted for level 1: the
    // probe, the fit, then the check.
    expect(dimmerPhasors(host, dimmer).iterations).toBe(3);
    host.advance(20);
    expect(dimmerPhasors(host, dimmer).iterations).toBe(2);
    host.exec('lead.disconnect', { id: 1 });
    host.exec('edit.undo', {});
    // Reconnected: a structural change, so no warm start.
    expect(dimmerPhasors(host, dimmer).iterations).toBe(3);
    expect(rel(rms(host, dimmed) / rms(host, plain), dimmerRmsFraction(0.25))).toBeLessThan(1e-3);
  });

  it('two dimmers in series at 0.5 give about 0.707 together, not 0.5 (an abstraction, ADR 0021 L2), and stay readable', () => {
    const host = new SourceHost();
    const s1 = host.place(AC_SOURCE);
    const d1 = host.place(DIMMER);
    const d2 = host.place(DIMMER);
    const dimmed = host.place(RESISTOR_100);
    const s2 = host.place(AC_SOURCE);
    const plain = host.place(RESISTOR_100);
    const bar = (a: number, ta: string, b: number, tb: string) =>
      host.exec('lead.connect', { ref: BUSBAR, a: end(a, ta), b: end(b, tb) });
    bar(s1, 'l', d1, 'line');
    bar(d1, 'load', d2, 'line');
    bar(d2, 'load', dimmed, 'a');
    bar(dimmed, 'b', s1, 'n');
    bar(s2, 'l', plain, 'a');
    bar(plain, 'b', s2, 'n');
    host.operate(d1, 'on', true).operate(d1, 'level', 0.5).operate(d2, 'on', true).operate(d2, 'level', 0.5);
    const fractions: number[] = [];
    for (let t = 0; t < 20; t++) {
      host.advance(10);
      expect(host.engine.islands().every((i) => i.status === 'solved')).toBe(true);
      fractions.push(rms(host, dimmed) / rms(host, plain));
    }
    for (const f of fractions.slice(5)) expect(Math.abs(f - Math.SQRT1_2)).toBeLessThan(0.01);
    expect(Math.max(...fractions.slice(5)) - Math.min(...fractions.slice(5))).toBeLessThan(1e-3);
  });

  it('off opens the circuit; on with no load draws nothing and keeps any reactance', () => {
    const { host, dimmer, dimmed } = bench();
    host.operate(dimmer, 'level', 0.5).advance(10);
    host.operate(dimmer, 'on', false);
    expect(host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === dimmer)).toBe(
      false,
    );
    expect(rms(host, dimmed)).toBeLessThan(1e-6);
    // On again with the resistor's return lead removed: no current, so nothing to fit.
    host.operate(dimmer, 'on', true);
    host.exec('lead.disconnect', { id: 3 });
    host.advance(20);
    const { iRe, iIm } = dimmerPhasors(host, dimmer);
    expect(Math.sqrt(iRe * iRe + iIm * iIm)).toBeLessThan(1e-6);
  });

  it('dims an incandescent lamp: the lamp sees k of the voltage it would see undimmed at its own resistance', () => {
    const host = new SourceHost();
    const source = host.place(AC_SOURCE);
    const dimmer = host.place(DIMMER);
    const { holder, bulb } = socket(host, A19_60W);
    const bar = (a: number, ta: string, b: number, tb: string) =>
      host.exec('lead.connect', { ref: BUSBAR, a: end(a, ta), b: end(b, tb) });
    bar(source, 'l', dimmer, 'line');
    bar(dimmer, 'load', holder, 'hot');
    bar(holder, 'neutral', source, 'n');
    host.operate(dimmer, 'on', true).operate(dimmer, 'level', 0.5).advance(1000);
    const record = host.record(bulb);
    const r = record['resistanceOhm'] as number;
    // R_th: the source's 0.1 Ω and the two E26 contacts (2 mΩ each); the busbars are 17 nΩ.
    const undimmed = (120 * r) / (r + AC_SOURCE_OHMS + 0.004);
    expect(rel(record['voltageV'] as number, dimmerRmsFraction(0.5) * undimmed)).toBeLessThan(0.005);
    // A dimmed filament runs cooler, so its resistance is well below the 240 Ω it has at 120 V.
    expect(r).toBeLessThan(220);
    expect(record['lightOutputRel']).toBeLessThan(0.5);
  });

  it('on a DC island its triac latches on: a small resistance; off it is open', () => {
    const top = (on: boolean) =>
      DEVICE_NETLIST_MODELS['dimmer.wall'].topology({ params: {}, state: { on, level: 0.4 }, sim: {} });
    expect(top(true).elements.map((e) => [e.part, e.a, e.b, e.values])).toStrictEqual([
      ['phaseControl', 'line', 'load', { level: 0.4 }],
    ]);
    expect(top(false).elements).toStrictEqual([]);
    expect(DEVICE_NETLIST_MODELS['dimmer.wall'].wiringPath).toBe(true);
    const bank = DIMMER_MODEL.bank([
      {
        entity: 1,
        params: { ratedVoltageV: 120, ratedPowerW: 600 },
        bag: {},
        state: {},
        branches: [0],
        frequencyHz: 60,
        stream: () => {
          throw new Error('unused');
        },
      } as never,
    ]);
    let stamped = 0;
    const dc = {
      resistorAt: (_b: number, ohms: Float64Array, i: number) => (stamped = ohms[i]),
    } as never as Parameters<NonNullable<typeof bank.dcValue>>[2];
    expect(bank.dcValue?.(0, { index: 0 } as NetlistBranch, dc)).toBe(true);
    expect(stamped).toBe(DIMMER_DC_ON_OHM.value);
    expect(ENGINE_TEST_CATALOG.kindOf(DIMMER)?.kind).toBe('dimmer.wall');
  });
});
