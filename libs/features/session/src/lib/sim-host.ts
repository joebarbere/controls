import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, InjectionToken, type Signal, signal } from '@angular/core';
import { SIM_STEP_COMMAND } from '@controls/commands';
import type { ReplayEntry, ReplayLog } from '@controls/save-format';
import type { TimeHost } from '@controls/scripting-api';
import { netlistDump } from '@controls/sim-core';
import {
  materialiseWorld,
  MAX_LEAD_WALL_MS,
  MAX_PANEL_SAMPLE_HZ,
  PACE_INTERVAL_MS,
  Pacer,
  PANEL_SAMPLE_HZ,
  SIM_SETTLE_MS,
  type SimEvent,
  type SimStart,
  type SimStateExport,
  type SimTransport,
  type SimWorkerFactory,
  snapshotHash,
  type SnapshotView,
  SpeedMeter,
  STATE_QUERY_TIMEOUT_MS,
  type TopologyDescriptor,
  WATCHDOG_MS,
} from '@controls/sim-protocol';
import { type World, worldHash } from '@controls/world-model';
import {
  type SimClock,
  type SimFailure,
  SimLink,
  type SimLinkEvents,
  SimQueryRejection,
  type SimStateReply,
} from './sim-link';

export { type SimClock, type SimFailure, SimQueryRejection, type SimStateReply } from './sim-link';

/*
 * The main thread's side of the sim worker (ADR 0011 §2, §9, §10, plan F2.3b): one worker per game,
 * every logged entry and advance forwarded in order, integer tick targets paced from the wall clock
 * and capped by the worker's progress, the one snapshot reader, the asynchronous hash and save
 * queries, suspend on a hidden window, hold during console scripts, and the crash and watchdog
 * model. It is the game's `TimeHost` (`Session` creates every game with it).
 */

/** The sim's status (ADR 0011 §10), also the `sim.status` context key. */
export type SimStatus = 'none' | 'starting' | 'running' | 'paused' | 'suspended' | 'crashed' | 'unavailable';

/** The game a host follows: `Session` binds its current game on every start or adopt. */
export interface SimSessionBinding {
  /** The bus's tick (the commanded tick). */
  tick(): number;
  /** Lets time pass on the bus to `tick` (the host's pacing); the game forwards it back as an advance. */
  advanceTo(tick: number): void;
  /** The bus world now (inert sim bags: only for materialising an export into it). */
  world(): World;
}

/** A crash the player sees (ADR 0011 §10): its code and tick, with the Restart action. */
export interface SimCrash {
  readonly code: SimFailure['code'];
  readonly message: string;
  readonly tick: number | null;
}

/** The wall clock and timers: `performance.now()` and the global timers, or a spec's fakes. */
export const SIM_CLOCK = new InjectionToken<SimClock>('controls.simClock', {
  providedIn: 'root',
  factory: () => ({
    now: () => performance.now(),
    setTimeout: (task, ms) => setTimeout(task, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }),
});

/**
 * Makes the game's sim worker. `apps/game` provides the factory around the literal
 * `new Worker(new URL(…), { type: 'module' })` (ADR 0011 §10); features never import the worker.
 * Without one (most component specs) the sim is `unavailable`.
 */
export const SIM_WORKER_FACTORY = new InjectionToken<SimWorkerFactory | null>('controls.simWorkerFactory', {
  providedIn: 'root',
  factory: () => null,
});

/**
 * The transport to ask for: the shared buffer when the page is cross-origin isolated, else (or with
 * `?sab=0`) `postMessage` (ADR 0011 §8). `?sab=0` is deliberately honoured in every build, not only
 * with `?e2e=1`: it only lowers the transport to one that gives the same bytes, so it costs speed,
 * never correctness, and the desktop app loads a fixed URL anyway.
 */
export const SIM_TRANSPORT = new InjectionToken<SimTransport>('controls.simTransport', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    const off = view !== null && new URLSearchParams(view.location.search).get('sab') === '0';
    const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
    return off || !isolated ? 'message' : 'sab';
  },
});

