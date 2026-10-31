import { createWorld } from '@controls/save-format';
import { ManualFrameClock } from './loop/manual-frame-clock';

/**
 * `ViewportRenderer` with a fake `WebGPURenderer` (no GPU in Node): proves the GPU shell wires the
 * on-demand loop correctly. three's own animation loop is stopped, an idle viewport draws nothing,
 * its own triggers (context restore, page shown, resize) draw, and dispose leaves no listener or
 * pending frame behind.
 */
const fake = vi.hoisted(() => ({ renderers: [] as unknown[] }));

vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  class FakeWebGPURenderer {
    readonly backend = { isWebGPUBackend: false };
    readonly info = {
      render: { drawCalls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
      reset: vi.fn(function (this: { render: { drawCalls: number; triangles: number } }) {
        this.render.drawCalls = 0;
        this.render.triangles = 0;
      }),
    };
    readonly _animation = { stop: vi.fn() };
    readonly render = vi.fn(() => {
      this.info.render.drawCalls += 3;
      this.info.render.triangles += 12;
    });
    readonly setPixelRatio = vi.fn();
    readonly setSize = vi.fn();
    readonly dispose = vi.fn();
    readonly domElement: unknown;
    constructor(options: { canvas: unknown }) {
      this.domElement = options.canvas;
      fake.renderers.push(this);
    }
    init(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, WebGPURenderer: FakeWebGPURenderer };
});

const { ViewportRenderer } = await import('./viewport-renderer');

type FakeRenderer = {
  render: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  _animation: { stop: ReturnType<typeof vi.fn> };
};

/** EventTarget that counts live listeners. */
class TrackingTarget extends EventTarget {
  readonly live = new Map<string, number>();
  override addEventListener(
    type: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: AddEventListenerOptions | boolean,
  ): void {
    this.live.set(type, (this.live.get(type) ?? 0) + 1);
    super.addEventListener(type, cb, o);
  }
  override removeEventListener(
    type: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: EventListenerOptions | boolean,
  ): void {
    const n = this.live.get(type) ?? 0;
    if (n <= 1) this.live.delete(type);
    else this.live.set(type, n - 1);
    super.removeEventListener(type, cb, o);
  }
}

/** A window whose frames, clock and timers come from a ManualFrameClock. */
class FakeWindow extends TrackingTarget {
  constructor(readonly clock: ManualFrameClock) {
    super();
  }
  readonly performance = { now: () => this.clock.now() };
  requestAnimationFrame = (cb: (t: number) => void) => this.clock.requestFrame(cb);
  cancelAnimationFrame = (h: number) => this.clock.cancelFrame(h);
  setTimeout = (cb: () => void, ms: number) => this.clock.setTimer(cb, ms);
  clearTimeout = (h: number) => this.clock.clearTimer(h);
}

class FakeDocument extends TrackingTarget {
  pointerLockElement: unknown = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  constructor(readonly defaultView: FakeWindow) {
    super();
  }
  exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

class FakeCanvas extends TrackingTarget {
  readonly style: Record<string, string> = {};
  clientWidth = 1280;
  clientHeight = 720;
  width = 1280;
  height = 720;
  constructor(readonly ownerDocument: FakeDocument) {
    super();
  }
  getRootNode(): FakeDocument {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 };
  }
}

async function start() {
  const clock = new ManualFrameClock();
  const doc = new FakeDocument(new FakeWindow(clock));
  const canvas = new FakeCanvas(doc);
  const viewport = new ViewportRenderer();
  await viewport.init(canvas as unknown as HTMLCanvasElement);
  const gpu = fake.renderers.at(-1) as FakeRenderer;
  clock.ticks(3);
  return { clock, doc, canvas, viewport, gpu };
}

