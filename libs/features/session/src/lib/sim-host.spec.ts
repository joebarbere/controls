import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createWorld, type World } from '@controls/save-format';
import { createGame, type Game } from '@controls/scripting-api';
import {
  BUFFER_OFFSETS,
  MAX_LEAD_WALL_MS,
  PACE_INTERVAL_MS,
  PUBLISH_SEQ_INDEX,
  SIM_SETTLE_MS,
  SLOT_OFFSETS,
  slotOffset,
  STATE_QUERY_TIMEOUT_MS,
  type SnapshotView,
  WATCHDOG_MS,
} from '@controls/sim-protocol';
import { FakeSimWorker, type FakeSimWorkerOptions } from '../testing/fake-sim-worker';
import { SIM_CLOCK, SIM_TRANSPORT, SIM_WORKER_FACTORY, SimHost, SimQueryRejection } from './sim-host';
import type { SimClock } from './sim-link';

/*
 * SimHost (ADR 0011 §2, §9, §10, plan F2.3b): one worker per game, every committed command forwarded
 * with its tick, integer pacing capped by the worker's progress, suspend and hold, the crash and
 * watchdog model, the asynchronous queries and disposal. The clock is fake (SIM_CLOCK), so pacing
 * runs exactly; the worker is the protocol-level fake on the real engine.
 */

/** A manual clock: timers run only when `advance` passes them, in due order. */
class FakeClock implements SimClock {
  time = 1_000;
  private nextId = 1;
  readonly timers = new Map<number, { at: number; task: () => void }>();
  now = () => this.time;
  setTimeout = (task: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, task });
    return id;
  };
  clearTimeout = (handle: unknown): void => void this.timers.delete(handle as number);
  /** Moves time on by `ms`, running due timers (and settling the fake worker's replies between them). */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await microtasks();
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].task();
    }
    this.time = end;
    await settle();
  }
}

/** Lets the fake worker's deliveries (microtasks) run. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/**
 * {@link microtasks}, then real task turns: an `Atomics.waitAsync` waiter is woken on a task, not a
 * microtask.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await microtasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const battery = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const lamp = { id: 'lamp.lumivane-12v-5w', version: 1 };
const at = { x: 0, y: 0, z: 0 };

function setup(
  options: { worker?: FakeSimWorkerOptions; factory?: boolean; hidden?: boolean; transport?: 'sab' | 'message' } = {},
) {
  const clock = new FakeClock();
  const fakes = FakeSimWorker.factory(options.worker);
  const doc = document;
  let hidden = options.hidden ?? false;
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  TestBed.configureTestingModule({
    providers: [
      { provide: SIM_CLOCK, useValue: clock },
      { provide: SIM_WORKER_FACTORY, useValue: options.factory === false ? null : fakes.factory },
      { provide: SIM_TRANSPORT, useValue: options.transport ?? 'message' },
      { provide: DOCUMENT, useValue: doc },
    ],
  });
  const host = TestBed.inject(SimHost);
  let game: Game = createGame({ seed: 1, time: host.time });
  const bind = (next: Game) => {
    game = next;
    host.bind({ tick: () => game.tick(), advanceTo: (t) => game.advanceTo(t), world: () => game.world() as World });
  };
  bind(game);
  /** A new game from `world`, as Session.newSandbox does. */
  const start = (world: World = createWorld({ seed: 1 })) => {
    bind(createGame({ world, registry: game.registry, time: host.time }));
    host.startWorld(world, 0);
  };
  const setHidden = (value: boolean) => {
    hidden = value;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { clock, host, fakes, game: () => game, start, setHidden };
}

afterEach(() => {
  TestBed.resetTestingModule();
  delete (document as unknown as Record<string, unknown>)['visibilityState'];
});

