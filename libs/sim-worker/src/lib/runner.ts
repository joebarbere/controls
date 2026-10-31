import { type CommandBus, replayEntries } from '@controls/commands';
import type { ReplayEntry, World } from '@controls/save-format';
import { SimEngine, type SimEngineOptions, SimStartError, SOLVE_INTERVAL_TICKS } from '@controls/sim-core';
import {
  createSnapshotBuffer,
  type HostToWorker,
  MAX_SLOT_BYTES,
  parseHostMessage,
  PUBLISH_MIN_WALL_MS,
  SIM_PROTOCOL_VERSION,
  type SimErrorCode,
  type SimEvent,
  SimStateExport,
  type SimTransport,
  slotCapacityFor,
  SnapshotWriter,
  type WatchTarget,
  WORK_SLICE_MS,
  type WorkerToHostMessage,
} from '@controls/sim-protocol';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import { WorkerDiagnostics, type WorkerClock } from './pacing/worker-clock';

/*
 * The sim worker's inbox and run loop (ADR 0011 §4, §7, §10). The main thread owns the bus, `seq`
 * and the clock; this follows it deterministically: a mirror bus re-executes every logged entry it
 * is sent (a desync is an error), the engine steps to each `advance` target, and snapshots are
 * published after solves (throttled), on a new generation and on reaching the target (both
 * unthrottled). Messages are consumed strictly in order; the loop yields to the queue at least
 * every `WORK_SLICE_MS` and never calls `Atomics.wait`.
 *
 * Wall time (through the injected {@link WorkerClock}) decides only *when* work runs and whether a
 * cadence publish is skipped, never what the engine computes or which bytes a tick's snapshot holds.
 */

/** How the runner talks to its host: `postMessage` with a transfer list. */
export interface RunnerPort {
  post(message: WorkerToHostMessage, transfer?: readonly ArrayBuffer[]): void;
}

/** What the runner needs from its scope (the real worker's, or a test's). */
export interface RunnerEnvironment {
  /** `self.crossOriginIsolated`, read in the worker's own scope. */
  readonly isolated: boolean;
  /** Whether `SharedArrayBuffer` exists here. */
  readonly sharedArrayBuffer: boolean;
  /** The platform is little-endian (the layout is; typed arrays use the platform's order). */
  readonly littleEndian: boolean;
  readonly clock: WorkerClock;
  /** Runs `task` after yielding to the message queue (a `MessageChannel` round trip, never a nested `setTimeout`). */
  schedule(task: () => void): void;
  /** Engine options: the catalogue and models (tests use synthetic ones). */
  readonly engine?: SimEngineOptions;
  /** For tests: a smaller cap on one slot. */
  readonly maxSlotBytes?: number;
  /** For tests: a smaller minimum slot (so a growth is cheap to provoke). */
  readonly minSlotBytes?: number;
}

