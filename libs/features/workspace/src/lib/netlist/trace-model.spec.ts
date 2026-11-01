import { describeTrace, layoutTrace, PLOT } from './trace-model';

describe('layoutTrace', () => {
  it('draws sample-and-hold steps, breaks at no reading, and summarises peak and last solve', () => {
    // 0 ms: 2 A; 10 ms: 1 A; 20 ms: no reading; 30 ms: 1 A; 40 ms: 0.5 A.
    const layout = layoutTrace(Float64Array.from([0, 2, 10, 1, 20, Number.NaN, 30, 1, 40, 0.5]));
    const h = PLOT.height;
    const x = (tick: number) => (tick / 40) * PLOT.width;
    // The value holds until the next solve: a vertical step at each one, never a slope.
    expect(layout.lines).toEqual([
      `${x(0)},0 ${x(10)},0 ${x(10)},${h / 2}`,
      `${x(30)},${h / 2} ${x(40)},${h / 2} ${x(40)},${(3 * h) / 4}`,
    ]);
    expect(layout).toMatchObject({
      t0: 0,
      t1: 0.04,
      max: 2,
      peak: { value: 2, t: 0 },
      latest: { value: 0.5, t: 0.04 },
    });
    expect(describeTrace(layout, 'A')).toBe('Peak 2.00 A at 0.000 s; last solve at 0.040 s: 500 mA.');
  });

  it('says so with no samples, or no reading at the last solve', () => {
    expect(describeTrace(layoutTrace(new Float64Array(0)), 'A')).toBe('No samples yet.');
    expect(describeTrace(layoutTrace(Float64Array.from([5, Number.NaN])), 'A')).toBe(
      'Peak no reading; last solve at 0.005 s: no reading.',
    );
  });
});
