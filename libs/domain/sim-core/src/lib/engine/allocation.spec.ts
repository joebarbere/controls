import { Session } from 'node:inspector';
import type { CatalogRef } from '@controls/save-format';
import { AC_SOURCE, BATTERY, end, LEAD, origin } from '../../testing/bench';
import {
  DROOP,
  engineBus,
  engineTestOptions,
  REACTOR,
  RESISTOR_12,
  RHEOSTAT,
  THERMAL_LOAD,
} from '../../testing/engine';
import { BENCH_SUPPLY, DIN_PSU, UTILITY_208, UTILITY_SPLIT } from '../../testing/sources';
import type { SimDeviceModel } from './device-model';
import { settledWindows } from './allocation-settle';
import { SimEngine, type SimEngineOptions } from './engine';

/*
 * Per-tick allocation gates (plan F2.3a; simulation caveats, "Allocation gates"). Zero allocation per
 * tick is the plan's criterion; these gates stop the per-tick path growing until it gets there.
 *
 * This file holds the gates and nothing else, on purpose. Vitest runs each spec file in its own worker
 * process (`isolate`, the default), so V8's type feedback here comes from these workloads alone. When
 * the gates ran at the end of engine.spec.ts, after some thirty tests had sent other island shapes and
 * device kinds through the same solver call sites, V8 sometimes compiled the solver with a call it
 * didn't inline, and every non-integer double crossing that call was boxed into a heap number: the
 * whole process sat on a plateau 5-20 B/step higher (2-3 % of runs under load, F2.4). The gates here
 * run in order and share one process, so each later gate's baseline includes the earlier ones'
 * feedback: add a gate at the end, and measure its baseline in place.
 *
 * It runs without coverage, in its own Vitest run (`vitest.allocation.mts`, the second half of
 * sim-core's `test` target, so still in `pnpm verify`): coverage instrumentation changes what V8
 * optimizes, and made the gates 4-5x slower, past Vitest's 5 s timeout on CI's runners. The baselines
 * are uninstrumented, the engine the game runs.
 */

/** Steps before measuring (tier-up ended about 110 000 under coverage, which these gates now run without). */
const WARM_UP_STEPS = 100_000;
const WINDOW_STEPS = 10_000;
const WINDOWS = 8;
/** V8 samples an allocation every this many bytes on average, and scales each sample to an unbiased estimate. */
const SAMPLING_INTERVAL = 128;

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
}

/**
 * The bytes the engine allocates while it advances `steps`, by V8's sampling heap profiler with
 * collected objects kept: what was allocated, whenever a GC ran (heap growth plus what GCs freed was
 * off by up to ±1.4 MB in a window). Only allocations under `SimEngine.advanceTo` count, never the
 * measuring code's own; `sites` attributes them, for a failing gate's message.
 */
