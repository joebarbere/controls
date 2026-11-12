import {
  BUILTIN_CATALOG,
  conductanceToAirWPerMK,
  conductorPhysics,
  conductorResistanceOhm,
  conductorThermal,
  type DeviceDefinition,
  leadThermalLine,
  type LeadParams,
  type ThermalLineData,
} from '@controls/catalog';
import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { deriveStream, mix32, terminationStreamKey, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { engineBus } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { BREAKER_REF, LEAD_REF, NUT_REF, THHN_14, wiredLoopWorld } from '../../testing/wired-loop';
import { AMBIENT_TEMPERATURE_K, OUTER_LOOP_MAX_ITERATIONS } from '../constants';
import {
  ARC_CURRENT_FLOOR_A,
  ARC_VOLTAGE_MAX_V,
  ARC_VOLTAGE_MIN_V,
  arcResistanceOhm,
  arcVoltageV,
  BURNED_OPEN_OHM,
  DEGRADATION_RATE_PER_K_S,
  degradationStep,
  END_ARCING,
  END_INTERMITTENT_CLOSED,
  END_INTERMITTENT_OPEN,
  END_OK,
  endStateCode,
  GLOW_CURRENT_FLOOR_A,
  GLOW_ONSET_OHM,
  GLOW_P,
  GLOW_V0,
  glowResistanceOhm,
  INSULATION_DAMAGE_MARGIN_K,
  INTERMITTENT_MIN_DWELL_TICKS,
  INTERMITTENT_ONSET_OHM,
  INTERMITTENT_P_ARC,
  INTERMITTENT_P_OPEN,
  intermittentBucket,
  intermittentDrawU32,
  OXIDATION_ONSET_K,
  TERMINATION_OVERHEAT_RISE_K,
} from '../contact/regimes';
import { SOLVE_INTERVAL_TICKS, TICK_S } from '../engine/constants';
import type { LayerContext } from '../engine/device-model';
import { SimEngine } from '../engine/engine';
import { createDcSolution } from '../mna/dc';
import { compileNetlist } from '../netlist/compile';
import {
  CONNECTION_STEP_S,
  CONNECTION_TOPOLOGY_CHANGED,
  CONNECTION_UNCHANGED,
  CONNECTION_VALUES_CHANGED,
  ConnectionThermalBank,
  type ConnectionBankOptions,
} from './bank';

/*
 * F3.6 part 2 (ADR 0018 §5, §6, §12 "F3.6 part 2"): degradation, the glowing and arcing regimes, the
 * intermittent states, burn-open, the fusing and insulation rule, and the detections. Goldens carry
 * their hand calculations; tolerances are at most 0.5 % (of the rise over ambient for temperatures).
 */

const TA = AMBIENT_TEMPERATURE_K.value;
const ONSET = OXIDATION_ONSET_K.value;
const CU_MELT_K = 1357.77;
/** R_made of a breaker screw at its marked torque, 14 AWG solid copper: R₀ = 0.3 mΩ (r = 1, no factor). */
const R0 = 3e-4;
const TWO_POW_32 = 0x1_0000_0000;

const device = (ref: { id: string; version: number }) => BUILTIN_CATALOG.device(ref) as DeviceDefinition;
const transform = { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } };
const screw = (id: number, torqueNm: number) => ({
  id,
  method: 'screw',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm,
  accessory: null,
});

/**
 * A breaker (1, handle on) with conductor 1 (14 AWG THHN, 2 m) from its load screw (termination 1,
 * `torqueA`) to its line screw (termination 2, full torque) and lead 2 across the same screws;
 * `sim1` merges into conductor 1's bag (a loaded save's degradation).
 */
function benchWorld(torqueA = 4, sim1: object = {}, seed = 3, tick = 0, ref = THHN_14): World {
  return World.parse({
    schemaVersion: 3,
    seed,
    tick,
    nextEntityId: 2,
    nextConnectionId: 10,
    nextCableId: 1,
    nextTerminationId: 10,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [
      {
        id: 1,
        ref: BREAKER_REF,
        transform,
        state: { on: true },
        sim: { thermal: 0, tripped: false },
        mountedOn: null,
        label: null,
        extensions: {},
      },
    ],
    connections: [
      {
        id: 1,
        ref,
        a: { entity: 1, terminal: 'load', termination: screw(1, torqueA) },
        b: { entity: 1, terminal: 'line', termination: screw(2, 4) },
        cable: null,
        route: [{ kind: 'free', positionMm: { x: 0, y: 500, z: 0 }, entity: null, fixture: null, tool: null }],
        lengthMm: 2000,
        colour: { base: 'black', stripe: null },
        label: null,
        state: {},
        sim: { ...LEAD_SIM_BAG_V3, ...sim1 },
        extensions: {},
      },
      {
        id: 2,
        ref: LEAD_REF,
        a: { entity: 1, terminal: 'load', termination: null },
        b: { entity: 1, terminal: 'line', termination: null },
        cable: null,
        route: null,
        lengthMm: null,
        colour: null,
        label: null,
        state: {},
        sim: { ...LEAD_SIM_BAG_V3 },
        extensions: {},
      },
    ],
    cables: [],
    sim: null,
    extensions: {},
  });
}