describe('SimHost: one worker per game', () => {
  it('starts a worker for a new game, paused, and replaces it (terminated) for the next', async () => {
    const { host, fakes, start } = setup();
    expect(host.status()).toBe('none');
    start();
    expect(host.status()).toBe('starting');
    expect(fakes.workers).toHaveLength(1);
    expect(fakes.workers[0].received[0]).toMatchObject({
      type: 'init',
      transport: 'message',
      start: { kind: 'world', firstSeq: 0 },
    });
    await settle();
    expect(host.status()).toBe('paused');
    expect(host.transport()).toBe('message');
    start();
    await settle();
    expect(fakes.workers).toHaveLength(2);
    expect(fakes.workers[0].terminated).toBe(true);
    expect(host.workerCount).toBe(1);
    host.stop();
    expect(host.status()).toBe('none');
    expect(fakes.workers[1].terminated).toBe(true);
    expect(host.workerCount).toBe(0);
  });

  it('is unavailable without a worker factory, and its queries say so', async () => {
    const { host, start } = setup({ factory: false });
    start();
    expect(host.status()).toBe('unavailable');
    await expect(host.hashAt()).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(host.snapshotHash()).rejects.toBeInstanceOf(SimQueryRejection);
  });

  it('forwards every committed command with its tick, and each advance, in order', async () => {
    const { host, fakes, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('entity.place', { ref: battery, positionMm: at });
    game().execOrThrow('sim.step', { ticks: 250 });
    game().execOrThrow('entity.place', { ref: lamp, positionMm: at });
    game().execOrThrow('view.resetLayout');
    const sent = fakes.workers[0].received
      .filter((m) => m.type === 'command' || m.type === 'advance')
      .map((m) =>
        m.type === 'command'
          ? `command ${(m['entry'] as { id: string }).id}@${(m['entry'] as { tick: number }).tick}`
          : `${m.type} ${m['tick']}`,
      );
    expect(sent).toEqual([
      'command entity.place@0',
      'command sim.step@0',
      'advance 250',
      'command entity.place@250',
      'command view.resetLayout@250',
    ]);
    await host.waitForTick(250);
    expect(fakes.workers[0].tick).toBe(250);
  });

  it('answers hashAt and snapshotHash with what the headless engine gives at the same tick', async () => {
    const { host, start, game } = setup();
    start();
    const headless = createGame({ seed: 1 });
    for (const g of [game(), headless]) {
      g.execOrThrow('entity.place', { ref: battery, positionMm: at });
      g.execOrThrow('sim.step', { ticks: 37 });
    }
    expect(await host.hashAt()).toEqual({ tick: 37, hash: headless.hash() });
    expect(await host.snapshotHash()).toBe(headless.snapshotHash());
  });

  it('hashes the world as it is with no worker (the menu backdrop)', async () => {
    const { host } = setup();
    host.stop();
    expect((await host.hashAt()).hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SimHost: pacing (ADR 0011 §2)', () => {
  it('advances in integer ticks at the requested speed, and stops when paused', async () => {
    const { host, clock, fakes, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 1 });
    expect(host.status()).toBe('running');
    await clock.advance(500);
    const advances = fakes.workers[0].received.filter((m) => m.type === 'advance').map((m) => m['tick'] as number);
    expect(advances.every((t) => Number.isSafeInteger(t))).toBe(true);
    expect(advances).toEqual([...advances].sort((a, b) => a - b));
    expect(game().tick()).toBeGreaterThanOrEqual(480);
    expect(game().tick()).toBeLessThanOrEqual(500);
    game().execOrThrow('sim.setSpeed', { speed: 0 });
    const paused = game().tick();
    await clock.advance(500);
    expect(game().tick()).toBe(paused);
    expect(host.status()).toBe('paused');
    game().execOrThrow('sim.resume');
    expect(host.speed()).toBe(1); // the last non-zero speed
  });

  it("caps the commanded tick at the worker's progress plus the lead, so 60× degrades with an indicator", async () => {
    const { host, clock, fakes, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 60 });
    await clock.advance(50);
    fakes.workers[0].hold(); // the worker stops answering: progress stays put
    await clock.advance(200); // the panel-rate sample catches up with the frozen progress
    const progress = host.simTick();
    await clock.advance(2_300);
    const lead = 60 * MAX_LEAD_WALL_MS;
    expect(game().tick()).toBeLessThanOrEqual(progress + lead);
    expect(host.effectiveSpeed()).toBeLessThan(0.9 * 60);
    expect(host.behind()).toBe(true); // "falling behind", after two slow windows
    fakes.workers[0].release();
    await clock.advance(2_000);
    expect(host.behind()).toBe(false);
  });

  it('suspends while the document is hidden and re-anchors when it is shown (no jump)', async () => {
    const { host, clock, start, game, setHidden } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 10 });
    await clock.advance(100);
    setHidden(true);
    expect(host.status()).toBe('suspended');
    const hiddenAt = game().tick();
    await clock.advance(5_000);
    expect(game().tick()).toBe(hiddenAt);
    expect(host.speed()).toBe(10); // the speed is unchanged
    setHidden(false);
    await clock.advance(100);
    expect(game().tick() - hiddenAt).toBeLessThanOrEqual(10 * (100 + PACE_INTERVAL_MS));
  });

  it('holds pacing while a script runs', async () => {
    const { host, clock, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 1 });
    const release = host.hold();
    const before = game().tick();
    await clock.advance(1_000);
    expect(game().tick()).toBe(before);
    release();
    release(); // idempotent
    await clock.advance(200);
    expect(game().tick()).toBeGreaterThan(before);
  });

  it('samples the panel signals at the panel rate, with a trailing sample', async () => {
    const { host, clock, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.step', { ticks: 10 });
    await clock.advance(200);
    expect(host.simTick()).toBe(10);
    expect(host.commandedTick()).toBe(10);
    expect(host.catchingUp()).toBe(false);
  });
});

