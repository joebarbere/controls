import { FrameTimer } from './frame-timer';

describe('FrameTimer', () => {
  it('reports the mean and worst frame per window', () => {
    const t = new FrameTimer();
    expect(t.tick(1000)).toBe(0);
    t.tick(1016);
    t.tick(1048); // 32 ms frame
    const s = t.sample();
    expect(s.avgMs).toBe(24);
    expect(s.worstMs).toBe(32);
    expect(s.fps).toBeCloseTo(1000 / 24, 9);
    expect(s.frames).toBe(2);
    t.tick(1058);
    // A new window: the slow frame above no longer counts.
    expect(t.sample()).toEqual({ avgMs: 10, worstMs: 10, fps: 100, frames: 3 });
  });

  it('handles an empty window and clocks that step backwards', () => {
    const t = new FrameTimer();
    expect(t.sample()).toEqual({ avgMs: 0, worstMs: 0, fps: 0, frames: 0 });
    t.tick(10);
    expect(t.tick(5)).toBe(0);
  });
});
