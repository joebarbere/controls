import type { GfciClassLimits } from '@controls/catalog';
import type { Sfc32 } from '@controls/world-model';
import { GFCI_INTEGRAL_TOLERANCE } from './constants';

/*
 * The GFCI device logic (P4 D7, ADR 0021 part 2), shared by the GFCI breaker (`breaker.gfci1p`) and,
 * from F4.1 part 2, the GFCI receptacle: what a ground-fault sensor does with the residual current
 * |I_hot + I_neutral| it reads each tick.
 *
 * - **Pickup** I_p, drawn once per bank build from the device's `entity:<id>:gfciPickup` stream as
 *   min + (max − min) u over the entry's band (4–6 mA, inside the region's Class A limits).
 * - **The inverse-time limit**, the region's (`RegionProfile.protection.gfci.tripTimeLimit`), tabulated
 *   at the pre-audit's points (6, 10, 20, 30, 50, 100, 150 and 264 mA) and read **as a rate** 1/t,
 *   interpolated linearly in rate between the points. Linear in rate stays inside the limit (the rate
 *   is convex in I between the points of the published power law t = (20 mA / I)^1.43, so a chord lies
 *   above it), where linear in t overshoots it by up to 22 %; a power law needs `Math.pow` (D6). The
 *   curve is an upper limit only: the model trips at it, so any lower edge is game-design.
 * - **Below the first point**, from the pickup to 6 mA, the rate is the first point's (labelled:
 *   `GFCI_BELOW_FIRST_POINT_RULE`). **Above the last point** (264 mA) the rate is unbounded: the
 *   integral reaches 1 at once and the trip is the mechanism time alone, never a clamp at 25 ms.
 * - **Integration.** For a varying residual the trip comes when Σ dt / t(I) ≥ 1 (persisted as
 *   `residualIntegral`, clamped at 1), counted from the excursion's first tick (`residualSinceTick`);
 *   it falls back to 0 the moment the residual drops below the pickup.
 * - **Mechanism time** t_m, drawn once per bank build from `entity:<id>:gfciMechanism` as
 *   ⌈min + (max − min) u⌉ ticks over the entry's band (3–14 ms: detection, the half-cycle SCR wait and
 *   the solenoid). It floors every trip: the device opens no earlier than t_m after the excursion began.
 *
 * **Ticks.** The device opens at the last tick at or before the integral reaches 1 at the present rate,
 * so at a constant residual I it is open max(t_m, ⌊t(I) / 1 ms⌋) ticks after the excursion began:
 * never later than the limit, at most a tick early (a tabulated point that is a whole number of ticks,
 * such as 2.695 s at 10 mA, lands exactly on it). Only `+ − × ÷` and `Math.ceil` here (D6).
 */

/** The region's limit as typed rate points: `amps[k]` (A) ascending, `rates[k]` = 1 / t (1/s). */
export interface GfciRateTable {
  readonly amps: Float64Array;
  readonly rates: Float64Array;
}

/** The region's Class A limit as a rate table (built once per bank). */
export function gfciRateTable(limits: GfciClassLimits): GfciRateTable {
  const points = limits.tripTimeLimit.points;
  const amps = new Float64Array(points.length);
  const rates = new Float64Array(points.length);
  for (let k = 0; k < points.length; k++) {
    amps[k] = points[k].x;
    rates[k] = 1 / points[k].y;
  }
  return { amps, rates };
}

/**
 * The trip rate 1 / t(I) (1/s) at a residual current `amps` at or above the pickup: the first point's
 * below the first point, linear in rate between points, `Infinity` above the last point.
 */
export function gfciTripRate(table: GfciRateTable, amps: number): number {
  const xs = table.amps;
  const rs = table.rates;
  const last = xs.length - 1;
  if (amps <= xs[0]) return rs[0];
  if (amps > xs[last]) return Infinity;
  let k = 1;
  while (amps > xs[k]) k++;
  return rs[k - 1] + ((rs[k] - rs[k - 1]) * (amps - xs[k - 1])) / (xs[k] - xs[k - 1]);
}