/** The bank on `world` with a solution whose currents the test sets, stepping and deciding at cadence ticks. */
function rig(world: World, options: ConnectionBankOptions = {}) {
  const bank = new ConnectionThermalBank(BUILTIN_CATALOG, options);
  bank.syncWorld(world);
  const netlist = compileNetlist(world, BUILTIN_CATALOG, { connectionSim: (id) => bank.topologyView(id) });
  bank.refresh(netlist);
  const solution = createDcSolution(netlist);
  const ctx = {
    tick: world.tick,
    dtS: TICK_S.value,
    netlist,
    solution,
    islandReadable: () => true,
    islandStatus: () => 'solved' as const,
    emit: () => undefined,
  } satisfies LayerContext;
  const setAmps = (connection: number, amps: number) => {
    const branch = bank.branch[bank.indexOf(connection)];
    if (branch < 0) return;
    solution.branches[2 * branch] = amps;
    solution.branches[2 * branch + 1] = 0;
  };
  /** `n` cadence steps: continuous then protection, at ticks t, t + 10, …; returns the last protection result. */
  const step = (n: number): number => {
    let changed = CONNECTION_UNCHANGED;
    for (let k = 0; k < n; k++) {
      bank.continuous(ctx);
      const now = bank.protection(ctx);
      if (now > changed) changed = now;
      ctx.tick += SOLVE_INTERVAL_TICKS.value;
    }
    return changed;
  };
  const bag = (connection: number) => bank.bag(bank.indexOf(connection));
  return { bank, netlist, solution, ctx, setAmps, step, bag };
}

describe('F3.6 part 2 constants (ADR 0018 §11)', () => {
  it('are sourced, labelled, and hold the ADR values', () => {
    const all = {
      OXIDATION_ONSET_K: [OXIDATION_ONSET_K, 422.15, 'game-design'],
      DEGRADATION_RATE_PER_K_S: [DEGRADATION_RATE_PER_K_S, 1 / 30_000, 'game-design'],
      BURNED_OPEN_OHM: [BURNED_OPEN_OHM, 1, 'game-design'],
      GLOW_ONSET_OHM: [GLOW_ONSET_OHM, 0.08, 'real-world'],
      GLOW_V0: [GLOW_V0, 1.5915, 'real-world'],
      GLOW_P: [GLOW_P, 3.1268, 'real-world'],
      GLOW_CURRENT_FLOOR_A: [GLOW_CURRENT_FLOOR_A, 0.5, 'numerical'],
      INTERMITTENT_ONSET_OHM: [INTERMITTENT_ONSET_OHM, 0.16, 'game-design'],
      INTERMITTENT_MIN_DWELL_TICKS: [INTERMITTENT_MIN_DWELL_TICKS, 100, 'game-design'],
      INTERMITTENT_P_OPEN: [INTERMITTENT_P_OPEN, 0.3, 'game-design'],
      INTERMITTENT_P_ARC: [INTERMITTENT_P_ARC, 0.2, 'game-design'],
      ARC_VOLTAGE_MIN_V: [ARC_VOLTAGE_MIN_V, 15, 'game-design'],
      ARC_VOLTAGE_MAX_V: [ARC_VOLTAGE_MAX_V, 30, 'game-design'],
      ARC_CURRENT_FLOOR_A: [ARC_CURRENT_FLOOR_A, 0.5, 'game-design'],
      TERMINATION_OVERHEAT_RISE_K: [TERMINATION_OVERHEAT_RISE_K, 100, 'game-design'],
      INSULATION_DAMAGE_MARGIN_K: [INSULATION_DAMAGE_MARGIN_K, 40, 'game-design'],
    } as const;
    for (const [name, [constant, value, kind]] of Object.entries(all)) {
      expect([name, constant.value, constant.kind]).toStrictEqual([name, value, kind]);
      expect(constant.source.length, name).toBeGreaterThan(40);
    }
    // The dwell is a whole number of cadence steps, so bucket boundaries are cadence ticks.
    expect(INTERMITTENT_MIN_DWELL_TICKS.value % SOLVE_INTERVAL_TICKS.value).toBe(0);
  });

  it('the melting points are the ITS-90 fixed points (materials table, the lead)', () => {
    expect(BUILTIN_CATALOG.tableRow({ table: 'materials', version: 1, key: 'copperAnnealed' })).toMatchObject({
      meltingPointK: 1357.77,
    });
    expect(BUILTIN_CATALOG.tableRow({ table: 'materials', version: 1, key: 'aluminiumAa8000' })).toMatchObject({
      meltingPointK: 933.473,
    });
    expect((device(LEAD_REF).model.params as LeadParams).meltingPointK).toBe(1357.77);
    expect((device(LEAD_REF).model.params as LeadParams).insulationRatedTempK).toBe(363.15);
  });
});

