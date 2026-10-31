import { TestBed } from '@angular/core/testing';
import { createManifest, readCtrl, writeCtrl } from '@controls/save-format';
import { BUILD_ENGINE_VERSIONS, createGame, MAX_VERIFY_TICKS } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { STATE_QUERY_TIMEOUT_MS } from '@controls/sim-protocol';
import { FakeSimWorker, type FakeSimWorkerOptions } from '../testing/fake-sim-worker';
import { START_RETRY_MS, verifyDeadlineMs } from './load';
import { Session } from './session';
import { SIM_CLOCK, SIM_TRANSPORT, SIM_WORKER_FACTORY } from './sim-host';
import type { SimClock } from './sim-link';

/*
 * Loading a save in the game (ADR 0011 §10, plan F2.3b): the log is verified in a worker (a replay
 * start), never on the main thread; the same `planLoad` decides it as headless; a match carries the
 * worker on, anything else restarts from world.json; a same-engine misfit is refused, another
 * engine's dropped.
 */

const battery = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const sw = { id: 'switch.tessaline-spst-toggle', version: 1 };
const lead = { id: 'lead.quillfern-test-1m', version: 1 };
const at = { x: 0, y: 0, z: 0 };

/** A save of a battery shorted through a switch, run for `ticks`: it has a circuit and a solution. */
function circuitSave(ticks = 40) {
  const game = createGame({ seed: 4 });
  game.execOrThrow('entity.place', { ref: battery, positionMm: at });
  game.execOrThrow('entity.place', { ref: sw, positionMm: at });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
  game.execOrThrow('sim.step', { ticks });
  return { bytes: game.save(), hash: game.hash(), game };
}

/** Rewrites a save's documents. */
function rewrite(bytes: Uint8Array, change: (c: Parameters<typeof writeCtrl>[0]) => Parameters<typeof writeCtrl>[0]) {
  const read = readCtrl(bytes);
  if (!read.ok) throw new Error('unreadable');
  const { manifest, world, replayLog, thumbnail } = read.value;
  return writeCtrl(change({ manifest, world, replayLog, thumbnail }));
}

/** A clock whose timers run only when the spec fires them (deadlines are tested, never waited for). */
class ManualClock implements SimClock {
  readonly timers = new Map<number, { readonly ms: number; readonly task: () => void }>();
  private next = 1;
  now = () => 0;
  setTimeout = (task: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { ms, task });
    return id;
  };
  clearTimeout = (handle: unknown): void => void this.timers.delete(handle as number);
  /** Runs the pending timers with a deadline of at least `ms`. */
  fire(ms: number): number {
    const due = [...this.timers.entries()].filter(([, t]) => t.ms >= ms);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.task();
    }
    return due.length;
  }
}

function setup(
  factory = true,
  options: FakeSimWorkerOptions | ((index: number) => FakeSimWorkerOptions) = {},
  clock?: SimClock,
) {
  const fakes = FakeSimWorker.factory(options);
  TestBed.configureTestingModule({
    providers: [
      { provide: SIM_WORKER_FACTORY, useValue: factory ? fakes.factory : null },
      { provide: SIM_TRANSPORT, useValue: 'message' },
      ...(clock === undefined ? [] : [{ provide: SIM_CLOCK, useValue: clock }]),
    ],
  });
  return { session: TestBed.inject(Session), fakes };
}