/** min + (max − min) u, u the first output of `stream` (a band draw, ADR 0019 "PRNG stream keys"). */
export function drawInBand(stream: Sfc32, min: number, max: number): number {
  return min + (max - min) * stream.nextFloat();
}

/** ⌈min + (max − min) u⌉ ticks for a band in ms (1 tick = 1 ms), u the first output of `stream`. */
export function drawTicksInBand(stream: Sfc32, minMs: number, maxMs: number): number {
  return Math.ceil(drawInBand(stream, minMs, maxMs));
}

const TRIP_AT = 1 + GFCI_INTEGRAL_TOLERANCE.value;

/**
 * The ground-fault sensors of a bank's GFCI devices, struct-of-arrays (no allocation per tick). `since`
 * and `testHeld` hold −1 for `null`.
 */
export class GfciSensor {
  readonly pickupA: Float64Array;
  readonly mechanismTicks: Float64Array;
  readonly integral: Float64Array;
  readonly since: Float64Array;
  readonly testHeld: Float64Array;

  constructor(
    count: number,
    readonly table: GfciRateTable,
  ) {
    this.pickupA = new Float64Array(count);
    this.mechanismTicks = new Float64Array(count);
    this.integral = new Float64Array(count);
    this.since = new Float64Array(count).fill(-1);
    this.testHeld = new Float64Array(count).fill(-1);
  }

  /**
   * Device `i`'s draws (its `gfciPickup` and `gfciMechanism` streams, first outputs) and its persisted
   * state from its bag (missing or `null` keys at their initial values).
   */
  init(
    i: number,
    band: { pickupMinA: number; pickupMaxA: number; mechanismMinMs: number; mechanismMaxMs: number },
    pickupStream: Sfc32,
    mechanismStream: Sfc32,
    bag: Readonly<Record<string, unknown>>,
  ): void {
    this.pickupA[i] = drawInBand(pickupStream, band.pickupMinA, band.pickupMaxA);
    this.mechanismTicks[i] = drawTicksInBand(mechanismStream, band.mechanismMinMs, band.mechanismMaxMs);
    const integral = bag['residualIntegral'];
    const since = bag['residualSinceTick'];
    const held = bag['testHeldSinceTick'];
    this.integral[i] = typeof integral === 'number' ? integral : 0;
    this.since[i] = typeof since === 'number' ? since : -1;
    this.testHeld[i] = typeof held === 'number' ? held : -1;
  }

  /**
   * One protection step `[tick, tick + 1)` of device `i` at residual current `amps` (A, a reading):
   * integrates, and returns whether it trips at this step (open from `tick + 1`). Allocates nothing.
   */
  step(i: number, amps: number, tick: number, dtS: number): boolean {
    if (!(amps >= this.pickupA[i])) {
      this.integral[i] = 0;
      this.since[i] = -1;
      return false;
    }
    if (this.since[i] < 0) {
      this.since[i] = tick;
      this.integral[i] = 0;
    }
    const rate = gfciTripRate(this.table, amps);
    if (rate === Infinity) this.integral[i] = 1;
    else this.integral[i] = Math.min(1, this.integral[i] + dtS * rate);
    // Open at the last tick at or before the integral reaches 1 at the present rate: never later than
    // the limit, at most a tick early (a tabulated point, a whole number of ticks, lands exactly on it).
    const due = rate === Infinity || this.integral[i] + dtS * rate > TRIP_AT;
    return due && tick + 1 - this.since[i] >= this.mechanismTicks[i];
  }

  /** No residual flows (the device is open): the excursion ends. */
  quiet(i: number): void {
    this.integral[i] = 0;
    this.since[i] = -1;
  }

  /** Device `i` tripped: the excursion and any held test end with it. */
  tripped(i: number): void {
    this.quiet(i);
    this.testHeld[i] = -1;
  }

  /** Device `i`'s persisted keys, written into `bag`. */
  bagInto(i: number, bag: Record<string, number | null>): void {
    bag['residualIntegral'] = this.integral[i];
    bag['residualSinceTick'] = this.since[i] < 0 ? null : this.since[i];
    bag['testHeldSinceTick'] = this.testHeld[i] < 0 ? null : this.testHeld[i];
  }
}
