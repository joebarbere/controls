import { ManualFrameClock } from './manual-frame-clock';
import { RenderLoop } from './render-loop';

const setup = (options: { animateFor?: number; frameCostMs?: number; stats?: boolean } = {}) => {
  const clock = new ManualFrameClock();
  const dts: number[] = [];
  let animateFor = options.animateFor ?? 0;
  const draw = vi.fn(() => clock.advance(options.frameCostMs ?? 0));
  const onStats = vi.fn();
  const loop = new RenderLoop({
    clock,
    update: (dt) => {
      dts.push(dt);
      return animateFor-- > 0;
    },
    draw,
    onStats: options.stats ? onStats : undefined,
  });
  return { clock, loop, draw, dts, onStats, animate: (frames: number) => (animateFor = frames) };
};

describe('RenderLoop', () => {
  it('draws nothing and requests no animation frame until asked', () => {
    const { clock, loop, draw } = setup();
    clock.ticks(10);
    expect(draw).not.toHaveBeenCalled();
    expect(clock.pendingFrames).toBe(0);
    expect(loop.pending).toBe(false);
  });

  it('coalesces requests into one frame, then goes idle', () => {
    const { clock, loop, draw } = setup();
    loop.requestRender();
    loop.requestRender();
    loop.requestRender();
    expect(clock.pendingFrames).toBe(1);
    clock.tick();
    expect(draw).toHaveBeenCalledTimes(1);
    clock.ticks(10);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(clock.pendingFrames).toBe(0);
    expect(loop.frames).toBe(1);
  });

  it('keeps drawing while update says an animation runs, with real dt only back to back', () => {
    const { clock, loop, draw, dts } = setup({ animateFor: 3 });
    loop.requestRender();
    clock.ticks(10);
    // Frame 1 follows idle time (dt 0, nothing jumps); frames 2-4 are back to back (16 ms); then idle.
    expect(draw).toHaveBeenCalledTimes(4);
    expect(dts).toEqual([0, 0.016, 0.016, 0.016]);
    expect(clock.pendingFrames).toBe(0);
  });

  it('renderNow draws in the same task, idle or not, and continues an animation it starts', () => {
    const { clock, loop, draw, animate } = setup();
    loop.renderNow();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(clock.pendingFrames).toBe(0);
    animate(1);
    loop.renderNow();
    expect(clock.pendingFrames).toBe(1);
  });

  it('afterFrames requests and waits for frames; whenIdle waits for the pending one', async () => {
    const { clock, loop, draw } = setup();
    await loop.whenIdle(); // nothing pending: resolves at once
    let done = false;
    const waited = loop.afterFrames(3).then(() => (done = true));
    clock.ticks(2);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.tick();
    await waited;
    expect(draw).toHaveBeenCalledTimes(3);
    clock.ticks(5);
    expect(draw).toHaveBeenCalledTimes(3); // and idle again

    loop.requestRender();
    let idle = false;
    const settled = loop.whenIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    clock.tick();
    await settled;
  });

  it('reports stats while drawing, then once more as idle, then stays quiet', () => {
    const { clock, loop, onStats } = setup({ animateFor: 40, frameCostMs: 2, stats: true });
    loop.requestRender();
    clock.tick();
    expect(onStats).toHaveBeenCalledTimes(1); // the first frame reports at once
    const first = loop.sampleTiming();
    expect(first).toMatchObject({ windowFrames: 1, avgMs: 2, idle: false, fps: 0 });
    clock.ticks(40); // 640 ms of animation: one more report on the 500 ms interval
    expect(onStats).toHaveBeenCalledTimes(2);
    const animating = loop.sampleTiming();
    expect(animating.fps).toBeCloseTo(1000 / 18, 6); // 16 ms vsync + 2 ms drawing each
    expect(animating.idle).toBe(false);
    // Idle now: the trailing report fires with what was drawn since, then one with nothing (idle).
    clock.ticks(100);
    expect(onStats).toHaveBeenCalledTimes(4);
    expect(loop.sampleTiming()).toMatchObject({ idle: true, lastMs: 2 });
    expect(clock.pendingTimers).toBe(0);
  });

  it('dispose cancels the pending frame and timers and releases waiters', async () => {
    const { clock, loop, draw } = setup({ stats: true });
    loop.requestRender();
    clock.tick();
    loop.requestRender();
    const waiting = loop.afterFrames(5);
    loop.dispose();
    loop.dispose(); // idempotent
    await waiting;
    expect(clock.pendingFrames).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    loop.requestRender();
    loop.renderNow();
    clock.ticks(5);
    expect(draw).toHaveBeenCalledTimes(1);
  });
});