function sampledBytes(engine: SimEngine, steps: number): { bytes: number; sites: Map<string, number> } {
  const session = new Session();
  session.connect();
  let head: ProfileNode | null = null;
  const sampling = {
    samplingInterval: SAMPLING_INTERVAL,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
  // A session in the same thread answers each post synchronously.
  session.post('HeapProfiler.startSampling', sampling, (error) => {
    if (error) throw error;
  });
  engine.advanceTo(engine.tick + steps);
  session.post('HeapProfiler.stopSampling', (error, result) => {
    if (error) throw error;
    head = result.profile.head as ProfileNode;
  });
  session.disconnect();
  if (head === null) throw new Error('HeapProfiler.stopSampling returned no profile');
  const sites = new Map<string, number>();
  let bytes = 0;
  const walk = (node: ProfileNode, inEngine: boolean, caller: string) => {
    const { functionName, url, lineNumber } = node.callFrame;
    const name = `${functionName || '(anonymous)'} ${url.split('/').slice(-2).join('/')}:${lineNumber + 1}`;
    const counted = inEngine || (functionName === 'advanceTo' && url.endsWith('/engine/engine.ts'));
    if (counted && node.selfSize > 0) {
      bytes += node.selfSize;
      const site = `${caller} > ${name}`;
      sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, counted, name);
  };
  walk(head, false, '(root)');
  return { bytes, sites };
}

/** For the check that the measurement sees an allocation: other engine models, a shorter run. */
interface MeasureOptions {
  readonly options?: SimEngineOptions;
  readonly warmUpSteps?: number;
  readonly windowCount?: number;
  readonly windowSteps?: number;
}

interface Allocation {
  /** The median window's bytes per step: what the gate compares. */
  perStep: number;
  /** Every window and the top allocation sites: the failing gate's message. */
  report: string;
}

/**
 * Bytes allocated per step by `source` into `load` through two leads, or shorted by one lead (`load`
 * null): the layers' work every step and a cadence solve every 10th. The median of the last eight (once settled: `settledWindows`, `allocation-settle.ts`) 10 000-step
 * windows after the warm-up: a per-step allocation raises every window, while a window that catches
 * a late tier-up or a short-lived slower regime is one of a few the median ignores. Never the
 * smallest window: measured by heap growth, single windows read as low as -48 B/step, and the
 * smallest of ten hid a planted 8 B/step.
 */
function allocatedPerStep(
  source: CatalogRef,
  pos: string,
  neg: string,
  load: CatalogRef | null = THERMAL_LOAD,
  measure: MeasureOptions = {},
): Allocation {
  return allocatedBy(loopCommands(1, source, pos, neg, load), measure);
}

type Command = [string, object];

/** `source` (placed as entity `id`) into `load` (entity `id + 1`) through two leads, or shorted by one. */
function loopCommands(id: number, source: CatalogRef, pos: string, neg: string, load: CatalogRef | null): Command[] {
  if (load === null) {
    return [
      ['entity.place', { ref: source, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(id, pos), b: end(id, neg) }],
    ];
  }
  return [
    ['entity.place', { ref: source, positionMm: origin }],
    ['entity.place', { ref: load, positionMm: origin }],
    ['lead.connect', { ref: LEAD, a: end(id, pos), b: end(id + 1, 'a') }],
    ['lead.connect', { ref: LEAD, a: end(id + 1, 'b'), b: end(id, neg) }],
  ];
}

/** As `allocatedPerStep`, for the world `commands` build. */
function allocatedBy(
  commands: readonly Command[],
  {
    options = engineTestOptions(),
    warmUpSteps = WARM_UP_STEPS,
    windowCount = WINDOWS,
    windowSteps = WINDOW_STEPS,
  }: MeasureOptions = {},
): Allocation {
  const bus = engineBus(11);
  const engine = SimEngine.start(bus.state, options);
  for (const [id, args] of commands) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error)}`);
    if (result.logged) engine.applied(result.entry, bus.state);
  }
  engine.advanceTo(warmUpSteps);
  const perWindow: Map<string, number>[] = [];
  const { perStep, all } = settledWindows(windowCount, () => {
    const sample = sampledBytes(engine, windowSteps);
    perWindow.push(sample.sites);
    return sample.bytes / windowSteps;
  });
  const sites = new Map<string, number>();
  for (const sample of perWindow.slice(-windowCount)) {
    for (const [site, bytes] of sample) sites.set(site, (sites.get(site) ?? 0) + bytes);
  }
  const steps = windowCount * windowSteps;
  const top = [...sites]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([site, bytes]) => `  ${(bytes / steps).toFixed(2)} B/step  ${site}`);
  return {
    perStep,
    report: `windows (B/step, the gate's last ${windowCount} of ${all.length}): ${all.map((w) => w.toFixed(2)).join(' ')}\ntop sites (those windows):\n${top.join('\n')}`,
  };
}

/**
 * The engine's test models with 32 B/step planted in the thermal load's continuous layer: a 32-byte
 * object a step, kept alive in a ring so escape analysis can't remove it.
 */
function plantedOptions(): SimEngineOptions {
  const options = engineTestOptions();
  const thermal = options.deviceModels['test.thermalLoad'];
  const ring: unknown[] = new Array(4096).fill(null);
  let at = 0;
  const planted: SimDeviceModel = {
    ...thermal,
    bank(devices) {
      const bank = thermal.bank(devices);
      const continuous = bank.continuous;
      return {
        ...bank,
        continuous(ctx) {
          continuous?.(ctx);
          ring[at++ & 4095] = { tick: ctx.tick };
        },
      };
    },
  };
  return { ...options, deviceModels: { ...options.deviceModels, 'test.thermalLoad': planted } };
}

/**
 * Mixed worlds: several device kinds in one engine, each its own island. The game's worker runs every
 * kind in one process, so the engine's and the solvers' call sites see all of them (polymorphic
 * feedback), which a per-source gate's world never shows them. Two worlds rather than one, for the
 * cost: V8 keeps type feedback per call site, shared by every engine in the process, so a DC world and
 * an AC world measured in the same process see the same polymorphism as one world with both, at about
 * half the steps' cost each (one world of every kind took 6-10 s under coverage on CI).
 *
 * DC: a battery into a load whose resistance rises with its current, which the outer loop iterates
 * (entities 1, 2); a DIN PSU hiccuping into a heating load, limit, off and retry (3, 4); a bench supply
 * in current limit into a rheostat (5, 6).
 */
