import { type CommandBus, replayEntries } from '@controls/commands';
import type { World } from '@controls/save-format';
import { SimEngine, type SimEngineOptions, SimStartError } from '@controls/sim-core';
import {
  createSnapshotBuffer,
  parseHostMessage,
  SIM_PROTOCOL_VERSION,
  type SimErrorCode,
  type SimEvent,
  type SimWorkerFactory,
  type SimWorkerHandlers,
  type SimWorkerLike,
  slotCapacityFor,
  SnapshotWriter,
  type WorkerToHostMessage,
} from '@controls/sim-protocol';
import { createWorldBus, createWorldRegistry, replayLog } from '@controls/world-model';

/*
 * A sim worker for feature specs (`@controls/feature-session/testing`): the protocol's host side
 * talks to the real `SimEngine` on the calling thread, answering in order through the `postMessage`
 * transport (no slicing, no shared buffer). Specs can hold its replies back, make it hang (the
 * watchdog, timeouts) or crash it. Feature libs can't import `@controls/sim-worker`; app specs use
 * its in-process worker instead. Never for the game.
 */

export interface FakeSimWorkerOptions {
  /** Runs a delivery later (default `queueMicrotask`). */
  readonly defer?: (task: () => void) => void;
  readonly engine?: SimEngineOptions;
  /** What `ready.isolated` says (default false). */
  readonly isolated?: boolean;
  /** Reply with another protocol version's mismatch error to `init`. */
  readonly protocol?: number;
  /** Honour `init.transport: 'sab'`: publish through a `SharedArrayBuffer` with the seqlock writer. */
  readonly sab?: boolean;
  /** Answer `init` with this error instead of starting (`capacity`, `engine-threw`, …). */
  readonly failInit?: SimErrorCode;
  /** Never answer `init` (a worker that never becomes ready). */
  readonly silent?: boolean;
  /** Answer queries with this instead: a crash (`engine-threw`) or silence (`hang`). */
  readonly onQuery?: SimErrorCode | 'hang';
}

/** A fake worker. */
export class FakeSimWorker implements SimWorkerLike {
  /** Every message the host posted, in order. */
  readonly received: { readonly type: string; readonly [key: string]: unknown }[] = [];
  terminated = false;
  private handlers: SimWorkerHandlers | null = null;
  private engine: SimEngine | null = null;
  private bus: CommandBus<World> | null = null;
  private generation = -1;
  /** As the runner: sorted batches cut at each command, posted with the next publish. */
  private pendingEvents: SimEvent[] = [];
  private hung = false;
  private held: (() => void)[] | null = null;
  private writer: SnapshotWriter | null = null;
  /** Snapshots published so far. */
  publishes = 0;
  private readonly defer: (task: () => void) => void;

  constructor(private readonly options: FakeSimWorkerOptions = {}) {
    this.defer = options.defer ?? ((task) => queueMicrotask(task));
  }

  /** A factory that records every worker it makes. */
  static factory(options: FakeSimWorkerOptions | ((index: number) => FakeSimWorkerOptions) = {}): {
    readonly factory: SimWorkerFactory;
    readonly workers: FakeSimWorker[];
  } {
    const workers: FakeSimWorker[] = [];
    return {
      workers,
      factory: () => {
        const worker = new FakeSimWorker(typeof options === 'function' ? options(workers.length) : options);
        workers.push(worker);
        return worker;
      },
    };
  }

  /** The shared snapshot buffer in `sab` mode (specs that hold slots busy), else `null`. */
  get sharedBuffer(): SharedArrayBuffer | null {
    return (this.writer?.buffer as SharedArrayBuffer | undefined) ?? null;
  }

  /** The engine's tick (what the worker has reached). */
  get tick(): number {
    return this.engine?.tick ?? 0;
  }

  /** Stops answering anything (a hung worker: timeouts, the watchdog). */
  hang(): void {
    this.hung = true;
  }

  /** Holds every reply until {@link release} (a slow check). */
  hold(): void {
    this.held ??= [];
  }

