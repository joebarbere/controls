import { createWorld, type ReplayEntry, type World } from '@controls/save-format';
import { createGame, type Game } from '@controls/scripting-api';
import { ENGINE_BENCH, ENGINE_TEST_CATALOG, engineTestOptions } from '@controls/sim-core/testing';
import {
  MIN_SLOT_BYTES,
  PUBLISH_MIN_WALL_MS,
  PUBLISH_SEQ_INDEX,
  readDiagnostics,
  SIM_PROTOCOL_VERSION,
  WORK_SLICE_MS,
} from '@controls/sim-protocol';
import { createWorldRegistry } from '@controls/world-model';
import fc from 'fast-check';
import { RunnerHarness } from '../testing/runner-harness';

/*
 * The sim worker's inbox and run loop (ADR 0011 §4, §7, §8, §10), driven by a deterministic host:
 * the protocol check, both starts, the mirror bus and its desync check, ordered queries, slicing,
 * throttled and forced publishes, the fallback's pool, capacity and events. The snapshot bytes and
 * the materialised hash always equal the headless `Game`'s (the same engine through `sim-cli`'s path).
 */

const registry = () => createWorldRegistry({ catalog: ENGINE_TEST_CATALOG });
const options = () => engineTestOptions();

/** A headless game on the engine test catalogue: the reference the worker must match. */
function reference(world: World = createWorld({ seed: 11 })): Game {
  return createGame({ world, registry: registry(), engine: options() });
}

/** Runs the engine bench in `game`, returning its entries. */
function runBench(game: Game): readonly ReplayEntry[] {
  for (const [id, args] of ENGINE_BENCH) game.execOrThrow(id, args);
  return game.entries();
}

const harness = (extra: ConstructorParameters<typeof RunnerHarness>[0] = {}) =>
  new RunnerHarness({ engine: options(), ...extra });

