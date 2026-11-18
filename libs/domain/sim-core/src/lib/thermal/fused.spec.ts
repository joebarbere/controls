import { BUILTIN_CATALOG } from '@controls/catalog';
import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { engineTestOptions } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { THHN_14 } from '../../testing/wired-loop';
import { formatWireInfo } from '../engine/wire-info';
import { compileNetlist } from '../netlist/compile';

/*
 * A fused conductor stays open (ADR 0018 implementation notes, F3.6 part 2's fusing rule, made sticky
 * before v0.4.0): once a conductor's node reaches its metal's melting point, its sticky `fused` key is
 * set and the compiler reads it, so re-landing an end (a new termination id: that end resets to D = 1,
 * `ok`) never closes the conductor again. Only a new conductor (a new connection) conducts.
 *
 * The rig: the split-phase stand-in (entity 1, 120 V L1–N, kiloamps into a short) with one 1.5 m 14 AWG
 * solid THHN conductor (connection 1) screwed from L1 (termination 1) to N (termination 2), both at the
 * marked 4 N·m. It carries kiloamps, so its conductor node reaches copper's melting point (1357.77 K)
 * within a few cadence steps and it fuses.
 *
 * Hand calculation for the open circuit after the fuse: nothing else loads the stand-in, so no current
 * flows anywhere and the L1–N terminal voltage is its open-circuit 120 V RMS (the stand-in's L1–N
 * phasor, no drop across its source impedance). With both ends re-landed and closed, each half of the
 * fused conductor sits at its own terminal, so the body's gap is |V(L1) − V(N)| = 120 V, and 0 A flows.
 */

const CU_MELT_K = 1357.77;
const UTILITY_SPLIT = { id: 'utility.larkmoor-split-phase-25kva', version: 1 };
/** The open-circuit L1–N voltage of the stand-in (V RMS), the gap across the fused body (hand calculation above). */
const L1_N_VOLTS = 120;

const screw = (id: number) => ({
  id,
  method: 'screw',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm: 4,
  accessory: null,
});

/** The rig (see the file comment), at tick 0 with nothing simulated yet. */
function shortWorld(): World {
  return World.parse({
    schemaVersion: 4,
    seed: 5,
    tick: 0,
    nextEntityId: 2,
    nextConnectionId: 2,
    nextCableId: 1,
    nextTerminationId: 3,
    regionId: 'nec',
    difficulty: 'trainee',
    assisted: false,
    fixtures: [],
    areas: [],
    entities: [
      {
        id: 1,
        ref: UTILITY_SPLIT,
        transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
        state: {},
        sim: {},
        mountedOn: null,
        inEntry: null,
        pluggedInto: null,
        label: null,
        extensions: {},
      },
    ],
    connections: [
      {
        id: 1,
        ref: THHN_14,
        a: { entity: 1, terminal: 'l1', termination: screw(1) },
        b: { entity: 1, terminal: 'n', termination: screw(2) },
        cable: null,
        route: [{ kind: 'free', positionMm: { x: 100, y: 900, z: 200 }, entity: null, fixture: null, tool: null }],
        lengthMm: 1500,
        colour: { base: 'black', stripe: null },
        label: null,
        state: {},
        sim: { ...LEAD_SIM_BAG_V3, fused: false },
        extensions: {},
        marking: { a: null, b: null },
      },
    ],
    cables: [],
    sim: null,
    extensions: {},
  });
}

/** The built-in catalogue (its tools: the landings and the cutter), the engine's built-in models. */
const OPTIONS = { ...engineTestOptions(), catalog: BUILTIN_CATALOG };
const hostOn = (world: World) =>
  new SourceHost(createWorldBus(world, createWorldRegistry({ catalog: BUILTIN_CATALOG })), OPTIONS);

const TERMINAL = { a: 'l1', b: 'n' } as const;
type Side = keyof typeof TERMINAL;

/** The explicit landing steps (a re-strip): the bad-termination scenario's stripper and 1.5–15 N·m driver. */
const explicit = (lengthMm: number, torqueNm: number) => ({
  method: 'screw',
  strip: { tool: { id: 'tool.veltmark-ws-1018', version: 1 }, hole: 'sol14', lengthMm },
  accessory: null,
  clamp: { tool: { id: 'tool.calderyn-ts-15', version: 1 }, torqueNm },
});

const unland = (host: SourceHost, side: Side) => host.exec('wire.unland', { id: 1, end: side });
const land = (host: SourceHost, side: Side, termination: unknown = 'auto') =>
  host.exec('wire.land', { id: 1, end: side, at: { entity: 1, terminal: TERMINAL[side], termination } });

/** Connection 1's materialised sim bag. */
const bagOf = (host: SourceHost) => host.materialised().connections.find((c) => c.id === 1)?.sim ?? {};

