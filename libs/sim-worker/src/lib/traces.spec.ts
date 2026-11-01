import { replayEntries } from '@controls/commands';
import { createWorld, type ReplayEntry, type World } from '@controls/save-format';
import { createGame } from '@controls/scripting-api';
import { SimEngine } from '@controls/sim-core';
import { NetlistReadout, PUBLISH_MIN_WALL_MS, snapshotViewFromBytes, type WatchTarget } from '@controls/sim-protocol';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import { RunnerHarness } from '../testing/runner-harness';

/*
 * Traces (ADR 0011 §4, F2.6): the worker samples each watched quantity at every electrical solve and
 * posts the samples as `trace` batches with its publishes. On the bench lamp (F2.5) the trace must
 * hold every value the headless engine's per-tick snapshots show, the cold-filament inrush peak
 * included, bit for bit; and what the host receives must not depend on when the worker publishes.
 */

const LAMP: WatchTarget = { kind: 'branch', element: { kind: 'entity', entity: 3, part: 'filament' } };
const LIT_TICK = 1500;

/** The bench-lamp scenario's commands up to closing the switch (`apps/sim-cli/scenarios/bench-lamp.console`). */
function benchLamp(): { readonly world: World; readonly entries: readonly ReplayEntry[] } {
  const world = createWorld({ seed: 5 });
  const game = createGame({ world });
  const lead = { id: 'lead.quillfern-test-1m', version: 1 };
  const at = (x: number) => ({ x, y: -300, z: 200 });
  game.execOrThrow('entity.place', { ref: { id: 'battery.ferrovane-12v-7ah', version: 1 }, positionMm: at(900) });
  game.execOrThrow('entity.place', { ref: { id: 'switch.tessaline-spst-toggle', version: 1 }, positionMm: at(1100) });
  game.execOrThrow('entity.place', { ref: { id: 'lamp.lumivane-12v-5w', version: 1 }, positionMm: at(1300) });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 3, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
  return { world, entries: game.entries() };
}

/**
 * The reference, headless: the engine stepped one tick at a time, the lamp's |I| read from each
 * tick's snapshot through `NetlistReadout` (the inspector's and overlays' path, not the worker's
 * `branchAmps`), keyed by the tick of the solution it holds.
 */
function perTick(world: World, entries: readonly ReplayEntry[], to: number): Map<number, number> {
  const engine = SimEngine.start(world);
  const bus = createWorldBus(world, createWorldRegistry(), { firstSeq: 0 });
  const result = replayEntries(bus, entries, { time: engine });
  if (!result.ok) throw new Error('the bench lamp did not replay');
  const values = new Map<number, number>();
  const read = () => {
    const view = snapshotViewFromBytes(engine.snapshot(), engine.topologyDescriptor());
    const readout = NetlistReadout.of(view.descriptor);
    const reading = readout.createReading();
    readout.read(view, reading);
    const branch = view.descriptor.branches.findIndex(
      (b) => b.element.kind === 'entity' && b.element.entity === 3 && b.element.part === 'filament',
    );
    values.set(engine.lastSolveTick, reading.branchAmps[branch]);
  };
  read();
  for (let t = 1; t <= to; t++) {
    engine.advanceTo(t);
    read();
  }
  return values;
}

/** Runs the bench lamp in a worker watching the lamp; returns its trace samples (concatenated) and the batches. */
function traced(transport: 'sab' | 'message', msPerRead: number): { readonly samples: number[]; batches: number } {
  const { world, entries } = benchLamp();
  const h = new RunnerHarness();
  h.msPerRead = msPerRead;
  h.init({ kind: 'world', world, firstSeq: 0 }, transport);
  h.send({ type: 'watch', id: 7, target: LAMP });
  for (const entry of entries) h.send({ type: 'command', entry });
  h.send({ type: 'advance', tick: LIT_TICK });
  h.drain();
  expect(h.of('error')).toEqual([]);
  const batches = h.of('trace');
  for (const batch of batches) expect(batch.id).toBe(7);
  return { samples: batches.flatMap((b) => [...b.samples]), batches: batches.length };
}

const pairs = (samples: readonly number[]) =>
  Array.from({ length: samples.length / 2 }, (_, i) => [samples[2 * i], samples[2 * i + 1]] as const);

