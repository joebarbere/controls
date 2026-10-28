import { mdegToRadians } from './angle';

describe('mdegToRadians', () => {
  it('converts millidegrees to radians', () => {
    expect(mdegToRadians(0)).toBe(0);
    expect(mdegToRadians(180_000)).toBeCloseTo(Math.PI, 12);
    expect(mdegToRadians(90_000)).toBeCloseTo(Math.PI / 2, 12);
    expect(mdegToRadians(360_000)).toBeCloseTo(2 * Math.PI, 12);
  });
});