describe('the end-regime laws (ADR 0018 §6, goldens 3 and 4)', () => {
  it('the glowing law: 1.800 V at 15 A and 5.500 V at 0.8 A (BSS 103 midpoints), floored at 0.5 A', () => {
    // V = V_G0 + P_G/|I|: 1.5915 + 3.1268/15 = 1.79995 V; 1.5915 + 3.1268/0.8 = 5.50000 V.
    expect(glowResistanceOhm(15) * 15).toBeCloseTo(1.8, 3);
    expect(Math.abs(glowResistanceOhm(15) * 15 - 1.8) / 1.8).toBeLessThan(0.005);
    expect(Math.abs(glowResistanceOhm(0.8) * 0.8 - 5.5) / 5.5).toBeLessThan(0.005);
    // The floor: 1.5915/0.5 + 3.1268/0.25 = 15.6902 Ω, whatever the current below it.
    expect(glowResistanceOhm(0.1)).toBe(glowResistanceOhm(0.5));
    expect(glowResistanceOhm(0)).toBeCloseTo(15.6902, 4);
  });

  it('the series arc: R = V_arc/|I|, floored at 0.5 A (at most 60 Ω)', () => {
    expect(arcResistanceOhm(20, 12.5)).toBe(1.6);
    expect(arcResistanceOhm(20, 0.1)).toBe(40);
    expect(arcResistanceOhm(30, 0)).toBe(60);
    expect(arcVoltageV(0)).toBe(15);
    expect(arcVoltageV(TWO_POW_32 / 2)).toBe(22.5);
    expect(arcVoltageV(TWO_POW_32 - 1)).toBeLessThan(30);
  });

  it('the state thresholds compare R_deg: ok below 160 mΩ, intermittent from it, burned open from 1 Ω', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TWO_POW_32 - 1 }), fc.integer({ min: -10, max: 1e9 }), (first, bucket) => {
        expect(endStateCode(0.159_999, first, bucket)).toBe(END_OK);
        expect(endStateCode(1, first, bucket)).toBe(END_INTERMITTENT_OPEN);
        expect(endStateCode(50, first, bucket)).toBe(END_INTERMITTENT_OPEN);
        expect([END_INTERMITTENT_OPEN, END_ARCING, END_INTERMITTENT_CLOSED]).toContain(
          endStateCode(0.16, first, bucket),
        );
      }),
    );
  });

  it('the bucket draw is mix32(s ^ imul(bucket, 0x9e3779b1)), pinned (save format), with the 0.3/0.2/0.5 split', () => {
    // Golden vectors: a change to the draw changes every intermittent end of every save.
    expect(intermittentDrawU32(0, 0)).toBe(mix32(0));
    expect(intermittentDrawU32(0x1234_5678, 7)).toBe(mix32((0x1234_5678 ^ Math.imul(7, 0x9e37_79b1)) >>> 0));
    expect([intermittentDrawU32(1, 1), intermittentDrawU32(0xffff_ffff, 123_456)]).toStrictEqual([
      intermittentDrawU32(1, 1),
      mix32((0xffff_ffff ^ Math.imul(123_456, 0x9e37_79b1)) >>> 0),
    ]);
    const counts = [0, 0, 0, 0];
    const first = deriveStream(3, `${terminationStreamKey(1)}:intermittent`).nextU32();
    const n = 100_000;
    for (let b = 0; b < n; b++) counts[endStateCode(0.5, first, b)]++;
    expect(counts[END_OK]).toBe(0);
    expect(Math.abs(counts[END_INTERMITTENT_OPEN] / n - 0.3)).toBeLessThan(0.01);
    expect(Math.abs(counts[END_ARCING] / n - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(counts[END_INTERMITTENT_CLOSED] / n - 0.5)).toBeLessThan(0.01);
    expect(intermittentBucket(99)).toBe(0);
    expect(intermittentBucket(100)).toBe(1);
    expect(intermittentBucket(-1)).toBe(-1);
  });
});

