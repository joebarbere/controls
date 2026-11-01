import { type Signal, signal } from '@angular/core';
import { MAX_PANEL_SAMPLE_HZ, PANEL_SAMPLE_HZ, type WatchTarget } from '@controls/sim-protocol';
import type { SimClock } from './sim-link';

/*
 * A live trace on the host (ADR 0011 §4, plan F2.6): the samples of one watched quantity the worker
 * took at every electrical solve, as `trace` batches, kept in a ring of the newest `capacity`. View
 * state: watches are never logged and never change the engine. A panel redraws from `version`,
 * which changes at most `hz` times a second (with a trailing change), never per batch.
 */

/** The ring's default size: about 80 s of sim time at the 10-tick cadence, a warm-up's ~270 extra solves included. */
export const TRACE_CAPACITY = 8192;

export interface SimTraceOptions {
  /** How many (tick, value) samples are kept (default {@link TRACE_CAPACITY}). */
  readonly capacity?: number;
  /** How often `version` may change (default `PANEL_SAMPLE_HZ`, at most `MAX_PANEL_SAMPLE_HZ`). */
  readonly hz?: number;
}

/** One watched quantity's trace. */
export interface SimTrace {
  readonly id: number;
  readonly target: WatchTarget;
  /** Changes when there are new samples to show (panel rate) and when the trace is cleared. */
  readonly version: Signal<number>;
  /**
   * The samples held, oldest first, as (tick, value) pairs: a branch's |I| in A, or a device field.
   * `NaN` is no reading (the branch isn't in the netlist, or its island isn't solved), never 0.
   */
  samples(): Float64Array;
  /** Stops the trace: the worker is told to unwatch it. */
  stop(): void;
}

/** The host's store behind a {@link SimTrace}. */
export class TraceBuffer implements SimTrace {
  private readonly ring: Float64Array;
  private start = 0;
  private count = 0;
  private readonly versionState = signal(0);
  readonly version = this.versionState.asReadonly();
  private last = Number.NEGATIVE_INFINITY;
  private trailing: unknown = null;
  private readonly intervalMs: number;

  constructor(
    readonly id: number,
    readonly target: WatchTarget,
    private readonly clock: SimClock,
    options: SimTraceOptions,
    private readonly onStop: (trace: TraceBuffer) => void,
  ) {
    this.ring = new Float64Array(2 * Math.max(1, options.capacity ?? TRACE_CAPACITY));
    this.intervalMs = 1000 / Math.min(MAX_PANEL_SAMPLE_HZ, Math.max(0.1, options.hz ?? PANEL_SAMPLE_HZ));
  }

  /** The number of samples held. */
  get length(): number {
    return this.count;
  }

  samples(): Float64Array {
    const capacity = this.ring.length / 2;
    const out = new Float64Array(2 * this.count);
    const first = Math.min(this.count, capacity - this.start);
    out.set(this.ring.subarray(2 * this.start, 2 * (this.start + first)));
    if (first < this.count) out.set(this.ring.subarray(0, 2 * (this.count - first)), 2 * first);
    return out;
  }

  /** A `trace` batch from the worker: appended, the oldest samples dropped past the capacity. */
  append(batch: Float64Array): void {
    const capacity = this.ring.length / 2;
    for (let i = 0; i + 1 < batch.length; i += 2) {
      const at = (this.start + this.count) % capacity;
      this.ring[2 * at] = batch[i];
      this.ring[2 * at + 1] = batch[i + 1];
      if (this.count < capacity) this.count++;
      else this.start = (this.start + 1) % capacity;
    }
    this.changed();
  }

  /** A new worker (a new game, a load, a restart): a new timeline, so the samples go. */
  clear(): void {
    this.start = 0;
    this.count = 0;
    this.cancel();
    this.bump();
  }

  stop(): void {
    this.cancel();
    this.onStop(this);
  }

  private changed(): void {
    const wait = this.last + this.intervalMs - this.clock.now();
    if (wait <= 0) {
      this.bump();
    } else if (this.trailing === null) {
      this.trailing = this.clock.setTimeout(() => {
        this.trailing = null;
        this.bump();
      }, wait);
    }
  }

  private bump(): void {
    this.last = this.clock.now();
    this.versionState.update((v) => v + 1);
  }

  private cancel(): void {
    if (this.trailing !== null) this.clock.clearTimeout(this.trailing);
    this.trailing = null;
  }
}