  /** Sends the held replies, in order. */
  release(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const task of held) task();
  }

  /** Reports an error message, as the worker does before the host terminates it. */
  crash(code: SimErrorCode = 'engine-threw'): void {
    this.post({
      type: 'error',
      code,
      message: 'A fake failure.',
      seq: null,
      tick: this.engine?.tick ?? null,
      reason: null,
    });
  }

  /** What `self.onerror` would report. */
  fireError(): void {
    this.handlers?.error();
  }

  /** What `onmessageerror` would report. */
  fireMessageError(): void {
    this.handlers?.messageError();
  }

  /** Sends a raw message, as if the worker had (for malformed-message tests). */
  sendRaw(data: unknown): void {
    this.deliver(() => this.handlers?.message(data));
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    const parsed = parseHostMessage(structuredClone(message));
    if (parsed === null) throw new Error('the host posted a message outside the protocol');
    this.received.push(parsed as unknown as FakeSimWorker['received'][number]);
    this.defer(() => {
      if (!this.terminated && !this.hung) this.handle(parsed);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  listen(handlers: SimWorkerHandlers): void {
    this.handlers = handlers;
  }

  private handle(message: NonNullable<ReturnType<typeof parseHostMessage>>): void {
    switch (message.type) {
      case 'init': {
        if (this.options.silent === true) return;
        if (this.options.failInit !== undefined) {
          this.post({
            type: 'error',
            code: this.options.failInit,
            message: 'A fake start failure.',
            seq: null,
            tick: null,
            reason: null,
          });
          return;
        }
        if ((this.options.protocol ?? SIM_PROTOCOL_VERSION) !== message.protocol) {
          this.post({
            type: 'error',
            code: 'protocol-mismatch',
            message: 'Another protocol.',
            seq: null,
            tick: null,
            reason: null,
          });
          return;
        }
        const start = message.start;
        const world = start.kind === 'world' ? start.world : start.log.initialWorld;
        const registry = createWorldRegistry(
          this.options.engine?.catalog ? { catalog: this.options.engine.catalog } : {},
        );
        try {
          this.engine = SimEngine.start(world, this.options.engine ?? {});
        } catch (error) {
          // As the runner: start-failed with its reason for a record that doesn't fit, engine-threw otherwise.
          if (error instanceof SimStartError) {
            this.post({
              type: 'error',
              code: 'start-failed',
              message: `Start failed (${error.reason}).`,
              seq: null,
              tick: null,
              reason: error.reason,
            });
          } else {
            this.post({
              type: 'error',
              code: 'engine-threw',
              message: 'Start threw.',
              seq: null,
              tick: null,
              reason: null,
            });
          }
          return;
        }
        if (start.kind === 'world') {
          this.bus = createWorldBus(world, registry, { firstSeq: start.firstSeq });
        } else {
          const replayed = replayLog(start.log, registry, { time: this.engine });
          if (!replayed.ok) {
            this.post({
              type: 'error',
              code: 'desync',
              message: 'Replay failed.',
              seq: null,
              tick: null,
              reason: null,
            });
            return;
          }
          this.bus = replayed.bus;
          this.engine.takeEvents();
        }
        const shared = message.transport === 'sab' && this.options.sab === true;
        if (shared)
          this.writer = new SnapshotWriter(
            createSnapshotBuffer(slotCapacityFor(this.engine.snapshotBytes()) as number, true),
          );
        this.post({
          type: 'ready',
          protocol: SIM_PROTOCOL_VERSION,
          transport: shared ? 'sab' : 'message',
          isolated: this.options.isolated ?? shared,
          buffer: this.writer === null ? null : (this.writer.buffer as SharedArrayBuffer),
          tick: this.engine.tick,
        });
        this.publish();
        return;
      }
      case 'advance':
        if (this.engine !== null && message.tick > this.engine.tick) this.engine.advanceTo(message.tick);
        this.publish();
        return;
      case 'command': {
        const engine = this.engine as SimEngine;
        if (message.entry.tick > engine.tick) engine.advanceTo(message.entry.tick);
        this.pendingEvents.push(...engine.takeEvents()); // time's events up to the command: their own batch
        const result = replayEntries(this.bus as CommandBus<World>, [message.entry], { time: engine });
        if (!result.ok) {
          this.post({
            type: 'error',
            code: 'desync',
            message: 'Desync.',
            seq: message.entry.seq,
            tick: engine.tick,
            reason: null,
          });
          return;
        }
        this.publish();
        return;
      }
      case 'query': {
        if (this.options.onQuery === 'hang') return;
        if (this.options.onQuery !== undefined) {
          this.post({
            type: 'error',
            code: this.options.onQuery,
            message: 'A fake crash.',
            seq: null,
            tick: this.tick,
            reason: null,
          });
          return;
        }
        const engine = this.engine as SimEngine;
        if (message.tick < engine.tick) {
          // As the runner: main never queries below what it already sent.
          this.post({
            type: 'error',
            code: 'desync',
            message: 'Query behind.',
            seq: null,
            tick: engine.tick,
            reason: null,
          });
          return;
        }
        if (message.tick > engine.tick) engine.advanceTo(message.tick);
        const bus = this.bus as CommandBus<World>;
        if (bus.currentTick() < message.tick) bus.advanceTo(message.tick);
        if (message.query === 'snapshot') {
          const bytes = engine.snapshot();
          this.post({ type: 'snapshotBytes', id: message.id, tick: message.tick, bytes: bytes.buffer as ArrayBuffer });
        } else {
          this.post({
            type: 'state',
            id: message.id,
            tick: message.tick,
            export: engine.exportState(),
            snapshotHash: engine.snapshotHash(),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private publish(): void {
    const engine = this.engine;
    if (engine === null) return;
    const events = [...this.pendingEvents, ...engine.takeEvents()];
    this.pendingEvents = [];
    if (events.length > 0) this.post({ type: 'events', events });
    if (engine.topologyGeneration !== this.generation) {
      this.generation = engine.topologyGeneration;
      let replacement: SharedArrayBuffer | null = null;
      if (this.writer !== null && engine.snapshotBytes() > this.writer.slotBytes) {
        this.writer = new SnapshotWriter(createSnapshotBuffer(slotCapacityFor(engine.snapshotBytes()) as number, true));
        replacement = this.writer.buffer as SharedArrayBuffer;
      }
      this.post({ type: 'topology', descriptor: engine.topologyDescriptor(), buffer: replacement });
    }
    this.publishes++;
    if (this.writer !== null) {
      // The shared path: the slot is written now, the host wakes on the publish word.
      const writer = this.writer;
      this.deliver(() => writer.publish((slot, seq) => void engine.encodeInto(slot, seq)));
      return;
    }
    const buffer = new ArrayBuffer(engine.snapshotBytes());
    engine.encodeInto(new Uint8Array(buffer), 0);
    this.post({ type: 'snapshot', buffer });
  }

  private post(message: WorkerToHostMessage): void {
    const copy = structuredClone(message);
    this.deliver(() => this.handlers?.message(copy));
  }

  private deliver(task: () => void): void {
    const run = () => {
      if (!this.terminated) task();
    };
    if (this.held !== null) this.held.push(run);
    else this.defer(run);
  }
}
