import {
  Box3Helper,
  BufferAttribute,
  Color,
  InstancedMesh,
  Mesh,
  Scene,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import {
  CONNECTION_OUTPUT_FIELDS,
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  CONNECTION_RECORD_OPEN,
  fakeSnapshotView,
  NetlistReadout,
  SIM_PROTOCOL_VERSION,
  type FakeIsland,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';
import { createWorldBus, type World } from '@controls/world-model';
import { routingPanelBus, rowA, rowB } from '@controls/world-model/testing';
import { GCProfiler, getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ManualFrameClock } from '../loop/manual-frame-clock';
import { RenderLoop } from '../loop/render-loop';
import { describeSceneGraph } from '../scene';
import { HEAT_LEGEND, heatStep, heatStepColour } from '../sim/heat-scale';
import { cssColour, OVER_RANGE_BIN, OVER_RANGE_COLOUR, STEP_UNKNOWN, UNKNOWN_COLOUR } from '../sim/overlay-scale';
import { ViewportController } from '../viewport-controller';
import { SimOverlays, type SnapshotFeed } from './sim-overlays';

// ADR 0010's r186 gotcha: no partial upload of an instanced attribute, ever (also an ESLint rule).
let updateRange: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  updateRange = vi.spyOn(BufferAttribute.prototype, 'addUpdateRange');
});
afterEach(() => {
  expect(updateRange).not.toHaveBeenCalled();
  updateRange.mockRestore();
});

/** A canvas stand-in with live-listener tracking (the controller spec's pattern). */
class TrackingTarget extends EventTarget {
  readonly live = new Map<string, number>();
  override addEventListener(
    t: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: AddEventListenerOptions | boolean,
  ) {
    this.live.set(t, (this.live.get(t) ?? 0) + 1);
    super.addEventListener(t, cb, o);
  }
  override removeEventListener(
    t: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: EventListenerOptions | boolean,
  ) {
    const n = this.live.get(t) ?? 0;
    if (n <= 1) this.live.delete(t);
    else this.live.set(t, n - 1);
    super.removeEventListener(t, cb, o);
  }
}
class FakeDocument extends TrackingTarget {
  pointerLockElement: unknown = null;
  readonly defaultView = new TrackingTarget();
  exitPointerLock = vi.fn();
}
class FakeCanvas extends TrackingTarget {
  readonly ownerDocument = new FakeDocument();
  readonly style: Record<string, string> = {};
  clientWidth = 1280;
  clientHeight = 720;
  focus = vi.fn();
  getRootNode() {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 };
  }
}

