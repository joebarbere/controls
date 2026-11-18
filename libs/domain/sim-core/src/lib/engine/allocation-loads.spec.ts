import { Session } from 'node:inspector';
import { type BankRig, bankRig } from '../../testing/breakers';
import { GFCI_SENSE_PARAMS, plugOnParams } from '../../testing/plug-on';
import {
  AFCI_BREAKER_MODEL,
  GFCI_BREAKER_MODEL,
  PLUG_ON_1P_MODEL,
  PLUG_ON_2P_MODEL,
} from '../devices/protection/plug-on';
import { deviceExtras } from '../../testing/devices';
import { BATTERY, end, LAMP, LEAD, origin } from '../../testing/bench';
import { ENGINE_TEST_CATALOG, engineBus, engineTestOptions, THERMAL_LOAD } from '../../testing/engine';
import { BENCH_SUPPLY } from '../../testing/sources';
import { HEATER, RESISTOR_10R } from '../../testing/loads';
import { BREAKER, FUSE_1A } from '../../testing/protection';
import { settledWindows } from './allocation-settle';
import { SimEngine, type SimEngineOptions } from './engine';
import type { LayerContext, SimDevice } from './device-model';
import type { DeviceStateValue } from '@controls/save-format';
import { deriveStream, entityStreamKey } from '@controls/world-model';
import { LAMP_MODEL } from '../devices/loads/lamp';
import { GROUND_ROD_MODEL } from '../devices/sources/ground-rod';
import { SERVICE_SPLIT_PHASE_MODEL } from '../devices/sources/service';
import { residentialTestOptions, ROD, SERVICE } from '../../testing/residential';
import { BREAKER_MODEL } from '../devices/protection/breaker';
import { FUSE_MODEL } from '../devices/protection/fuse';

/*
 * Per-tick allocation gates for F2.5's devices: a lit lamp, a fuse and a closed breaker (plan F2.5;
 * simulation caveats, "Allocation gates"). The settling rule is shared with `allocation.spec.ts`
 * (`allocation-settle.ts`, Node-free); the profiler sampling (`sampledBytes`, `node:inspector`) is a
 * copy of that file's, because these gates must run in a process of their own: placed after that
 * file's gates they measured 70 to 96 B/step, all of it in `solveIsland`'s frame (the caveats' "a
 * second bank variant of one model kind in the process" regime), where alone they measure under a
 * byte for the lamp. The gates
 * here run in order and share this process: add a gate at the end, and measure its baseline in place.
 */

/** Steps before measuring. Under coverage tier-up ends about 110 000: the median absorbs the first windows. */
const WARM_UP_STEPS = 100_000;
/**
 * Gates from in-place baselines, uncovered (this file runs in `vitest.allocation.mts` beside F2.4's
 * gates, out of the covered run), the worst median of 100 runs with other test suites loading the
 * machine: a lit lamp 0.70 B/step, a fuse carrying a lit lamp 0.28, a closed breaker carrying 1.3 A
 * 0.64 (gates 1.0 each); every F2.5 kind at once in one engine 2.14 on F2.4's mixed-world windows
 * (8 × 2,000 steps after an 80,000-step warm-up; gate 2.5 until F3.6 part 1, which stamps the resistor
 * defaults from a slot instead of a keyed load per solve: 0 B/step in 8 of 8 runs, gate 1). The last
 * test measures each layer alone.
 */
const LAMP_GATE = 1;
const FUSE_GATE = 1;
const BREAKER_GATE = 1;
const MIXED_GATE = 1;
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
  /** The commands that build the circuit, in place of `source` into `load`. */
  readonly commands?: readonly (readonly [string, object])[];
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
 * null): the layers' work every step and a cadence solve every 10th. The median of the last eight 10 000-step
 * windows once they have settled (`settledWindows`, `allocation-settle.ts`), after the warm-up: a per-step allocation raises every window, while a window that catches
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
    windowSteps = WINDOW_STEPS,
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

/** Calls `call` `calls` times: a named frame, so the profile can be cut to what it allocates. */
function runCalls(call: () => void, calls: number): void {
  for (let k = 0; k < calls; k++) call();
}

