import { TestBed } from '@angular/core/testing';
import { createManifest, readCtrl, writeCtrl } from '@controls/save-format';
import { BUILD_ENGINE_VERSIONS, createGame, MAX_VERIFY_TICKS } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { FakeSimWorker } from '../testing/fake-sim-worker';
import { Session } from './session';
import { SIM_TRANSPORT, SIM_WORKER_FACTORY } from './sim-host';

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

function setup(factory = true) {
  const fakes = FakeSimWorker.factory();
  TestBed.configureTestingModule({
    providers: [
      { provide: SIM_WORKER_FACTORY, useValue: factory ? fakes.factory : null },
      { provide: SIM_TRANSPORT, useValue: 'message' },
    ],
  });
  return { session: TestBed.inject(Session), fakes };
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

  it('loads a save from another engine without verifying it (engine-changed), dropping a misfit record', async () => {
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
    expect(starts(fakes)).toEqual(['world', 'world']); // the misfit record failed, then started without it
    expect(fakes.workers[0].terminated).toBe(true);
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
});