describe('SimHost: crashes (ADR 0011 §10)', () => {
  it('on a worker error: crashed, terminated, readers reset, the world intact, and restart replays to the tick', async () => {
    const { host, fakes, start, game } = setup();
    start();
    game().execOrThrow('entity.place', { ref: battery, positionMm: at });
    game().execOrThrow('sim.step', { ticks: 20 });
    await settle();
    const views: (SnapshotView | null)[] = [];
    host.subscribe((view) => views.push(view));
    const crashes: unknown[] = [];
    host.onCrash((crash) => crashes.push(crash));
    fakes.workers[0].crash('engine-threw');
    await settle();
    expect(host.status()).toBe('crashed');
    expect(fakes.workers[0].terminated).toBe(true);
    expect(views.at(-1)).toBeNull();
    expect(crashes).toEqual([{ code: 'engine-threw', message: 'A fake failure.', tick: 20 }]);
    await expect(host.hashAt()).rejects.toMatchObject({ reason: 'crashed' });
    // World commands keep running on main.
    expect(game().exec('entity.place', { ref: lamp, positionMm: at }).ok).toBe(true);
    host.restart(game().replayLog());
    expect(fakes.workers[1].received[0]).toMatchObject({
      type: 'init',
      start: { kind: 'replay', log: { endTick: 20 } },
    });
    await settle();
    expect(host.status()).toBe('paused');
    expect(host.crash()).toBeNull();
    const headless = createGame({ seed: 1 });
    headless.execOrThrow('entity.place', { ref: battery, positionMm: at });
    headless.execOrThrow('sim.step', { ticks: 20 });
    headless.execOrThrow('entity.place', { ref: lamp, positionMm: at });
    expect((await host.hashAt()).hash).toBe(headless.hash());
  });

  it('crashes on onerror (start-failed before ready) and onmessageerror', async () => {
    const before = setup();
    before.start();
    before.fakes.workers[0].hang();
    before.fakes.workers[0].fireError();
    await settle();
    expect(before.host.crash()?.code).toBe('start-failed');
    TestBed.resetTestingModule();
    const after = setup();
    after.start();
    await settle();
    after.fakes.workers[0].fireMessageError();
    await settle();
    expect(after.host.crash()?.code).toBe('invalid-message');
  });

  it('crashes on a message outside the protocol, without echoing it', async () => {
    const { host, fakes, start } = setup();
    start();
    await settle();
    fakes.workers[0].sendRaw({ type: 'ready', secret: 'do-not-echo' });
    await settle();
    expect(host.crash()?.code).toBe('invalid-message');
    expect(host.crash()?.message).not.toContain('do-not-echo');
  });

  it('the watchdog crashes a worker that stops publishing while behind', async () => {
    const { host, clock, fakes, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 1 });
    await clock.advance(100);
    fakes.workers[0].hang();
    await clock.advance(WATCHDOG_MS - 200);
    expect(host.status()).toBe('running');
    await clock.advance(400);
    expect(host.crash()?.code).toBe('watchdog');
    expect(fakes.workers[0].terminated).toBe(true);
  });

  it('the watchdog measures liveness: a busy worker that still talks is never crashed; a silent one is', async () => {
    const { host, clock, fakes, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.setSpeed', { speed: 1 });
    await clock.advance(100);
    fakes.workers[0].hang(); // no more snapshots: it is draining a burst
    for (let i = 0; i < 6; i++) {
      await clock.advance(WATCHDOG_MS / 2);
      fakes.workers[0].sendRaw({ type: 'events', events: [] }); // but it is heard from
      await settle();
    }
    expect(host.crash()).toBeNull();
    expect(host.status()).toBe('running'); // three watchdog periods without a snapshot
    await clock.advance(WATCHDOG_MS + 100); // now silent
    expect(host.crash()?.code).toBe('watchdog');
  });

  it('a protocol mismatch is unavailable: no crash toast, no retry', async () => {
    const { host, fakes, start } = setup({ worker: { protocol: 999 } });
    const crashes: unknown[] = [];
    host.onCrash((c) => crashes.push(c));
    start();
    await settle();
    expect(host.status()).toBe('unavailable');
    expect(crashes).toEqual([]);
    expect(fakes.workers).toHaveLength(1);
  });
});