describe('degradation (ADR 0018 §5, goldens 1 and 2)', () => {
  it('golden 2: T_h held 50 K above onset for 600 s doubles D (D = 1 + 600 × 50 / 30 000 = 2.000)', () => {
    // dD/dt = 1/30 000 × 50 = 1/600 per second; 60 000 steps of 0.01 s → +1.000.
    const r = rig(benchWorld(4), { holdEndTempK: ONSET + 50 });
    r.step(60_000);
    for (const key of ['endADegradation', 'endBDegradation']) {
      expect(Math.abs((r.bag(1)[key] as number) - 2) / 2).toBeLessThan(1e-9);
    }
    // The pure step agrees.
    let d = 1;
    for (let k = 0; k < 60_000; k++) d = degradationStep(d, ONSET + 50, 1, CONNECTION_STEP_S);
    expect(d).toBe(r.bag(1)['endADegradation']);
  });

  it('grows only above the onset: held at it, or 1 K under it, D stays exactly 1', () => {
    for (const hold of [ONSET, ONSET - 1]) {
      const r = rig(benchWorld(4), { holdEndTempK: hold });
      r.step(1000);
      expect([r.bag(1)['endADegradation'], r.bag(1)['endBDegradation']]).toStrictEqual([1, 1]);
    }
  });

  it('aluminium on a method not rated for it degrades 10× as fast (golden 7 of F3.3 part 1: rate only)', () => {
    // An aluminium 4 AWG conductor between two wire nuts (`alRated: false`), built directly (the engine
    // never checks a combination): held 50 K above onset for 60 s, D = 1 + 10 × 60 × 50/30 000 = 2.000.
    const al = { id: 'conductor.quorvale-xhhw2-al-4-compact', version: 1 };
    const nut = (entity: number, id: number) => ({
      entity,
      terminal: 'splice',
      termination: { ...screw(id, 0), method: 'twistOn', torqueNm: null },
    });
    const base = benchWorld();
    const world = World.parse({
      ...base,
      nextEntityId: 4,
      entities: [
        ...base.entities,
        { ...base.entities[0], id: 2, ref: NUT_REF, state: {}, sim: {} },
        { ...base.entities[0], id: 3, ref: NUT_REF, state: {}, sim: {} },
      ],
      connections: [{ ...base.connections[0], ref: al, a: nut(2, 1), b: nut(3, 2) }],
    });
    const r = rig(world, { holdEndTempK: ONSET + 50 });
    r.step(6000);
    expect(Math.abs((r.bag(1)['endADegradation'] as number) - 2) / 2).toBeLessThan(1e-9);
  });

  it('golden 1 (property): D never falls, whatever the currents, and cooling never reverses it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 40, noNaN: true }), fc.integer({ min: 1, max: 1500 })), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.double({ min: 0, max: 1.2, noNaN: true }),
        (schedule, torque) => {
          const r = rig(benchWorld(torque));
          let previous = [1, 1];
          for (const [amps, steps] of schedule) {
            r.setAmps(1, amps);
            for (let k = 0; k < steps; k++) {
              r.step(1);
              const now = [r.bag(1)['endADegradation'] as number, r.bag(1)['endBDegradation'] as number];
              expect(now[0]).toBeGreaterThanOrEqual(previous[0]);
              expect(now[1]).toBeGreaterThanOrEqual(previous[1]);
              previous = now;
            }
          }
          // Then cold: D may still grow while the end is above the onset, never falls, and once the end
          // has cooled it stays exactly where it was.
          r.setAmps(1, 0);
          r.step(30_000);
          const cooled = [r.bag(1)['endADegradation'] as number, r.bag(1)['endBDegradation'] as number];
          expect(cooled[0]).toBeGreaterThanOrEqual(previous[0]);
          expect(cooled[1]).toBeGreaterThanOrEqual(previous[1]);
          r.step(3000);
          expect([r.bag(1)['endADegradation'], r.bag(1)['endBDegradation']]).toStrictEqual(cooled);
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe('the end states and their stamps (ADR 0018 §6)', () => {
  /** The bench with conductor 1's end A degraded to R_deg = R0 × D (termination 1 continues: same id). */
  const degraded = (d: number, tick = 1000, seed = 3) =>
    benchWorld(4, { endADegradation: d, endATerminationId: 1, endBTerminationId: 2 }, seed, tick);

  it('an ok end below 80 mΩ is ohmic, from 80 mΩ it follows the glowing law (golden 3 in the stamp)', () => {
    // D = 400: R_deg = 0.12 Ω, ok and glowing. At 15 A the end stamps max(0.12, 1.800/15 = 0.11999…) = 0.12 Ω;
    // at 2 A it stamps the law, 1.5915/2 + 3.1268/4 = 1.57745 Ω.
    const r = rig(degraded(400));
    expect(r.bag(1)['endAState']).toBe('ok');
    const i = r.bank.indexOf(1);
    const conductor = r.bank.resistanceOhm(i, 0) - r.bank.resistanceOhm(i, 0); // 0: the same stamp
    expect(conductor).toBe(0);
    const ohmicEnd = R0 * 400;
    const rest = r.bank.resistanceOhm(i, 1000) - ohmicEnd; // a large current: the ohmic part wins
    expect(r.bank.resistanceOhm(i, 15) - rest).toBeCloseTo(ohmicEnd, 12);
    expect(r.bank.resistanceOhm(i, 2) - rest).toBeCloseTo(1.5915 / 2 + 3.1268 / 4, 12);
    expect(r.bank.isNonlinear(i)).toBe(true);
    // D = 100: R_deg = 30 mΩ, ohmic at any current.
    const ohmic = rig(degraded(100));
    expect(ohmic.bank.isNonlinear(0)).toBe(false);
    expect(ohmic.bank.resistanceOhm(0, 2)).toBe(ohmic.bank.resistanceOhm(0, 15));
  });

  it("an intermittent end's state is endStateCode(R_deg, its :intermittent first output, the bucket of T − 1)", () => {
    // D = 1000: R_deg = 0.3 Ω, intermittent. Started at T = 1000, the state is decided for bucket 9.
    const r = rig(degraded(1000));
    const first = deriveStream(3, `${terminationStreamKey(1)}:intermittent`).nextU32();
    expect(r.bank.intermittentFirst(0, 0)).toBe(first);
    const expected = (bucket: number) =>
      ['ok', 'intermittentClosed', 'intermittentOpen', 'arcing'][endStateCode(R0 * 1000, first, bucket)];
    expect(r.bag(1)['endAState']).toBe(expected(9));
    expect(r.bag(1)['endBState']).toBe('ok');
    // Each cadence step decides for its own bucket: the state at T holds bucket ⌊(T − 1)/100⌋'s.
    for (let k = 0; k < 300; k++) {
      r.step(1);
      expect(r.bag(1)['endAState']).toBe(expected(intermittentBucket(r.ctx.tick - SOLVE_INTERVAL_TICKS.value)));
    }
  });

  it('V_arc is drawn once per termination from :arcing, and an arcing end stamps V_arc/|I|', () => {
    const r = rig(degraded(1000));
    const v = arcVoltageV(deriveStream(3, `${terminationStreamKey(1)}:arcing`).nextU32());
    expect(r.bank.arcVolts(0, 0)).toBe(v);
    expect(v).toBeGreaterThanOrEqual(15);
    expect(v).toBeLessThan(30);
    // Find an arcing bucket and read the stamp there.
    const first = r.bank.intermittentFirst(0, 0);
    let bucket = 10;
    while (endStateCode(R0 * 1000, first, bucket) !== END_ARCING) bucket++;
    const arcing = rig(degraded(1000, bucket * 100 + 1));
    expect(arcing.bag(1)['endAState']).toBe('arcing');
    const rest = arcing.bank.resistanceOhm(0, 12.5) - v / 12.5;
    expect(arcing.bank.resistanceOhm(0, 4) - rest).toBeCloseTo(v / 4, 12);
    expect(arcing.bank.resistanceOhm(0, 0.1) - rest).toBeCloseTo(v / 0.5, 12);
  });

  it('only open versus not open is a topology change: protection reports it, and the compiler drops the branch', () => {
    const r = rig(degraded(1000));
    const first = r.bank.intermittentFirst(0, 0);
    const code = (bucket: number) => endStateCode(R0 * 1000, first, bucket);
    r.setAmps(1, 4);
    // Step through buckets: each change reports topology exactly when open-ness changed.
    let previous = code(9);
    for (let bucket = 10; bucket < 60; bucket++) {
      r.ctx.tick = bucket * 100;
      const changed = r.bank.protection(r.ctx);
      const now = code(bucket);
      const wasOpen = previous === END_INTERMITTENT_OPEN;
      const isOpen = now === END_INTERMITTENT_OPEN;
      expect(changed).toBe(
        now === previous
          ? CONNECTION_UNCHANGED
          : wasOpen !== isOpen
            ? CONNECTION_TOPOLOGY_CHANGED
            : CONNECTION_VALUES_CHANGED,
      );
      previous = now;
    }
    // The compiler: an open end makes the connection absent, `intermittent-open`, and moves the hash.
    const world = degraded(1000);
    const closed = compileNetlist(world, BUILTIN_CATALOG, {
      connectionSim: () => ({ endAState: 'intermittentClosed', endBState: 'ok' }),
    });
    const arcing = compileNetlist(world, BUILTIN_CATALOG, {
      connectionSim: () => ({ endAState: 'arcing', endBState: 'ok' }),
    });
    const open = compileNetlist(world, BUILTIN_CATALOG, {
      connectionSim: (id) => (id === 1 ? { endAState: 'intermittentOpen', endBState: 'ok' } : undefined),
    });
    expect(arcing.topologyHash).toBe(closed.topologyHash);
    expect(open.topologyHash).not.toBe(closed.topologyHash);
    expect(open.diagnostics).toContainEqual({ code: 'absent-connection', connection: 1, reason: 'intermittent-open' });
    expect(open.branches.some((b) => b.element.kind === 'connection' && b.element.connection === 1)).toBe(false);
    // Without connectionSim the world's own bag is read (a load).
    const loaded = World.parse({
      ...world,
      connections: world.connections.map((c) =>
        c.id === 1 ? { ...c, sim: { ...c.sim, endBState: 'intermittentOpen' } } : c,
      ),
    });
    expect(compileNetlist(loaded, BUILTIN_CATALOG).topologyHash).toBe(open.topologyHash);
  });

  it('golden 6: a hot spot reaching the metal melting point is held there and burns open (D ≥ 1 Ω / R_made)', () => {
    // 20 % torque (R_made 25.47 mΩ) at 60 A: about 92 W into a 1.1 J/K clamp, it reaches 1357.77 K in seconds.
    const r = rig(benchWorld(0.8));
    r.setAmps(1, 60);
    let steps = 0;
    while ((r.bag(1)['endATempK'] as number) < CU_MELT_K && steps < 20_000) {
      r.step(1);
      steps++;
      expect(r.bag(1)['endATempK'] as number).toBeLessThanOrEqual(CU_MELT_K);
    }
    expect(r.bag(1)['endATempK']).toBe(CU_MELT_K);
    const made = r.bank.madeOhm(0, 0);
    expect(made).toBeCloseTo(0.3 / Math.sqrt(0.4) / 1000 + 0.1 * 0.25, 9); // golden 2 of F3.3 part 1
    expect(r.bag(1)['endADegradation'] as number).toBeGreaterThanOrEqual(1 / made);
    expect(r.bag(1)['endAState']).toBe('intermittentOpen');
    // Burned open in every bucket: no current any more, the end cools, and stays open.
    r.setAmps(1, 0);
    r.step(30_000);
    expect(r.bag(1)['endATempK'] as number).toBeLessThan(320);
    expect(r.bag(1)['endAState']).toBe('intermittentOpen');
  });
});

describe('detections (ADR 0018 §6, goldens 7 and 8)', () => {
  it('terminationOverheat once per upward crossing of T_a + 100 K', () => {
    // 20 % torque at 12.5 A settles at T_h = 406.7 K (ADR 0018 §7): above 393.15 K, below the onset.
    const r = rig(benchWorld(0.8));
    const overheats = () => r.bank.takeDetections().filter((d) => d.kind === 'terminationOverheat');
    r.setAmps(1, 12.5);
    r.step(30_000);
    const first = overheats();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ connection: 1, end: 'a' });
    expect(first[0].temperatureK).toBeGreaterThanOrEqual(TA + 100);
    r.step(5000);
    expect(overheats()).toHaveLength(0);
    r.setAmps(1, 0);
    r.step(30_000);
    r.setAmps(1, 12.5);
    r.step(30_000);
    expect(overheats()).toHaveLength(1);
  });

  it('insulationDamaged is sticky at the rating + 40 K (403.15 K for THHN), with one detection', () => {
    // 20 % torque at 13.5 A: T_h passes 403.15 K (ADR 0018 §7: set only from 12.30 A).
    const r = rig(benchWorld(0.8));
    r.setAmps(1, 13.5);
    r.step(30_000);
    expect(r.bag(1)['insulationDamaged']).toBe(true);
    const insulation = r.bank.takeDetections().filter((d) => d.kind === 'insulationDamaged');
    expect(insulation).toHaveLength(1);
    expect(insulation[0].temperatureK).toBeGreaterThanOrEqual(363.15 + 40);
    r.setAmps(1, 0);
    r.step(30_000);
    expect(r.bag(1)['insulationDamaged']).toBe(true);
    expect(r.bank.takeDetections()).toHaveLength(0);
    // 12.0 A never gets there.
    const cool = rig(benchWorld(0.8));
    cool.setAmps(1, 12);
    cool.step(30_000);
    expect(cool.bag(1)['insulationDamaged']).toBe(false);
  });
});

describe('finite whatever the inputs (the #106 CI counterexample)', () => {
  it('stamps (DC and AC) and bags stay finite for any accepted bag and any current, +∞ and NaN included', () => {
    const temp = fc.oneof(fc.constantFrom(1e-300, 1, 293.15, 1e6, 1e300), fc.double({ min: 1, max: 1e7, noNaN: true }));
    const amps = fc.oneof(
      fc.constantFrom(0, 1e-300, 1e150, 1e300, Number.POSITIVE_INFINITY, Number.NaN),
      fc.double({ min: 0, max: 1e6, noNaN: true }),
    );
    fc.assert(
      fc.property(
        temp,
        temp,
        fc.oneof(fc.constantFrom(1, 1e6, 1e300, Number.MAX_VALUE), fc.double({ min: 1, max: 1e4, noNaN: true })),
        amps,
        amps,
        fc.integer({ min: 1, max: 30 }),
        (tc, th, d, conductorAmps, leadAmps, steps) => {
          const r = rig(
            benchWorld(0.8, { conductorTempK: tc, endATempK: th, endADegradation: d, endATerminationId: 1 }),
          );
          r.setAmps(1, conductorAmps);
          r.setAmps(2, leadAmps);
          r.step(steps);
          for (const id of [1, 2]) {
            const i = r.bank.indexOf(id);
            for (const at of [0, 1, 12.5, conductorAmps]) {
              if (Number.isFinite(at))
                expect(Number.isFinite(r.bank.resistanceOhm(i, at)), `${id} at ${at} A`).toBe(true);
            }
            for (const v of Object.values(r.bag(id))) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
            expect(r.bag(id)['conductorTempK'] as number).toBeLessThanOrEqual(CU_MELT_K);
          }
        },
      ),
      {
        numRuns: 150,
        examples: [
          // A loaded conductor at 1e-300 K (schema-valid) with I² = +∞: a negative R(T) made a −∞ step.
          [1e-300, 1, 1, Number.POSITIVE_INFINITY, 0, 1],
          // A NaN current (never a reading, but the bank must not pass it on).
          [293.15, 293.15, 1, Number.NaN, Number.NaN, 3],
          // An overflowing current on both, from the hottest accepted start.
          [1e300, 1e300, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 30],
        ],
      },
    );
  });
});

describe('the fusing rule (F3.6 part 2)', () => {
  const ta = TA;
  /** The steady current at which the model's conductor node reaches `tK` in free air (ADR 0018 §3.5 inversion). */
  const steadyAmps = (line: ThermalLineData, tK: number) => {
    const g = conductanceToAirWPerMK(conductorThermal(line), tK, ta);
    return Math.sqrt(((tK - ta) * g) / conductorResistanceOhm(line, 1000, tK));
  };
  /** Preece's fusing current for bare copper in air, I = 80 d^1.5 (d in mm), computed with Math.sqrt. */
  const preece = (line: ThermalLineData) => {
    const d = line.diameterM * 1000;
    return 80 * d * Math.sqrt(d);
  };

  it('is anchored to Preece: the model fuses 18 AWG and bare 14 AWG within +40 % of I = 80 d^1.5', () => {
    // Above 200 °C the model's R(T) is clamped (ADR 0018 §2), so it reaches the melting point at a higher
    // current than a real wire: lead (insulated) 102.8 A against Preece's 82.9 A (+24 %); bare 14 AWG
    // 221.8 A against 166.1 A (+34 %). Never below Preece: the model never fuses early.
    const lead = leadThermalLine(device(LEAD_REF).model.params as LeadParams);
    const bare = conductorPhysics(BUILTIN_CATALOG, device({ id: 'conductor.sorrelby-bare-14-solid', version: 1 }));
    if (bare === undefined) throw new Error('bare 14 AWG');
    for (const [line, low, high] of [
      [lead, 1.2, 1.3],
      [bare, 1.3, 1.4],
    ] as const) {
      const ratio = steadyAmps(line, line.meltingPointK) / preece(line);
      expect(ratio).toBeGreaterThan(low);
      expect(ratio).toBeLessThan(high);
    }
    expect(preece(lead)).toBeCloseTo(82.9, 1);
  });

  it('a shorted lead fuses at the melting point: open for good, both end states intermittentOpen, cooling after', () => {
    // A lead across the split-phase stand-in's L1 and N: kiloamps, adiabatic, it reaches 1357.77 K within
    // a few steps. Onderdonk's adiabatic time to melt 18 AWG (1624 cmil) from 20 °C at the first step's
    // current is t = (1624 / I)² log10(1063/254 + 1) / 33 (log10 5.185 = 0.71475): the model's is longer
    // (R(T) clamped at 200 °C, a 10 ms zero-order hold), and within 5× of it.
    const host = new SourceHost();
    host.place({ id: 'utility.larkmoor-split-phase-25kva', version: 1 });
    host.lead(1, 'l1', 1, 'n');
    const amps = host.engine.branchAmps({ kind: 'connection', connection: 1 });
    expect(amps).toBeGreaterThan(1000);
    const onderdonkS = ((1624 / amps) * (1624 / amps) * 0.71475) / 33;
    let fusedAt = -1;
    for (let t = 0; t < 1000 && fusedAt < 0; t++) {
      host.advance(1);
      if (host.materialised().connections[0].sim['endAState'] === 'intermittentOpen') fusedAt = host.engine.tick;
    }
    expect(fusedAt).toBeGreaterThan(0);
    const modelS = fusedAt / 1000;
    expect(modelS).toBeGreaterThan(onderdonkS);
    expect(modelS).toBeLessThan(5 * onderdonkS);
    const sim = host.materialised().connections[0].sim;
    expect(sim).toMatchObject({
      endAState: 'intermittentOpen',
      endBState: 'intermittentOpen',
      insulationDamaged: true,
    });
    expect(sim['conductorTempK']).toBe(CU_MELT_K);
    expect(host.engine.netlist.diagnostics).toContainEqual({
      code: 'absent-connection',
      connection: 1,
      reason: 'intermittent-open',
    });
    expect(Number.isNaN(host.engine.branchAmps({ kind: 'connection', connection: 1 }))).toBe(true);
    host.advance(60_000);
    const cooled = host.materialised().connections[0].sim;
    expect(cooled['conductorTempK'] as number).toBeLessThan(320);
    expect(cooled).toMatchObject({ endAState: 'intermittentOpen', insulationDamaged: true });
    // A save holding it loads open, and stays open.
    const loaded = host.reload();
    expect(loaded.engine.netlist.diagnostics).toContainEqual({
      code: 'absent-connection',
      connection: 1,
      reason: 'intermittent-open',
    });
  });

  it("a conductor whose node reaches its metal's melting point burns open at both landed ends", () => {
    // 14 AWG THHN at 300 A (full torque ends: cooler than the conductor): the conductor node melts first.
    const r = rig(benchWorld(4));
    r.setAmps(1, 300);
    let steps = 0;
    while ((r.bag(1)['conductorTempK'] as number) < CU_MELT_K && steps < 10_000) {
      r.step(1);
      steps++;
    }
    expect(r.bag(1)['conductorTempK']).toBe(CU_MELT_K);
    for (const side of [0, 1]) {
      const prefix = side === 0 ? 'endA' : 'endB';
      expect(r.bag(1)[`${prefix}Degradation`] as number).toBeGreaterThanOrEqual(1 / r.bank.madeOhm(0, side));
      expect(r.bag(1)[`${prefix}State`]).toBe('intermittentOpen');
    }
    expect(r.bag(1)['insulationDamaged']).toBe(true);
  });
});

describe('the end states in the engine (ADR 0018 §12, goldens 5, 10–12)', () => {
  /** The wired loop with conductor 2's end A (the breaker's load screw, R_made 0.3 mΩ) degraded to `d`. */
  const loop = (d: number, seed = 5) =>
    new SourceHost(
      engineBus(seed, wiredLoopWorld({ seed, conductor2Sim: { endADegradation: d, endATerminationId: 1 } })),
    );

  /** Every materialised conductor end's state against the refined pure function (ADR 0018 §6). */
  const checkPureFunction = (world: World) => {
    const allClosed = compileNetlist(world, BUILTIN_CATALOG, {
      connectionSim: () => ({ endAState: 'ok', endBState: 'ok' }),
    });
    const bucket = intermittentBucket(world.tick - 1);
    for (const connection of world.connections) {
      if (connection.lengthMm === null) continue;
      const branch = allClosed.branches.find(
        (b) => b.element.kind === 'connection' && b.element.connection === connection.id,
      );
      for (const [side, end] of [
        ['A', connection.a],
        ['B', connection.b],
      ] as const) {
        if (end?.termination == null || branch === undefined) continue;
        const sim = connection.sim;
        const made = branch.values[`end${side}ContactOhm`];
        const first = deriveStream(world.seed, `${terminationStreamKey(end.termination.id)}:intermittent`).nextU32();
        const d = sim[`end${side}Degradation`] as number;
        expect(Number.isFinite(d) && d >= 1).toBe(true);
        expect(sim[`end${side}State`]).toBe(
          ['ok', 'intermittentClosed', 'intermittentOpen', 'arcing'][endStateCode(made * d, first, bucket)],
        );
      }
    }
  };

  it('golden 5 (property): states are identical across runs and across a save and load, and every bag is the pure function', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 400, max: 2500 }),
        fc.integer({ min: 1, max: 1500 }),
        fc.integer({ min: 1, max: 1500 }),
        (d, cut, more) => {
          const straight = loop(d).advanceTo(cut);
          const again = loop(d).advanceTo(cut);
          expect(again.engine.exportState()).toStrictEqual(straight.engine.exportState());
          checkPureFunction(straight.materialised());
          const loaded = straight.reload();
          straight.advance(more);
          loaded.advance(more);
          expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
          expect(loaded.engine.exportState()).toStrictEqual(straight.engine.exportState());
          expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
          checkPureFunction(straight.materialised());
        },
      ),
      { numRuns: 12 },
    );
  });

  it("the engine's toggle-path netlist and snapshot equal a full compile's and a fresh start's at every bucket", () => {
    // The engine recompiles each open/close through the compiler's open-toggle path (same world, one
    // end's state changed); a fresh engine on the materialised world compiles it from scratch.
    const host = loop(1000);
    for (let tick = 101; tick <= 3001; tick += 100) {
      host.advanceTo(tick);
      const world = host.materialised();
      const full = compileNetlist(world, BUILTIN_CATALOG);
      expect(host.engine.netlist).toStrictEqual(full);
      const fresh = SimEngine.start(world, host.options);
      expect(fresh.snapshot()).toStrictEqual(host.engine.snapshot());
    }
  });

  it('an intermittent end opens and closes the circuit in whole 100-tick buckets (the heater current follows)', () => {
    const host = loop(1000);
    const first = deriveStream(5, `${terminationStreamKey(1)}:intermittent`).nextU32();
    const heater = () => host.engine.branchAmps({ kind: 'entity', entity: 5, part: 'element' });
    let opens = 0;
    for (let bucket = 0; bucket < 40; bucket++) {
      host.advanceTo(bucket * 100 + 50);
      const code = endStateCode(R0 * 1000, first, intermittentBucket(host.engine.tick - 1));
      const amps = heater();
      if (code === END_INTERMITTENT_OPEN) {
        opens++;
        expect(Number.isNaN(amps) || amps === 0).toBe(true);
      } else {
        expect(amps).toBeGreaterThan(0.1);
      }
    }
    expect(opens).toBeGreaterThan(3);
  });

  it('golden 10 (property): glowing and arcing ends converge within the outer-loop cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 300, max: 3200 }), fc.integer({ min: 1, max: 3000 }), (d, ticks) => {
        const host = loop(d).advance(ticks);
        for (const island of host.engine.islands()) {
          expect(island.status).toBe('solved');
          expect(island.iterations).toBeLessThanOrEqual(OUTER_LOOP_MAX_ITERATIONS.value);
        }
      }),
      { numRuns: 20 },
    );
  });

  it('golden 11 (property): every materialised bag is finite, D ≥ 1, no node above its melting point', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 1, max: 6000 }), (d, ticks) => {
        const world = loop(d).advance(ticks).materialised();
        for (const { sim } of world.connections) {
          expect(Number.isFinite(sim['conductorTempK'])).toBe(true);
          expect(sim['conductorTempK'] as number).toBeLessThanOrEqual(CU_MELT_K);
          for (const side of ['A', 'B']) {
            const t = sim[`end${side}TempK`];
            if (t !== null) expect(Number.isFinite(t) && (t as number) <= CU_MELT_K).toBe(true);
            const deg = sim[`end${side}Degradation`] as number;
            expect(Number.isFinite(deg) && deg >= 1).toBe(true);
          }
        }
      }),
      { numRuns: 20 },
    );
  });

  it('golden 12 (property): a re-landed end resets (T_h = T_c, D = 1, the new id) with its state decided for D = 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 3500 }), fc.integer({ min: 1, max: 3000 }), (d, ticks) => {
        const world = wiredLoopWorld({ spread: true, conductor2Sim: { endADegradation: d, endATerminationId: 1 } });
        const host = new SourceHost(engineBus(5, { ...world, difficulty: 'trainee' })).advance(ticks);
        host.exec('wire.unland', { id: 2, end: 'a' });
        host.exec('wire.land', { id: 2, end: 'a', at: { entity: 2, terminal: 'load', termination: 'auto' } });
        const materialised = host.materialised();
        const sim = materialised.connections.find((c) => c.id === 2)?.sim ?? {};
        expect(sim['endADegradation']).toBe(1);
        expect(sim['endATerminationId']).toBe(8);
        expect(sim['endATempK']).toBe(sim['conductorTempK']);
        expect(sim['endAState']).toBe('ok');
        checkPureFunction(materialised);
      }),
      { numRuns: 10 },
    );
  });

  it('an engine-changed load re-decides the states when the bank is built, before the first compile', () => {
    // A save whose state disagrees with this engine's decision (as another engine's may): the engine
    // starts from the decision, so the compiler never sees the stale state.
    const world = wiredLoopWorld({
      tick: 1000,
      conductor2Sim: { endADegradation: 1, endATerminationId: 1, endAState: 'intermittentOpen' },
    });
    const engine = SimEngine.start(world, new SourceHost().options);
    expect(engine.exportState().connections.find((c) => c.id === 2)?.state['endAState']).toBe('ok');
    expect(engine.netlist.diagnostics.some((x) => x.code === 'absent-connection' && x.connection === 2)).toBe(false);
  });
});
