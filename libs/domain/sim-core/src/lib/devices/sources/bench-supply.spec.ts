import { BUILTIN_CATALOG, type BenchSupplyParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import fc from 'fast-check';
import { FLIP, RESISTOR_12, RHEOSTAT, THERMAL_LOAD } from '../../../testing/engine';
import { BENCH_SUPPLY, SourceHost } from '../../../testing/sources';
import { BENCH_SUPPLY_OUTPUT } from './bench-supply';
import {
  currentBand,
  CV_CC_HYSTERESIS,
  CV_CC_HYSTERESIS_AMPS,
  CV_CC_HYSTERESIS_VOLTS,
  REG_CC,
  REG_CV,
  regulate,
  voltageBand,
} from './regulator';

/*
 * The bench DC supply (plan F2.4): CV behind its output resistance, CC at the limit, the crossover at
 * R = V / I within 0.5 %, never past either setpoint beyond the hysteresis band, no mode chatter.
 *
 * The catalogue supply (supply.brindlecore-bench-30v-5a): R_out = 1 mΩ. Each circuit is the supply
 * (1) into a load (2) through two 1 m leads of R_L = 0.040948155 Ω each.
 */

const params = BUILTIN_CATALOG.device(BENCH_SUPPLY)?.model.params as BenchSupplyParams;
const R_OUT = params.outputResistanceOhm;
const R_LEAD = 0.040948155;
const h = CV_CC_HYSTERESIS.value;

/** The supply (1) into a load (2) through two leads, set to `setpointV` and `limitA`, output on. */
function loop(load: { id: string; version: number }, setpointV: number, limitA: number, on = true): SourceHost {
  const host = new SourceHost();
  const supply = host.place(BENCH_SUPPLY);
  const device = host.place(load);
  host.lead(supply, 'pos', device, 'a').lead(device, 'b', supply, 'neg');
  host.operate(supply, 'setpointV', setpointV).operate(supply, 'currentLimitA', limitA);
  if (on) host.operate(supply, 'outputOn', true);
  return host;
}

/** The supply into the rheostat, which is set to `ohms` before the output goes on. */
function rheostatLoop(setpointV: number, limitA: number, ohms: number): SourceHost {
  const host = new SourceHost();
  host.place(BENCH_SUPPLY);
  host.place(RHEOSTAT);
  host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
  host.operate(2, 'ohms', ohms);
  host.operate(1, 'setpointV', setpointV).operate(1, 'currentLimitA', limitA).operate(1, 'outputOn', true);
  return host;
}

const mode = (host: SourceHost) => host.record(1)['mode'];

describe('regulate: the CV/CC decision with hysteresis', () => {
  it('leaves CV only above the limit plus its band, and CC only above the knee plus its band', () => {
    expect(params).toStrictEqual({ maxVoltageV: 30, maxCurrentA: 5, outputResistanceOhm: 0.001 });
    expect(currentBand(2)).toBe(h * 2 + CV_CC_HYSTERESIS_AMPS.value);
    expect(voltageBand(12)).toBe(h * 12 + CV_CC_HYSTERESIS_VOLTS.value);
    // CV at 12 V, 2 A limit: CC only past 2.002001 A.
    expect(regulate(REG_CV, 2.002, 11.99, 12, 2, R_OUT)).toBe(REG_CV);
    expect(regulate(REG_CV, 2.0021, 11.99, 12, 2, R_OUT)).toBe(REG_CC);
    // CC: the knee is 12 − 2 × 0.001 = 11.998 V; CV only past 11.998 + 0.012001 V.
    expect(regulate(REG_CC, 2, 12.0, 12, 2, R_OUT)).toBe(REG_CC);
    expect(regulate(REG_CC, 2, 12.0101, 12, 2, R_OUT)).toBe(REG_CV);
  });
});

describe('the bench supply (golden)', () => {
  it('in CV, holds the setpoint behind its output resistance: 12 V into 12 Ω', () => {
    // I = 12 / (0.001 + 12 + 0.08189631) = 12 / 12.08289631 = 0.993139 A; V = 12 − 0.001 I = 11.999007 V.
    const host = loop(RESISTOR_12, 12, 2);
    const I = 12 / (R_OUT + 12 + 2 * R_LEAD);
    expect(I).toBeCloseTo(0.993139, 6);
    expect(12 - R_OUT * I).toBeCloseTo(11.999007, 6);
    expect(host.amps(1)).toBeCloseTo(I, 9);
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(12 - R_OUT * I, 9);
    expect(host.record(1)).toStrictEqual({
      outputV: host.volts(1, 'pos', 1, 'neg'),
      outputA: host.amps(1),
      mode: 'cv',
      status: 'solved',
    });
    expect(host.sim(1)).toStrictEqual({ mode: 'cv' });
  });

  it('in CC, holds the limit exactly: 12 V, 0.5 A into 12 Ω', () => {
    // CV would draw 0.993 A > 0.5 A: CC at 0.5 A, V = 0.5 × (12 + 0.08189631) = 6.040948 V.
    const host = loop(RESISTOR_12, 12, 0.5);
    expect(host.amps(1)).toBe(0.5);
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(0.5 * (12 + 2 * R_LEAD), 9);
    expect(host.record(1)).toMatchObject({ outputA: 0.5, mode: 'cc', status: 'solved' });
    expect(host.sim(1)).toStrictEqual({ mode: 'cc' });
  });

  it('crosses over at R = V / I within 0.5 %: CC just below, CV just above, from a fresh start', () => {
    // R_load = V / I − R_out at the crossover; the load the supply sees is the rheostat plus two leads.
    for (const [V, I] of [
      [12, 1],
      [5, 2],
      [30, 0.1],
      [1, 5],
    ]) {
      const crossover = V / I - R_OUT - 2 * R_LEAD;
      expect(mode(rheostatLoop(V, I, crossover * 0.995))).toBe('cc');
      expect(mode(rheostatLoop(V, I, crossover * 1.005))).toBe('cv');
      // A fresh supply leaves CV only past the band: at the crossover itself it stays in CV.
      expect(mode(rheostatLoop(V, I, crossover))).toBe('cv');
    }
  });

  it('output off is an open circuit (0 A, mode off); on again, it starts in CV', () => {
    const host = loop(RESISTOR_12, 12, 0.5, false);
    expect(host.amps(1)).toBe(0);
    expect(host.record(1)).toMatchObject({ outputA: 0, mode: 'off', status: 'solved' });
    host.operate(1, 'outputOn', true);
    expect(host.record(1)['mode']).toBe('cc');
    host.operate(1, 'outputOn', false);
    expect(host.sim(1)).toStrictEqual({ mode: 'cv' });
    expect(host.record(1)['mode']).toBe('off');
  });

  it('changing a setpoint is a value change: same topologyHash, re-solved at the command tick', () => {
    const host = loop(RESISTOR_12, 12, 2).advance(15);
    const hash = host.engine.netlist.topologyHash;
    host.operate(1, 'setpointV', 6);
    expect(host.engine.netlist.topologyHash).toBe(hash);
    expect(host.engine.lastSolveTick).toBe(15);
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(6 - R_OUT * host.amps(1), 9);
  });

  it('two supplies paralleled in CV are a resistive loop, never singular: they settle through CV/CC', () => {
    // 12.0 V and 12.5 V, 1 A limits, paralleled by two leads into 12 Ω: CV alone would circulate
    // 0.5 V / (2 × 1 mΩ + 2 R_L) ≈ 6 A, so the higher one limits at 1 A and the lower one regulates
    // (sinking the difference: an abstraction, real bench supplies mostly can't sink).
    const host = new SourceHost();
    const a = host.place(BENCH_SUPPLY);
    const b = host.place(BENCH_SUPPLY);
    const load = host.place(RESISTOR_12);
    host.lead(a, 'pos', b, 'pos').lead(a, 'neg', b, 'neg').lead(a, 'pos', load, 'a').lead(load, 'b', a, 'neg');
    for (const [id, v] of [
      [a, 12],
      [b, 12.5],
    ])
      host.operate(id, 'setpointV', v).operate(id, 'currentLimitA', 1).operate(id, 'outputOn', true);
    expect(host.engine.islands()[0].status).toBe('solved');
    expect(host.record(b)).toMatchObject({ mode: 'cc', outputA: 1 });
    expect(host.record(a)['mode']).toBe('cv');
    host.advance(1000);
    expect([host.record(a)['mode'], host.record(b)['mode']]).toStrictEqual(['cv', 'cc']);
  });

  it('shows an island the outer loop flags nonConverged as unsettled, never as a reading', () => {
    // A load that jumps with its own current never settles (`test.flip`).
    const host = loop(FLIP, 12, 5);
    expect(host.engine.islands()[0].status).toBe('nonConverged');
    expect(host.record(1)).toMatchObject({ outputV: 0, outputA: 0, status: 'unsettled' });
    expect(host.engine.probe({ entity: 1, terminal: 'pos' }, { entity: 1, terminal: 'neg' }).kind).toBe('unsettled');
  });

  it('publishes a valid output record schema', () => {
    expect(deviceOutputSchemaProblems(BENCH_SUPPLY_OUTPUT)).toStrictEqual([]);
  });
});

describe('the bench supply: no chatter at the crossover', () => {
  it('a load held exactly at the crossover keeps its mode over 100 cadence solves, each warm in 1 iteration', () => {
    for (const start of [0.9, 1.1]) {
      // Arrive from CC (below) or CV (above), then sit exactly at the crossover.
      const crossover = 12 / 1 - R_OUT - 2 * R_LEAD;
      const host = rheostatLoop(12, 1, crossover * start);
      const before = mode(host);
      host.operate(2, 'ohms', crossover);
      expect(mode(host)).toBe(before);
      for (let k = 0; k < 100; k++) {
        host.advance(10);
        expect(mode(host)).toBe(before);
        expect(host.engine.islands()[0].iterations).toBe(1);
      }
    }
  });

  it('sweeping the load up and down crosses over once each way, the two points a hysteresis band apart', () => {
    // CC → CV going up at R_t ≈ (V/I)(1 + h) − R_out; CV → CC going down at R_t ≈ V / (I (1 + h)) − R_out.
    const V = 12;
    const I = 1;
    const host = rheostatLoop(V, I, 11.5);
    const seen: string[] = [mode(host) as string];
    const points: number[] = [];
    const sweep = (from: number, to: number, steps: number) => {
      for (let k = 0; k <= steps; k++) {
        const ohms = from + ((to - from) * k) / steps;
        host.operate(2, 'ohms', ohms);
        const m = mode(host) as string;
        if (m !== seen[seen.length - 1]) points.push(ohms + 2 * R_LEAD);
        seen.push(m);
      }
    };
    sweep(11.5, 12.2, 1400);
    sweep(12.2, 11.5, 1400);
    expect(seen[0]).toBe('cc');
    expect(points).toHaveLength(2); // once up, once down: no chatter
    const [up, down] = points;
    expect(up).toBeGreaterThan(down);
    expect(Math.abs(up - ((V * (1 + h) + CV_CC_HYSTERESIS_VOLTS.value) / I - R_OUT))).toBeLessThan(1e-3);
    expect(Math.abs(down - (V / (I * (1 + h) + CV_CC_HYSTERESIS_AMPS.value) - R_OUT))).toBeLessThan(1e-3);
    for (const point of points) expect(Math.abs(point / (V / I) - 1)).toBeLessThan(0.005);
  });

  it('with a lamp-like load: a cold filament pulls the supply into CC, then lets it back to CV once as it heats', () => {
    // `test.thermalLoad`: about 2 Ω cold, +0.4 %/K, 0.5 J/K, 0.05 W/K (a stand-in until F2.5's lamp).
    // At 12 V and 3 A the cold load would draw about 6 A: CC at 3 A heats it until R passes 4 Ω,
    // then CV, where it settles near 5.9 Ω and 2 A, never back in CC.
    const host = loop(THERMAL_LOAD, 12, 3);
    expect(mode(host)).toBe('cc');
    const modes: string[] = [];
    for (let t = 0; t < 20_000; t += 10) {
      host.advance(10);
      const m = mode(host) as string;
      if (modes[modes.length - 1] !== m) modes.push(m);
      expect(host.engine.islands()[0].status).toBe('solved');
    }
    expect(modes).toStrictEqual(['cc', 'cv']);
    expect(host.amps(1)).toBeGreaterThan(1.9);
    expect(host.amps(1)).toBeLessThan(3);
  });
});

/** Module-level arbitraries (never built inside `.chain`). */
const setpointArb = fc.oneof(fc.constantFrom(0, 0.5, 30), fc.double({ min: 0, max: 30, noNaN: true }));
const limitArb = fc.oneof(fc.constantFrom(0, 0.001, 5), fc.double({ min: 0, max: 5, noNaN: true }));
/** Load resistances, log-uniform from 1 mΩ to 1 MΩ (exponent in tenths of a decade). */
const ohmsArb = fc.integer({ min: -30, max: 60 }).map((e) => 10 ** (e / 10));
const caseArb = fc.record({
  setpointV: setpointArb,
  limitA: limitArb,
  loads: fc.array(ohmsArb, { minLength: 1, maxLength: 6 }),
});

/** Whether the supply's solved output is inside both setpoints' tolerances, and in the mode it says. */
function withinSetpoints(host: SourceHost, setpointV: number, limitA: number): string {
  const record = host.record(1);
  const V = record['outputV'] as number;
  const A = record['outputA'] as number;
  const slack = 1e-9 * (1 + setpointV + limitA);
  expect(record['status']).toBe('solved');
  expect(A).toBeLessThanOrEqual(limitA + currentBand(limitA) + slack);
  expect(V).toBeLessThanOrEqual(setpointV + voltageBand(setpointV) + slack);
  if (record['mode'] === 'cc') {
    expect(A).toBe(limitA);
    expect(V).toBeLessThanOrEqual(setpointV - limitA * R_OUT + voltageBand(setpointV) + slack);
  } else {
    expect(Math.abs(V - (setpointV - R_OUT * A))).toBeLessThanOrEqual(slack);
  }
  return record['mode'] as string;
}

describe('the bench supply (properties)', () => {
  it('never exceeds either setpoint beyond its tolerance, whatever the load and its history', () => {
    fc.assert(
      fc.property(caseArb, ({ setpointV, limitA, loads }) => {
        const host = rheostatLoop(setpointV, limitA, loads[0]);
        withinSetpoints(host, setpointV, limitA);
        for (const ohms of loads.slice(1)) {
          host.operate(2, 'ohms', ohms);
          withinSetpoints(host, setpointV, limitA);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('the generator reaches both modes and both sides of the crossover (health, fixed seed)', () => {
    let cv = 0;
    let cc = 0;
    let both = 0;
    for (const { setpointV, limitA, loads } of fc.sample(caseArb, { seed: 20261031, numRuns: 60 })) {
      const host = rheostatLoop(setpointV, limitA, loads[0]);
      const modes = new Set([withinSetpoints(host, setpointV, limitA)]);
      for (const ohms of loads.slice(1)) {
        host.operate(2, 'ohms', ohms);
        modes.add(withinSetpoints(host, setpointV, limitA));
      }
      if (modes.has('cv')) cv++;
      if (modes.has('cc')) cc++;
      if (modes.size === 2) both++;
    }
    // Measured on this seed, of 60: 44 reach CV, 24 reach CC, 8 cross over within one case.
    expect(cv).toBeGreaterThan(30);
    expect(cc).toBeGreaterThan(16);
    expect(both).toBeGreaterThan(5);
  });
});
