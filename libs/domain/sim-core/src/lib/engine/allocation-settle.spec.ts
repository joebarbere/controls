import { MAX_WINDOWS_FACTOR, median, settledWindows } from './allocation-settle';

/** A window source that replays `sequence`, then repeats its last value. */
function replay(sequence: readonly number[]): () => number {
  let at = 0;
  return () => sequence[Math.min(at++, sequence.length - 1)];
}

describe('the allocation gates’ settling rule (#66)', () => {
  it('takes the median, the mean of the middle two for an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('keeps measuring through CI’s late tier-up and lands low', () => {
    // The slowest runner's AC gate: the fixed eight windows gave a median of 6.18 against a gate of 6.
    const ci = [11.97, 9.65, 10.28, 10.04, 2.7, 0.5, 0.51, 0.0];
    expect(median(ci)).toBeCloseTo(6.18, 2);
    const later = [0.4, 0.6, 0.5, 0.45, 0.55, 0.5, 0.48, 0.52];
    const result = settledWindows(8, replay([...ci, ...later]));
    // Not settled at eight (the last four, 2.70 … 0.00, span more than 2): one more window settles it,
    // and the last eight drop the first, 11.97.
    expect(result.all).toStrictEqual([...ci, 0.4]);
    expect(result.counted).toStrictEqual(result.all.slice(-8));
    expect(result.perStep).toBeCloseTo((0.51 + 2.7) / 2, 10);
    expect(result.perStep).toBeLessThan(2); // well under the AC gate it failed (6)
  });

  it('measures a steady allocation in full: eight windows, its value', () => {
    let calls = 0;
    const steady = settledWindows(8, () => (calls++, 8 + (calls % 3) * 0.5)); // 8.0 to 9.0 B/step
    expect(calls).toBe(8);
    expect(steady.all).toHaveLength(8);
    expect(steady.perStep).toBeGreaterThanOrEqual(8);
  });

  it('stops at the cap when it never settles, and counts the last windows', () => {
    const swinging = settledWindows(4, replay([0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10]));
    expect(swinging.all).toHaveLength(MAX_WINDOWS_FACTOR * 4);
    expect(swinging.counted).toStrictEqual([0, 10, 0, 10]);
    expect(swinging.perStep).toBe(5);
  });

  it('needs only as many agreeing windows as it counts', () => {
    expect(settledWindows(2, replay([20, 1, 1.5])).all).toStrictEqual([20, 1, 1.5]);
  });
});