describe('ViewportRenderer (fake GPU)', () => {
  it("stops three's own animation loop and draws the first frame, then idles", async () => {
    const { clock, viewport, gpu } = await start();
    expect(gpu._animation.stop).toHaveBeenCalledTimes(1);
    expect(gpu.render).toHaveBeenCalledTimes(1);
    clock.ticks(300);
    expect(gpu.render).toHaveBeenCalledTimes(1);
    expect(clock.pendingFrames).toBe(0);
    expect(viewport.framesDrawn).toBe(1);
    // Counters are the last frame's, not a running total (info is reset before each draw).
    expect(viewport.stats()).toMatchObject({ drawCalls: 3, triangles: 12 });
    viewport.dispose();
  });

  it('draws on requestRender, controller changes, context restore and the page being shown', async () => {
    const { clock, doc, canvas, viewport, gpu } = await start();
    const drawsAfter = (act: () => void) => {
      gpu.render.mockClear();
      act();
      clock.ticks(3);
      return gpu.render.mock.calls.length;
    };
    expect(drawsAfter(() => viewport.requestRender())).toBe(1);
    expect(drawsAfter(() => viewport.setMode('walk'))).toBe(1);
    expect(drawsAfter(() => canvas.dispatchEvent(new Event('webglcontextrestored')))).toBe(1);
    expect(drawsAfter(() => doc.dispatchEvent(new Event('visibilitychange')))).toBe(1);
    doc.visibilityState = 'hidden';
    expect(drawsAfter(() => doc.dispatchEvent(new Event('visibilitychange')))).toBe(0);
    expect(viewport.stats()).toMatchObject({ drawCalls: 3, triangles: 12 });
    viewport.dispose();
  });

  it('keeps lamp outputs given before init, and draws a lamp change only when a drawn level moves', async () => {
    const clock = new ManualFrameClock();
    const doc = new FakeDocument(new FakeWindow(clock));
    const canvas = new FakeCanvas(doc);
    const viewport = new ViewportRenderer();
    const lamp = {
      id: 1,
      ref: { id: 'lamp.lumivane-12v-5w', version: 1 },
      transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      state: {},
      sim: {},
      extensions: {},
    };
    viewport.syncWorld({ ...createWorld({ seed: 0 }), nextEntityId: 2, entities: [lamp] });
    viewport.setLampOutputs(new Map([[1, { lightOutputRel: 1, status: 'solved' as const }]]));
    await viewport.init(canvas as unknown as HTMLCanvasElement);
    const gpu = fake.renderers.at(-1) as FakeRenderer;
    clock.ticks(3);
    const world = () => viewport.sceneGraph()?.children?.find((c) => c.name === 'world');
    expect(world()?.children?.[0]?.lamp).toStrictEqual({ level: 204, status: 'solved' });
    const drawsAfter = (act: () => void) => {
      gpu.render.mockClear();
      act();
      clock.ticks(3);
      return gpu.render.mock.calls.length;
    };
    expect(drawsAfter(() => viewport.setLampOutputs(new Map([[1, { lightOutputRel: 1, status: 'solved' }]])))).toBe(0);
    expect(drawsAfter(() => viewport.setLampOutputs(new Map([[1, { lightOutputRel: 0.5, status: 'solved' }]])))).toBe(
      1,
    );
    expect(drawsAfter(() => viewport.setLampOutputs(new Map()))).toBe(1); // unknown
    expect(world()?.children?.[0]?.lamp).toStrictEqual({ level: 0, status: 'unknown' });
    viewport.dispose();
  });

  it('a resize draws in the same task (resizing clears the canvas)', async () => {
    const { viewport, gpu } = await start();
    gpu.render.mockClear();
    viewport.resize(800, 600, 1);
    expect(gpu.setSize).toHaveBeenCalledWith(800, 600, false);
    expect(gpu.render).toHaveBeenCalledTimes(1);
    viewport.dispose();
  });

  it('afterFrames and whenIdle resolve from drawn frames', async () => {
    const { clock, viewport, gpu } = await start();
    gpu.render.mockClear();
    const frames = viewport.afterFrames(2);
    clock.ticks(2);
    await frames;
    expect(gpu.render).toHaveBeenCalledTimes(2);
    viewport.requestRender();
    const idle = viewport.whenIdle();
    clock.tick();
    await idle;
    viewport.dispose();
  });

  it('dispose removes every listener, cancels the pending frame and disposes the GPU renderer', async () => {
    const { clock, doc, canvas, viewport, gpu } = await start();
    viewport.requestRender();
    viewport.dispose();
    expect(clock.pendingFrames).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(canvas.live.size).toBe(0);
    expect(doc.live.size).toBe(0);
    expect(doc.defaultView.live.size).toBe(0);
    expect(gpu.dispose).toHaveBeenCalledTimes(1);
    viewport.requestRender();
    clock.ticks(3);
    expect(viewport.framesDrawn).toBe(0);
  });
});