/** Advances the rig until connection 1 has fused (at most 1 s), returning the host. */
function fusedHost(): SourceHost {
  const host = hostOn(shortWorld());
  for (let t = 0; t < 1000 && bagOf(host)['fused'] !== true; t++) host.advance(1);
  return host;
}

/** Connection 1 is open for good: fused, not netlisted, absent as open (or unlanded), its record open at 0 A. */
function expectOpen(host: SourceHost): void {
  const world = host.bus.state;
  const wire = world.connections.find((c) => c.id === 1);
  expect(bagOf(host)['fused']).toBe(true);
  expect(host.engine.netlist.branches.some((b) => b.element.kind === 'connection' && b.element.connection === 1)).toBe(
    false,
  );
  const reason = wire?.a !== null && wire?.b !== null ? 'intermittent-open' : 'unlanded';
  expect(host.engine.netlist.diagnostics).toContainEqual({ code: 'absent-connection', connection: 1, reason });
  // A from-scratch compile of the saved world agrees: the bag alone keeps it open.
  expect(
    compileNetlist(host.materialised(), host.options.catalog, { models: host.options.netlistModels }).diagnostics,
  ).toContainEqual({ code: 'absent-connection', connection: 1, reason });
  const record = host.engine.connectionRecord(1);
  expect(record?.values['status']).toBe('open');
  expect(record?.values['conductorState']).toBe('open');
  expect(record?.values['currentA']).toBe(0);
}