describe('SimHost: queries and disposal', () => {
  it('rejects a query the worker never answers, after STATE_QUERY_TIMEOUT_MS', async () => {
    const { host, clock, fakes, start } = setup();
    start();
    await settle();
    fakes.workers[0].hang();
    const hash = host.hashAt();
    const outcome = hash.then(
      () => 'resolved',
      (error: SimQueryRejection) => error.reason,
    );
    await clock.advance(STATE_QUERY_TIMEOUT_MS + 1);
    expect(await outcome).toBe('timeout');
  });

  it('a replace settles pending queries for up to SIM_SETTLE_MS, then rejects them as superseded', async () => {
    const { host, clock, fakes, start } = setup();
    start();
    await settle();
    fakes.workers[0].hold();
    const pending = host.hashAt().then(
      () => 'answered',
      (error: SimQueryRejection) => error.reason,
    );
    start(); // a New sandbox
    expect(fakes.workers[0].terminated).toBe(false); // settling
    await clock.advance(SIM_SETTLE_MS + 1);
    expect(fakes.workers[0].terminated).toBe(true);
    expect(await pending).toBe('superseded');
    // A pending query that is answered in time settles first.
    const second = host.hashAt();
    start();
    await clock.advance(10);
    await expect(second).resolves.toMatchObject({ tick: 0 });
    expect(fakes.workers[1].terminated).toBe(true);
  });

  it('teardown leaves no worker, timer, waiter or listener (disposal, shared mode)', async () => {
    const { host, clock, fakes, start, game } = setup({ worker: { sab: true }, transport: 'sab' });
    start();
    await settle();
    expect(host.transport()).toBe('sab');
    game().execOrThrow('sim.setSpeed', { speed: 1 });
    const views: (SnapshotView | null)[] = [];
    host.subscribe((v) => views.push(v));
    await clock.advance(100);
    expect(views.some((v) => v !== null && v.tick > 0)).toBe(true); // woken by Atomics.waitAsync
    expect(host.waitersParked).toBe(true);
    expect(host.timersPending).toBe(true);
    TestBed.resetTestingModule();
    await settle();
    expect(fakes.workers.every((w) => w.terminated)).toBe(true);
    expect(host.workerCount).toBe(0);
    expect(host.timersPending).toBe(false);
    expect(host.waitersParked).toBe(false);
    expect(clock.timers.size).toBe(0);
    expect(views.at(-1)).toBeNull();
  });

  it('select samples at the panel rate, trails, resets on a new game and goes stale on a crash', async () => {
    const { host, clock, fakes, start, game } = setup();
    start();
    await settle();
    const ref = TestBed.inject(Injector).get(DestroyRef);
    const tick = host.select((view) => view.tick, { initial: -1, hz: 10, destroyRef: ref });
    game().execOrThrow('sim.step', { ticks: 5 });
    await clock.advance(1);
    game().execOrThrow('sim.step', { ticks: 5 });
    await settle();
    expect(tick()).toBe(0); // the first snapshot of the generation is sampled at once; the rest trail
    await clock.advance(50);
    expect(tick()).toBe(0); // still inside the 100 ms window
    await clock.advance(150);
    expect(tick()).toBe(10);
    fakes.workers[0].crash();
    await settle();
    expect(tick.stale()).toBe(true);
    expect(tick()).toBe(10); // frozen
    start();
    expect(tick()).toBe(-1); // a source reset
  });

  it('select starts from the latest snapshot, so a panel opened while paused shows it (F2.6)', async () => {
    const { host, clock, start, game } = setup();
    start();
    await settle();
    game().execOrThrow('sim.step', { ticks: 5 });
    await settle();
    const ref = TestBed.inject(Injector).get(DestroyRef);
    let samples = 0;
    const tick = host.select((view) => (samples++, view.tick), { initial: -1, hz: 10, destroyRef: ref });
    expect(tick()).toBe(5); // no new snapshot needed
    expect(samples).toBe(1);
    expect(tick.stale()).toBe(false);
    // The start-up sample is this generation's: snapshots of it inside the 100 ms window (the
    // worker's next publish at tick 5, then tick 10) aren't sampled until the trailing timer.
    const views: number[] = [];
    host.subscribe((v) => v !== null && views.push(v.tick));
    game().execOrThrow('sim.step', { ticks: 5 });
    await clock.advance(20);
    expect(views).toContain(10);
    expect(samples).toBe(1);
    expect(tick()).toBe(5);
    await clock.advance(100);
    expect(tick()).toBe(10);
    expect(samples).toBe(2);
  });

  it('select opened while crashed starts stale, like every frozen selection', async () => {
    const { host, fakes, start } = setup();
    start();
    await settle();
    fakes.workers[0].crash();
    await settle();
    const ref = TestBed.inject(Injector).get(DestroyRef);
    const tick = host.select((view) => view.tick, { initial: -1, destroyRef: ref });
    expect(tick.stale()).toBe(true);
  });

  it('rejects a waitForTick when the worker is replaced or crashes, so a wait fails fast', async () => {
    const { host, fakes, start } = setup();
    start();
    await settle();
    const replaced = host.waitForTick(1_000_000).catch((e: SimQueryRejection) => e.reason);
    start();
    expect(await replaced).toBe('superseded');
    await settle();
    const crashed = host.waitForTick(1_000_000).catch((e: SimQueryRejection) => e.reason);
    fakes.workers[1].crash();
    expect(await crashed).toBe('crashed');
    expect(await host.waitForTick(5).catch((e: SimQueryRejection) => e.reason)).toBe('crashed');
  });

  it('after a miss (both slots busy) re-reads on a task, not in a microtask spin', async () => {
    const { host, clock, fakes, start } = setup({ worker: { sab: true }, transport: 'sab' });
    start();
    await settle();
    const buffer = fakes.workers[0].sharedBuffer as SharedArrayBuffer;
    const i32 = new Int32Array(buffer);
    const slotBytes = new DataView(buffer).getUint32(BUFFER_OFFSETS.slotBytes, true);
    const seq = (slot: number) => (slotOffset(slot, slotBytes) + SLOT_OFFSETS.slotSeq) / 4;
    const views: (SnapshotView | null)[] = [];
    host.subscribe((v) => views.push(v));
    // Both slots mid-write, and a new publish announced.
    Atomics.add(i32, seq(0), 1);
    Atomics.add(i32, seq(1), 1);
    Atomics.add(i32, PUBLISH_SEQ_INDEX, 1);
    Atomics.notify(i32, PUBLISH_SEQ_INDEX);
    await settle();
    expect(host.stats().misses).toBeGreaterThan(0);
    expect(host.retryingRead).toBe(true); // a task is scheduled, nothing spins
    const misses = host.stats().misses;
    await settle();
    expect(host.stats().misses).toBe(misses); // no further attempts until the task runs
    Atomics.add(i32, seq(0), 1); // both slots complete again
    Atomics.add(i32, seq(1), 1);
    await clock.advance(0);
    expect(host.retryingRead).toBe(false);
    expect(views.at(-1)).not.toBeNull();
  });
});