/** A worker being started for a load (ADR 0011 §10 step 3): not yet the game's; promote or dispose it. */
export interface SimCandidate {
  /** Resolves once the worker is ready; rejects with a {@link SimFailure} (`start-failed`, …). */
  readonly ready: Promise<void>;
  /** {@link ready}, or a rejection (and the worker terminated) if it isn't ready within `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<void>;
  /** A `state` query at `tick`, rejected after `timeoutMs` (default `STATE_QUERY_TIMEOUT_MS`). */
  state(tick: number, timeoutMs?: number): Promise<SimStateReply>;
  /** Terminates it (a load that didn't go ahead). */
  dispose(): void;
}

/** A snapshot listener: `null` is a source reset (lamps unknown, no overlays). */
export type SnapshotListener = (view: SnapshotView | null) => void;

/** What `select` returns: the sampled value, and whether it is frozen because the sim crashed. */
export type SimSelection<T> = Signal<T> & { readonly stale: Signal<boolean> };

interface TickWaiter {
  readonly tick: number;
  readonly resolve: () => void;
  readonly reject: (error: SimQueryRejection) => void;
}

@Injectable({ providedIn: 'root' })
export class SimHost {
  private readonly clock = inject(SIM_CLOCK);
  private readonly factory = inject(SIM_WORKER_FACTORY);
  private readonly transportWanted = inject(SIM_TRANSPORT);
  private readonly document = inject(DOCUMENT);

  private link: SimLink | null = null;
  private readonly links = new Set<SimLink>();
  private readonly candidates = new WeakMap<SimCandidate, SimLink>();
  private binding: SimSessionBinding | null = null;
  private readonly pacer = new Pacer();
  private readonly meter = new SpeedMeter();
  private requested = 0;
  private lastNonZero = 1;
  private hidden = false;
  private holds = 0;
  private pacingTimer: unknown = null;
  private pacing = false;
  private sampleTimer: unknown = null;
  private lastSample = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly crashListeners = new Set<(crash: SimCrash) => void>();
  private readonly eventListeners = new Set<(events: readonly SimEvent[]) => void>();
  private tickWaiters: TickWaiter[] = [];
  private readonly selections = new Set<() => void>();

  private readonly phaseState = signal<'none' | 'starting' | 'ready' | 'crashed' | 'unavailable'>('none');
  private readonly speedState = signal(0);
  private readonly hiddenState = signal(false);
  private readonly simTickState = signal(0);
  private readonly commandedTickState = signal(0);
  private readonly effectiveState = signal(0);
  private readonly behindState = signal(false);
  private readonly descriptorState = signal<TopologyDescriptor | null>(null);
  private readonly crashState = signal<SimCrash | null>(null);
  private readonly transportState = signal<SimTransport | null>(null);

  /** The requested speed: 0 (paused), 1, 10 or 60 (the last `sim.setSpeed`, or `sim.resume`). */
  readonly speed = this.speedState.asReadonly();
  /** Δtick ÷ Δwall over the last window: the achieved multiple of real time. Panel rate. */
  readonly effectiveSpeed = this.effectiveState.asReadonly();
  /** "Falling behind" (with hysteresis, ADR 0011 §2). Panel rate. */
  readonly behind = this.behindState.asReadonly();
  /** The latest snapshot's tick: the sim time the player sees. Panel rate. */
  readonly simTick = this.simTickState.asReadonly();
  /** The bus's tick, what commands are stamped with (for "catching up"). Panel rate. */
  readonly commandedTick = this.commandedTickState.asReadonly();
  /** The current generation's topology descriptor (unthrottled). */
  readonly descriptor = this.descriptorState.asReadonly();
  /** The last crash, until a restart or a new game. */
  readonly crash = this.crashState.asReadonly();
  /** The transport the worker chose (`ready.transport`), or `null` without one. */
  readonly transport = this.transportState.asReadonly();

