import type { ReplayEntry } from '@controls/save-format';
import {
  isSharedArrayBuffer,
  parseWorkerMessage,
  PUBLISH_SEQ_INDEX,
  SIM_PROTOCOL_VERSION,
  type SimErrorCode,
  type SimEvent,
  type SimQueryError,
  type SimStart,
  type SimStateExport,
  type SimTransport,
  type SimWorkerLike,
  SnapshotReader,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';

/*
 * One sim worker as the host drives it (ADR 0011 §9, §10): its messages, its reader, its pending
 * queries and its wake-ups. `SimHost` owns at most one current link, plus a candidate while a load
 * is being verified and retired links settling their last queries.
 */

/** The clock and timers a host runs on (injected as `SIM_CLOCK`, so specs use fake timers). */
export interface SimClock {
  now(): number;
  setTimeout(task: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A query the host gave up on, or the worker died under (never on the wire). */
export class SimQueryRejection extends Error {
  constructor(readonly reason: SimQueryError) {
    super(`The sim query was ${reason === 'superseded' ? 'superseded' : `rejected (${reason})`}.`);
    this.name = 'SimQueryRejection';
  }
}

/** What a `state` query answers. */
export interface SimStateReply {
  readonly tick: number;
  readonly export: SimStateExport;
  readonly snapshotHash: string;
}

/** A worker failure: an `error` message, `onerror`, `onmessageerror`, the watchdog, or a bad message. */
export interface SimFailure {
  readonly code: SimErrorCode | 'watchdog' | 'worker-error';
  readonly message: string;
  readonly tick: number | null;
  readonly beforeReady: boolean;
}

/** The link's callbacks into its host. Only the current link's snapshots and events are delivered. */
export interface SimLinkEvents {
  ready(link: SimLink): void;
  snapshot(link: SimLink, view: SnapshotView): void;
  descriptor(link: SimLink, descriptor: TopologyDescriptor): void;
  events(link: SimLink, events: readonly SimEvent[]): void;
  failed(link: SimLink, failure: SimFailure): void;
  /** The worker was terminated (disposed, failed or retired and settled). */
  closed(link: SimLink): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: SimQueryRejection) => void;
  readonly timer: unknown;
}

type Waiter = { value: Promise<unknown> } | { value: string };
type WaitAsync = (array: Int32Array, index: number, value: number) => { async: boolean; value: Waiter['value'] };

/** One worker, from `init` to `terminate`. */
export class SimLink {
  readonly reader = new SnapshotReader();
  phase: 'starting' | 'ready' | 'failed' | 'disposed' = 'starting';
  transport: SimTransport | null = null;
  /** `self.crossOriginIsolated` from the worker's own scope (`ready.isolated`). */
  isolated: boolean | null = null;
  /** The worker's tick in `ready`. */
  startTick = 0;
  /** The last `advance` posted (advances are strictly increasing). */
  lastAdvance: number;
  /** Host wall time of the last accepted snapshot (the watchdog's input). */
  lastPublishWall: number;
  /** The worker's progress: the latest accepted snapshot's tick. */
  progress: number;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: SimFailure) => void;
  private readonly pending = new Map<number, Pending>();
  private nextQuery = 1;
  private i32: Int32Array | null = null;
  /** The buffer our `Atomics.waitAsync` is parked on, if any. */
  private waitingOn: Int32Array | null = null;
  private retired: { readonly timer: unknown } | null = null;

  constructor(
    private readonly worker: SimWorkerLike,
    private readonly events: SimLinkEvents,
    private readonly clock: SimClock,
    start: SimStart,
    transport: SimTransport,
    private readonly queryTimeoutMs: number,
  ) {
    this.lastAdvance = start.kind === 'world' ? start.world.tick : start.log.endTick;
    this.progress = start.kind === 'world' ? start.world.tick : start.log.initialWorld.tick;
    this.lastPublishWall = clock.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined); // observed through `failed` too
    worker.listen({
      message: (data) => this.receive(data),
      error: () => this.fail({ code: 'worker-error', message: 'The sim worker stopped with an error.', tick: null }),
      messageError: () =>
        this.fail({ code: 'invalid-message', message: 'A message from the sim worker could not be read.', tick: null }),
    });
    worker.postMessage({ type: 'init', protocol: SIM_PROTOCOL_VERSION, transport, start }, []);
  }

  /** Is this link still talking to its worker? */
  get alive(): boolean {
    return this.phase === 'starting' || this.phase === 'ready';
  }

  /** Queries waiting for an answer (the disposal spec counts them). */
  get pendingQueries(): number {
    return this.pending.size;
  }

  /** Posts an advance if `tick` is past the last one. */
  advance(tick: number): void {
    if (!this.alive || tick <= this.lastAdvance) return;
    this.lastAdvance = tick;
    this.worker.postMessage({ type: 'advance', tick }, []);
  }

  command(entry: ReplayEntry): void {
    if (this.alive) this.worker.postMessage({ type: 'command', entry }, []);
  }

  /** A `state` query at `tick` (the bus's current tick), rejected after `timeoutMs`. */
  state(tick: number, timeoutMs = this.queryTimeoutMs): Promise<SimStateReply> {
    return this.query<SimStateReply>('state', tick, timeoutMs);
  }

  /** A `snapshot` query: the hashed bytes encoded at exactly `tick`. */
  snapshotBytes(tick: number, timeoutMs = this.queryTimeoutMs): Promise<Uint8Array> {
    return this.query<Uint8Array>('snapshot', tick, timeoutMs);
  }

  /**
   * Stops delivering snapshots and events; terminates once its pending queries settle, or after
   * `settleMs` (then they are `superseded`). Replace and teardown (ADR 0011 §9.5).
   */
  retire(settleMs: number): void {
    if (!this.alive || this.retired !== null) return;
    if (this.pending.size === 0) {
      this.dispose('superseded');
      return;
    }
    this.retired = { timer: this.clock.setTimeout(() => this.dispose('superseded'), settleMs) };
  }

  /** Terminates the worker now: pending queries are rejected with `reason`, and nothing more is delivered. */
  dispose(reason: SimQueryError = 'superseded'): void {
    if (this.phase === 'disposed') return;
    const failed = this.phase === 'failed';
    this.phase = 'disposed';
    if (this.retired !== null) this.clock.clearTimeout(this.retired.timer);
    this.retired = null;
    this.worker.terminate();
    this.rejectAll(failed ? 'crashed' : reason);
    this.i32 = null;
    this.release();
    this.rejectReady({ code: 'worker-error', message: 'The sim worker was stopped.', tick: null, beforeReady: true });
    this.events.closed(this);
  }

  /** Reports a failure the host found (the watchdog), then terminates. */
  fail(failure: Omit<SimFailure, 'beforeReady'>): void {
    if (!this.alive) return;
    const beforeReady = this.phase === 'starting';
    this.phase = 'failed';
    this.rejectReady({ ...failure, beforeReady });
    this.events.failed(this, { ...failure, beforeReady });
    this.dispose('crashed');
  }

  /** The descriptor arrived for a slot that was held back: read it now (shared mode). */
  private retryRead(): void {
    if (this.i32 === null) return;
    const before = this.reader.stats.reads;
    const view = this.reader.retry();
    if (view !== null && this.reader.stats.reads !== before) this.accepted(view);
    this.arm();
  }

  private query<T>(kind: 'state' | 'snapshot', tick: number, timeoutMs: number): Promise<T> {
    if (!this.alive || this.retired !== null) {
      return Promise.reject(new SimQueryRejection(this.phase === 'failed' ? 'crashed' : 'superseded'));
    }
    const id = this.nextQuery++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(new SimQueryRejection('timeout'));
        this.settled();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.worker.postMessage({ type: 'query', id, query: kind, tick }, []);
    });
  }

  private answer(id: number, value: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.clock.clearTimeout(pending.timer);
    pending.resolve(value);
    this.settled();
  }

  private settled(): void {
    if (this.retired !== null && this.pending.size === 0) this.dispose('superseded');
  }

  private rejectAll(reason: SimQueryError): void {
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.reject(new SimQueryRejection(reason));
    }
    this.pending.clear();
  }

  private receive(data: unknown): void {
    if (!this.alive) return; // a late message from a terminated worker
    const message = parseWorkerMessage(data);
    if (message === null) {
      this.fail({
        code: 'invalid-message',
        message: 'The sim worker sent a message outside the protocol.',
        tick: null,
      });
      return;
    }
    const delivering = this.retired === null;
    switch (message.type) {
      case 'ready':
        this.phase = 'ready';
        this.transport = message.transport;
        this.isolated = message.isolated;
        this.startTick = message.tick;
        if (message.buffer !== null) this.attach(message.buffer);
        this.resolveReady();
        if (delivering) this.events.ready(this);
        return;
      case 'topology':
        this.reader.setDescriptor(message.descriptor);
        if (delivering) this.events.descriptor(this, message.descriptor);
        if (message.buffer !== null) this.attach(message.buffer);
        else if (this.i32 !== null) this.retryRead();
        return;
      case 'snapshot': {
        const view = this.reader.acceptSlot(new Uint8Array(message.buffer));
        this.worker.postMessage({ type: 'release', buffer: message.buffer }, [message.buffer]);
        if (view !== null) this.accepted(view);
        return;
      }
      case 'events':
        if (delivering) this.events.events(this, message.events);
        return;
      case 'trace':
        return; // F2.6
      case 'state':
        this.answer(message.id, { tick: message.tick, export: message.export, snapshotHash: message.snapshotHash });
        return;
      case 'snapshotBytes':
        this.answer(message.id, new Uint8Array(message.bytes));
        return;
      case 'error':
        this.fail({ code: message.code, message: message.message, tick: message.tick });
        return;
    }
  }

  private accepted(view: SnapshotView): void {
    this.progress = view.tick;
    this.lastPublishWall = this.clock.now();
    if (this.retired === null) this.events.snapshot(this, view);
  }

  /** Shared mode: read from `buffer` and wait for publishes with `Atomics.waitAsync`. */
  private attach(buffer: SharedArrayBuffer): void {
    if (!isSharedArrayBuffer(buffer)) return;
    this.reader.attach(buffer);
    this.i32 = new Int32Array(buffer);
    this.release(); // a waiter on the old buffer would never wake
    this.read();
  }

  /** Wakes our own parked waiter, so none is left behind; its handler sees it is stale and stops. */
  private release(): void {
    const parked = this.waitingOn;
    if (parked !== null) Atomics.notify(parked, PUBLISH_SEQ_INDEX);
  }

  /** Whether a waiter is parked (the disposal spec checks none is left). */
  get parked(): boolean {
    return this.waitingOn !== null;
  }

  /** Reads what is new, then waits for the next publish (not while a descriptor is awaited). */
  private read(): void {
    if (this.i32 === null || !this.alive) return;
    const before = this.reader.stats.reads;
    const view = this.reader.latest();
    if (view !== null && this.reader.stats.reads !== before) this.accepted(view);
    if (!this.reader.awaitingDescriptor) this.arm();
  }

  private arm(): void {
    const i32 = this.i32;
    if (i32 === null || this.waitingOn === i32 || !this.alive) return;
    const seen = this.reader.publishSeq;
    if (Atomics.load(i32, PUBLISH_SEQ_INDEX) !== seen) {
      queueMicrotask(() => this.read());
      return;
    }
    const wait = (Atomics as unknown as { waitAsync: WaitAsync }).waitAsync(i32, PUBLISH_SEQ_INDEX, seen);
    if (!wait.async) {
      queueMicrotask(() => this.read());
      return;
    }
    this.waitingOn = i32;
    void (wait.value as Promise<unknown>).then(() => {
      if (this.waitingOn === i32) this.waitingOn = null;
      if (this.i32 === i32) this.read();
    });
  }
}