describe('a fused conductor stays open (ADR 0018 implementation notes: the sticky `fused`)', () => {
  /** Just fused (at the melting point), and a minute later (cooled below the oxidation onset, 422.15 K). */
  let fused: World;
  let cooled: World;
  beforeAll(() => {
    const host = fusedHost();
    fused = host.materialised();
    cooled = host.advance(60_000).materialised();
    // Cool: a re-made end starts its hot spot at T_c (ADR 0018 §6), so it neither burns open nor
    // degrades, and without the sticky flag the conductor would carry kiloamps again at once.
    expect(cooled.connections[0].sim['conductorTempK'] as number).toBeLessThan(422.15);
  });

  it('fuses at the melting point: `fused` set, both ends burned open, absent from the netlist (live and loaded)', () => {
    const live = fusedHost();
    expectOpen(live);
    // The save written at that tick loads open too.
    const host = hostOn(fused);
    const sim = bagOf(host);
    // The conductor's eleven keys: the lead's ten and `fused`.
    expect(Object.keys(sim).sort()).toStrictEqual([...Object.keys(LEAD_SIM_BAG_V3), 'fused'].sort());
    expect(sim).toMatchObject({ fused: true, endAState: 'intermittentOpen', endBState: 'intermittentOpen' });
    expect(sim['conductorTempK']).toBe(CU_MELT_K);
    expect(host.engine.tick).toBeLessThan(1000);
    expectOpen(host);
  });

  it('golden: re-landing both ends (new terminations, D = 1, ok) leaves it open at 0 A with the 120 V gap across its body', () => {
    // Cooled first: a re-landing at the melting point would start its new hot spot there (T_h = T_c,
    // ADR 0018 §6), burn it open again and hide the rule.
    const host = hostOn(cooled);
    unland(host, 'a');
    land(host, 'a');
    expect(bagOf(host)).toMatchObject({ fused: true, endATerminationId: 3, endADegradation: 1, endAState: 'ok' });
    host.advance(1000);
    let sim = bagOf(host);
    // End a is a new termination (id 3): reset to D = 1 and `ok` (ADR 0018 §6), but the conductor stays fused.
    expect(sim).toMatchObject({ fused: true, endATerminationId: 3, endADegradation: 1, endAState: 'ok' });
    expect(sim['endBState']).toBe('intermittentOpen');
    expectOpen(host);
    unland(host, 'b');
    land(host, 'b');
    expectOpen(host);
    host.advance(1000);
    sim = bagOf(host);
    expect(sim).toMatchObject({
      fused: true,
      endATerminationId: 3,
      endBTerminationId: 4,
      endBDegradation: 1,
      endAState: 'ok',
      endBState: 'ok',
    });
    expectOpen(host);
    // Both halves sit at their terminals: the body's gap is the L1–N voltage, a reading (0.5 %).
    const record = host.engine.connectionRecord(1);
    const gap = record?.values['conductorDropV'] as number;
    expect(Math.abs(gap - L1_N_VOLTS)).toBeLessThanOrEqual(0.005 * L1_N_VOLTS);
    const info = formatWireInfo(host.engine, host.bus.state, 1);
    expect(info).toContain('status open (not netlisted)');
    expect(info).toContain('current 0 A');
    expect(info).toMatch(/conductor open \(fused\) at [\d.]+ K, gap 120(\.\d+)? V/);
    expect(info).toMatch(/end a ok, contact [\d.e-]+ Ω/);
    expect(info).toMatch(/end b ok, contact [\d.e-]+ Ω/);
  });

  it('a fused body with one end still burned open has no gap reading (its half floats between two gaps)', () => {
    const host = hostOn(cooled);
    unland(host, 'a');
    land(host, 'a');
    host.advance(100);
    const record = host.engine.connectionRecord(1);
    expect(record?.values['endAState']).toBe('ok');
    expect(record?.values['endBState']).toBe('intermittentOpen');
    // conductorDropV (bit 2) and end b's drop (bit 8) are no reading; end a's drop (bit 4) is a 0 V reading.
    const readings = record?.values['readings'] as number;
    expect(readings & 2).toBe(0);
    expect(readings & 8).toBe(0);
    expect(readings & 4).toBe(4);
    expect(record?.values['endADropV']).toBe(0);
  });

  it('only a new conductor conducts: deleting it and adding another between the same terminals closes the circuit', () => {
    const host = hostOn(cooled);
    unland(host, 'a');
    land(host, 'a');
    host.exec('wire.delete', { id: 1 });
    host.exec('wire.add', {
      ref: THHN_14,
      a: { entity: 1, terminal: 'l1', termination: 'auto' },
      b: { entity: 1, terminal: 'n', termination: 'auto' },
      route: [{ kind: 'free', positionMm: { x: 100, y: 900, z: 200 }, entity: null, fixture: null, tool: null }],
      lengthMm: 1500,
      colour: { base: 'black', stripe: null },
      tool: { id: 'tool.veltmark-dc-8', version: 1 },
    });
    const id = host.bus.state.nextConnectionId - 1;
    expect(id).toBe(2);
    expect(host.materialised().connections.find((c) => c.id === id)?.sim['fused']).toBe(false);
    expect(host.engine.connectionRecord(id)?.values['status']).toBe('solved');
    expect(host.engine.branchAmps({ kind: 'connection', connection: id })).toBeGreaterThan(1000);
  });

  it('undoing the delete restores the fused conductor (its bag is a tombstone), still open', () => {
    const host = hostOn(cooled);
    host.exec('wire.delete', { id: 1 });
    host.exec('edit.undo');
    host.advance(10);
    expectOpen(host);
  });

  it('save and load mid-way keeps the flag: the loaded run equals the uninterrupted one', () => {
    const straight = hostOn(cooled);
    unland(straight, 'a');
    land(straight, 'a');
    unland(straight, 'b');
    straight.advance(250);
    const loaded = straight.reload();
    expect(bagOf(loaded)['fused']).toBe(true);
    for (const host of [straight, loaded]) {
      land(host, 'b');
      expect(bagOf(host)).toMatchObject({ endAState: 'ok', endBState: 'ok', fused: true });
      expectOpen(host);
      host.advance(500);
      expectOpen(host);
    }
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    expect(loaded.engine.exportState()).toStrictEqual(straight.engine.exportState());
    expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
  });

  it('property: any sequence of unlands, re-lands, re-strips, advances and save/loads keeps it open', () => {
    type Op =
      | { readonly kind: 'unland'; readonly side: Side }
      | { readonly kind: 'land'; readonly side: Side; readonly strip: number; readonly torque: number }
      | { readonly kind: 'advance'; readonly ticks: number }
      | { readonly kind: 'reload' };
    const side = fc.constantFrom<Side>('a', 'b');
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('unland' as const), side }),
      // strip 0 means 'auto'; otherwise an explicit re-strip at 12–14 mm, clamped at 3–5 N·m.
      fc.record({
        kind: fc.constant('land' as const),
        side,
        strip: fc.constantFrom(0, 12, 13, 14),
        torque: fc.constantFrom(3, 4, 5),
      }),
      fc.record({ kind: fc.constant('advance' as const), ticks: fc.integer({ min: 1, max: 400 }) }),
      fc.record({ kind: fc.constant('reload' as const) }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 8 }), (ops) => {
        let host = hostOn(cooled);
        const landed = (s: Side) => host.bus.state.connections.find((c) => c.id === 1)?.[s] !== null;
        for (const o of ops) {
          // Inapplicable steps (unland a free end, land a landed one) are skipped, never filtered.
          if (o.kind === 'unland' && landed(o.side)) unland(host, o.side);
          else if (o.kind === 'land' && !landed(o.side)) {
            land(host, o.side, o.strip === 0 ? 'auto' : explicit(o.strip, o.torque));
          } else if (o.kind === 'advance') host.advance(o.ticks);
          else if (o.kind === 'reload') host = host.reload();
          expectOpen(host);
        }
        // Finally re-make both ends with new terminations (each `ok` at D = 1): still open, for good.
        for (const s of ['a', 'b'] as const) {
          if (landed(s)) unland(host, s);
          land(host, s);
        }
        expect(bagOf(host)).toMatchObject({ endADegradation: 1, endBDegradation: 1 });
        expectOpen(host);
        host.advance(100);
        expectOpen(host);
      }),
      { numRuns: 15 },
    );
  });
});
