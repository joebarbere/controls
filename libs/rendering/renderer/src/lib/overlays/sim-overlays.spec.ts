import { Box3Helper, InstancedMesh, Mesh, Scene, type BufferGeometry, type Material } from 'three/webgpu';
import { createWorld } from '@controls/save-format';
import {
  fakeSnapshotView,
  NetlistReadout,
  SIM_PROTOCOL_VERSION,
  type FakeIsland,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';
import { createWorldBus, type World } from '@controls/world-model';
import { GCProfiler, getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ManualFrameClock } from '../loop/manual-frame-clock';
import { RenderLoop } from '../loop/render-loop';
import { describeSceneGraph } from '../scene';
import { ViewportController } from '../viewport-controller';
import { SimOverlays, type SnapshotFeed } from './sim-overlays';

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
      });
    const overlays = new SimOverlays(new Scene(), () => undefined, undefined, ['none', 'dc12']);
    overlays.syncWorld(bus.state);
    const feed = new FakeFeed();
    overlays.attach(feed);
    overlays.setOverlay('voltage', true);
    overlays.setOverlay('current', true);
    // Two views of one generation, values within one bin's hysteresis: the steady per-snapshot path
    // (the readout, then the step update finding nothing to redraw).
    const [a, b] = [view(5), view(5.01)];
    feed.publish(a);
    const graph = overlays.describe();
    expect(graph.leads.every((l) => typeof l.amps === 'number' && l.amps > 0)).toBe(true);
    expect(graph.terminals.some((t) => t.volts === 24)).toBe(true);
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
      bands: ['dc12'],
      noScale: false,
      unknown: true,
    });
    overlays.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

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
