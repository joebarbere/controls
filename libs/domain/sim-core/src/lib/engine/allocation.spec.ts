import { Session } from 'node:inspector';
import { AC_SOURCE, BATTERY, end, LEAD, origin } from '../../testing/bench';
import { engineBus, engineTestOptions, RESISTOR_12, THERMAL_LOAD } from '../../testing/engine';
import { DIN_PSU } from '../../testing/sources';
import type { SimDeviceModel } from './device-model';
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
 */

/** Steps before measuring. Under coverage tier-up ends about 110 000: the median absorbs the first windows. */
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

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** For the check that the measurement sees an allocation: other engine models, a shorter run. */
interface MeasureOptions {
  readonly options?: SimEngineOptions;
  readonly warmUpSteps?: number;
  readonly windowCount?: number;
}

interface Allocation {
  /** The median window's bytes per step: what the gate compares. */
  perStep: number;
  /** Every window and the top allocation sites: the failing gate's message. */
  report: string;
}

/**
 * Bytes allocated per step by `source` into `load` through two leads, or shorted by one lead (`load`
 * null): the layers' work every step and a cadence solve every 10th. The median of eight 10 000-step
 * windows after the warm-up: a per-step allocation raises every window, while a window that catches
 * a late tier-up or a short-lived slower regime is one of a few the median ignores. Never the
 * smallest window: measured by heap growth, single windows read as low as -48 B/step, and the
 * smallest of ten hid a planted 8 B/step.
 */
function allocatedPerStep(
  source: typeof BATTERY,
  pos: string,
  neg: string,
  load: typeof BATTERY | null = THERMAL_LOAD,
  { options = engineTestOptions(), warmUpSteps = WARM_UP_STEPS, windowCount = WINDOWS }: MeasureOptions = {},
): Allocation {
  const bus = engineBus(11);
  const engine = SimEngine.start(bus.state, options);
  const commands: [string, object][] =
    load === null
      ? [
          ['entity.place', { ref: source, positionMm: origin }],
          ['lead.connect', { ref: LEAD, a: end(1, pos), b: end(1, neg) }],
        ]
      : [
          ['entity.place', { ref: source, positionMm: origin }],
          ['entity.place', { ref: load, positionMm: origin }],
          ['lead.connect', { ref: LEAD, a: end(1, pos), b: end(2, 'a') }],
          ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, neg) }],
        ];
  for (const [id, args] of commands) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error)}`);
    if (result.logged) engine.applied(result.entry, bus.state);
  }
  engine.advanceTo(warmUpSteps);
  const windows: number[] = [];
  const sites = new Map<string, number>();
  for (let w = 0; w < windowCount; w++) {
    const sample = sampledBytes(engine, WINDOW_STEPS);
    windows.push(sample.bytes / WINDOW_STEPS);
    for (const [site, bytes] of sample.sites) sites.set(site, (sites.get(site) ?? 0) + bytes);
  }
  const steps = windowCount * WINDOW_STEPS;
  const top = [...sites]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([site, bytes]) => `  ${(bytes / steps).toFixed(2)} B/step  ${site}`);
  return {
    perStep: median(windows),
    report: `windows (B/step): ${windows.map((w) => w.toFixed(2)).join(' ')}\ntop sites:\n${top.join('\n')}`,
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

describe('SimEngine per-tick allocation (regression gates, not yet zero)', () => {
  it('the DC path (a battery into a heating load) stays under 4 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(BATTERY, 'pos', 'neg');
    expect(perStep, report).toBeLessThan(4);
  });

  it('the DIN PSU regulating (CV into 12 Ω) stays under 6 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(DIN_PSU, 'pos', 'neg', RESISTOR_12);
    expect(perStep, report).toBeLessThan(6);
  });

  it('the DIN PSU shorted (in its limit and hiccuping) stays under 10.5 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(DIN_PSU, 'pos', 'neg', null);
    expect(perStep, report).toBeLessThan(10.5);
  });

  it('the AC path (a phasor source into a heating load) stays under 36 bytes per step', () => {
    const { perStep, report } = allocatedPerStep(AC_SOURCE, 'l', 'n');
    expect(perStep, report).toBeLessThan(36);
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