/** Lets the fake workers' deliveries (microtasks) run. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const starts = (fakes: { workers: FakeSimWorker[] }) =>
  fakes.workers.map((w) => (w.received[0] as unknown as { start: { kind: string } }).start.kind);

afterEach(() => TestBed.resetTestingModule());

describe('prepareLoad', () => {
  it('verifies the log in a worker (a replay start) and carries that worker on', async () => {
    const { session, fakes } = setup();
    const save = circuitSave();
    const result = await session.prepareLoad(save.bytes);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.prepared.replay).toEqual({ status: 'continued' });
    expect(result.prepared.hash).toBe(save.hash);
    expect(starts(fakes)).toEqual(['replay']);
    expect(fakes.workers[0].terminated).toBe(false);
    session.adopt(result.prepared);
    expect(await session.hashAt()).toBe(save.hash);
    expect(session.entries()).toEqual(save.game.entries());
  });

  it("restarts the log from world.json when the replay doesn't reproduce it (and terminates the checker)", async () => {
    const { session, fakes } = setup();
    const save = circuitSave();
    const tampered = rewrite(save.bytes, (c) => ({
      ...c,
      // A moved battery: the circuit (and so the solution record) still fits, but the hash differs.
      world: {
        ...c.world,
        entities: c.world.entities.map((e) =>
          e.id === 1 ? { ...e, transform: { ...e.transform, positionMm: { x: 5, y: 0, z: 0 } } } : e,
        ),
      },
    }));
    const result = await session.prepareLoad(tampered);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'hash-mismatch' });
    expect(starts(fakes)).toEqual(['replay', 'world']);
    expect(fakes.workers[0].terminated).toBe(true);
    expect(result.prepared.game.entries()).toEqual([]);
    // The new log numbers on from the saved one.
    expect(result.prepared.game.execOrThrow('view.resetLayout')?.seq).toBe(save.game.entries().length);
  });

  it('never replays a log longer than MAX_VERIFY_TICKS, exactly as the headless load (too-long-to-verify)', async () => {
    const { session, fakes } = setup();
    const save = circuitSave(MAX_VERIFY_TICKS.value + 1);
    const result = await session.prepareLoad(save.bytes);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
    expect(starts(fakes)).toEqual(['world']); // no replay start was ever sent
    expect(result.prepared.hash).toBe(save.hash); // world.json as saved
  });

  it('loads a save from another engine without verifying it (engine-changed), never with its solution record', async () => {
    const { session, fakes } = setup();
    const save = circuitSave();
    const other = rewrite(save.bytes, (c) => ({
      ...c,
      manifest: createManifest({
        ...BUILD_ENGINE_VERSIONS,
        simEngineVersion: BUILD_ENGINE_VERSIONS.simEngineVersion + 1,
      }),
      world: c.world.sim === null ? c.world : { ...c.world, sim: { ...c.world.sim, topologyHash: '0'.repeat(64) } },
    }));
    const result = await session.prepareLoad(other);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
    // D8 as headless (F2.4): never another engine's solution record, so one start, without it.
    expect(starts(fakes)).toEqual(['world']);
    const sent = fakes.workers[0].received[0] as unknown as { start: { world: { sim: unknown } } };
    expect(sent.start.world.sim).toBeNull();
  });

  it('refuses a same-engine save whose solution record does not fit its circuit (start-failed)', async () => {
    const { session, fakes } = setup();
    const save = circuitSave();
    const damaged = rewrite(save.bytes, (c) => ({
      ...c,
      replayLog: null,
      world: c.world.sim === null ? c.world : { ...c.world, sim: { ...c.world.sim, topologyHash: '0'.repeat(64) } },
    }));
    const result = await session.prepareLoad(damaged);
    expect(result).toMatchObject({ ok: false, error: { kind: 'start-failed', reason: 'topology-mismatch' } });
    expect(fakes.workers.every((w) => w.terminated)).toBe(true);
  });

  it('refuses bytes that are not a save, and devices the catalogue refuses, before any worker starts', async () => {
    const { session, fakes } = setup();
    expect(await session.prepareLoad(new Uint8Array([1, 2, 3]))).toMatchObject({
      ok: false,
      error: { kind: 'not-a-zip' },
    });
    const save = circuitSave();
    const bad = rewrite(save.bytes, (c) => ({
      ...c,
      replayLog: null,
      world: { ...c.world, entities: c.world.entities.map((e) => (e.id === 2 ? { ...e, state: { nope: 1 } } : e)) },
    }));
    expect(await session.prepareLoad(bad)).toMatchObject({ ok: false, error: { kind: 'invalid-device-state' } });
    expect(fakes.workers).toEqual([]);
  });

  it('says the sim is unavailable when there is no worker to check with', async () => {
    const { session } = setup(false);
    expect(await session.prepareLoad(circuitSave().bytes)).toMatchObject({
      ok: false,
      error: { kind: 'sim-unavailable' },
    });
  });

  it('a prepared load that is not adopted terminates its worker on dispose', async () => {
    const { session, fakes } = setup();
    const result = await session.prepareLoad(circuitSave().bytes);
    if (!result.ok) throw new Error(result.error.message);
    result.prepared.dispose();
    expect(fakes.workers[0].terminated).toBe(true);
    expect(worldHash(result.prepared.game.world() as never)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('a load never depends on the worker being well or fast (#58 review)', () => {
    it('a verifying worker that crashes after ready restarts the log from world.json (verify-unavailable), never refuses', async () => {
      const { session, fakes } = setup(true, (i) => (i === 0 ? { onQuery: 'engine-threw' } : {}));
      const save = circuitSave();
      const result = await session.prepareLoad(save.bytes);
      if (!result.ok) throw new Error(`refused: ${result.error.kind}`);
      expect(result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'verify-unavailable' });
      expect(starts(fakes)).toEqual(['replay', 'world']);
      expect(fakes.workers[0].terminated).toBe(true);
      expect(result.prepared.hash).toBe(save.hash); // world.json as saved
    });

    it('a verifying worker that misses its deadline restarts the log; the deadline grows with the log', async () => {
      const clock = new ManualClock();
      const { session, fakes } = setup(true, (i) => (i === 0 ? { onQuery: 'hang' } : {}), clock);
      const save = circuitSave(400);
      const pending = session.prepareLoad(save.bytes);
      await microtasks();
      const deadline = verifyDeadlineMs({ endTick: 400, initialWorld: { tick: 0 } });
      expect(deadline).toBeGreaterThan(STATE_QUERY_TIMEOUT_MS);
      expect(clock.fire(deadline)).toBe(1); // only the verification query's own deadline
      await microtasks();
      const result = await pending;
      if (!result.ok) throw new Error(`refused: ${result.error.kind}`);
      expect(result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'verify-unavailable' });
      expect(starts(fakes)).toEqual(['replay', 'world']);
      expect(fakes.workers[0].terminated).toBe(true);
    });

    it('the verify deadline at MAX_VERIFY_TICKS is at least 5x the slowest runner seen', () => {
      // MAX_VERIFY_TICKS' source: about 0.15 ms per tick on the slowest CI runner.
      const slowestMsPerTick = 0.15;
      expect(String(MAX_VERIFY_TICKS.source)).toContain('0.15 ms per tick on the slowest');
      const ticks = MAX_VERIFY_TICKS.value;
      expect(verifyDeadlineMs({ endTick: ticks, initialWorld: { tick: 0 } })).toBeGreaterThanOrEqual(
        5 * slowestMsPerTick * ticks,
      );
      // And per tick, without the fixed part: any log length gets the margin.
      expect(
        verifyDeadlineMs({ endTick: 1_000, initialWorld: { tick: 0 } }) - STATE_QUERY_TIMEOUT_MS,
      ).toBeGreaterThanOrEqual(5 * slowestMsPerTick * 1_000);
    });

    it('a worker that never becomes ready is disposed after the deadline, and the load goes on', async () => {
      const clock = new ManualClock();
      const { session, fakes } = setup(true, (i) => (i === 0 ? { silent: true } : {}), clock);
      const pending = session.prepareLoad(circuitSave().bytes);
      await microtasks();
      expect(clock.fire(STATE_QUERY_TIMEOUT_MS)).toBe(1);
      const result = await pending;
      expect(result.ok && result.prepared.replay).toMatchObject({ status: 'restarted', reason: 'verify-unavailable' });
      expect(fakes.workers[0].terminated).toBe(true);
      expect(session.sim.workerCount).toBe(1); // only the one that carries on
    });

    it('a world.json start whose worker is slow to load is retried once with longer deadlines, and loads', async () => {
      const clock = new ManualClock();
      const { session, fakes } = setup(true, (i) => (i === 0 ? { silent: true } : {}), clock);
      const noLog = rewrite(circuitSave().bytes, (c) => ({ ...c, replayLog: null }));
      const pending = session.prepareLoad(noLog);
      await microtasks();
      expect([...clock.timers.values()].map((t) => t.ms)).toEqual([STATE_QUERY_TIMEOUT_MS]);
      expect(clock.fire(STATE_QUERY_TIMEOUT_MS)).toBe(1);
      const result = await pending;
      if (!result.ok) throw new Error(`refused: ${result.error.kind}`);
      expect(starts(fakes)).toEqual(['world', 'world']);
      expect(fakes.workers[0].terminated).toBe(true);
      expect(START_RETRY_MS).toBeGreaterThan(STATE_QUERY_TIMEOUT_MS);
    });

    it('sim-failed only after the retry with longer deadlines has failed too', async () => {
      const clock = new ManualClock();
      const { session, fakes } = setup(true, { silent: true }, clock);
      const noLog = rewrite(circuitSave().bytes, (c) => ({ ...c, replayLog: null }));
      const pending = session.prepareLoad(noLog);
      await microtasks();
      expect(clock.fire(STATE_QUERY_TIMEOUT_MS)).toBe(1);
      await microtasks();
      expect([...clock.timers.values()].map((t) => t.ms)).toEqual([START_RETRY_MS]); // the retry's own deadline
      expect(clock.fire(START_RETRY_MS)).toBe(1);
      expect(await pending).toMatchObject({ ok: false, error: { kind: 'sim-failed' } });
      expect(fakes.workers.map((w) => w.terminated)).toEqual([true, true]);
    });

    it('a worker failure starting world.json is the simulator failing (sim-failed), not a damaged save', async () => {
      for (const failInit of ['capacity', 'engine-threw'] as const) {
        TestBed.resetTestingModule();
        const { session, fakes } = setup(true, { failInit });
        const noLog = rewrite(circuitSave().bytes, (c) => ({ ...c, replayLog: null }));
        expect(await session.prepareLoad(noLog)).toMatchObject({ ok: false, error: { kind: 'sim-failed' } });
        expect(fakes.workers).toHaveLength(2); // retried once
      }
    });

    it('refuses as start-failed only with the reason the worker sent', async () => {
      const { session } = setup();
      const save = circuitSave();
      const damaged = rewrite(save.bytes, (c) => ({
        ...c,
        replayLog: null,
        world: c.world.sim === null ? c.world : { ...c.world, sim: { ...c.world.sim, nodes: [] } },
      }));
      expect(await session.prepareLoad(damaged)).toMatchObject({
        ok: false,
        error: { kind: 'start-failed', reason: 'length-mismatch' },
      });
    });
  });
});