  /** Whether the sim is behind what is commanded by more than the lead (the HUD's "catching up"). */
  catchingUp(): boolean {
    const lead = Math.max(1, this.requested) * MAX_LEAD_WALL_MS;
    return this.commandedTickState() - this.simTickState() > lead;
  }

  /** The game's time host: every logged entry and advance goes to the current worker (ADR 0011 §3, §4). */
  readonly time: TimeHost = {
    advanceTo: (tick) => this.advanced(tick),
    applied: (entry) => this.applied(entry),
  };

  constructor() {
    const onVisibility = () => this.setHidden(this.document.visibilityState === 'hidden');
    this.document.addEventListener('visibilitychange', onVisibility);
    this.hidden = this.document.visibilityState === 'hidden';
    this.hiddenState.set(this.hidden);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      this.teardown();
    });
  }

  /** The sim's status (ADR 0011 §10): also the `sim.status` context key. */
  status(): SimStatus {
    const phase = this.phaseState();
    if (phase !== 'ready') return phase;
    if (this.speedState() === 0) return 'paused';
    return this.hiddenState() ? 'suspended' : 'running';
  }

  // --- lifecycle ------------------------------------------------------------------------------

  /** Follows `binding`'s game from now on (each start or adopt binds the new game). */
  bind(binding: SimSessionBinding | null): void {
    this.binding = binding;
    this.commandedTickState.set(binding?.tick() ?? 0);
  }

  /** A new game (ADR 0011 §10 "Start"): replaces any worker with one started from `world`, paused. */
  startWorld(world: World, firstSeq: number): void {
    const link = this.open({ kind: 'world', world, firstSeq });
    this.replace(link, link === null ? 'unavailable' : 'none');
  }

  /** The menu backdrop and teardown: no worker (readers get `null`). */
  stop(): void {
    this.replace(null);
  }

  /** `sim.restart`: a new worker that replays `log` (the session's, to the current tick) and resumes paused. */
  restart(log: ReplayLog): void {
    const link = this.open({ kind: 'replay', log });
    this.replace(link, link === null ? 'unavailable' : 'none');
  }

  /** Starts a worker for a load that isn't the game's yet (verification, ADR 0011 §10). */
  prepare(start: SimStart): SimCandidate | null {
    const link = this.open(start);
    if (link === null) return null;
    const candidate: SimCandidate = {
      ready: link.ready,
      whenReady: (timeoutMs) =>
        new Promise<void>((resolve, reject) => {
          const timer = this.clock.setTimeout(() => {
            link.fail({
              code: 'worker-error',
              message: 'The sim worker never became ready.',
              tick: null,
              reason: null,
            });
            reject(new SimQueryRejection('timeout'));
          }, timeoutMs);
          link.ready.then(
            () => {
              this.clock.clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              this.clock.clearTimeout(timer);
              reject(error);
            },
          );
        }),
      state: (tick, timeoutMs) => link.state(tick, timeoutMs),
      dispose: () => {
        if (this.link !== link) link.dispose('superseded');
      },
    };
    this.candidates.set(candidate, link);
    return candidate;
  }

  /** Makes a prepared worker the game's (a load went ahead): the old one is retired. */
  promote(candidate: SimCandidate): void {
    const link = this.candidates.get(candidate);
    if (link === undefined) throw new Error('SimHost.promote needs a candidate this host prepared');
    this.candidates.delete(candidate);
    this.replace(link);
  }

  /** Suspends pacing while a console script runs (ADR 0011 §9.4). Returns the release. */
  hold(): () => void {
    this.holds++;
    this.stopPacing();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.reanchor();
      this.schedulePacing();
    };
  }

  // --- queries --------------------------------------------------------------------------------

  /**
   * `world.hash` at the bus's current tick T (ADR 0011 §9.4): the bus world captured now, materialised
   * with the worker's export at T. Without a worker (the menu backdrop) it is the world as it is.
   * Rejects with a {@link SimQueryRejection} while crashed or unavailable, or on a timeout.
   */
  async hashAt(): Promise<{ readonly tick: number; readonly hash: string }> {
    const captured = this.capture();
    const world = await captured.world;
    return { tick: captured.tick, hash: worldHash(world) };
  }

  /**
   * The `netlist.dump` text at the bus's current tick T (plan F2.6): the world {@link capture}d now,
   * materialised with the worker's export at T, dumped on the main thread by `sim-core`'s pure
   * `netlistDump`, so it is byte for byte what `sim-cli` prints for the same session. The worker
   * contract needs no new message (ADR 0011 §9.4). Rejects as {@link hashAt} does.
   */
  async netlistDumpAt(): Promise<{ readonly tick: number; readonly text: string }> {
    const captured = this.capture();
    const world = await captured.world;
    return { tick: captured.tick, text: netlistDump(world) };
  }

  /**
   * The materialised world at the bus's tick, captured now: what a save writes (ADR 0011 §9.5). The
   * query is posted in this call, bound to this worker. `timeoutMs` shortens the deadline (the quit
   * flush gives at most `SIM_SETTLE_MS`).
   */
  capture(timeoutMs = STATE_QUERY_TIMEOUT_MS): { readonly tick: number; readonly world: Promise<World> } {
    const busWorld = this.requireBinding().world();
    const tick = busWorld.tick;
    const phase = this.phaseState();
    if (phase === 'none') return { tick, world: Promise.resolve(busWorld) };
    if (phase === 'crashed' || phase === 'unavailable' || this.link === null) {
      return { tick, world: Promise.reject(new SimQueryRejection(phase === 'crashed' ? 'crashed' : 'unavailable')) };
    }
    const reply = this.link.state(tick, timeoutMs);
    return { tick, world: reply.then((r) => materialiseWorld(busWorld, r.export as SimStateExport)) };
  }

  /** `snapshot.hash` at the bus's tick: the bytes encoded at exactly that tick (ADR 0011 §9.4). */
  async snapshotHash(): Promise<string> {
    const tick = this.requireBinding().tick();
    if (this.link === null || !this.link.alive)
      throw new SimQueryRejection(this.phaseState() === 'crashed' ? 'crashed' : 'unavailable');
    return snapshotHash(await this.link.snapshotBytes(tick));
  }

  /**
   * Resolves once a snapshot at `tick` or later has been read (the e2e hook's `waitForTick`). Rejects
   * (`superseded`, `crashed`) if the worker is replaced or crashes first, so a wait fails fast.
   */
  waitForTick(tick: number): Promise<void> {
    if ((this.link?.progress ?? 0) >= tick && this.link?.phase === 'ready') return Promise.resolve();
    if (this.phaseState() === 'crashed') return Promise.reject(new SimQueryRejection('crashed'));
    return new Promise((resolve, reject) => this.tickWaiters.push({ tick, resolve, reject }));
  }

  private rejectWaiters(reason: 'superseded' | 'crashed'): void {
    const waiters = this.tickWaiters;
    this.tickWaiters = [];
    for (const waiter of waiters) waiter.reject(new SimQueryRejection(reason));
  }

  /** Whether the current worker's reader is waiting a task to retry after a miss (specs). */
  get retryingRead(): boolean {
    return this.link?.retrying ?? false;
  }

  /** How far behind the worker is, in wall time at the requested speed (the autosave skip, ADR 0011 §9.5). */
  behindWallMs(): number {
    const link = this.link;
    if (link === null) return 0;
    const ticks = Math.max(0, link.lastAdvance - link.progress);
    return ticks / Math.max(1, this.requested);
  }

  /** Reader counters for the dev HUD and `sim.stats` (never the player's HUD). */
  stats(): { readonly misses: number; readonly reads: number; readonly transport: SimTransport | null } {
    const reader = this.link?.reader;
    return {
      misses: reader?.stats.misses ?? 0,
      reads: reader?.stats.reads ?? 0,
      transport: this.link?.transport ?? null,
    };
  }

  /** Whether a worker is alive, for the disposal spec. */
  get workerCount(): number {
    return [...this.links].filter((l) => l.alive).length;
  }

  /** Whether the pacing loop is scheduled (the e2e hook's `simPacing`: false while suspended or held). */
  get pacingScheduled(): boolean {
    return this.pacingTimer !== null;
  }

  /** Whether any timer of the host is pending, for the disposal spec. */
  get timersPending(): boolean {
    return this.pacingTimer !== null || this.sampleTimer !== null;
  }

  /** Whether any `Atomics.waitAsync` waiter is parked, for the disposal spec. */
  get waitersParked(): boolean {
    return [...this.links].some((l) => l.parked);
  }

  // --- readers --------------------------------------------------------------------------------

  /** The renderer's `SnapshotSource`: called after every new snapshot, `null` on a reset. */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether the sim is advancing (the renderer animates current only then). */
  get running(): boolean {
    return this.status() === 'running';
  }

  /** Listeners for crashes (the app shows the toast with Restart). */
  onCrash(listener: (crash: SimCrash) => void): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  /** Listeners for sim events (`tripped`, `blown`, …), in delivery order. */
  onEvents(listener: (events: readonly SimEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * A panel's view of the snapshot (ADR 0011 §9.3): `selector(view)` at most `hz` times a second
   * (at most 30), with a trailing sample, set only when the selected value changes (`equal`), reset
   * to `initial` on a source reset or a generation change, frozen and `stale` while crashed.
   * Unsubscribes with `destroyRef`.
   */
  select<T>(
    selector: (view: SnapshotView) => T,
    options: {
      readonly initial: T;
      readonly hz?: number;
      readonly equal?: (a: T, b: T) => boolean;
      readonly destroyRef?: DestroyRef;
    },
  ): SimSelection<T> {
    const value = signal(options.initial, { equal: options.equal ?? Object.is });
    const stale = signal(false);
    const interval = 1000 / Math.min(MAX_PANEL_SAMPLE_HZ, Math.max(1, options.hz ?? PANEL_SAMPLE_HZ));
    let last = Number.NEGATIVE_INFINITY;
    let trailing: unknown = null;
    let generation: TopologyDescriptor | null = null;
    const sample = (view: SnapshotView) => {
      last = this.clock.now();
      value.set(selector(view));
    };
    const off = this.subscribe((view) => {
      if (view === null) {
        if (trailing !== null) this.clock.clearTimeout(trailing);
        trailing = null;
        generation = null;
        if (this.phaseState() === 'crashed') {
          stale.set(true);
        } else {
          stale.set(false);
          value.set(options.initial);
        }
        return;
      }
      stale.set(false);
      if (view.descriptor !== generation) {
        generation = view.descriptor;
        sample(view); // a new generation: resample at once
        return;
      }
      const wait = last + interval - this.clock.now();
      if (wait <= 0) {
        sample(view);
      } else if (trailing === null) {
        trailing = this.clock.setTimeout(() => {
          trailing = null;
          const latest = this.link?.reader.current;
          if (latest) sample(latest);
        }, wait);
      }
    });
    const dispose = () => {
      off();
      if (trailing !== null) this.clock.clearTimeout(trailing);
      trailing = null;
      this.selections.delete(dispose);
    };
    this.selections.add(dispose);
    options.destroyRef?.onDestroy(dispose);
    return Object.assign(value.asReadonly(), { stale: stale.asReadonly() });
  }

  // --- internals: links -----------------------------------------------------------------------

  private open(start: SimStart): SimLink | null {
    if (this.factory === null) return null;
    const events: SimLinkEvents = {
      ready: (link) => this.linkReady(link),
      snapshot: (link, view) => this.linkSnapshot(link, view),
      descriptor: (link, descriptor) => {
        if (link === this.link) this.descriptorState.set(descriptor);
      },
      events: (link, list) => {
        if (link === this.link) for (const listener of [...this.eventListeners]) listener(list);
      },
      failed: (link, failure) => this.linkFailed(link, failure),
      closed: (link) => this.links.delete(link),
    };
    const link = new SimLink(this.factory(), events, this.clock, start, this.transportWanted, STATE_QUERY_TIMEOUT_MS);
    this.links.add(link);
    return link;
  }

  /** Makes `next` the current link (or none), retiring the old one and resetting every reader. */
  private replace(next: SimLink | null, phaseWithout: 'none' | 'unavailable' = 'none'): void {
    const old = this.link;
    if (old !== null && old !== next) old.retire(SIM_SETTLE_MS);
    this.link = next;
    this.stopPacing();
    this.clearSample();
    this.requested = 0;
    this.speedState.set(0);
    this.crashState.set(null);
    this.descriptorState.set(next?.reader.descriptor ?? null);
    this.transportState.set(null);
    this.effectiveState.set(0);
    this.behindState.set(false);
    this.simTickState.set(next?.progress ?? 0);
    this.commandedTickState.set(this.binding?.tick() ?? 0);
    this.rejectWaiters('superseded');
    this.phaseState.set(next === null ? phaseWithout : 'starting');
    for (const listener of [...this.listeners]) listener(null);
    if (next?.phase === 'ready') {
      this.linkReady(next);
      if (next.reader.current !== null) this.linkSnapshot(next, next.reader.current);
    }
  }

  private linkReady(link: SimLink): void {
    if (link !== this.link) return;
    this.phaseState.set('ready');
    this.transportState.set(link.transport);
    this.reanchor();
    this.schedulePacing();
  }

  private linkSnapshot(link: SimLink, view: SnapshotView): void {
    if (link !== this.link) return;
    for (const listener of [...this.listeners]) listener(view);
    if (this.tickWaiters.length > 0) {
      const due = this.tickWaiters.filter((w) => w.tick <= view.tick);
      this.tickWaiters = this.tickWaiters.filter((w) => w.tick > view.tick);
      for (const waiter of due) waiter.resolve();
    }
    this.sampleSoon();
    if (link.lastAdvance > link.progress) this.schedulePacing(); // supervise the catch-up
  }

  private linkFailed(link: SimLink, failure: SimFailure): void {
    this.links.delete(link);
    if (link !== this.link) return;
    if (failure.code === 'protocol-mismatch') {
      this.phaseState.set('unavailable'); // "simulation unavailable", no retry (ADR 0011 §10)
    } else {
      this.phaseState.set('crashed');
    }
    this.stopPacing();
    this.requested = 0;
    this.speedState.set(0);
    const code = failure.beforeReady && failure.code === 'worker-error' ? 'start-failed' : failure.code;
    const crash: SimCrash = { code, message: failure.message, tick: failure.tick ?? link.progress };
    this.crashState.set(crash);
    this.rejectWaiters('crashed');
    for (const listener of [...this.listeners]) listener(null);
    this.sampleNow();
    if (failure.code !== 'protocol-mismatch') for (const listener of [...this.crashListeners]) listener(crash);
  }

  // --- internals: time ------------------------------------------------------------------------

  private applied(entry: ReplayEntry): void {
    this.link?.command(entry);
    if (entry.id === 'sim.setSpeed') this.setSpeed(entry.args['speed'] as number);
    else if (entry.id === 'sim.resume') this.setSpeed(this.lastNonZero);
    else if (entry.id === SIM_STEP_COMMAND) this.sampleSoon();
  }

  private advanced(tick: number): void {
    this.link?.advance(tick);
    if (!this.pacing) {
      // A `sim.step` (or a script's advance): it isn't capped by the lead, so re-anchor after it.
      this.reanchor(tick);
      this.schedulePacing();
      this.sampleSoon();
    }
  }

  private setSpeed(speed: number): void {
    if (speed > 0) this.lastNonZero = speed;
    this.requested = speed;
    this.speedState.set(speed);
    this.reanchor();
    this.meter.reset(this.clock.now(), this.link?.progress ?? 0, speed);
    this.behindState.set(false);
    this.effectiveState.set(speed);
    this.schedulePacing();
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.hiddenState.set(hidden);
    if (hidden) {
      this.stopPacing(); // suspended (U1): host state, the speed is unchanged
    } else {
      this.reanchor();
      this.schedulePacing();
    }
  }

  private reanchor(tick = this.binding?.tick() ?? 0): void {
    const now = this.clock.now();
    this.pacer.setSpeed(this.requested, now, tick);
    this.meter.reset(now, this.link?.progress ?? tick, this.requested);
  }

  /** Whether the pacing loop should run: advancing, or supervising a catch-up (the watchdog). */
  private shouldPace(): boolean {
    const link = this.link;
    if (link === null || link.phase !== 'ready' || this.hidden || this.holds > 0) return false;
    return this.requested > 0 || link.lastAdvance > link.progress;
  }

  private schedulePacing(): void {
    if (this.pacingTimer !== null || !this.shouldPace()) return;
    this.pacingTimer = this.clock.setTimeout(() => {
      this.pacingTimer = null;
      this.pace();
    }, PACE_INTERVAL_MS);
  }

  private stopPacing(): void {
    if (this.pacingTimer !== null) this.clock.clearTimeout(this.pacingTimer);
    this.pacingTimer = null;
  }

  /** One pacing step (ADR 0011 §2): target = min(desired, progress + lead); the watchdog; the speed meter. */
  private pace(): void {
    const link = this.link;
    const binding = this.binding;
    if (link === null || binding === null || !this.shouldPace()) return;
    const now = this.clock.now();
    if (link.lastAdvance > link.progress && now - link.lastHeardWall >= WATCHDOG_MS) {
      link.fail({ code: 'watchdog', message: 'The sim worker stopped responding.', tick: link.progress, reason: null });
      return;
    }
    if (this.requested > 0) {
      const decision = this.pacer.target(now, link.progress, binding.tick());
      if (decision.advanceTo !== null) {
        this.pacing = true;
        try {
          binding.advanceTo(decision.advanceTo);
        } finally {
          this.pacing = false;
        }
      }
      const window = this.meter.sample(now, link.progress, this.requested);
      if (window !== null) {
        this.effectiveState.set(window.effective);
        this.behindState.set(window.behind);
      }
    }
    this.sampleSoon();
    this.schedulePacing();
  }

  // --- internals: panel-rate signals ----------------------------------------------------------

  /** Writes the tick signals at most at the panel rate, with a trailing sample (ADR 0011 §9.3). */
  private sampleSoon(): void {
    const wait = this.lastSample + 1000 / PANEL_SAMPLE_HZ - this.clock.now();
    if (wait <= 0) {
      this.sampleNow();
      return;
    }
    if (this.sampleTimer !== null) return;
    this.sampleTimer = this.clock.setTimeout(() => {
      this.sampleTimer = null;
      this.sampleNow();
    }, wait);
  }

  private sampleNow(): void {
    this.lastSample = this.clock.now();
    this.simTickState.set(this.link?.progress ?? this.simTickState());
    this.commandedTickState.set(this.binding?.tick() ?? 0);
  }

  private clearSample(): void {
    if (this.sampleTimer !== null) this.clock.clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
  }

  private requireBinding(): SimSessionBinding {
    if (this.binding === null) throw new Error('SimHost has no game bound');
    return this.binding;
  }

  private teardown(): void {
    this.replace(null);
    for (const link of [...this.links]) link.dispose('superseded');
    for (const dispose of [...this.selections]) dispose();
    this.stopPacing();
    this.clearSample();
    this.listeners.clear();
  }
}
