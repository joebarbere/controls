import fc from 'fast-check';
import { Pacer, SpeedMeter } from './pacer';
import { BEHIND_CLEAR_RATIO, BEHIND_RAISE_RATIO, MAX_LEAD_WALL_MS, PACE_INTERVAL_MS } from './timing';

/*
 * The pacing policy (ADR 0011 §2): integer targets from wall time, capped by the worker's progress,
 * with lost time dropped; and the effective speed with its "falling behind" hysteresis.
 */

describe('Pacer', () => {
  it('does nothing while paused', () => {
    const pacer = new Pacer();
    pacer.setSpeed(0, 0, 0);
    expect(pacer.target(1_000, 0, 0)).toEqual({ advanceTo: null, dropped: 0 });
  });

  it('advances by speed × wall time when the worker keeps up', () => {
    const pacer = new Pacer();
    pacer.setSpeed(1, 1_000, 0);
    expect(pacer.target(1_010, 0, 0).advanceTo).toBe(10);
    expect(pacer.target(1_020, 10, 10).advanceTo).toBe(20);
    pacer.setSpeed(60, 1_020, 20);
    expect(pacer.target(1_030, 20, 20).advanceTo).toBe(20 + 600);
  });

  it('caps the target at progress + speed × MAX_LEAD_WALL_MS and drops the lost time', () => {
    const pacer = new Pacer();
    pacer.setSpeed(60, 0, 0);
    const lead = 60 * MAX_LEAD_WALL_MS;
    // The worker is stuck at 0: the target stops at the lead, and the anchor moves there.
    const first = pacer.target(1_000, 0, 0);
    expect(first.advanceTo).toBe(lead);
    expect(first.dropped).toBe(60_000 - lead);
    expect(pacer.target(1_000, 0, lead).advanceTo).toBeNull(); // no catch-up spiral
    // The worker catches up: pacing resumes from the re-anchored tick, not from the lost time.
    expect(pacer.target(1_010, lead, lead).advanceTo).toBe(lead + 600);
  });

  it("never commands below the bus's tick, and resumes at once after an uncapped step", () => {
    const pacer = new Pacer();
    pacer.setSpeed(1, 0, 0);
    // A `sim.step` jumped the bus to 600 000 and re-anchored; the worker is still far behind.
    pacer.anchor(10, 600_000);
    expect(pacer.target(20, 1_000, 600_000).advanceTo).toBeNull();
    // Once the worker is there, time moves from the step's tick, not from the capped value.
    expect(pacer.target(40, 600_000, 600_000).advanceTo).toBe(600_020);
  });

  it('refuses a bad speed or anchor', () => {
    const pacer = new Pacer();
    expect(() => pacer.setSpeed(-1, 0, 0)).toThrow(RangeError);
    expect(() => pacer.setSpeed(Number.NaN, 0, 0)).toThrow(RangeError);
    expect(() => pacer.anchor(0, 1.5)).toThrow(RangeError);
    expect(pacer.speed).toBe(0);
  });

  it('targets are integers, increasing, and never more than the lead past progress (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 10, 60),
        fc.array(fc.record({ dt: fc.integer({ min: 0, max: 50 }), lag: fc.nat({ max: 5_000 }) }), { maxLength: 60 }),
        (speed, steps) => {
          const pacer = new Pacer();
          let now = 0;
          let current = 0;
          pacer.setSpeed(speed, now, current);
          for (const { dt, lag } of steps) {
            now += dt;
            const progress = Math.max(0, current - lag);
            const { advanceTo } = pacer.target(now, progress, current);
            if (advanceTo === null) continue;
            expect(Number.isSafeInteger(advanceTo)).toBe(true);
            expect(advanceTo).toBeGreaterThan(current);
            expect(advanceTo).toBeLessThanOrEqual(progress + speed * MAX_LEAD_WALL_MS);
            current = advanceTo;
          }
        },
      ),
    );
  });

  it('the lead allows 60× at the pacing interval', () => {
    expect(MAX_LEAD_WALL_MS).toBeGreaterThanOrEqual(2 * PACE_INTERVAL_MS);
  });
});

describe('SpeedMeter', () => {
  it('measures Δtick ÷ Δwall per window', () => {
    const meter = new SpeedMeter(1_000);
    expect(meter.sample(0, 0, 10)).toBeNull(); // opens a window
    expect(meter.effective).toBe(10);
    expect(meter.sample(500, 5_000, 10)).toBeNull();
    expect(meter.sample(1_000, 10_000, 10)).toEqual({ effective: 10, behind: false });
  });

  it('raises "falling behind" after two slow windows and clears it after one good one', () => {
    const meter = new SpeedMeter(1_000);
    meter.reset(0, 0);
    const slow = BEHIND_RAISE_RATIO * 60 * 1_000 - 1;
    expect(meter.sample(1_000, slow, 60)?.behind).toBe(false); // one slow window: not yet
    expect(meter.sample(2_000, 2 * slow, 60)?.behind).toBe(true);
    // A window between the two ratios keeps it (hysteresis)…
    const middle = ((BEHIND_RAISE_RATIO + BEHIND_CLEAR_RATIO) / 2) * 60 * 1_000;
    expect(meter.sample(3_000, 2 * slow + middle, 60)?.behind).toBe(true);
    // …and one at the clear ratio clears it.
    expect(meter.sample(4_000, 2 * slow + middle + 60_000, 60)?.behind).toBe(false);
    // One slow window in between two good ones raises nothing.
    expect(meter.sample(5_000, 2 * slow + middle + 60_000 + slow, 60)?.behind).toBe(false);
  });

  it('never falls behind at speed 0, and a reset clears it', () => {
    const meter = new SpeedMeter(100);
    meter.reset(0, 0);
    meter.sample(100, 0, 60);
    meter.sample(200, 0, 60);
    expect(meter.behind).toBe(true);
    expect(meter.sample(300, 0, 0)?.behind).toBe(false);
    meter.sample(400, 0, 60);
    meter.sample(500, 0, 60);
    meter.reset(500, 0);
    expect(meter.behind).toBe(false);
    expect(meter.effective).toBe(0);
  });
});
