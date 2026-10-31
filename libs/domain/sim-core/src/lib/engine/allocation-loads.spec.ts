import { Session } from 'node:inspector';
import { BATTERY, end, LAMP, LEAD, origin } from '../../testing/bench';
import { engineBus, engineTestOptions, THERMAL_LOAD } from '../../testing/engine';
import { SimEngine, type SimEngineOptions } from './engine';

/*
 * Per-tick allocation gates for F2.5's devices: a lit lamp, a fuse and a closed breaker (plan F2.5;
 * simulation caveats, "Allocation gates"). The measurement is `allocation.spec.ts`'s, copied, because
 * these gates must run in a process of their own: placed after that file's gates they measured 70 to
 * 96 B/step, all of it in `solveIsland`'s frame (the caveats' "a second bank variant of one model kind
 * in the process" regime, F2.4's solver code), where alone they measure under a byte for the lamp. Fold
 * the two files' measurement into one helper once F2.4's solver allocation work has landed. The gates
 * here run in order and share this process: add a gate at the end, and measure its baseline in place.
 */

/** Steps before measuring. Under coverage tier-up ends about 110 000: the median absorbs the first windows. */
const WARM_UP_STEPS = 100_000;
/**
 * Gates from in-place baselines, uncovered (this file runs in `vitest.allocation.mts` beside F2.4's
 * gates, out of the covered run): a lit lamp 0.70 B/step at worst (the worst median of 100 runs with
 * other test suites loading the machine; gate 1).
 */
const LAMP_GATE = 1;
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
  /** The commands that build the circuit, in place of `source` into `load`. */
  readonly commands?: readonly (readonly [string, object])[];
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
  {
    options = engineTestOptions(),
    warmUpSteps = WARM_UP_STEPS,
    windowCount = WINDOWS,
    commands: given,
  }: MeasureOptions = {},
): Allocation {
  const bus = engineBus(11);
  const engine = SimEngine.start(bus.state, options);
  const commands: readonly (readonly [string, object])[] =
    given !== undefined
      ? given
      : load === null
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

describe('SimEngine per-tick allocation, F2.5 devices (regression gates)', () => {
  /** The battery (1) through `device` (2; terminals `a`, `b`) into `load` (3), `extra` commands first. */
  const series = (
    device: typeof BATTERY,
    [a, b]: readonly [string, string],
    load: typeof BATTERY,
    extra: readonly (readonly [string, object])[] = [],
  ): readonly (readonly [string, object])[] => [
    ['entity.place', { ref: BATTERY, positionMm: origin }],
    ['entity.place', { ref: device, positionMm: origin }],
    ['entity.place', { ref: load, positionMm: origin }],
    ...extra,
    ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, a) }],
    ['lead.connect', { ref: LEAD, a: end(2, b), b: end(3, 'a') }],
    ['lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') }],
  ];
  const log = (name: string, a: { perStep: number; report: string }) => {
    if (process.env['ALLOC_LOG'] === '1') console.log(`ALLOC ${name} ${a.perStep}\n${a.report}`);
  };

  it('a lit lamp (the filament ODE every tick) stays under 1 byte per step', () => {
    const measured = allocatedPerStep(BATTERY, 'pos', 'neg', LAMP);
    log('lamp', measured);
    expect(measured.perStep, measured.report).toBeLessThan(LAMP_GATE);
  });
});