/** Thrown inside the loop to report a protocol error with its code. */
class RunnerError extends Error {
  constructor(
    readonly code: SimErrorCode,
    message: string,
    readonly seq: number | null = null,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** The fallback's pool size (ADR 0011 §8). */
const POOL_SIZE = 3;

/** Is the platform little-endian? */
export function platformIsLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

/**
 * One worker's state machine: `waiting` for `init`, then `running` until `stop`, or `failed` after
 * an error (the host terminates the worker; nothing more is sent).
 */
export class SimWorkerRunner {
  private phase: 'waiting' | 'running' | 'stopped' | 'failed' = 'waiting';
  private readonly inbox: HostToWorker[] = [];
  private engine: SimEngine | null = null;
  private bus: CommandBus<World> | null = null;
  private transport: SimTransport = 'message';
  private writer: SnapshotWriter | null = null;
  private slotBytes = 0;
  private pool: ArrayBuffer[] = [];
  private scheduled = false;
  private lastPublishWall = Number.NEGATIVE_INFINITY;
  private lastPublishedSolve = Number.NaN;
  private lastGeneration = -1;
  /** The engine changed since the last publish (the idle publish shows it). */
  private dirty = false;
  /** A forced publish found no free buffer (fallback): sent when one comes back. */
  private forcedPending = false;
  private readonly watches = new Map<number, WatchTarget>();
  /** Events at or before this tick are a replay start's history, not news: dropped. */
  private quietThrough = -1;
  /**
   * Events taken from the engine and not yet posted: sorted batches, one per stretch between command
   * boundaries, concatenated (ADR 0011 §4). Cutting at each command, as headless delivers per call,
   * makes what main receives the same list headless whatever the publish timing.
   */
  private pendingEvents: SimEvent[] = [];
  private readonly diagnostics: WorkerDiagnostics;
  private readonly maxSlotBytes: number;

  constructor(
    private readonly port: RunnerPort,
    private readonly env: RunnerEnvironment,
  ) {
    this.diagnostics = new WorkerDiagnostics(env.clock);
    this.maxSlotBytes = env.maxSlotBytes ?? MAX_SLOT_BYTES;
  }

  /** The runner's phase (tests). */
  get state(): 'waiting' | 'running' | 'stopped' | 'failed' {
    return this.phase;
  }

  /** The watched targets (view state for F2.6's traces; never affects the engine). */
  get watched(): ReadonlyMap<number, WatchTarget> {
    return this.watches;
  }

  /** `onmessage`: parses and queues one message. Never echoes a payload. */
  receive(data: unknown): void {
    if (this.phase === 'stopped' || this.phase === 'failed') return;
    if (this.phase === 'waiting') {
      this.init(data);
      return;
    }
    const message = parseHostMessage(data);
    if (message === null) {
      this.fail('invalid-message', 'A message from the host did not match the protocol.');
      return;
    }
    switch (message.type) {
      // Out of band: these never depend on the engine's progress.
      case 'release':
        if (message.buffer.byteLength >= this.slotBytes && this.pool.length < POOL_SIZE) this.pool.push(message.buffer);
        if (this.forcedPending) this.schedulePump();
        return;
      case 'watch':
        this.watches.set(message.id, message.target);
        return;
      case 'unwatch':
        this.watches.delete(message.id);
        return;
      case 'stop':
        this.phase = 'stopped';
        this.inbox.length = 0;
        return;
      case 'init':
        this.fail('invalid-message', 'The worker was already started.');
        return;
      default:
        this.inbox.push(message);
        this.schedulePump();
    }
  }

  /** Reports an error raised outside the loop (`self.onerror`, `unhandledrejection`, a CSP violation). */
  fail(code: SimErrorCode, message: string, seq: number | null = null): void {
    if (this.phase === 'failed' || this.phase === 'stopped') return;
    this.phase = 'failed';
    this.inbox.length = 0;
    this.port.post({ type: 'error', code, message: message.slice(0, 500), seq, tick: this.engine?.tick ?? null });
  }

  // --- start ----------------------------------------------------------------------------------

  private init(data: unknown): void {
    const raw = data as { readonly type?: unknown; readonly protocol?: unknown } | null;
    // The version first: a host of another protocol may send an init this build can't parse.
    if (typeof raw === 'object' && raw !== null && raw.type === 'init' && raw.protocol !== SIM_PROTOCOL_VERSION) {
      this.fail('protocol-mismatch', `This sim worker speaks protocol ${SIM_PROTOCOL_VERSION}.`);
      return;
    }
    const message = parseHostMessage(data);
    if (message === null || message.type !== 'init') {
      this.fail('invalid-message', 'The first message must be a valid init.');
      return;
    }
    if (!this.env.littleEndian) {
      this.fail('start-failed', 'The snapshot layout is little-endian; this platform is not.');
      return;
    }
    const start = message.start;
    const world = start.kind === 'world' ? start.world : start.log.initialWorld;
    const firstSeq = start.kind === 'world' ? start.firstSeq : start.log.firstSeq;
    try {
      this.engine = SimEngine.start(world, this.env.engine ?? {});
    } catch (error) {
      if (error instanceof SimStartError) {
        this.fail('start-failed', `The world's sim state doesn't fit its circuit (${error.reason}).`);
        return;
      }
      this.fail('engine-threw', 'The engine failed to start.');
      return;
    }
    this.bus = createWorldBus(
      world,
      createWorldRegistry(this.env.engine?.catalog ? { catalog: this.env.engine.catalog } : {}),
      {
        firstSeq,
      },
    );
    this.transport = message.transport === 'sab' && this.env.sharedArrayBuffer && this.env.isolated ? 'sab' : 'message';
    if (!this.allocate(this.engine.snapshotBytes())) return;
    this.phase = 'running';
    this.port.post({
      type: 'ready',
      protocol: SIM_PROTOCOL_VERSION,
      transport: this.transport,
      isolated: this.env.isolated,
      buffer: this.writer === null ? null : (this.writer.buffer as SharedArrayBuffer),
      tick: this.engine.tick,
    });
    this.sendTopology(false);
    this.publish(true);
    if (start.kind === 'replay') {
      // A replay start: the log's entries, each at its tick, then its end. The same loop as live
      // commands, so it is sliced and published the same way.
      this.quietThrough = start.log.endTick;
      for (const entry of start.log.entries) this.inbox.push({ type: 'command', entry });
      this.inbox.push({ type: 'advance', tick: start.log.endTick });
      this.schedulePump();
    }
  }

  /** Sizes the buffer (shared) or the pool (fallback) for `needed` bytes per slot. */
  private allocate(needed: number): boolean {
    const slotBytes = slotCapacityFor(needed, this.maxSlotBytes, this.env.minSlotBytes);
    if (slotBytes === null) {
      this.fail('capacity', `A snapshot needs ${needed} bytes, over the ${this.maxSlotBytes}-byte cap.`);
      return false;
    }
    try {
      if (this.transport === 'sab') {
        this.writer = new SnapshotWriter(createSnapshotBuffer(slotBytes, true));
      } else {
        this.pool = this.pool.filter((b) => b.byteLength >= slotBytes);
        while (this.pool.length < POOL_SIZE) this.pool.push(new ArrayBuffer(slotBytes));
      }
    } catch {
      this.fail('capacity', `A snapshot buffer of ${slotBytes} bytes per slot couldn't be allocated.`);
      return false;
    }
    this.slotBytes = slotBytes;
    return true;
  }

  // --- the loop -------------------------------------------------------------------------------

  private schedulePump(): void {
    if (this.scheduled || this.phase !== 'running') return;
    this.scheduled = true;
    this.env.schedule(() => this.pump());
  }

  private pump(): void {
    this.scheduled = false;
    if (this.phase !== 'running') return;
    const sliceStart = this.env.clock.now();
    try {
      while (this.inbox.length > 0) {
        if (!this.handle(this.inbox[0], sliceStart)) {
          this.schedulePump(); // yielded mid-message: carry on after the queue
          return;
        }
        this.inbox.shift();
        if (this.phase !== 'running') return;
      }
      // Idle: the engine reached its target. Always publish, so a paused sim shows its exact tick.
      if (this.dirty || this.forcedPending) this.publish(true);
      if (this.diagnostics.roll()) this.writeDiagnostics();
    } catch (error) {
      if (error instanceof RunnerError) this.fail(error.code, error.message, error.seq);
      else this.fail('engine-threw', 'The engine threw while running.');
    }
  }

  /** Handles the inbox's head; `false` if it yielded before finishing (the message stays queued). */
  private handle(message: HostToWorker, sliceStart: number): boolean {
    switch (message.type) {
      case 'advance':
        // Advances are strictly increasing; one at or below the engine (after a replay start's own end) changes nothing.
        return message.tick <= (this.engine as SimEngine).tick || this.runTo(message.tick, sliceStart, null);
      case 'command':
        if (!this.runTo(message.entry.tick, sliceStart, message.entry.seq)) return false;
        this.apply(message.entry);
        return true;
      case 'query':
        if (!this.runTo(message.tick, sliceStart, null)) return false;
        this.answer(message.id, message.query, message.tick);
        return true;
      default:
        return true; // handled on receipt
    }
  }

  /**
   * Steps the engine to `tick` in chunks that end on cadence boundaries, publishing after each solve
   * (throttled), and yields once the slice is used up. A tick behind the engine is a desync: main
   * never stamps or queries below what it already sent.
   */
  private runTo(tick: number, sliceStart: number, seq: number | null): boolean {
    const engine = this.engine as SimEngine;
    if (tick < engine.tick) {
      throw new RunnerError('desync', `Tick ${tick} is behind the engine's tick ${engine.tick}.`, seq);
    }
    const interval = SOLVE_INTERVAL_TICKS.value;
    while (engine.tick < tick) {
      const from = engine.tick;
      const next = Math.min(tick, (Math.floor(from / interval) + 1) * interval);
      const solvesBefore = solveCount(engine);
      const t0 = this.env.clock.now();
      engine.advanceTo(next);
      const t1 = this.env.clock.now();
      if (this.diagnostics.chunk(t1 - t0, next - from, solveCount(engine) - solvesBefore)) this.writeDiagnostics();
      this.dirty = true;
      this.afterChange();
      if (this.phase !== 'running') return true;
      if (t1 - sliceStart >= WORK_SLICE_MS) return engine.tick >= tick;
    }
    return true;
  }

  /** Re-executes one logged entry on the mirror bus and hands it to the engine at its tick. */
  private apply(entry: ReplayEntry): void {
    this.cutEvents(); // what time raised up to this command is one batch; the command's start the next
    const result = replayEntries(this.bus as CommandBus<World>, [entry], { time: this.engine as SimEngine });
    if (!result.ok) {
      throw new RunnerError('desync', `The mirror bus refused entry ${entry.seq}: ${result.error.kind}.`, entry.seq);
    }
    this.dirty = true;
    this.afterChange();
  }

  /** After the engine moved: a new generation sends its descriptor and publishes; a new solve publishes (throttled). */
  private afterChange(): void {
    const engine = this.engine as SimEngine;
    if (engine.topologyGeneration !== this.lastGeneration) {
      if (!this.sendTopology(true)) return;
      this.publish(true);
    } else if (engine.lastSolveTick !== this.lastPublishedSolve) {
      this.publish(false);
    }
  }

  private answer(id: number, query: 'state' | 'snapshot', tick: number): void {
    const engine = this.engine as SimEngine;
    const bus = this.bus as CommandBus<World>;
    if (bus.currentTick() < tick) bus.advanceTo(tick);
    if (query === 'snapshot') {
      const bytes = engine.snapshot();
      this.port.post({ type: 'snapshotBytes', id, tick, bytes: bytes.buffer as ArrayBuffer }, [
        bytes.buffer as ArrayBuffer,
      ]);
      return;
    }
    const exported = SimStateExport.safeParse(engine.exportState());
    if (!exported.success)
      throw new RunnerError('engine-threw', 'The engine exported a value the save format refuses.');
    this.port.post({ type: 'state', id, tick, export: exported.data, snapshotHash: engine.snapshotHash() });
  }

  // --- publishing -----------------------------------------------------------------------------

  /** Sends the generation's descriptor, with a bigger buffer when it no longer fits. */
  private sendTopology(grow: boolean): boolean {
    const engine = this.engine as SimEngine;
    const needed = engine.snapshotBytes();
    let replacement: SharedArrayBuffer | null = null;
    if (grow && needed > this.slotBytes) {
      if (!this.allocate(needed)) return false;
      if (this.writer !== null) replacement = this.writer.buffer as SharedArrayBuffer;
    }
    const descriptor = engine.topologyDescriptor();
    this.port.post({ type: 'topology', descriptor, buffer: replacement });
    this.lastGeneration = descriptor.generation;
    return true;
  }

  private publish(force: boolean): void {
    const engine = this.engine as SimEngine;
    const now = this.env.clock.now();
    if (!force && now - this.lastPublishWall < PUBLISH_MIN_WALL_MS) {
      this.diagnostics.throttled();
      return; // `dirty` stays set: the next publish (or the idle one) shows it
    }
    this.flushEvents();
    if (this.writer !== null) {
      this.writer.publish((slot, slotSeq) => engine.encodeInto(slot, slotSeq));
    } else {
      const buffer = this.pool.pop();
      if (buffer === undefined) {
        if (force) this.forcedPending = true;
        else this.diagnostics.throttled();
        return;
      }
      engine.encodeInto(new Uint8Array(buffer), 0);
      this.port.post({ type: 'snapshot', buffer }, [buffer]);
    }
    this.lastPublishWall = now;
    this.lastPublishedSolve = engine.lastSolveTick;
    this.dirty = false;
    this.forcedPending = false;
  }

  /** The unhashed diagnostics area (shared mode only: the fallback has no buffer to hold it). */
  private writeDiagnostics(): void {
    this.writer?.writeDiagnostics(this.diagnostics.current);
  }

  /** Ends the current batch: the engine's events since the last cut, sorted, after the pending ones. */
  private cutEvents(): void {
    const all = (this.engine as SimEngine).takeEvents();
    for (const event of all) if (event.tick > this.quietThrough) this.pendingEvents.push(event);
  }

  private flushEvents(): void {
    this.cutEvents();
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.port.post({ type: 'events', events });
  }
}

function solveCount(engine: SimEngine): number {
  const s = engine.stats;
  return s.cadenceSolves + s.commandSolves + s.layerSolves + s.startSolves;
}