/** Bytes the sampling heap profiler sees allocated under `runCalls` while `call` runs `calls` times. */
function sampledLoopBytes(call: () => void, calls: number): number {
  const session = new Session();
  session.connect();
  let head: ProfileNode | null = null;
  session.post(
    'HeapProfiler.startSampling',
    {
      samplingInterval: SAMPLING_INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    },
    (error) => {
      if (error) throw error;
    },
  );
  runCalls(call, calls);
  session.post('HeapProfiler.stopSampling', (error, result) => {
    if (error) throw error;
    head = result.profile.head as ProfileNode;
  });
  session.disconnect();
  let bytes = 0;
  // Everything sampled in the window except the inspector's own frames (where the profile's result
  // objects are built): nothing else runs between start and stop but the loop, and frames inlined into
  // it don't keep their own names, so no frame can be singled out.
  const walk = (node: ProfileNode) => {
    if (node.callFrame.url.startsWith('node:inspector')) return;
    bytes += node.selfSize;
    for (const child of node.children) walk(child);
  };
  if (head === null) throw new Error('HeapProfiler.stopSampling returned no profile');
  walk(head);
  return bytes;
}

/** A layer's measure: windows of this many calls, after `LAYER_WARM_UP_CALLS` calls. */
const LAYER_WINDOW_CALLS = 40_000;
const LAYER_WINDOWS = 5;
const LAYER_WARM_UP_CALLS = 200_000;

/**
 * Bytes a layer's `call` allocates per call, by the engine gates' rule (`settledWindows`): sampled
 * windows of `LAYER_WINDOW_CALLS` calls until the last four agree within 2 B a call, then the median
 * of the last `LAYER_WINDOWS`. The warm-up goes through `runCalls` in short calls, so `runCalls` is
 * optimised on entry rather than by an on-stack replacement inside a window (a compile that allocates
 * about 11.5 kB under the window's frame; snapshot-read, #152). A layer that allocates on every call
 * raises every window. A layer still tiering up, or re-optimising after a deopt, boxes its doubles for
 * a while (measured: the lamp's `continuous` at 121 B a call through the second window in 60 of 60
 * runs, `Math.sqrt`, `max` and `min` returning heap numbers; the AFCI's `protection` 1.19 MB in a
 * window after new closures deoptimised it), so its windows fall, and the rule waits for them. With
 * one 200,000-call window, `afci1p` read 1.72 B a call once in a full `verify` under load.
 */