describe('traces (ADR 0011 §4, F2.6)', () => {
  it("capture the bench lamp's inrush peak exactly as the headless engine's per-tick current shows it", () => {
    const { world, entries } = benchLamp();
    const reference = perTick(world, entries, LIT_TICK);
    const trace = pairs(traced('sab', 0).samples);
    const traceAt = new Map<number, number>();
    for (const [tick, value] of trace) traceAt.set(tick, value); // the last solve at a tick is what a tick's snapshot holds
    // Every solution a per-tick snapshot held is in the trace, bit for bit (the trace has more: solves
    // superseded within one step, and the lamp's absence before its lead closed the loop).
    for (const [tick, amps] of reference) expect({ tick, amps: traceAt.get(tick) }).toEqual({ tick, amps });
    const peak = Math.max(...[...reference.values()]);
    const lit = trace.filter(([, v]) => !Number.isNaN(v));
    expect(Math.max(...lit.map(([, v]) => v))).toBe(peak);
    // The peak is the switch's own solve at tick 0: the cold filament.
    expect(lit.find(([, v]) => v === peak)?.[0]).toBe(0);
    // Settled by 1.5 s: the inrush is 10–15× the settled current (the lamp's `inrush-band` source).
    const settled = lit[lit.length - 1][1];
    expect(peak / settled).toBeGreaterThanOrEqual(10);
    expect(peak / settled).toBeLessThanOrEqual(15);
    // Ticks never go back, and none passes the target.
    for (let i = 1; i < trace.length; i++) expect(trace[i][0]).toBeGreaterThanOrEqual(trace[i - 1][0]);
    expect(trace[trace.length - 1][0]).toBeLessThanOrEqual(LIT_TICK);
  });

  it('are the same samples, in the same order, whatever the publish timing or transport', () => {
    const base = traced('sab', 0);
    for (const [transport, msPerRead] of [
      ['sab', PUBLISH_MIN_WALL_MS],
      ['message', 1],
      ['message', 0],
    ] as const) {
      const run = traced(transport, msPerRead);
      expect({ transport, msPerRead, samples: run.samples }).toEqual({ transport, msPerRead, samples: base.samples });
      expect(run.batches).toBeGreaterThan(0);
    }
    // A publish every chunk cuts more batches than a throttled run's; the samples are the same.
    expect(traced('sab', PUBLISH_MIN_WALL_MS).batches).toBeGreaterThan(base.batches);
  });

  it("start from the held solution, sample a device field, stop on unwatch, and never change the engine's bytes", () => {
    const { world, entries } = benchLamp();
    const h = new RunnerHarness();
    h.init({ kind: 'world', world, firstSeq: 0 });
    for (const entry of entries) h.send({ type: 'command', entry });
    h.send({ type: 'advance', tick: 200 });
    h.drain();
    const unwatched = h.view()?.hashedBytes();
    // Watched while paused at 200: the first batch is the solution held, at its tick.
    h.send({ type: 'watch', id: 1, target: { kind: 'device', entity: 3, field: 'lightOutputRel' } });
    h.send({ type: 'watch', id: 2, target: { kind: 'branch', element: { kind: 'connection', connection: 99 } } });
    h.send({ type: 'advance', tick: 201 });
    h.drain();
    const first = h.of('trace');
    expect(first.map((m) => m.id).sort()).toEqual([1, 2]);
    const light = [...(first.find((m) => m.id === 1)?.samples ?? [])];
    expect(light[0]).toBeLessThanOrEqual(200);
    expect(light[1]).toBeGreaterThan(0);
    // A lead that isn't in the netlist is no reading, never 0 A.
    expect(Number.isNaN(first.find((m) => m.id === 2)?.samples[1])).toBe(true);
    // The same bytes as a run that never watched.
    const plain = new RunnerHarness();
    plain.init({ kind: 'world', world, firstSeq: 0 });
    for (const entry of entries) plain.send({ type: 'command', entry });
    plain.send({ type: 'advance', tick: 201 });
    plain.drain();
    expect(h.view()?.hashedBytes()).toEqual(plain.view()?.hashedBytes());
    expect(unwatched).toBeDefined();
    h.send({ type: 'unwatch', id: 1 });
    h.send({ type: 'unwatch', id: 2 });
    const before = h.of('trace').length;
    h.send({ type: 'advance', tick: 400 });
    h.drain();
    expect(h.of('trace')).toHaveLength(before);
  });

  it("keep a replay start's history quiet, as events do", () => {
    const game = createGame({ world: createWorld({ seed: 5 }) });
    const { entries } = benchLamp();
    for (const entry of entries) game.execOrThrow(entry.id, entry.args);
    game.advance(300);
    const h = new RunnerHarness();
    h.init({ kind: 'replay', log: game.replayLog() });
    h.send({ type: 'watch', id: 3, target: LAMP });
    h.drain();
    h.send({ type: 'advance', tick: 320 });
    h.drain();
    const ticks = pairs(h.of('trace').flatMap((m) => [...m.samples])).map(([t]) => t);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) expect(t).toBeGreaterThan(300);
  });
});