describe('SimHost: traces (ADR 0011 §4, plan F2.6)', () => {
  const lampBranch = { kind: 'branch', element: { kind: 'entity', entity: 3, part: 'filament' } } as const;
  const watches = (worker: { received: readonly { type: string; [key: string]: unknown }[] }) =>
    worker.received.filter((m) => m.type === 'watch' || m.type === 'unwatch').map((m) => `${m.type} ${m['id']}`);

  it('watches on the worker, appends its batches, and changes version at the panel rate with a trailing change', async () => {
    const { host, fakes, start, clock } = setup();
    start();
    await settle();
    const trace = host.watch(lampBranch);
    expect(watches(fakes.workers[0])).toEqual([`watch ${trace.id}`]);
    const v0 = trace.version();
    fakes.workers[0].sendRaw({ type: 'trace', id: trace.id, samples: new Float64Array([0, 6.1, 10, 3.2]) });
    await settle();
    expect([...trace.samples()]).toEqual([0, 6.1, 10, 3.2]);
    expect(trace.version()).toBe(v0 + 1);
    // A second batch within the panel interval: held for the trailing change, never lost.
    fakes.workers[0].sendRaw({ type: 'trace', id: trace.id, samples: new Float64Array([20, 1.1]) });
    await settle();
    expect(trace.version()).toBe(v0 + 1);
    await clock.advance(100);
    expect(trace.version()).toBe(v0 + 2);
    expect([...trace.samples()]).toEqual([0, 6.1, 10, 3.2, 20, 1.1]);
    // A batch for a watch the host doesn't hold is ignored; the e2e hook lists what the UI received.
    fakes.workers[0].sendRaw({ type: 'trace', id: 999, samples: new Float64Array([1, 1]) });
    await settle();
    expect(host.traceSamples()).toEqual([{ id: trace.id, target: lampBranch, samples: [0, 6.1, 10, 3.2, 20, 1.1] }]);
  });

  it('starts afresh on a new worker, watched again there, and unwatches on stop', async () => {
    const { host, fakes, start } = setup();
    start();
    await settle();
    const trace = host.watch(lampBranch, { capacity: 2 });
    fakes.workers[0].sendRaw({ type: 'trace', id: trace.id, samples: new Float64Array([0, 1, 10, 2, 20, 3]) });
    await settle();
    expect([...trace.samples()]).toEqual([10, 2, 20, 3]); // the newest `capacity`, oldest first
    start(); // a new game: a new timeline
    await settle();
    expect(trace.samples()).toHaveLength(0);
    expect(watches(fakes.workers[1])).toEqual([`watch ${trace.id}`]);
    // The retired worker's late batch is never shown.
    fakes.workers[0].sendRaw({ type: 'trace', id: trace.id, samples: new Float64Array([30, 4]) });
    await settle();
    expect(trace.samples()).toHaveLength(0);
    trace.stop();
    expect(watches(fakes.workers[1])).toEqual([`watch ${trace.id}`, `unwatch ${trace.id}`]);
    expect(host.traceSamples()).toEqual([]);
  });
});