/** A `SimHost` stand-in: publishes views to its listeners, with a `running` flag. */
class FakeFeed implements SnapshotFeed {
  running = false;
  readonly listeners = new Set<(view: SnapshotView | null) => void>();
  subscribe(listener: (view: SnapshotView | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(view: SnapshotView | null): void {
    this.listeners.forEach((l) => l(view));
  }
}

const ref = (id: string) => ({ id, version: 1 });
const at = (x: number) => ({
  positionMm: { x, y: -300, z: 200 },
  orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
});

/** `apps/sim-cli/scenarios/sim-step.console`'s bench: a battery shorted by a switch through two leads, and an unwired lamp. */
function benchWorld(extraLeads = 0): World {
  const bus = createWorldBus(createWorld({ seed: 0 }));
  const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
  ok(bus.exec('entity.place', { ref: ref('battery.ferrovane-12v-7ah'), ...at(900) }));
  ok(bus.exec('entity.place', { ref: ref('switch.tessaline-spst-toggle'), ...at(1100) }));
  ok(bus.exec('entity.place', { ref: ref('lamp.lumivane-12v-5w'), ...at(1300) }));
  const lead = ref('lead.quillfern-test-1m');
  ok(bus.exec('lead.connect', { ref: lead, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } }));
  ok(bus.exec('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } }));
  for (let i = 0; i < extraLeads; i++) {
    // More lamps, each with a jumper across it (a lead between two terminals of one device is allowed).
    ok(bus.exec('entity.place', { ref: ref('lamp.lumivane-12v-5w'), ...at(1500 + 100 * i) }));
    const id = 4 + i;
    ok(bus.exec('lead.connect', { ref: lead, a: { entity: id, terminal: 'a' }, b: { entity: id, terminal: 'b' } }));
  }
  return bus.state;
}

/** The bench's netlist with the switch closed: the battery loop (island 0) and the lamp (island 1). */
const benchDescriptor = (): TopologyDescriptor => ({
  protocol: SIM_PROTOCOL_VERSION,
  generation: 2,
  topologyHash: '9a'.repeat(32),
  nodes: [
    { island: 0, members: [{ entity: 1, terminal: 'neg' }] },
    { island: 0, members: [{ entity: 1, terminal: 'pos' }] },
    {
      island: 0,
      members: [
        { entity: 2, terminal: 'a' },
        { entity: 2, terminal: 'b' },
      ],
    },
    { island: 1, members: [{ entity: 3, terminal: 'a' }] },
    { island: 1, members: [{ entity: 3, terminal: 'b' }] },
  ],
  branches: [
    { element: { kind: 'entity', entity: 1, part: 'cell' }, a: 0, b: 1, island: 0 },
    { element: { kind: 'connection', connection: 1 }, a: 1, b: 2, island: 0 },
    { element: { kind: 'connection', connection: 2 }, a: 2, b: 0, island: 0 },
    { element: { kind: 'entity', entity: 3, part: 'filament' }, a: 3, b: 4, island: 1 },
  ],
  islands: [
    { kind: 'dc', nodes: [0, 1, 2] },
    { kind: 'empty', nodes: [3, 4] },
  ],
  devices: [],
  schemas: {},
  connections: [],
  connectionSchemas: {},
});

const benchSnapshot = (descriptor: TopologyDescriptor, island0: FakeIsland = {}, amps = 50, volts = 11.5) =>
  fakeSnapshotView({
    descriptor,
    tick: 1234,
    nodes: [
      [0, 0],
      [volts, 0],
      [volts / 2, 0],
    ],
    branches: [
      [-amps, 0],
      [amps, 0],
      [amps, 0],
    ],
    islands: [
      { reference: 0, ...island0 },
      { iterations: 0, reference: -1 },
    ],
  });

function setup(world: World = benchWorld()) {
  const canvas = new FakeCanvas();
  const controller = new ViewportController(canvas as unknown as HTMLElement);
  controller.resize(1280, 720);
  controller.syncWorld(world);
  const feed = new FakeFeed();
  controller.overlays.attach(feed);
  const invalidations = vi.fn();
  controller.onInvalidate(invalidations);
  return { canvas, controller, feed, invalidations, overlays: controller.overlays };
}

const arrowMatrices = (overlays: SimOverlays) =>
  Array.from((overlays.group.getObjectByName('overlay:sim-arrows-dc') as InstancedMesh).instanceMatrix.array);

describe('SimOverlays in the viewport', () => {
  it('draws nothing and leaves the scene untouched while every overlay is off', () => {
    const { controller, feed } = setup();
    const before = controller.sceneGraph();
    feed.publish(benchSnapshot(benchDescriptor()));
    expect(controller.sceneGraph()).toStrictEqual(before);
    expect(controller.scene.getObjectByName('overlay:sim')).toBeUndefined();
    expect(controller.overlays.describe().inScene).toBe(false);
    controller.dispose();
  });

  it('voltage and current on the bench (band 0: no voltage scale; the unwired lamp: no reading)', () => {
    const { controller, feed, overlays } = setup();
    feed.publish(benchSnapshot(benchDescriptor()));
    overlays.setOverlay('voltage', true);
    overlays.setOverlay('current', true);
    const graph = overlays.describe();
    expect(graph).toMatchSnapshot();
    expect(graph.terminals.filter((t) => t.entity !== 3).every((t) => t.volts === 'noScale')).toBe(true);
    expect(graph.terminals.filter((t) => t.entity === 3).every((t) => t.volts === 'unknown')).toBe(true);
    // 50 A is bin 1 + 31 × log10(5e4) / 5 = 30; both leads carry it from end a to end b.
    expect(graph.leads.map((l) => [l.amps, l.direction])).toStrictEqual([
      [30, 'a→b'],
      [30, 'a→b'],
    ]);
    expect(describeSceneGraph(overlays.group)).toMatchSnapshot();
    expect(overlays.legendState).toStrictEqual({
      voltage: true,
      current: true,
      heat: false,
      heatLegend: null,
      heatUnavailable: null,
      bands: [],
      noScale: true,
      unknown: true,
    });
    controller.dispose();
  });

  it('a source reset (null) shows no reading, never 0 V', () => {
    const { controller, feed, overlays } = setup();
    overlays.setOverlay('voltage', true);
    feed.publish(benchSnapshot(benchDescriptor()));
    feed.publish(null);
    const graph = overlays.describe();
    expect(graph.terminals.every((t) => t.volts === 'unknown')).toBe(true);
    expect(graph.leads.every((l) => l.amps === 'unknown' && l.direction === 'none')).toBe(true);
    controller.dispose();
  });

  it('asks for a frame only when a drawn step changes', () => {
    const { controller, feed, overlays, invalidations } = setup();
    const d = benchDescriptor();
    overlays.setOverlay('current', true);
    feed.publish(benchSnapshot(d));
    invalidations.mockClear();
    feed.publish(benchSnapshot(d, {}, 50.5)); // same bin
    expect(invalidations).not.toHaveBeenCalled();
    feed.publish(benchSnapshot(d, {}, 5)); // a lower bin
    expect(invalidations).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('reads while the overlays are off, so switching one on draws the latest values at once', () => {
    const { controller, feed, overlays } = setup();
    feed.publish(benchSnapshot(benchDescriptor()));
    overlays.setOverlay('current', true);
    expect(overlays.describe().leads[0].amps).toBe(30);
    controller.dispose();
  });

  it('animates current only while the sim runs, and holds the arrows still under reduced motion', () => {
    const { controller, feed, overlays } = setup();
    overlays.setOverlay('current', true);
    feed.publish(benchSnapshot(benchDescriptor()));
    const rest = arrowMatrices(overlays);
    expect(controller.update(0.1)).toBe(false); // paused: static
    feed.running = true;
    expect(controller.update(0.1)).toBe(true);
    const moved = arrowMatrices(overlays);
    expect(moved).not.toStrictEqual(rest);
    overlays.setReducedMotion(true);
    expect(overlays.reducedMotion).toBe(true);
    expect(controller.update(0.1)).toBe(false);
    expect(arrowMatrices(overlays)).toStrictEqual(rest);
    overlays.setReducedMotion(false);
    expect(controller.update(0.1)).toBe(true);
    feed.running = false;
    expect(controller.update(0.1)).toBe(false); // paused again: back to rest
    expect(arrowMatrices(overlays)).toStrictEqual(rest);
    // No current: nothing to animate even while running.
    feed.running = true;
    feed.publish(benchSnapshot(benchDescriptor(), {}, 0));
    expect(controller.update(0.1)).toBe(false);
    expect(overlays.describe().leads.every((l) => l.arrows === 0)).toBe(true);
    controller.dispose();
  });

  it('keeps the render loop going while current animates, then idles', () => {
    const canvas = new FakeCanvas();
    const controller = new ViewportController(canvas as unknown as HTMLElement);
    controller.syncWorld(benchWorld());
    const feed = new FakeFeed();
    controller.overlays.attach(feed);
    const clock = new ManualFrameClock();
    const draw = vi.fn();
    const loop = new RenderLoop({ clock, update: (dt) => controller.update(dt), draw });
    controller.onInvalidate(() => loop.requestRender());
    controller.overlays.setOverlay('current', true);
    feed.running = true;
    feed.publish(benchSnapshot(benchDescriptor()));
    clock.ticks(5);
    expect(draw).toHaveBeenCalledTimes(5);
    expect(clock.pendingFrames).toBe(1);
    feed.running = false;
    clock.ticks(3);
    expect(clock.pendingFrames).toBe(0);
    loop.dispose();
    controller.dispose();
  });

  it('highlights a node’s terminals for the netlist inspector, whatever the overlays show (view state only)', () => {
    const world = benchWorld();
    const { controller, overlays, invalidations } = setup(world);
    expect(
      overlays.highlightTerminals([
        { entity: 2, terminal: 'a' },
        { entity: 2, terminal: 'b' },
        { entity: 42, terminal: 'x' }, // not drawn: skipped
      ]),
    ).toBe(2);
    expect(invalidations).toHaveBeenCalled();
    expect(controller.scene.getObjectByName('overlay:sim')).toBeDefined();
    const graph = overlays.describe();
    expect(graph.terminals.filter((t) => t.highlighted).map((t) => `${t.entity}.${t.terminal}`)).toStrictEqual([
      '2.a',
      '2.b',
    ]);
    // A world change keeps the highlight on the terminals that still exist.
    controller.syncWorld(benchWorld(1));
    expect(overlays.describe().terminals.filter((t) => t.highlighted)).toHaveLength(2);
    expect(overlays.highlightTerminals(null)).toBe(0);
    expect(controller.scene.getObjectByName('overlay:sim')).toBeUndefined();
    controller.dispose();
  });

  it('never makes the overlays pickable', () => {
    const { controller, overlays } = setup();
    overlays.setOverlay('voltage', true);
    overlays.group.traverse((o) => {
      if (o instanceof InstancedMesh) expect(Object.prototype.hasOwnProperty.call(o, 'raycast')).toBe(true);
    });
    expect(controller.selection.all.some((s) => s.id.startsWith('overlay'))).toBe(false);
    controller.dispose();
  });

  it('grows its instance buffers by doubling, disposing the meshes it replaces', () => {
    const { controller, overlays } = setup();
    overlays.setOverlay('voltage', true);
    const before = overlays.group.getObjectByName('overlay:sim-leads') as InstancedMesh;
    const disposed = vi.fn();
    before.addEventListener('dispose', disposed);
    const capacity = before.instanceMatrix.count;
    controller.syncWorld(benchWorld(6)); // 8 leads, 16 halves
    const after = overlays.group.getObjectByName('overlay:sim-leads') as InstancedMesh;
    expect(after).not.toBe(before);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(after.instanceMatrix.count).toBe(16);
    expect(after.count).toBe(16);
    expect(capacity).toBe(4);
    expect(overlays.describe().leads).toHaveLength(8);
    expect(after.visible).toBe(true);
    controller.dispose();
  });
});

describe('SimOverlays per descriptor', () => {
  it('resolves the netlist lookups once per descriptor, not per snapshot', () => {
    const { controller, feed, overlays } = setup();
    overlays.setOverlay('current', true);
    const of = vi.spyOn(NetlistReadout, 'of');
    const d1 = benchDescriptor();
    feed.publish(benchSnapshot(d1));
    feed.publish(benchSnapshot(d1, {}, 5));
    expect(of).toHaveBeenCalledTimes(1);
    feed.publish(benchSnapshot(benchDescriptor())); // a new generation: a new descriptor object
    expect(of).toHaveBeenCalledTimes(2);
    of.mockRestore();
    controller.dispose();
  });

  it('restarts the steps on a new descriptor, so no bin carries over from the old band', () => {
    const scene = new Scene();
    const overlays = new SimOverlays(scene, () => undefined, undefined, ['none', 'dc12', 'dc24']);
    overlays.syncWorld(benchWorld());
    const feed = new FakeFeed();
    overlays.attach(feed);
    overlays.setOverlay('voltage', true);
    const pos = () => overlays.describe().terminals.find((t) => t.entity === 1 && t.terminal === 'pos')?.volts;
    // dc12 (16 V full scale): 11.9 V is coordinate 23.8, bin 23.
    feed.publish(benchSnapshot(benchDescriptor(), { band: 1 }, 50, 11.9));
    expect(pos()).toBe(23);
    // dc24 (32 V): 24.2 V is coordinate 24.2. Within half a bin of 23, so hysteresis on the same
    // descriptor would keep 23; a new descriptor starts over and reads bin 24.
    feed.publish(benchSnapshot(benchDescriptor(), { band: 2 }, 50, 24.2));
    expect(pos()).toBe(24);
    overlays.dispose();
  });
});

/**
 * Bytes allocated per call of `run`, by `sim bench`'s method (apps/sim-cli/src/bench/snapshot-read.ts
 * `bytesPerRead`, which sim-cli can't share: it may import domain libs only, and this path is the
 * renderer's): a collection before each window, heap growth plus what each GC freed, the smallest of
 * a few windows, and the slope between window sizes so the profiler's fixed cost cancels out.
 */
function bytesPerCall(run: () => void, calls = 200, windows = 1, warmup = 1_000): number {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  for (let i = 0; i < warmup; i++) run();
  const window = (count: number) => {
    collect();
    const profiler = new GCProfiler();
    const start = getHeapStatistics().used_heap_size;
    profiler.start();
    for (let i = 0; i < count; i++) run();
    const stats = profiler.stop()?.statistics ?? [];
    const freed = stats.reduce(
      (sum, s) => sum + s.beforeGC.heapStatistics.usedHeapSize - s.afterGC.heapStatistics.usedHeapSize,
      0,
    );
    return getHeapStatistics().used_heap_size - start + freed;
  };
  for (const count of [calls, 2 * calls, 3 * calls]) window(count);
  const smallest = (count: number) => Math.min(...Array.from({ length: windows }, () => window(count)));
  const [one, two, three] = [smallest(calls), smallest(2 * calls), smallest(3 * calls)];
  return Math.max(0, Math.min(two - one, three - two) / calls);
}

describe('SimOverlays allocation', () => {
  it('the measure catches a call that allocates', () => {
    const kept: number[][] = [];
    expect(bytesPerCall(() => (kept[0] = new Array(8).fill(1)))).toBeGreaterThan(32);
  });

  it('a snapshot whose steps did not move, and a frame of animation, allocate nothing', () => {
    // 20 battery-and-switch pairs (40 devices, 40 leads): the gate is about per-call allocation (any
    // object is 12 B or more against a 1 B gate), so the plant only needs every kind of item.
    const pairs = 20;
    const bus = createWorldBus(createWorld({ seed: 0 }));
    const lead = ref('lead.quillfern-test-1m');
    for (let i = 0; i < pairs; i++) {
      bus.exec('entity.place', { ref: ref('battery.ferrovane-12v-7ah'), ...at(900 + 100 * i) });
      bus.exec('entity.place', { ref: ref('switch.tessaline-spst-toggle'), ...at(900 + 100 * i) });
      const [b, w] = [1 + 2 * i, 2 + 2 * i];
      bus.exec('lead.connect', { ref: lead, a: { entity: b, terminal: 'pos' }, b: { entity: w, terminal: 'a' } });
      bus.exec('lead.connect', { ref: lead, a: { entity: w, terminal: 'b' }, b: { entity: b, terminal: 'neg' } });
    }
    const term = (entity: number, terminal: string) => ({ entity, terminal });
    const descriptor: TopologyDescriptor = {
      ...benchDescriptor(),
      nodes: Array.from({ length: pairs }, (_, i) => [
        { island: i, members: [term(1 + 2 * i, 'neg')] },
        { island: i, members: [term(1 + 2 * i, 'pos')] },
        { island: i, members: [term(2 + 2 * i, 'a'), term(2 + 2 * i, 'b')] },
      ]).flat(),
      branches: Array.from({ length: pairs }, (_, i) => [
        { element: { kind: 'entity' as const, entity: 1 + 2 * i, part: 'cell' }, a: 3 * i, b: 3 * i + 1, island: i },
        { element: { kind: 'connection' as const, connection: 1 + 2 * i }, a: 3 * i + 1, b: 3 * i + 2, island: i },
        { element: { kind: 'connection' as const, connection: 2 + 2 * i }, a: 3 * i + 2, b: 3 * i, island: i },
      ]).flat(),
      islands: Array.from({ length: pairs }, (_, i) => ({ kind: 'dc' as const, nodes: [3 * i, 3 * i + 1, 3 * i + 2] })),
      connections: Array.from({ length: 2 * pairs }, (_, k) => ({
        connection: k + 1,
        kind: 'lead',
        recordOffset: k * CONNECTION_RECORD_BYTES,
        branch: 3 * Math.floor(k / 2) + 1 + (k % 2),
      })),
      connectionSchemas: { lead: CONNECTION_OUTPUT_SCHEMAS['lead'] },
    };
    const view = (amps: number) =>
      fakeSnapshotView({
        descriptor,
        nodes: Array.from(
          { length: pairs },
          () =>
            [
              [0, 0],
              [12, 0],
              [6, 0],
            ] as const,
        ).flat(),
        branches: Array.from(
          { length: pairs },
          () =>
            [
              [-amps, 0],
              [amps, 0],
              [amps, 0],
            ] as const,
        ).flat(),
        islands: Array.from({ length: pairs }, (_, i) => ({ reference: 3 * i, band: 1 })),
        connections: connectionBytes(
          Array.from({ length: 2 * pairs }, () => ({ conductorTempK: 300 + amps / 1000, status: 1 })),
        ),
      });
    const overlays = new SimOverlays(new Scene(), () => undefined, undefined, ['none', 'dc12']);
    overlays.syncWorld(bus.state);
    const feed = new FakeFeed();
    overlays.attach(feed);
    overlays.setOverlay('voltage', true);
    overlays.setOverlay('current', true);
    overlays.setOverlay('heat', true);
    // Two views of one generation, values within one bin's hysteresis: the steady per-snapshot path
    // (the readout, then the step update finding nothing to redraw).
    const [a, b] = [view(5), view(5.01)];
    feed.publish(a);
    const graph = overlays.describe();
    expect(graph.leads.every((l) => typeof l.amps === 'number' && l.amps > 0)).toBe(true);
    expect(graph.terminals.some((t) => t.volts === 24)).toBe(true);
    expect(graph.leads.every((l) => l.heat.every((h) => h === 1))).toBe(true);
    // Call the subscribed listener itself, as SimHost does: the fake's `publish` loop isn't measured.
    const [listener] = [...feed.listeners];
    let flip = false;
    const snapshotBytes = bytesPerCall(() => {
      flip = !flip;
      listener(flip ? b : a);
    });
    feed.running = true;
    const frameBytes = bytesPerCall(() => overlays.update(1 / 60));
    expect(snapshotBytes).toBeLessThan(1);
    expect(frameBytes).toBeLessThan(1);
    overlays.dispose();
  });
});

describe('SimOverlays with a synthetic band table', () => {
  it('colours a band with a scale by bin and publishes the band to the legend', () => {
    const scene = new Scene();
    const overlays = new SimOverlays(scene, () => undefined, undefined, ['none', 'dc12']);
    overlays.syncWorld(benchWorld());
    const feed = new FakeFeed();
    overlays.attach(feed);
    const legend = vi.fn();
    overlays.onLegendChange(legend);
    overlays.setOverlay('voltage', true);
    feed.publish(benchSnapshot(benchDescriptor(), { band: 1 }));
    const graph = overlays.describe();
    // dc12 is 16 V full scale: 11.5 V → bin 23, 5.75 V → bin 11, 0 V → bin 0.
    expect(graph.terminals.map((t) => `${t.entity}.${t.terminal}=${t.volts}`)).toStrictEqual([
      '1.neg=0',
      '1.pos=23',
      '2.a=11',
      '2.b=11',
      '3.a=unknown',
      '3.b=unknown',
    ]);
    expect(graph.leads.map((l) => l.volts)).toStrictEqual([
      [23, 11],
      [11, 0],
    ]);
    expect(legend).toHaveBeenLastCalledWith({
      voltage: true,
      current: false,
      heat: false,
      heatLegend: null,
      heatUnavailable: null,
      bands: ['dc12'],
      noScale: false,
      unknown: true,
    });
    overlays.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

// --- D15: the overlays recolour conductor instances (F3.2 part 2) ------------------------------

/**
 * The routing panel's wire 1 (row A block 0's b to row B block 0's b) compiled to a branch between two
 * nodes of one DC island, at 12 V and 6 V with 2 A, and wire 2 left out of the netlist (unknown).
 */
const panelDescriptor = (): TopologyDescriptor => ({
  protocol: SIM_PROTOCOL_VERSION,
  generation: 3,
  topologyHash: '7c'.repeat(32),
  nodes: [
    { island: 0, members: [{ entity: rowA(0), terminal: 'b' }] },
    { island: 0, members: [{ entity: rowB(0), terminal: 'b' }] },
  ],
  branches: [{ element: { kind: 'connection', connection: 1 }, a: 0, b: 1, island: 0 }],
  islands: [{ kind: 'dc', nodes: [0, 1] }],
  devices: [],
  schemas: {},
  connections: [],
  connectionSchemas: {},
});
const panelSnapshot = () =>
  fakeSnapshotView({
    descriptor: panelDescriptor(),
    tick: 7,
    nodes: [
      [12, 0],
      [6, 0],
    ],
    branches: [[2, 0]],
    islands: [{ reference: 1, band: 1 }],
  });

describe('SimOverlays recolour the wire renderer’s conductors (D15)', () => {
  const panelSetup = () => {
    const canvas = new FakeCanvas();
    const controller = new ViewportController(canvas as unknown as HTMLElement);
    controller.syncWorld(routingPanelBus(true).state);
    const feed = new FakeFeed();
    controller.overlays.attach(feed);
    return { controller, feed, overlays: controller.overlays };
  };

  it('draws no lead segment of its own for a conductor; colours its halves by its ends instead', () => {
    const { controller, feed, overlays } = panelSetup();
    const own = controller.wireGraph().routes.map((r) => r.colour);
    expect(controller.wireGraph().routes.every((r) => r.tint === null)).toBe(true);
    feed.publish(panelSnapshot());
    overlays.setOverlay('voltage', true);
    const graph = overlays.describe();
    expect(graph.leads).toStrictEqual([]); // conductors are the wire renderer's, never an overlay lead
    expect(graph.conductors).toHaveLength(8);
    // Wire 1's ends have readings; the wires outside the netlist are unknown, never 0 V.
    expect(graph.conductors[0].volts.every((v) => v !== 'unknown')).toBe(true);
    expect(graph.conductors.slice(1).every((c) => c.volts.every((v) => v === 'unknown'))).toBe(true);
    const wires = controller.wireGraph();
    expect(wires.routes.every((r) => r.tint !== null)).toBe(true);
    expect(wires.routes[0].tint).not.toStrictEqual(wires.routes[1].tint);
    // The unknown conductors are all drawn in the unknown colour, both halves.
    expect(new Set(wires.routes.slice(1).map((r) => r.tint?.join()))).toHaveProperty('size', 1);
    // Current only: one colour per conductor (its current's bin), both halves.
    overlays.setOverlay('voltage', false);
    overlays.setOverlay('current', true);
    expect(overlays.describe().conductors[0].amps).not.toBe('unknown');
    const [a, b] = controller.wireGraph().routes[0].tint ?? [];
    expect(a).toBe(b);
    // Both off: back to the insulation colours.
    overlays.setOverlay('current', false);
    expect(controller.wireGraph().routes.map((r) => (r.tint === null ? r.colour : 'tinted'))).toStrictEqual(own);
    controller.dispose();
  });

  it('tints a wire added while the voltage overlay is on (unknown until the netlist has it)', () => {
    const bus = routingPanelBus(true);
    const seven = { ...bus.state, connections: bus.state.connections.slice(0, 7) };
    const canvas = new FakeCanvas();
    const controller = new ViewportController(canvas as unknown as HTMLElement);
    controller.syncWorld(seven);
    const feed = new FakeFeed();
    controller.overlays.attach(feed);
    feed.publish(panelSnapshot());
    controller.overlays.setOverlay('voltage', true);
    expect(controller.wireGraph().routes).toHaveLength(7);
    controller.syncWorld(bus.state); // wire 8 lands while the overlay is on
    const routes = controller.wireGraph().routes;
    expect(routes).toHaveLength(8);
    expect(routes[7].tint).not.toBeNull();
    // Not in this descriptor: drawn unknown, like wires 2–7, never in its insulation colour.
    expect(routes[7].tint).toStrictEqual(routes[1].tint);
    expect(controller.overlays.describe().conductors[7].volts).toStrictEqual(['unknown', 'unknown']);
    controller.dispose();
  });

  it('draws a cable in the unknown colour while an overlay is on: no reading for its jacket (R1)', () => {
    const { controller, feed, overlays } = panelSetup();
    const free = (x: number) => ({
      kind: 'free' as const,
      positionMm: { x, y: 600, z: 40 },
      entity: null,
      fixture: null,
      tool: null,
    });
    const world = routingPanelBus(true).state;
    controller.syncWorld({
      ...world,
      cables: [
        {
          id: 1,
          ref: { id: 'cable.sorrelby-nmb-12-2', version: 1 },
          a: null,
          b: null,
          route: [free(0), free(400)],
          lengthMm: 404,
          tailsMm: { a: 0, b: 0 },
          jacketStripMm: { a: 0, b: 0 },
          label: null,
          extensions: {},
        },
      ],
      nextCableId: 2,
    });
    feed.publish(panelSnapshot());
    const cable = () => controller.wireGraph().routes.find((r) => r.owner === 'k1');
    expect(cable()?.tint).toBeNull();
    overlays.setOverlay('current', true);
    const unknownConductor = controller.wireGraph().routes[1].tint; // wire 2 is outside the netlist
    expect(cable()?.tint).toStrictEqual(unknownConductor);
    overlays.setOverlay('current', false);
    expect(cable()?.tint).toBeNull();
    controller.dispose();
  });

  it('a snapshot that moves a conductor’s colour recolours it; one that does not rewrites nothing', () => {
    const { controller, feed, overlays } = panelSetup();
    overlays.setOverlay('current', true);
    feed.publish(panelSnapshot());
    const first = controller.wireGraph().routes[0].tint;
    const mesh = controller.scene.getObjectByName('wires:thhnThwn2') as InstancedMesh;
    const version = mesh.instanceColor?.version;
    feed.publish(panelSnapshot());
    expect(mesh.instanceColor?.version).toBe(version);
    feed.publish(
      fakeSnapshotView({
        descriptor: panelDescriptor(),
        tick: 8,
        nodes: [
          [12, 0],
          [6, 0],
        ],
        branches: [[200, 0]],
        islands: [{ reference: 1, band: 1 }],
      }),
    );
    // 2 A → 200 A moves the current bin: the wires rewrite their colours (and only then).
    expect(controller.wireGraph().routes[0].tint).not.toStrictEqual(first);
    expect(mesh.instanceColor?.version).toBeGreaterThan(version ?? 0);
    controller.dispose();
  });
});

// --- F3.6 part 3: the heat overlay -------------------------------------------------------------

/** Connection record bytes: per record, values by field name (u8 fields by code). */
function connectionBytes(records: readonly Readonly<Record<string, number>>[]): Uint8Array {
  const bytes = new Uint8Array(records.length * CONNECTION_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  records.forEach((record, i) => {
    for (const [name, value] of Object.entries(record)) {
      const field = CONNECTION_OUTPUT_FIELDS.find((f) => f.name === name);
      if (field === undefined) throw new Error(`no field ${name}`);
      const at = i * CONNECTION_RECORD_BYTES + field.offset;
      if (field.type === 'f64') view.setFloat64(at, value, true);
      else view.setUint8(at, value);
    }
  });
  return bytes;
}

/** The routing panel's netlist with records for wires 1 (netlisted) and 2 (open); wires 3–8 have none. */
const heatDescriptor = (): TopologyDescriptor => ({
  ...panelDescriptor(),
  connections: [
    { connection: 1, kind: 'conductor', recordOffset: 0, branch: 0 },
    { connection: 2, kind: 'conductor', recordOffset: CONNECTION_RECORD_BYTES, branch: -1 },
  ],
  connectionSchemas: { conductor: CONNECTION_OUTPUT_SCHEMAS['conductor'] },
});
/** One generation: a new descriptor object is a new generation (steps restart), which the game never sends per snapshot. */
const HEAT_DESCRIPTOR = heatDescriptor();
/** Wire 1: a 394 K loose end a on a 303 K conductor (the bad-termination figures). Wire 2: open, end b at `openEndK`. */
const heatSnapshot = (looseEndK = 393.822, openEndK = 450) =>
  fakeSnapshotView({
    descriptor: HEAT_DESCRIPTOR,
    tick: 9,
    nodes: [
      [12, 0],
      [6, 0],
    ],
    branches: [[2, 0]],
    islands: [{ reference: 1, band: 1 }],
    connections: connectionBytes([
      { conductorTempK: 303.033, endATempK: looseEndK, endAState: 1, endBTempK: 301.709, endBState: 1, status: 1 },
      { conductorTempK: 293.15, endBTempK: openEndK, endBState: 3, status: CONNECTION_RECORD_OPEN },
    ]),
  });

describe('SimOverlays heat overlay (F3.6 part 3)', () => {
  const panelSetup = (world: World = routingPanelBus(true).state) => {
    const canvas = new FakeCanvas();
    const controller = new ViewportController(canvas as unknown as HTMLElement);
    controller.syncWorld(world);
    const feed = new FakeFeed();
    controller.overlays.attach(feed);
    const legend = vi.fn();
    controller.overlays.onLegendChange(legend);
    return { controller, feed, overlays: controller.overlays, legend };
  };
  const hex = (step: number) => cssColour(heatStepColour(step));

  it('colours each conductor half by its hottest node; no record is unknown, never cold', () => {
    const { controller, feed, overlays, legend } = panelSetup();
    const own = controller.wireGraph().routes.map((r) => r.colour);
    feed.publish(heatSnapshot());
    overlays.setOverlay('heat', true);
    const graph = overlays.describe();
    expect(graph.heat).toBe(true);
    expect(graph.inScene).toBe(true);
    expect(graph.conductors.map((c) => c.heat)).toStrictEqual([
      [16, 1], // the loose end's half at the overheat point; the good end's half its 302 K
      [0, 20], // open, not netlisted: its free end shows the conductor at ambient, its open end 450 K (past oxidation onset)
      ...Array.from({ length: 6 }, () => ['unknown', 'unknown']),
    ]);
    const routes = controller.wireGraph().routes;
    expect(routes.map((r) => r.tint)).toStrictEqual([
      [hex(16), hex(1)],
      [hex(0), hex(20)],
      ...Array.from({ length: 6 }, () => [cssColour(UNKNOWN_COLOUR), cssColour(UNKNOWN_COLOUR)]),
    ]);
    expect(hex(0)).not.toBe(cssColour(UNKNOWN_COLOUR));
    expect(legend).toHaveBeenLastCalledWith({
      voltage: false,
      current: false,
      heat: true,
      heatLegend: HEAT_LEGEND,
      heatUnavailable: null,
      bands: [],
      noScale: false,
      unknown: true,
    });
    // Off: back to the insulation colours, and out of the scene.
    overlays.setOverlay('heat', false);
    expect(controller.wireGraph().routes.map((r) => (r.tint === null ? r.colour : 'tinted'))).toStrictEqual(own);
    expect(overlays.describe().inScene).toBe(false);
    expect(controller.scene.getObjectByName('overlay:sim')).toBeUndefined();
    controller.dispose();
  });

  it('takes the conductor colours from voltage and current while it is on, and gives them back', () => {
    const { controller, feed, overlays } = panelSetup();
    feed.publish(heatSnapshot());
    overlays.setOverlay('voltage', true);
    const voltageTint = controller.wireGraph().routes[0].tint;
    overlays.setOverlay('heat', true);
    expect(controller.wireGraph().routes[0].tint).toStrictEqual([hex(16), hex(1)]);
    expect(overlays.legendState).toMatchObject({ voltage: true, heat: true });
    overlays.setOverlay('heat', false);
    expect(controller.wireGraph().routes[0].tint).toStrictEqual(voltageTint);
    controller.dispose();
  });

  it('draws a cable as no reading: there is no record for its jacket', () => {
    const { controller, feed, overlays } = panelSetup();
    const free = (x: number) => ({
      kind: 'free' as const,
      positionMm: { x, y: 600, z: 40 },
      entity: null,
      fixture: null,
      tool: null,
    });
    const world = routingPanelBus(true).state;
    controller.syncWorld({
      ...world,
      cables: [
        {
          id: 1,
          ref: { id: 'cable.sorrelby-nmb-12-2', version: 1 },
          a: null,
          b: null,
          route: [free(0), free(400)],
          lengthMm: 404,
          tailsMm: { a: 0, b: 0 },
          jacketStripMm: { a: 0, b: 0 },
          label: null,
          extensions: {},
        },
      ],
      nextCableId: 2,
    });
    feed.publish(heatSnapshot());
    overlays.setOverlay('heat', true);
    const cable = controller.wireGraph().routes.find((r) => r.owner === 'k1');
    expect(cable?.tint).toStrictEqual([cssColour(UNKNOWN_COLOUR), cssColour(UNKNOWN_COLOUR)]);
    controller.dispose();
  });

  it('rewrites conductor colours only when a heat step moves, and asks for a frame only then', () => {
    const { controller, feed, overlays } = panelSetup();
    const invalidations = vi.fn();
    controller.onInvalidate(invalidations);
    overlays.setOverlay('heat', true);
    feed.publish(heatSnapshot());
    const mesh = controller.scene.getObjectByName('wires:thhnThwn2') as InstancedMesh;
    const version = mesh.instanceColor?.version ?? 0;
    const frames = invalidations.mock.calls.length;
    // Within the hysteresis: nothing is rewritten and no frame is requested.
    feed.publish(heatSnapshot(394.4, 451));
    expect(mesh.instanceColor?.version).toBe(version);
    expect(invalidations.mock.calls.length).toBe(frames);
    // Voltage moves while heat is shown: the conductors' colours are heat's, so nothing changes either.
    feed.publish(
      fakeSnapshotView({
        ...heatSnapshotInput(),
        nodes: [
          [11, 0],
          [1, 0],
        ],
      }),
    );
    expect(mesh.instanceColor?.version).toBe(version);
    // The loose end runs away: its half is rewritten.
    feed.publish(heatSnapshot(700));
    expect(controller.wireGraph().routes[0].tint?.[0]).toBe(hex(overlays.describe().conductors[0].heat[0] as number));
    expect(overlays.describe().conductors[0].heat[0]).toBeGreaterThan(16);
    expect(mesh.instanceColor?.version).toBeGreaterThan(version);
    expect(invalidations.mock.calls.length).toBeGreaterThan(frames);
    controller.dispose();
  });

  it('colours test leads by their conductor temperature, both halves', () => {
    const { controller, feed, overlays } = setup();
    const descriptor: TopologyDescriptor = {
      ...benchDescriptor(),
      connections: [
        { connection: 1, kind: 'lead', recordOffset: 0, branch: 1 },
        { connection: 2, kind: 'lead', recordOffset: CONNECTION_RECORD_BYTES, branch: 2 },
      ],
      connectionSchemas: { lead: CONNECTION_OUTPUT_SCHEMAS['lead'] },
    };
    const view = (leadK: number) =>
      fakeSnapshotView({
        descriptor,
        tick: 1234,
        nodes: [
          [0, 0],
          [11.5, 0],
          [5.75, 0],
        ],
        branches: [
          [-50, 0],
          [50, 0],
          [50, 0],
        ],
        islands: [{ reference: 0 }, { iterations: 0, reference: -1 }],
        connections: connectionBytes([
          { conductorTempK: leadK, status: 1 },
          { conductorTempK: 1357.77, status: 1 }, // a shorted lead at copper's melting point
        ]),
      });
    feed.publish(view(317));
    overlays.setOverlay('heat', true);
    const graph = overlays.describe();
    expect(graph.leads.map((l) => l.heat)).toStrictEqual([
      [heatStep(317, STEP_UNKNOWN), heatStep(317, STEP_UNKNOWN)],
      [OVER_RANGE_BIN, OVER_RANGE_BIN],
    ]);
    // Lead segments are drawn; terminal markers are voltage's, so they stay hidden.
    expect(controller.scene.getObjectByName('overlay:sim-leads')?.visible).toBe(true);
    expect(controller.scene.getObjectByName('overlay:sim-terminals')?.visible).toBe(false);
    const leads = controller.scene.getObjectByName('overlay:sim-leads') as InstancedMesh;
    const colour = new Color();
    leads.getColorAt(3, colour);
    expect(colour.getHex()).toBe(OVER_RANGE_COLOUR);
    expect(describeSceneGraph(overlays.group)).toMatchSnapshot();
    controller.dispose();
  });

  it('a catalogue with no usable heat scale makes heat unavailable with a reason, never a crash', () => {
    const scene = new Scene();
    const modded: Catalog = { ...BUILTIN_CATALOG, tables: [] };
    const legend = vi.fn();
    const overlays = new SimOverlays(scene, () => undefined, modded);
    overlays.onLegendChange(legend);
    overlays.syncWorld(benchWorld());
    const feed = new FakeFeed();
    overlays.attach(feed);
    overlays.setOverlay('heat', true);
    feed.publish(benchSnapshot(benchDescriptor()));
    expect(overlays.describe().leads.map((l) => l.heat)).toStrictEqual([
      ['unknown', 'unknown'],
      ['unknown', 'unknown'],
    ]);
    expect(legend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        heat: true,
        heatLegend: null,
        heatUnavailable: 'the catalogue has no insulation rating or no melting point',
        unknown: true,
      }),
    );
    overlays.dispose();
  });

  it('disposes everything with heat on, and leaves no tint behind', () => {
    const { controller, feed, overlays } = panelSetup();
    feed.publish(heatSnapshot());
    overlays.setOverlay('heat', true);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    controller.scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    controller.dispose();
    controller.dispose();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(feed.listeners.size).toBe(0);
    expect(controller.scene.getObjectByName('overlay:sim')).toBeUndefined();
    expect(controller.scene.getObjectByName('wires')).toBeUndefined();
    expect(() => feed.publish(heatSnapshot(900))).not.toThrow();
  });
});

/** {@link heatSnapshot}'s input, for variants. */
function heatSnapshotInput() {
  return {
    descriptor: HEAT_DESCRIPTOR,
    tick: 10,
    nodes: [
      [12, 0],
      [6, 0],
    ] as [number, number][],
    branches: [[2, 0]] as [number, number][],
    islands: [{ reference: 1, band: 1 }],
    connections: connectionBytes([
      { conductorTempK: 303.033, endATempK: 393.822, endAState: 1, endBTempK: 301.709, endBState: 1, status: 1 },
      { conductorTempK: 293.15, endBTempK: 450, endBState: 3, status: CONNECTION_RECORD_OPEN },
    ]),
  };
}

describe('SimOverlays disposal', () => {
  it('disposes every geometry and material exactly once, unsubscribes and leaves the scene', () => {
    const { canvas, controller, feed, overlays } = setup();
    overlays.setOverlay('voltage', true);
    overlays.setOverlay('current', true);
    overlays.highlightTerminals([{ entity: 1, terminal: 'pos' }]);
    feed.running = true;
    feed.publish(benchSnapshot(benchDescriptor()));
    controller.update(1 / 60);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const meshes: Mesh[] = [];
    controller.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Box3Helper) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
      if (o instanceof InstancedMesh) meshes.push(o);
    });
    expect(meshes.length).toBe(6);
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    const meshDisposed = vi.fn();
    meshes.forEach((m) => m.addEventListener('dispose', meshDisposed));
    controller.dispose();
    controller.dispose();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(meshDisposed).toHaveBeenCalledTimes(6); // every instanced mesh's instance buffers
    expect(feed.listeners.size).toBe(0);
    expect(controller.scene.getObjectByName('overlay:sim')).toBeUndefined();
    expect(canvas.live.size).toBe(0);
    // A late snapshot after disposal is ignored.
    expect(() => feed.publish(benchSnapshot(benchDescriptor()))).not.toThrow();
  });

  it('attach replaces the subscription; null detaches and resets to no reading', () => {
    const { controller, feed, overlays } = setup();
    overlays.setOverlay('current', true);
    feed.publish(benchSnapshot(benchDescriptor()));
    const other = new FakeFeed();
    overlays.attach(other);
    expect(feed.listeners.size).toBe(0);
    expect(other.listeners.size).toBe(1);
    expect(overlays.describe().leads[0].amps).toBe('unknown');
    overlays.attach(null);
    expect(other.listeners.size).toBe(0);
    controller.dispose();
  });
});