describe('starting', () => {
  it('refuses another protocol version before parsing anything else', () => {
    const h = harness();
    h.send({ type: 'init', protocol: SIM_PROTOCOL_VERSION + 1, transport: 'sab', start: 'whatever' });
    expect(h.messages).toEqual([
      expect.objectContaining({ type: 'error', code: 'protocol-mismatch', seq: null, tick: null }),
    ]);
    expect(h.runner.state).toBe('failed');
    h.send({ type: 'advance', tick: 1 });
    expect(h.messages).toHaveLength(1); // a failed worker says nothing more
  });

  it('refuses a first message that is not a valid init, and a second init', () => {
    const bad = harness();
    bad.send({ type: 'advance', tick: 1 });
    expect(bad.of('error')[0]).toMatchObject({ code: 'invalid-message' });
    expect(bad.of('error')[0].message).not.toContain('advance');
    const twice = harness();
    twice.init({ kind: 'world', world: createWorld({ seed: 1 }), firstSeq: 0 });
    twice.send({
      type: 'init',
      protocol: SIM_PROTOCOL_VERSION,
      transport: 'sab',
      start: { kind: 'world', world: createWorld({ seed: 1 }), firstSeq: 0 },
    });
    expect(twice.of('error')[0]).toMatchObject({ code: 'invalid-message' });
  });

  it('refuses a big-endian platform, and a world whose sim state does not fit (start-failed)', () => {
    const big = harness({ littleEndian: false });
    big.init({ kind: 'world', world: createWorld({ seed: 1 }), firstSeq: 0 });
    expect(big.of('error')[0]).toMatchObject({ code: 'start-failed' });
    const misfit = harness();
    const world = {
      ...createWorld({ seed: 1 }),
      sim: { lastSolveTick: 0, topologyHash: 'a'.repeat(64), nodes: [], branches: [], islands: [] },
    };
    misfit.init({ kind: 'world', world, firstSeq: 0 });
    expect(misfit.of('error')[0]).toMatchObject({ code: 'start-failed' });
    expect(misfit.of('error')[0].message).toContain('solution-on-empty-netlist');
  });

  it('starts from a world: ready, then the descriptor, then a snapshot at its tick', () => {
    const game = reference();
    runBench(game);
    game.advance(55);
    const world = game.materialisedWorld() as World;
    const h = harness();
    h.init({ kind: 'world', world, firstSeq: game.entries().length });
    expect(h.messages.map((m) => m.type)).toEqual(['ready', 'topology']);
    expect(h.of('ready')[0]).toMatchObject({
      protocol: SIM_PROTOCOL_VERSION,
      transport: 'sab',
      isolated: true,
      tick: 55,
    });
    expect(h.of('ready')[0].buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(h.view()?.tick).toBe(55);
    expect(h.view()?.hashedBytes()).toEqual(game.snapshot());
  });

  it('falls back to messages when asked, when not isolated, or without SharedArrayBuffer (ADR 0011 §8)', () => {
    const asked = harness();
    asked.init({ kind: 'world', world: createWorld({ seed: 2 }), firstSeq: 0 }, 'message');
    expect(asked.of('ready')[0]).toMatchObject({ transport: 'message', buffer: null });
    expect(asked.of('snapshot')).toHaveLength(1);
    const unisolated = harness({ isolated: false });
    unisolated.init({ kind: 'world', world: createWorld({ seed: 2 }), firstSeq: 0 }, 'sab');
    expect(unisolated.of('ready')[0]).toMatchObject({ transport: 'message', isolated: false });
    const none = harness({ sharedArrayBuffer: false });
    none.init({ kind: 'world', world: createWorld({ seed: 2 }), firstSeq: 0 }, 'sab');
    expect(none.of('ready')[0].transport).toBe('message');
  });

  it('refuses a snapshot over the slot cap (capacity), never a partial publish', () => {
    const game = reference();
    runBench(game);
    const h = harness({ maxSlotBytes: 64 });
    h.init({ kind: 'world', world: game.materialisedWorld() as World, firstSeq: 0 });
    expect(h.messages.map((m) => m.type)).toEqual(['error']);
    expect(h.of('error')[0]).toMatchObject({ code: 'capacity' });
  });
});

describe('following the host', () => {
  it('applies commands at their ticks through the mirror bus and matches the headless game, both transports', () => {
    for (const transport of ['sab', 'message'] as const) {
      const game = reference();
      const h = harness();
      h.init({ kind: 'world', world: game.world() as World, firstSeq: 0 }, transport);
      let sent = 0;
      const forward = () => {
        for (const entry of game.entries().slice(sent)) h.send({ type: 'command', entry });
        sent = game.entries().length;
      };
      for (const [id, args] of ENGINE_BENCH) {
        game.execOrThrow(id, args);
        forward();
      }
      game.advance(123);
      h.send({ type: 'advance', tick: 123 });
      game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
      forward();
      game.advance(77);
      h.send({ type: 'advance', tick: 200 });
      h.drain();
      expect(h.view()?.tick).toBe(200);
      expect(h.view()?.hashedBytes()).toEqual(game.snapshot());
      const state = h.query('state', 200);
      expect(RunnerHarness.hashOf(game.world() as World, state)).toBe(game.hash());
      const bytes = h.query('snapshot', 200);
      expect(bytes.type === 'snapshotBytes' && new Uint8Array(bytes.bytes)).toEqual(game.snapshot());
      expect(state.type === 'state' && state.snapshotHash).toBe(game.snapshotHash());
    }
  });

  it('a replay start reaches the same state as a live run, and keeps its history quiet', () => {
    const game = reference();
    runBench(game);
    game.advance(400); // the fuse blows on the way: an event
    const log = game.replayLog();
    const h = harness();
    h.init({ kind: 'replay', log });
    h.drain();
    expect(h.view()?.tick).toBe(400);
    expect(h.view()?.hashedBytes()).toEqual(game.snapshot());
    expect(RunnerHarness.hashOf(game.world() as World, h.query('state', 400))).toBe(game.hash());
    expect(h.of('events')).toEqual([]); // the replay's events are history, not news
  });

  it('forwards sim events with the publish after them', () => {
    const game = reference();
    const events: unknown[] = [];
    game.on('sim', (event) => events.push(event));
    const h = harness();
    h.init({ kind: 'world', world: game.world() as World, firstSeq: 0 });
    for (const entry of runBench(game)) h.send({ type: 'command', entry });
    game.advance(400);
    h.send({ type: 'advance', tick: 400 });
    h.drain();
    expect(events.length).toBeGreaterThan(0);
    expect(h.of('events').flatMap((m) => m.events)).toEqual(events);
  });

  it('answers a query only after every earlier message, at its tick (ADR 0011 §9.5)', () => {
    const game = reference();
    const world = game.world() as World;
    const entries = runBench(game);
    const h = harness();
    h.msPerRead = 1; // work takes wall time: the loop yields between chunks
    h.init({ kind: 'world', world, firstSeq: 0 });
    for (const entry of entries) h.send({ type: 'command', entry });
    h.send({ type: 'advance', tick: 3_000 });
    h.send({ type: 'query', id: 7, query: 'state', tick: 3_000 });
    h.send({ type: 'advance', tick: 3_500 });
    const slices = h.drain();
    expect(h.of('error')).toEqual([]);
    expect(slices).toBeGreaterThan(1); // it yielded to the queue at least once
    const state = h.of('state')[0];
    expect(state).toMatchObject({ id: 7, tick: 3_000 });
    game.advance(3_000);
    expect(RunnerHarness.hashOf(game.world() as World, state)).toBe(game.hash());
    expect(h.view()?.tick).toBe(3_500);
  });

  it('yields at least every WORK_SLICE_MS of wall time', () => {
    const h = harness();
    h.msPerRead = WORK_SLICE_MS / 4;
    h.init({ kind: 'world', world: createWorld({ seed: 4 }), firstSeq: 0 });
    h.send({ type: 'advance', tick: 1_000 }); // 100 chunks of 10 ticks
    const slices = h.drain();
    // Each chunk reads the clock twice (half a slice); a slice holds about two chunks.
    expect(slices).toBeGreaterThanOrEqual(30);
  });

  it('reports a desync: an entry out of order, at a tick behind the engine, or one the mirror refuses', () => {
    const game = reference();
    const world = game.world() as World;
    const entries = runBench(game);
    const skipped = harness();
    skipped.init({ kind: 'world', world, firstSeq: 0 });
    skipped.send({ type: 'command', entry: entries[1] });
    skipped.drain();
    expect(skipped.of('error')[0]).toMatchObject({ code: 'desync', seq: 1 });

    const behind = harness();
    behind.init({ kind: 'world', world, firstSeq: 0 });
    behind.send({ type: 'advance', tick: 50 });
    behind.send({ type: 'command', entry: { ...entries[0], tick: 10 } });
    behind.drain();
    expect(behind.of('error')[0]).toMatchObject({ code: 'desync', seq: 0, tick: 50 });

    const refused = harness();
    refused.init({ kind: 'world', world, firstSeq: 0 });
    refused.send({
      type: 'command',
      entry: { seq: 0, tick: 0, id: 'device.operate', args: { id: 99, control: 'closed', value: true } },
    });
    refused.drain();
    expect(refused.of('error')[0]).toMatchObject({ code: 'desync' });
  });

  it('refuses a malformed message without echoing it', () => {
    const h = harness();
    h.init({ kind: 'world', world: createWorld({ seed: 4 }), firstSeq: 0 });
    h.send({ type: 'advance', tick: 'secret-payload' });
    expect(h.of('error')[0]).toMatchObject({ code: 'invalid-message' });
    expect(JSON.stringify(h.messages)).not.toContain('secret-payload');
  });

  it('stops on stop, and records watches without touching the engine', () => {
    const h = harness();
    h.init({ kind: 'world', world: createWorld({ seed: 4 }), firstSeq: 0 });
    h.send({ type: 'watch', id: 1, target: { kind: 'device', entity: 3, field: 'powerW' } });
    expect(h.runner.watched.get(1)).toEqual({ kind: 'device', entity: 3, field: 'powerW' });
    h.send({ type: 'unwatch', id: 1 });
    expect(h.runner.watched.size).toBe(0);
    h.send({ type: 'advance', tick: 100 });
    h.send({ type: 'stop' });
    h.drain();
    expect(h.runner.state).toBe('stopped');
    expect(h.view()?.tick).toBe(0); // the queued advance never ran
    h.runner.fail('engine-threw', 'late');
    expect(h.of('error')).toEqual([]);
  });
});

describe('publishing (ADR 0011 §7)', () => {
  it('throttles cadence publishes to PUBLISH_MIN_WALL_MS but always publishes on reaching the target', () => {
    const fast = harness();
    fast.init({ kind: 'world', world: game0(), firstSeq: 0 });
    for (const entry of benchEntries()) fast.send({ type: 'command', entry });
    fast.send({ type: 'advance', tick: 500 });
    fast.drain();
    // The clock never moved, so every cadence publish fell in one throttle window: only the forced
    // ones went out (one per topology generation, after its descriptor, plus the idle one at the end).
    const shared = fast.of('ready')[0].buffer as SharedArrayBuffer;
    expect(Atomics.load(new Int32Array(shared), PUBLISH_SEQ_INDEX)).toBe(fast.of('topology').length + 1);
    const slow = harness();
    slow.msPerRead = PUBLISH_MIN_WALL_MS; // every chunk is a new window
    slow.init({ kind: 'world', world: game0(), firstSeq: 0 }, 'message');
    for (const entry of benchEntries()) slow.send({ type: 'command', entry });
    slow.send({ type: 'advance', tick: 500 });
    slow.drain();
    expect(slow.of('snapshot').length).toBeGreaterThan(20);
    expect(slow.view()?.tick).toBe(500); // the idle publish shows the exact tick
  });

  it('a new generation sends its descriptor before its first slot, growing the buffer when needed', () => {
    const h = harness();
    h.init({ kind: 'world', world: game0(), firstSeq: 0 });
    for (const entry of benchEntries()) h.send({ type: 'command', entry });
    h.drain();
    const generations = h.of('topology').map((m) => m.descriptor.generation);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
    expect(new Set(generations).size).toBe(generations.length);
    expect(h.view()?.generation).toBe(generations.at(-1));
    expect(h.of('topology').every((m) => m.buffer === null)).toBe(true); // the minimum slot fits the bench
    expect(MIN_SLOT_BYTES).toBeGreaterThan(1000);
  });

  it('grows a too-small buffer at a generation change and sends the replacement, both transports', () => {
    for (const transport of ['sab', 'message'] as const) {
      const h = harness({ minSlotBytes: 128 });
      h.init({ kind: 'world', world: game0(), firstSeq: 0 }, transport);
      const game = reference();
      for (const entry of runBench(game)) h.send({ type: 'command', entry });
      h.drain();
      const grown = h.of('topology').filter((m) => m.buffer !== null);
      expect(grown.length).toBe(transport === 'sab' ? 1 : 0); // the fallback grows its pool instead
      expect(h.view()?.hashedBytes()).toEqual(game.snapshot());
    }
  });

  it('the fallback skips a throttled publish without a free buffer, and sends a forced one when one comes back', () => {
    const h = harness();
    h.holdReleases = true;
    h.msPerRead = PUBLISH_MIN_WALL_MS;
    h.init({ kind: 'world', world: game0(), firstSeq: 0 }, 'message');
    for (const entry of benchEntries()) h.send({ type: 'command', entry });
    h.send({ type: 'advance', tick: 300 });
    h.drain();
    expect(h.of('snapshot')).toHaveLength(3); // the pool: three buffers, all held by the host
    expect(h.view()?.tick).not.toBe(300);
    h.holdReleases = false;
    h.send({ type: 'release', buffer: h.held.pop() });
    h.drain();
    expect(h.of('snapshot')).toHaveLength(4); // the forced idle publish, once a buffer came back
    expect(h.view()?.tick).toBe(300);
    h.send({ type: 'release', buffer: new ArrayBuffer(8) }); // too small: dropped, never reused
    h.drain();
  });

  it('writes the diagnostics area once a second of wall time has passed (shared mode)', () => {
    const h = harness();
    h.init({ kind: 'world', world: game0(), firstSeq: 0 });
    for (const entry of benchEntries()) h.send({ type: 'command', entry });
    h.msPerRead = 30;
    h.send({ type: 'advance', tick: 2_000 });
    h.drain();
    const ready = h.of('ready')[0];
    const diagnostics = ready.buffer === null ? null : readDiagnostics(ready.buffer);
    expect(diagnostics?.solveCount).toBeGreaterThan(0);
    expect(diagnostics?.ticksPerSecond).toBeGreaterThan(0);
  });
});

describe('the worker matches the headless game (property)', () => {
  type Op =
    | { kind: 'operate'; value: boolean }
    | { kind: 'advance'; ticks: number }
    | { kind: 'step'; ticks: number }
    | { kind: 'undo' }
    | { kind: 'redo' }
    | { kind: 'query' };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.boolean().map((value) => ({ kind: 'operate' as const, value })),
    fc.integer({ min: 0, max: 120 }).map((ticks) => ({ kind: 'advance' as const, ticks })),
    fc.integer({ min: 1, max: 60 }).map((ticks) => ({ kind: 'step' as const, ticks })),
    fc.constant({ kind: 'undo' as const }),
    fc.constant({ kind: 'redo' as const }),
    fc.constant({ kind: 'query' as const }),
  );
  const scenarioArb = fc.record({
    transport: fc.constantFrom('sab' as const, 'message' as const),
    ops: fc.array(opArb, { maxLength: 10 }), // capped: a session of 10 ops is enough to mix every kind
    slice: fc.constantFrom(0, 1, 3),
  });

  // Every run starts from the bench circuit's world, built once: building it command by command (in
  // the reference, through the worker and again in the replay start) was nearly all of a run's time
  // under coverage, not the session. The bench's commands through the worker: 'following the host'.
  let benchWorld: World | null = null;
  const circuit = (): World => {
    if (benchWorld === null) {
      const game = reference();
      runBench(game);
      benchWorld = game.world() as World;
    }
    return benchWorld;
  };

  it('same snapshot bytes and materialised hash after any session, either transport, any slicing', () => {
    fc.assert(
      fc.property(scenarioArb, ({ transport, ops, slice }) => {
        const game = reference(circuit());
        const h = harness();
        h.msPerRead = slice;
        h.init({ kind: 'world', world: circuit(), firstSeq: 0 }, transport);
        let sent = 0;
        let advanced = 0;
        const sync = () => {
          // As SimHost does: an advance for every tick the bus moved to, then each new entry.
          for (const entry of game.entries().slice(sent)) {
            if (entry.tick > advanced) h.send({ type: 'advance', tick: (advanced = entry.tick) });
            h.send({ type: 'command', entry });
          }
          sent = game.entries().length;
          if (game.tick() > advanced) h.send({ type: 'advance', tick: (advanced = game.tick()) });
        };
        for (const op of ops) {
          if (op.kind === 'operate') game.exec('device.operate', { id: 2, control: 'closed', value: op.value });
          else if (op.kind === 'advance') game.advance(op.ticks);
          else if (op.kind === 'step') game.exec('sim.step', { ticks: op.ticks });
          else if (op.kind === 'undo') game.exec('edit.undo');
          else if (op.kind === 'redo') game.exec('edit.redo');
          sync();
          if (op.kind === 'query') {
            expect(RunnerHarness.hashOf(game.world() as World, h.query('state', game.tick()))).toBe(game.hash());
          }
        }
        h.drain();
        expect(h.of('error')).toEqual([]);
        expect(h.view()?.tick).toBe(game.tick());
        expect(h.view()?.hashedBytes()).toEqual(game.snapshot());
        // A replay start of the same session (load verification, the crash restart) reaches the same bytes.
        const replay = harness();
        replay.msPerRead = slice;
        replay.init({ kind: 'replay', log: game.replayLog() }, transport);
        replay.drain();
        expect(replay.of('error')).toEqual([]);
        expect(replay.view()?.hashedBytes()).toEqual(game.snapshot());
      }),
      { numRuns: 25 },
    );
  });
});

function game0(): World {
  return createWorld({ seed: 11 });
}

function benchEntries(): readonly ReplayEntry[] {
  return runBench(reference());
}