function layerBytesPerCall(call: () => void): { perCall: number; windows: readonly number[] } {
  for (let k = 0; k < LAYER_WARM_UP_CALLS; k += 1_000) runCalls(call, 1_000);
  const { perStep, all } = settledWindows(
    LAYER_WINDOWS,
    () => sampledLoopBytes(call, LAYER_WINDOW_CALLS) / LAYER_WINDOW_CALLS,
  );
  return { perCall: perStep, windows: all };
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
  // Every gate warms up for the full WARM_UP_STEPS: a fifth of it was tried for the gates after the
  // lamp's (F2.5 test review, T10) and the fuse's median read 19.8 B/step against 7, still tiering up.
  const later = (commands: readonly (readonly [string, object])[]) =>
    allocatedPerStep(BATTERY, 'pos', 'neg', null, { commands });
  const on: readonly (readonly [string, object])[] = [['device.operate', { id: 2, control: 'on', value: true }]];
  const fuseLoop = series(FUSE_1A, ['a', 'b'], LAMP);
  const breakerLoop = series(BREAKER, ['line', 'load'], RESISTOR_10R, on);

  it('a fuse carrying a lit lamp (its melt state every tick) stays under 1 byte per step', () => {
    const measured = later(fuseLoop);
    log('fuse', measured);
    expect(measured.perStep, measured.report).toBeLessThan(FUSE_GATE);
  });

  it('a closed breaker carrying 1.3 A (its bimetal every tick) stays under 1 byte per step', () => {
    const measured = later(breakerLoop);
    log('breaker', measured);
    expect(measured.perStep, measured.report).toBeLessThan(BREAKER_GATE);
  });

  it('every F2.5 kind at once in one engine (four solved islands) stays under 1 byte per step', () => {
    const shift = (commands: readonly (readonly [string, object])[], by: number) =>
      commands.map(
        ([id, args]) =>
          [
            id,
            JSON.parse(JSON.stringify(args), (key, v) =>
              (key === 'entity' || key === 'id') && typeof v === 'number' ? v + by : v,
            ),
          ] as const,
      );
    const supplyLoop: readonly (readonly [string, object])[] = [
      ['entity.place', { ref: BENCH_SUPPLY, positionMm: origin }],
      ['entity.place', { ref: LAMP, positionMm: origin }],
      ['device.operate', { id: 1, control: 'setpointV', value: 12 }],
      ['device.operate', { id: 1, control: 'currentLimitA', value: 2 }],
      ['device.operate', { id: 1, control: 'outputOn', value: true }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ];
    const heaterLoop: readonly (readonly [string, object])[] = [
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: HEATER, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ];
    // F2.4's mixed-world method: 8 windows of 2,000 steps after an 80,000-step warm-up (measured in
    // place, uncovered), so four islands cost about what one island's gate does.
    const measured = allocatedPerStep(BATTERY, 'pos', 'neg', null, {
      commands: [...fuseLoop, ...shift(breakerLoop, 3), ...shift(heaterLoop, 6), ...shift(supplyLoop, 8)],
      warmUpSteps: 80_000,
      windowSteps: 2_000,
    });
    log('mixed', measured);
    expect(measured.perStep, measured.report).toBeLessThan(MIXED_GATE);
  });

  // The A/B the review asked for, done on the layers themselves. Before #54/#55's mixed-process solver
  // fix the solver sat on a process-wide regime of 0 or about 7 B/step that flipped between gates (in
  // 140 runs a circuit with the fuse swapped for a fixed test resistor measured from 0.9 B/step below to
  // 5.7 above the fuse's), so an in-engine A/B measured the regime, not the device. Each device's own
  // layer, called on its bank with a fixed solution and no engine around it, allocates nothing.
  it('each F2.5 layer alone (bank calls on a fixed solution) allocates nothing per call', () => {
    const fixed = (amps: number) =>
      ({
        tick: 0,
        dtS: 0.001,
        netlist: { branches: [{ island: 0, a: 0, b: 1 }], islands: [{ kind: 'dc' }] },
        solution: { branches: Float64Array.of(amps, 0), nodes: Float64Array.of(12, 0, 0, 0) },
        islandReadable: () => true,
        islandStatus: () => 'solved',
        emit: () => undefined,
      }) as unknown as LayerContext;
    const device = (ref: typeof BATTERY, bag: Record<string, DeviceStateValue>, state = {}): SimDevice => ({
      entity: 2,
      params: ENGINE_TEST_CATALOG.device(ref)?.model.params as Record<string, number>,
      bag,
      state,
      branches: [0],
      frequencyHz: 60,
      ...deviceExtras(11, 2, ['element']),
      stream: () => deriveStream(11, entityStreamKey(2)),
    });
    const layers: [string, () => void][] = [
      [
        'lamp',
        () => {
          const b = LAMP_MODEL.bank([device(LAMP, { filamentTempK: 2700 })]);
          const c = fixed(0.4166);
          return () => b.continuous?.(c);
        },
      ],
      [
        'fuse',
        () => {
          const b = FUSE_MODEL.bank([device(FUSE_1A, { blown: false, elementHeat: 0, bodyHeat: 0 })]);
          const c = fixed(0.5);
          return () => b.protection?.(c);
        },
      ],
      [
        'breaker',
        () => {
          const b = BREAKER_MODEL.bank([device(BREAKER, { thermal: 0, tripped: false }, { on: true })]);
          const c = fixed(10);
          return () => b.protection?.(c);
        },
      ],
    ].map(([name, make]) => [name as string, (make as () => () => void)()]);
    for (const [name, call] of layers) {
      const { perCall, windows } = layerBytesPerCall(call);
      if (process.env['ALLOC_LOG'] === '1') console.log(`ALLOC layer-${name} ${perCall} [${windows.join(' ')}]`);
      // Under 1 B a call: one heap number a call is 16 B; the window's own noise measured 0.01–0.07.
      expect(perCall, `${name}: windows (B a call) ${windows.join(' ')}`).toBeLessThan(1);
    }
  });

  // Breakers v2 (P4 PR 10): each kind's protection layer on its bank, a loaded closed breaker every tick
  // (the AFCI's bucket boundaries included, with nothing arcing; the GFCI's residual 0).
  it('each breakers-v2 layer alone (bank calls on a fixed solution) allocates nothing per call', () => {
    const p20 = plugOnParams(20);
    const rigs: [string, BankRig][] = [
      ['plugOn1p', bankRig(PLUG_ON_1P_MODEL, p20, ['pole']).amps('pole', 15)],
      ['plugOn2p', bankRig(PLUG_ON_2P_MODEL, p20, ['pole1', 'pole2']).amps('pole1', 15).amps('pole2', -15)],
      [
        'gfci1p',
        bankRig(GFCI_BREAKER_MODEL, { ...p20, ...GFCI_SENSE_PARAMS }, ['neutral', 'pole'], {
          state: { on: true, test: 0 },
        })
          .amps('pole', 15)
          .amps('neutral', -15),
      ],
      [
        'afci1p',
        bankRig(AFCI_BREAKER_MODEL, p20, ['neutral', 'pole'], { state: { on: true, test: 0 } })
          .amps('pole', 15)
          .amps('neutral', -15),
      ],
    ];
    for (const [name, rig] of rigs) {
      const call = () => rig.step();
      const { perCall, windows } = layerBytesPerCall(call);
      if (process.env['ALLOC_LOG'] === '1') console.log(`ALLOC layer-${name} ${perCall} [${windows.join(' ')}]`);
      expect(rig.events, name).toStrictEqual([]);
      expect(perCall, `${name}: windows (B a call) ${windows.join(' ')}`).toBeLessThan(1);
    }
  });

  // Protocol 8 (P4 PR 11): every new record writer on its bank, into one reused buffer, on a solved
  // island with every electrical field a reading (the GFCI's and AFCI's voltages included). A record is
  // written at every publish, so it must not allocate either. The AFCI's downstream marks are built only
  // while an end arcs (none here).
  it('each protocol 8 record writer alone (a fixed solution, a reused buffer) allocates nothing per call', () => {
    const p20 = plugOnParams(20);
    const nodes = { line: 0, load: 1, pigtail: 2, loadNeutral: 3 };
    const sensing = (rig: BankRig) => rig.amps('pole', 15, 1).amps('neutral', -14.99, -1).volts(0, 120).volts(1, 119);
    const rigs: [string, BankRig][] = [
      ['plugOn1p', bankRig(PLUG_ON_1P_MODEL, p20, ['pole']).amps('pole', 15)],
      ['plugOn2p', bankRig(PLUG_ON_2P_MODEL, p20, ['pole1', 'pole2']).amps('pole1', 15).amps('pole2', -15)],
      [
        'gfci1p',
        sensing(
          bankRig(GFCI_BREAKER_MODEL, { ...p20, ...GFCI_SENSE_PARAMS }, ['neutral', 'pole'], {
            state: { on: true, test: 0 },
            nodes,
          }),
        ),
      ],
      [
        'afci1p',
        sensing(bankRig(AFCI_BREAKER_MODEL, p20, ['neutral', 'pole'], { state: { on: true, test: 0 }, nodes })),
      ],
    ];
    const writers: [string, () => void][] = rigs.map(([name, rig]) => {
      const view = new DataView(new ArrayBuffer(128));
      const write = rig.bank.writeRecord as NonNullable<typeof rig.bank.writeRecord>;
      return [name, () => write(0, view, 0, rig.ctx)];
    });
    // The service (dropN, l1, l2 and its earth contact) and a ground rod (its earth contact), on one
    // solved AC island; the lamp on a DC one.
    const ctx = (branches: number) =>
      ({
        tick: 0,
        dtS: 0.001,
        netlist: {
          branches: Array.from({ length: branches }, (_, i) => ({ index: i, island: 0, a: i, b: i + 1 })),
          islands: [{ kind: 'ac' }],
          nodes: Array.from({ length: branches + 1 }, () => ({ island: 0 })),
        },
        solution: {
          branches: Float64Array.from({ length: 2 * branches }, (_, k) => 1.5 + k),
          nodes: Float64Array.from({ length: 2 * branches + 2 }, (_, k) => 120.25 - k),
        },
        islandReadable: () => true,
        islandStatus: () => 'solved',
        emit: () => undefined,
        arcingCount: () => 0,
        arcingBranch: () => -1,
      }) as unknown as LayerContext;
    const residential = residentialTestOptions().catalog;
    const service = SERVICE_SPLIT_PHASE_MODEL.bank([
      {
        entity: 1,
        params: residential.device(SERVICE)?.model.params as Record<string, number>,
        bag: {},
        state: {},
        branches: [0, 1, 2],
        frequencyHz: 60,
        stream: () => deriveStream(11, entityStreamKey(1)),
        ...deviceExtras(11, 1, ['dropN', 'l1', 'l2'], {
          contacts: [{ branch: 3, relation: 'earth', contact: 'grounding' }],
        }),
      },
    ]);
    const rod = GROUND_ROD_MODEL.bank([
      {
        entity: 1,
        params: residential.device(ROD)?.model.params as Record<string, number>,
        bag: {},
        state: {},
        branches: [],
        frequencyHz: 60,
        stream: () => deriveStream(11, entityStreamKey(1)),
        ...deviceExtras(11, 1, [], { contacts: [{ branch: 0, relation: 'earth', contact: 'electrode' }] }),
      },
    ]);
    const lamp = LAMP_MODEL.bank([
      {
        entity: 2,
        params: ENGINE_TEST_CATALOG.device(LAMP)?.model.params as Record<string, number>,
        bag: { filamentTempK: 2700, burnedOut: false, overvoltageSinceTick: null },
        state: {},
        branches: [0],
        frequencyHz: 60,
        stream: () => deriveStream(11, entityStreamKey(2)),
        ...deviceExtras(11, 2, ['element']),
      },
    ]);
    const serviceCtx = ctx(4);
    const rodCtx = ctx(1);
    const lampCtx = ctx(1);
    const view = new DataView(new ArrayBuffer(128));
    writers.push(
      ['service', () => service.writeRecord?.(0, view, 0, serviceCtx)],
      ['groundRod', () => rod.writeRecord?.(0, view, 0, rodCtx)],
      ['lamp', () => lamp.writeRecord?.(0, view, 0, lampCtx)],
    );
    for (const [name, call] of writers) {
      const { perCall, windows } = layerBytesPerCall(call);
      if (process.env['ALLOC_LOG'] === '1') console.log(`ALLOC record-${name} ${perCall} [${windows.join(' ')}]`);
      expect(perCall, `${name}: windows (B a call) ${windows.join(' ')}`).toBeLessThan(1);
    }
    // The gate sees an allocation: a writer that builds one small object per call reads far above it.
    let sink: unknown = null;
    const planted = () => {
      sink = { v: view.getFloat64(0, true) };
    };
    for (let k = 0; k < 200_000; k++) planted();
    expect(sampledLoopBytes(planted, 200_000) / 200_000).toBeGreaterThan(8);
    expect(sink).not.toBeNull();
  });

  it("the layer measure sees a call's allocation, and a median ignores a one-off in one window", () => {
    const rig = bankRig(AFCI_BREAKER_MODEL, plugOnParams(20), ['neutral', 'pole'], { state: { on: true, test: 0 } })
      .amps('pole', 15)
      .amps('neutral', -15);
    const ring: unknown[] = new Array(4096).fill(null);
    let at = 0;
    // 32 B a call, kept alive in a ring so escape analysis can't remove it.
    const leaky = () => {
      rig.step();
      ring[at++ & 4095] = { a: at, b: at + 1 };
    };
    expect(layerBytesPerCall(leaky).perCall).toBeGreaterThan(8);
    // 400 kB once, in the third window (as the 1.72 B a call that one 200,000-call window read).
    let calls = 0;
    const once = LAYER_WARM_UP_CALLS + 2 * LAYER_WINDOW_CALLS + 100;
    const bursty = () => {
      rig.step();
      if (++calls === once) ring[0] = new Array(50_000).fill(0.5);
    };
    expect(layerBytesPerCall(bursty).perCall).toBeLessThan(1);
    expect(calls).toBeGreaterThan(once); // the burst ran inside the measured windows
  });
});