function mixedDcCommands(): Command[] {
  return [
    ...loopCommands(1, BATTERY, 'pos', 'neg', DROOP),
    ...loopCommands(3, DIN_PSU, 'pos', 'neg', THERMAL_LOAD),
    ...loopCommands(5, BENCH_SUPPLY, 'pos', 'neg', RHEOSTAT),
    ['device.operate', { id: 5, control: 'setpointV', value: 12 }],
    ['device.operate', { id: 5, control: 'currentLimitA', value: 1 }],
    ['device.operate', { id: 5, control: 'outputOn', value: true }],
  ];
}

/**
 * AC: the phasor source into a reactor (1, 2) and into a heating load (3, 4); a split-phase service,
 * L1 to N (5, 6), and a 208Y/120 V service, L2 to N (7, 8), each into a heating load (F2.4 part 2).
 */
function mixedAcCommands(): Command[] {
  return [
    ...loopCommands(1, AC_SOURCE, 'l', 'n', REACTOR),
    ...loopCommands(3, AC_SOURCE, 'l', 'n', THERMAL_LOAD),
    ...loopCommands(5, UTILITY_SPLIT, 'l1', 'n', THERMAL_LOAD),
    ...loopCommands(7, UTILITY_208, 'l2', 'n', THERMAL_LOAD),
  ];
}

/**
 * The mixed worlds' measurement (see `mixedDcCommands`): an 80 000-step warm-up and eight 2 000-step
 * windows. Shorter than the per-source gates' because the gates before them have already tiered up
 * every call site these worlds use, and measured in place: the windows from 80 000 read as the steady
 * state (worst medians over 100 runs: 0.0 and 3.4 B/step), while 20 000 and 40 000 still caught tier-up.
 */
const MIXED_MEASURE: MeasureOptions = {
  warmUpSteps: 80_000,
  windowSteps: 2_000,
  windowCount: 8,
};

describe('SimEngine per-tick allocation (regression gates, not yet zero)', () => {
  it('the DC path (a battery into a heating load) stays under 4 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(BATTERY, 'pos', 'neg');
    expect(perStep, report).toBeLessThan(4);
  });

  it('the DIN PSU regulating (CV into 12 Ω) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(DIN_PSU, 'pos', 'neg', RESISTOR_12);
    expect(perStep, report).toBeLessThan(6);
  });

  it('the DIN PSU shorted (in its limit and hiccuping) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(DIN_PSU, 'pos', 'neg', null);
    expect(perStep, report).toBeLessThan(6);
  });

  it('the AC path (a phasor source into a heating load) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(AC_SOURCE, 'l', 'n');
    expect(perStep, report).toBeLessThan(6);
  });

  // The 2 Ω cold load asks 12 A of a 5 A supply: 100 ms in current limit, 1 s off, retry, and every
  // retry re-solves a load whose resistance moved while it cooled (more outer-loop iterations a solve).
  it('the DIN PSU hiccuping into a heating load stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(DIN_PSU, 'pos', 'neg');
    expect(perStep, report).toBeLessThan(6);
  });

  it('a split-phase service with series inductance (F2.4 part 2) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(UTILITY_SPLIT, 'l1', 'n');
    expect(perStep, report).toBeLessThan(6);
  });

  it('a mixed DC world (battery, DIN PSU and bench supply, nonlinear loads) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedBy(mixedDcCommands(), MIXED_MEASURE);
    expect(perStep, report).toBeLessThan(6);
  });

  it('a mixed AC world (phasor sources into reactive and heating loads) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedBy(mixedAcCommands(), MIXED_MEASURE);
    expect(perStep, report).toBeLessThan(6);
  });

  // Last, because a second variant of the thermal model's bank changes the feedback every later test
  // would see. It fails if the measurement stops seeing the engine (a renamed `advanceTo` or engine
  // module, or an empty profile), which would make every gate above pass whatever it allocates. A short
  // run is enough for a lower bound: code not yet optimized allocates more, never less.
  it('the measurement counts a planted 32 B/step allocation (the gates can fail)', () => {
    const { perStep, report } = allocatedPerStep(BATTERY, 'pos', 'neg', THERMAL_LOAD, {
      options: plantedOptions(),
      warmUpSteps: 10_000,
      windowCount: 2,
    });
    expect(perStep, report).toBeGreaterThan(24);
  });
});
