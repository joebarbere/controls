import { FrameTimer } from './frame-timer';

describe('FrameTimer', () => {
  it('reports the mean and worst frame cost per window', () => {
    const t = new FrameTimer();
    t.record(4);
    t.record(12); // a slow frame
    const s = t.sample();
    expect(s).toMatchObject({ avgMs: 8, worstMs: 12, lastMs: 12, windowFrames: 2, idle: false, frames: 2 });
    t.record(2);
    // A new window: the slow frame above no longer counts.
    expect(t.sample()).toMatchObject({ avgMs: 2, worstMs: 2, lastMs: 2, windowFrames: 1, frames: 3 });
  });

  it('derives a frame rate only from back-to-back frames', () => {
    const t = new FrameTimer();
    t.record(3); // after idle: no interval
    expect(t.sample().fps).toBe(0);
    t.record(3, 16);
    t.record(3, 24);
    expect(t.sample().fps).toBeCloseTo(50, 9); // mean interval 20 ms
  });

  it('an empty window is idle but keeps the last frame cost', () => {
    const t = new FrameTimer();
    expect(t.sample()).toEqual({ avgMs: 0, worstMs: 0, lastMs: 0, fps: 0, windowFrames: 0, idle: true, frames: 0 });
    t.record(5);
    t.sample();
    expect(t.sample()).toEqual({ avgMs: 0, worstMs: 0, lastMs: 5, fps: 0, windowFrames: 0, idle: true, frames: 1 });
  });

  it('clamps negative costs (a clock that stepped backwards) to zero', () => {
    const t = new FrameTimer();
    t.record(-3, -1);
    expect(t.sample()).toMatchObject({ avgMs: 0, worstMs: 0, fps: 0, frames: 1 });
  });
});
