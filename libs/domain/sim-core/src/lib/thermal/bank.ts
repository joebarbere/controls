import {
  type Catalog,
  CONNECTION_END_STATES,
  type ConductorPhysics,
  H_CONV_COEFF,
  conductorPhysics,
  conductorResistanceOhm,
  conductorThermal,
  heatCapacityPerMetre,
  type LeadParams,
  STEFAN_BOLTZMANN,
  leadThermalLine,
  type TerminalMethodSpec,
  type ThermalLineData,
  thermalConductivityWPerMK,
} from '@controls/catalog';
import type { DeviceStateValue, World } from '@controls/save-format';
import { deriveStream, terminationStreamKey } from '@controls/world-model';
import { AMBIENT_TEMPERATURE_K } from '../constants';
import { asMadeContactInto, type ContactParts, degradationRateMultiplier } from '../contact/contact';
import {
  ARC_CURRENT_FLOOR_A,
  arcVoltageV,
  BURNED_OPEN_OHM,
  DEGRADATION_RATE_PER_K_S,
  END_ARCING,
  END_INTERMITTENT_CLOSED,
  END_INTERMITTENT_OPEN,
  END_OK,
  endStateCode,
  GLOW_CURRENT_FLOOR_A,
  GLOW_ONSET_OHM,
  GLOW_P,
  GLOW_V0,
  INSULATION_DAMAGE_MARGIN_K,
  INTERMITTENT_ONSET_OHM,
  intermittentBucket,
  OXIDATION_ONSET_K,
  TERMINATION_OVERHEAT_RISE_K,
} from '../contact/regimes';
import { SOLVE_INTERVAL_TICKS, TICK_S } from '../engine/constants';
import type { LayerContext } from '../engine/device-model';
import type { AcBranchValues } from '../mna/ac-values';
import type { DcSolution } from '../mna/dc';
import type { DcBranchValues } from '../mna/values';
import type { Netlist, NetlistBranch, StateBag } from '../netlist/types';
import { CONNECTION_RESOLVE_MIN_A, CONNECTION_RESOLVE_RELTOL } from './constants';

/*
 * The connection thermal bank (F3.6 parts 1 and 2, D2, D7, D8, ADR 0018 §3, §5, §6, ADR 0015
 * "Connection state bags"): the continuous and protection layers of every connection of a known
 * connection kind, leads and conductors, netlisted or not. It owns their ten `sim` keys, stamps each
 * netlisted connection's solve-time value, integrates its thermal nodes on the fixed absolute schedule
 * and decides its ends' states.
 *
 * **Nodes.** One lumped conductor node per connection (per metre, so the length cancels): C′ dT_c/dt =
 * I² R′(T_c) − G′(T_c) (T_c − T_a). One hot-spot node per landed conductor end (lead clips have none):
 * C_h dT_h/dt = I² R_end − G_fin (T_h − T_c) − G_term (T_h − T_a), with G_fin = √(G′ k A) (the
 * conductor leaving the terminal as a semi-infinite fin, one-way: the hot spot doesn't heat the lumped
 * node) and G_term, C_h from the terminal's method spec. No node is ever above its metal's melting
 * point: reaching it burns the end (or fuses the conductor) open, and the node is held there.
 *
 * **Schedule.** `continuous` runs only at ticks with t % `SOLVE_INTERVAL_TICKS` = 0 (the engine calls
 * it there), after that tick's cadence solve, by forward Euler over the exact dt = 10 × `TICK_S` =
 * 0.01 s, with the current from the solution at t (zero-order hold); `protection` runs right after it
 * and decides the end states. The bags at any tick hold the state after the last scheduled step, so a
 * save anywhere continues identically: no "last integrated" key, never staggered by id.
 *
 * **Stamps.** R = R_cond(T_c) + R_end,a + R_end,b: R_cond = R_cond(T₀) (1 + α (T_e − T₀)),
 * T_e = min(T_c, T_lin). Each end by its regime (ADR 0018 §6): ohmic (a (1 + α (T_h − T₀)) + b) · D,
 * glowing (`ok` from `GLOW_ONSET_OHM`, and `intermittentClosed`) the larger of that and
 * V_G0/|I|_f + P_G/|I|_f², arcing V_arc/|I|_a; an `intermittentOpen` end's connection isn't netlisted.
 * The glowing and arcing laws are nonlinear in the branch current: on DC the outer loop's `iterate`
 * hook values them at its iterate; on AC (no outer loop) they take |I| from the last solution and the
 * 1 % rule iterates across re-solves. A lead's is its conductor at its temperature plus its two
 * constant clip contacts.
 *
 * **Degradation (§5).** D grows only while T_h is above `OXIDATION_ONSET_K`, by
 * `DEGRADATION_RATE_PER_K_S` × the end's multiplier (10 for aluminium on an unrated method) per kelvin
 * of excess, and never falls: cooling doesn't reverse it.
 *
 * **States (§6).** A landed end's state is a pure function of R_deg = R_made · D, the termination's
 * `:intermittent` stream and the bucket of the tick before the state's tick: `endStateCode`. It is
 * decided at every cadence step (only for the ends in the compact list, those with R_deg at or above
 * `INTERMITTENT_ONSET_OHM`; every other landed end is `ok`) and at every rebuild, so the persisted
 * state at tick T equals `endStateCode(R_made · D, s, ⌊(T − 1) / 100⌋)` for every bag. Entering or
 * leaving `intermittentOpen` is a topology change; any other state or regime change a value change.
 *
 * **Failure (F3.6 part 2's rule).** A conductor or lead whose conductor node reaches its metal's
 * melting point is fused: a conductor's two landed ends are burned open (each D raised to
 * `BURNED_OPEN_OHM` / R_made), a lead's two end states become `intermittentOpen` for good (a lead's
 * only non-initial end key). `insulationDamaged` (sticky) is set when the conductor node, or a
 * conductor's hot spot, reaches the insulation's rating plus `INSULATION_DAMAGE_MARGIN_K` (a lead's
 * rating is its `insulationRatedTempK`; a bare conductor has none).
 *
 * **Detections.** `terminationOverheat` (a hot spot crossing T_a + 100 K upwards) and
 * `insulationDamaged` (the step that sets the flag) are recorded in a preallocated ring, read by
 * `takeDetections`; publishing them is protocol 7 (F3.6 part 3), so the engine doesn't emit them yet.
 *
 * **Readings only.** On an island that isn't a reading (unmodelled, mixed, singular, non-converged)
 * the current is unknown, so the connection and its ends are frozen, as the lamp's filament is. A
 * connection that isn't netlisted carries no current and relaxes towards ambient.
 *
 * **Bags (ADR 0015's identity rules).** For a conductor end: an unlanded end's temperature is null and
 * its degradation, state and termination id are kept; a termination whose id equals the bag's
 * `end*TerminationId` continues; any other resets (temperature = the conductor's, degradation 1, the new
 * id, the state decided for D = 1). A landed end whose temperature is null starts at T_c. A conductor
 * whose temperature is null starts at ambient. Deleted connections keep their bags as tombstones while
 * their id can't be reused, so undoing the delete restores them.
 *
 * **Layout.** Struct of arrays, sized at a rebuild (membership or termination change), indexed in
 * connection-id order; a step, a decision and a stamp allocate nothing.
 */

const KIND_LEAD = 0;
const KIND_CONDUCTOR = 1;
const AMBIENT = AMBIENT_TEMPERATURE_K.value;
const H_CONV = H_CONV_COEFF.value;
const SIGMA = STEFAN_BOLTZMANN.value;
/** The bank's step: exactly 0.01 s (10 × 0.001 is exact in binary64). */
export const CONNECTION_STEP_S = SOLVE_INTERVAL_TICKS.value * TICK_S.value;
const RESOLVE_RELTOL = CONNECTION_RESOLVE_RELTOL.value;
const RESOLVE_MIN_A2 = CONNECTION_RESOLVE_MIN_A.value * CONNECTION_RESOLVE_MIN_A.value;
const ONSET_K = OXIDATION_ONSET_K.value;
const DEGRADE_RATE = DEGRADATION_RATE_PER_K_S.value;
const BURNED_OHM = BURNED_OPEN_OHM.value;
const GLOW_OHM = GLOW_ONSET_OHM.value;
const INTERMITTENT_OHM = INTERMITTENT_ONSET_OHM.value;
const GLOW_V = GLOW_V0.value;
const GLOW_W = GLOW_P.value;
const GLOW_FLOOR = GLOW_CURRENT_FLOOR_A.value;
const ARC_FLOOR = ARC_CURRENT_FLOOR_A.value;
const OVERHEAT_K = AMBIENT + TERMINATION_OVERHEAT_RISE_K.value;
const DAMAGE_MARGIN_K = INSULATION_DAMAGE_MARGIN_K.value;

/** An end's regime code (stamps and heating): ohmic, glowing, arcing, open (never stamped). */
const REGIME_OHMIC = 0;
const REGIME_GLOW = 1;
const REGIME_ARC = 2;
const REGIME_OPEN = 3;

/** What `protection` reports: nothing, a value or regime change (re-solve), an open/closed change (recompile). */
export const CONNECTION_UNCHANGED = 0;
export const CONNECTION_VALUES_CHANGED = 1;
export const CONNECTION_TOPOLOGY_CHANGED = 2;

/** The detection kinds (protocol 7 publishes them as events, F3.6 part 3). */
export type ConnectionDetectionKind = 'terminationOverheat' | 'insulationDamaged';
const DETECTION_KINDS: readonly ConnectionDetectionKind[] = ['terminationOverheat', 'insulationDamaged'];
const DETECT_OVERHEAT = 0;
const DETECT_INSULATION = 1;
/** The detection ring's capacity: older detections are overwritten (counted in `detectionsDropped`). */
export const CONNECTION_DETECTION_CAPACITY = 256;

/** One detection: the tick of the state it describes (step tick + 1), the connection and end, the temperature. */
export interface ConnectionDetection {
  readonly tick: number;
  readonly kind: ConnectionDetectionKind;
  readonly connection: number;
  /** `'a'` or `'b'` for a hot spot, `null` for the conductor node. */
  readonly end: 'a' | 'b' | null;
  /** The node's temperature after the step (K). */
  readonly temperatureK: number;
}

/** The connection kinds the bank models. */
export const THERMAL_CONNECTION_KINDS: readonly string[] = ['conductor', 'lead'];

/** A connection end's state code: its index in `CONNECTION_END_STATES` (`ok` = 0). */
const STATE_CODE: Readonly<Record<string, number>> = Object.fromEntries(CONNECTION_END_STATES.map((s, i) => [s, i]));

/** Test parameters (ADR 0018 §3.5, §12): the linearised goldens, the time constant, the degradation golden. */
export interface ConnectionBankOptions {
  /** A fixed conductor conductance to air G′ (W/(m·K)) instead of the surface model. */
  readonly fixedConductanceWPerMK?: number;
  /** Take every temperature coefficient as 0 (the conductor's R and the ends' constriction). */
  readonly zeroAlpha?: boolean;
  /** Hold every hot spot at this temperature (K): degradation integrates against it (golden 2 of part 2). */
  readonly holdEndTempK?: number;
}

/** The static thermal data of one catalogue entry, cached by ref. */
interface LineStatic {
  readonly kind: number;
  readonly line: ThermalLineData;
  /** R′(T₀) per metre (Ω/m). */
  readonly rPerM0: number;
  readonly alpha: number;
  readonly t0: number;
  readonly tLin: number;
  /** 1 / C′ (m·K/J). */
  readonly invC: number;
  readonly rIns: number;
  readonly outerD: number;
  readonly emissivity: number;
  /** k · A (W·m/K): the fin's axial conductance. */
  readonly kA: number;
  /** A lead's two clip contacts (Ω); 0 for a conductor. */
  readonly clipsOhm: number;
  /** The metal's melting point (K). */
  readonly meltK: number;
  /** The insulation-damage temperature (K): rating + margin, or +∞ for a bare conductor. */
  readonly damageK: number;
  readonly lead: LeadParams | null;
  /** A conductor's physics (the contact model reads its stranding and resistivity); `null` for a lead. */
  readonly physics: ConductorPhysics | null;
}

/** One connection's bag in an export (`SimStateExport.connections`). */
export interface ConnectionBagExport {
  readonly id: number;
  readonly state: Record<string, DeviceStateValue>;
}

/** What the compiler reads of a connection's sim state (`CompileOptions.connectionSim`): its two end states. */
export interface ConnectionTopologyView {
  readonly [key: string]: string;
  readonly endAState: string;
  readonly endBState: string;
}

type Connection = World['connections'][number];
type End = Connection['a'];

const num = (bag: StateBag | undefined, key: string): number | null => {
  const value = bag?.[key];
  return typeof value === 'number' ? value : null;
};

export class ConnectionThermalBank {
  /** Members, ascending by connection id. */
  count = 0;
  ids = new Int32Array(0);
  /** Per member: its branch in the current netlist, or −1. */
  branch = new Int32Array(0);
  /**
   * The engine's last solution (or `null` before one, or after a structural recompile): an AC end's
   * nonlinear regime and a DC stamp before the outer loop read its branch current there.
   */
  solution: DcSolution | null = null;
  private kind = new Uint8Array(0);
  private rStatic = new Float64Array(0);
  private rPerM0 = new Float64Array(0);
  private alpha = new Float64Array(0);
  private t0 = new Float64Array(0);
  private tLin = new Float64Array(0);
  private invC = new Float64Array(0);
  private rIns = new Float64Array(0);
  private outerD = new Float64Array(0);
  private emissivity = new Float64Array(0);
  private kA = new Float64Array(0);
  private clipsOhm = new Float64Array(0);
  private meltK = new Float64Array(0);
  private damageK = new Float64Array(0);
  private tc = new Float64Array(0);
  private insulationDamaged = new Uint8Array(0);
  /** Per member: 1 if an end is in a nonlinear regime (glowing or arcing): its branch gets `iterate`. */
  private nonlinear = new Uint8Array(0);
  /** The solve-time value each `dcValue`/`acValue` wrote (scratch: never read back by the 1 % rule). */
  private stampOhm = new Float64Array(0);
  /** Per member: the |I| (A) the next `computeStamp` values its nonlinear ends at (scratch). */
  private stampAmps = new Float64Array(0);
  // Per end (2 × member + 0 for a, + 1 for b).
  private hot = new Uint8Array(0);
  private th = new Float64Array(0);
  private degradation = new Float64Array(0);
  private termId = new Float64Array(0);
  private state = new Uint8Array(0);
  private regime = new Uint8Array(0);
  private constriction = new Float64Array(0);
  private film = new Float64Array(0);
  private gTerm = new Float64Array(0);
  private invCh = new Float64Array(0);
  /** R_made at T₀ (Ω): the as-made contact, computed by the bank for every landed end, netlisted or not. */
  private rMade = new Float64Array(0);
  /** The degradation-rate multiplier (`degradationRateMultiplier`). */
  private rateMult = new Float64Array(0);
  /** The first outputs of the termination's `:intermittent` stream, and V_arc from its `:arcing` stream. */
  private drawFirst = new Uint32Array(0);
  private arcV = new Float64Array(0);
  /** The compact list (ADR 0015): the ends with R_deg ≥ `INTERMITTENT_ONSET_OHM`, the only ones decided per step. */
  private listed = new Uint8Array(0);
  private list = new Int32Array(0);
  private listCount = 0;

  /** Per member, while netlisted: its branch's island and end nodes (copied at a sync, read per step). */
  private memberIsland = new Int32Array(0);
  private memberNodeA = new Int32Array(0);
  private memberNodeB = new Int32Array(0);
  /** Per member, scratch for one step's phases (`continuous`): |I|², T_s, G′ and T_c before the step. */
  private scratchI2 = new Float64Array(0);
  private scratchTs = new Float64Array(0);
  private scratchG = new Float64Array(0);
  private scratchTc = new Float64Array(0);
  /** Per netlist branch: its member, or −1; and per island: 1 if a reading at this step (scratch). */
  private memberOfBranch = new Int32Array(0);
  private readableIsland = new Uint8Array(0);
  /** Set by `continuous` for `protection`: a lead fused (a topology change), a regime crossed (a value change). */
  private readonly pending = new Uint8Array(2);
  // The detection ring.
  private readonly detectKind = new Uint8Array(CONNECTION_DETECTION_CAPACITY);
  private readonly detectTick = new Float64Array(CONNECTION_DETECTION_CAPACITY);
  private readonly detectId = new Int32Array(CONNECTION_DETECTION_CAPACITY);
  private readonly detectEnd = new Int8Array(CONNECTION_DETECTION_CAPACITY);
  private readonly detectTemp = new Float64Array(CONNECTION_DETECTION_CAPACITY);
  /** [next slot, held, dropped]. */
  private readonly detectCounts = new Float64Array(3);
  /** The member `topologyView` answered last (−1: none yet). */
  private viewCursor = -1;
  private connectionsRef: readonly Connection[] | null = null;
  private readonly statics = new Map<string, LineStatic | null>();
  private readonly tombstones = new Map<number, StateBag>();
  /** Per termination id: its `:intermittent` first output and V_arc (pure functions of the seed and the id). */
  private readonly draws = new Map<number, { readonly first: number; readonly arcV: number }>();
  /** Test parameters, as slots so the step reads them unboxed: a fixed G′ and a held T_h (−1: off). */
  private readonly fixedG = new Float64Array(1);
  private readonly holdTh = new Float64Array(1);
  private readonly zeroAlpha: boolean;

  constructor(
    private readonly catalog: Catalog,
    options: ConnectionBankOptions = {},
  ) {
    this.fixedG[0] = options.fixedConductanceWPerMK ?? -1;
    this.holdTh[0] = options.holdEndTempK ?? -1;
    this.zeroAlpha = options.zeroAlpha === true;
  }

  /**
   * Brings the bank up to `world` and `netlist`: rebuilds it when the world's connections changed
   * (membership, an end, a termination: ADR 0015's identity rules, the end states decided at the
   * world's tick), else only refreshes each member's branch and static contact values (a recompile
   * moved them). Allocates (commands and recompiles only).
   */
  sync(world: World, netlist: Netlist): void {
    this.syncWorld(world);
    this.refresh(netlist);
  }

  /**
   * The first half of {@link sync}: rebuilds the members and decides their end states if the world's
   * connections changed. The engine calls it before a compile, which reads the end states
   * (`topologyView`), then {@link refresh} after it.
   */
  syncWorld(world: World): void {
    if (world.connections !== this.connectionsRef) this.rebuild(world);
  }

  /** Member `i`'s sim bag now: the ten connection keys, finite numbers (allocates; never per tick). */
  bag(i: number): Record<string, DeviceStateValue> {
    const a = 2 * i;
    const b = a + 1;
    return {
      conductorTempK: this.tc[i],
      endATempK: this.hot[a] === 1 ? this.th[a] : null,
      endADegradation: this.degradation[a],
      endATerminationId: this.termId[a] < 0 ? null : this.termId[a],
      endAState: CONNECTION_END_STATES[this.state[a]],
      endBTempK: this.hot[b] === 1 ? this.th[b] : null,
      endBDegradation: this.degradation[b],
      endBTerminationId: this.termId[b] < 0 ? null : this.termId[b],
      endBState: CONNECTION_END_STATES[this.state[b]],
      insulationDamaged: this.insulationDamaged[i] === 1,
    };
  }

  /** Every member's bag, ascending by id (`SimStateExport.connections`). */
  exportBags(): ConnectionBagExport[] {
    const out: ConnectionBagExport[] = [];
    for (let i = 0; i < this.count; i++) out.push({ id: this.ids[i], state: this.bag(i) });
    return out;
  }

  /**
   * Connection `id`'s end states as the compiler reads them (`CompileOptions.connectionSim`), or
   * `undefined` for a connection that isn't a member: one of 16 frozen objects, no allocation. A
   * compile asks in ascending id order, so the member after the last one asked is tried first (a
   * compile of the wired plant asks 2,600 times; a binary search each was 10 % of a toggle's re-solve).
   */
  topologyView(id: number): ConnectionTopologyView | undefined {
    const next = this.viewCursor + 1;
    const i = next < this.count && this.ids[next] === id ? next : this.indexOf(id);
    if (i < 0) return undefined;
    this.viewCursor = i;
    return TOPOLOGY_VIEWS[4 * this.state[2 * i] + this.state[2 * i + 1]];
  }

  /** The member netlist branch `branch` belongs to, or −1 (not a connection's, or not a member). */
  memberOf(branch: number): number {
    return branch < this.memberOfBranch.length ? this.memberOfBranch[branch] : -1;
  }

  /** Whether member `i` has an end in a nonlinear regime (glowing or arcing): its branch needs `iterate`. */
  isNonlinear(i: number): boolean {
    return this.nonlinear[i] === 1;
  }

  /** A member's index by connection id, or −1 (allocation-free binary search). */
  indexOf(id: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = this.ids[mid];
      if (at === id) return mid;
      if (at < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Member `i`'s solve-time resistance (Ω) from its current temperatures, degradation and states, its
   * nonlinear ends valued at `amps` (A, default the last solution's branch current). Allocates nothing.
   */
  resistanceOhm(i: number, amps?: number): number {
    this.stampAmps[i] = amps ?? this.solvedAmps(i);
    this.computeStamp(i);
    return this.stampOhm[i];
  }

  /** Member `i`'s R_made at T₀ (Ω) at end `side` (0 for a, 1 for b): 0 for an end without a hot spot. */
  madeOhm(i: number, side: number): number {
    return this.rMade[2 * i + side];
  }

  /** Member `i`'s end `side`'s `:intermittent` first output (for the pure-function property). */
  intermittentFirst(i: number, side: number): number {
    return this.drawFirst[2 * i + side];
  }

  /** Member `i`'s end `side`'s V_arc (V). */
  arcVolts(i: number, side: number): number {
    return this.arcV[2 * i + side];
  }

  /** Every detection recorded since the last call, oldest first (allocates; tests and part 3's publisher). */
  takeDetections(): ConnectionDetection[] {
    const held = this.detectCounts[1];
    const next = this.detectCounts[0];
    const out: ConnectionDetection[] = [];
    for (let k = 0; k < held; k++) {
      const slot = (next - held + k + CONNECTION_DETECTION_CAPACITY) % CONNECTION_DETECTION_CAPACITY;
      const end = this.detectEnd[slot];
      out.push({
        tick: this.detectTick[slot],
        kind: DETECTION_KINDS[this.detectKind[slot]],
        connection: this.detectId[slot],
        end: end < 0 ? null : end === 0 ? 'a' : 'b',
        temperatureK: this.detectTemp[slot],
      });
    }
    this.detectCounts[1] = 0;
    return out;
  }

  /** Detections overwritten before they were taken (the ring is full). */
  get detectionsDropped(): number {
    return this.detectCounts[2];
  }

  private detect(kind: number, tick: number, member: number, end: number, temperatureK: number): void {
    const counts = this.detectCounts;
    const slot = counts[0];
    this.detectKind[slot] = kind;
    this.detectTick[slot] = tick;
    this.detectId[slot] = this.ids[member];
    this.detectEnd[slot] = end;
    this.detectTemp[slot] = temperatureK;
    counts[0] = (slot + 1) % CONNECTION_DETECTION_CAPACITY;
    if (counts[1] < CONNECTION_DETECTION_CAPACITY) counts[1]++;
    else counts[2]++;
  }

  /** |I| (A) of member `i`'s branch in the last solution, or 0 (not netlisted, no solution). */
  private solvedAmps(i: number): number {
    const b = this.branch[i];
    const solution = this.solution;
    if (b < 0 || solution === null || 2 * b + 1 >= solution.branches.length) return 0;
    const re = solution.branches[2 * b];
    const im = solution.branches[2 * b + 1];
    return Math.sqrt(re * re + im * im);
  }

  /**
   * Writes member `i`'s solve-time value into `stampOhm[i]`: R_cond(T_c) + each end's value by its
   * regime (the nonlinear ones at `stampAmps[i]`), or a lead's conductor plus its clips. A slot, never a
   * returned double, and no calls: on a per-solve path a double crossing a call V8 doesn't inline is
   * boxed (simulation caveats, "Pass a slot, not a value"). An ohmic end's operations are part 1's, in
   * its order, so a stamp is bit-identical to part 1's while nothing degrades.
   */
  private computeStamp(i: number): void {
    const alpha = this.alpha[i];
    const t0 = this.t0[i];
    const te = Math.min(this.tc[i], this.tLin[i]);
    let r = this.rStatic[i] * (1 + alpha * (te - t0));
    if (this.kind[i] === KIND_LEAD) {
      r += this.clipsOhm[i];
    } else {
      const amps = this.stampAmps[i];
      for (let e = 2 * i; e < 2 * i + 2; e++) {
        if (this.hot[e] !== 1) continue;
        const regime = this.regime[e];
        if (regime === REGIME_ARC) {
          r += this.arcV[e] / (amps > ARC_FLOOR ? amps : ARC_FLOOR);
          continue;
        }
        if (regime === REGIME_OPEN) continue;
        let end = (this.constriction[e] * (1 + alpha * (this.th[e] - t0)) + this.film[e]) * this.degradation[e];
        if (regime === REGIME_GLOW) {
          const f = amps > GLOW_FLOOR ? amps : GLOW_FLOOR;
          const glow = GLOW_V / f + GLOW_W / (f * f);
          if (glow > end) end = glow;
        }
        r += end;
      }
    }
    this.stampOhm[i] = r;
  }

  /** `SimDeviceBank.dcValue` for member `i`'s branch: nonlinear ends at the last solution's current. */
  dcValue(i: number, branch: NetlistBranch, values: DcBranchValues): boolean {
    this.stampAmps[i] = this.nonlinear[i] === 1 ? this.solvedAmps(i) : 0;
    this.computeStamp(i);
    values.resistorAt(branch.index, this.stampOhm, i);
    return true;
  }

  /**
   * `SimDeviceBank.iterate` (DC outer loop) for a member with a nonlinear end: its value at the
   * iterate's branch current (the last solution's on a cold start). Pure in its inputs.
   */
  iterate(i: number, branch: NetlistBranch, iterate: DcSolution | null, values: DcBranchValues): void {
    let amps: number;
    if (iterate === null) {
      amps = this.solvedAmps(i);
    } else {
      const re = iterate.branches[2 * branch.index];
      const im = iterate.branches[2 * branch.index + 1];
      amps = Math.sqrt(re * re + im * im);
    }
    this.stampAmps[i] = amps;
    this.computeStamp(i);
    values.resistorAt(branch.index, this.stampOhm, i);
  }

  /**
   * `SimDeviceBank.acValue`: purely resistive on AC (ADR 0015). The AC solver has no outer loop, so a
   * nonlinear end is valued at the last solution's current and the 1 % rule re-solves until it settles.
   */
  acValue(i: number, branch: NetlistBranch, values: AcBranchValues): boolean {
    this.stampAmps[i] = this.nonlinear[i] === 1 ? this.solvedAmps(i) : 0;
    this.computeStamp(i);
    values.resistorAt(branch.index, this.stampOhm, i);
    return true;
  }

  /**
   * One scheduled step over [t, t + 10) (the engine calls it only at t % `SOLVE_INTERVAL_TICKS` = 0):
   * forward Euler on every conductor and hot-spot node with the solution at t, then degradation, the
   * melting and insulation limits and the detections. Returns whether a netlisted connection's value
   * moved more than 1 % from what the last solve saw.
   *
   * Allocates nothing: loops over typed arrays with every formula written out, no call but
   * `Math.sqrt`/`Math.min`/`Math.max` (intrinsics), the void `computeStamp` and the rare `detect`.
   * G′ is `conductanceToAirOf`'s exact sequence of operations, so the bank and the derived ampacity
   * agree bit for bit (a spec pins it).
   */
  continuous(ctx: LayerContext): boolean {
    const dt = CONNECTION_STEP_S;
    const ta = AMBIENT;
    const ta2 = ta * ta;
    const tick = ctx.tick + 1;
    const branches = ctx.solution.branches;
    const nodes = ctx.solution.nodes;
    const fixed = this.fixedG[0];
    const useFixed = fixed >= 0;
    const hold = this.holdTh[0];
    // Which islands are readings, once per step (not once per member).
    const islandCount = ctx.netlist.islands.length;
    if (this.readableIsland.length !== islandCount) this.readableIsland = new Uint8Array(islandCount);
    const readable = this.readableIsland;
    for (let k = 0; k < islandCount; k++) readable[k] = ctx.islandReadable(k) ? 1 : 0;
    // The arrays in locals: one load each per step, not one per member.
    const count = this.count;
    const branchOf = this.branch;
    const islandOf = this.memberIsland;
    const kind = this.kind;
    const alphaOf = this.alpha;
    const t0Of = this.t0;
    const tLin = this.tLin;
    const tcOf = this.tc;
    const rPerM0 = this.rPerM0;
    const outerD = this.outerD;
    const emissivity = this.emissivity;
    const rInsOf = this.rIns;
    const invC = this.invC;
    const kA = this.kA;
    const meltOf = this.meltK;
    const damageOf = this.damageK;
    const damaged = this.insulationDamaged;
    const hot = this.hot;
    const thOf = this.th;
    const constriction = this.constriction;
    const film = this.film;
    const degradation = this.degradation;
    const invCh = this.invCh;
    const gTerm = this.gTerm;
    const regimeOf = this.regime;
    const rMade = this.rMade;
    const rateMult = this.rateMult;
    const arcV = this.arcV;
    const stateOf = this.state;
    const nonlinear = this.nonlinear;
    // Scratch per member: |I|² (−1: frozen), the surface temperature, then G′ and the old T_c.
    const i2Of = this.scratchI2;
    const tsOf = this.scratchTs;
    const gOf = this.scratchG;
    const oldTc = this.scratchTc;
    /*
     * In phases over all members, not one member at a time: each member's chain (two fourth roots,
     * four divisions, a square root per end) is long and serial, but members are independent, so short
     * phases let the processor overlap many members' chains. Every member gets exactly the operations a
     * one-member-at-a-time loop would give it, so the results are bit-identical.
     */
    // 1. The current, and the surface temperature from h(T_c) (the one fixed-point step's first half).
    for (let i = 0; i < count; i++) {
      const b = branchOf[i];
      let i2 = 0;
      if (b >= 0) {
        // Only a reading moves a connection: on an unsolved or unsettled island it is frozen.
        if (readable[islandOf[i]] !== 1) {
          i2Of[i] = -1;
          continue;
        }
        const re = branches[2 * b];
        const im = branches[2 * b + 1];
        i2 = re * re + im * im;
      }
      i2Of[i] = i2;
      // h₀ = h(T_c), held in the T_s slot until the next phase.
      const tc = tcOf[i];
      tsOf[i] =
        H_CONV * Math.sqrt(Math.sqrt(Math.max(tc - ta, 0) / outerD[i])) +
        emissivity[i] * SIGMA * (tc * tc + ta2) * (tc + ta);
    }
    for (let i = 0; i < count; i++) {
      if (i2Of[i] < 0) continue;
      const tc = tcOf[i];
      const rIns = rInsOf[i];
      const surface0 = 1 / (tsOf[i] * (Math.PI * outerD[i]));
      tsOf[i] = ta + ((tc - ta) * surface0) / (rIns + surface0);
    }
    // 2. G′ from h(T_s) (ADR 0018 §3.2; conductanceToAirOf, operation for operation), and the conductor node.
    for (let i = 0; i < count; i++) {
      if (i2Of[i] < 0) continue;
      // h₁ = h(T_s), held in the G′ slot until the next loop.
      const ts = tsOf[i];
      gOf[i] =
        H_CONV * Math.sqrt(Math.sqrt(Math.max(ts - ta, 0) / outerD[i])) +
        emissivity[i] * SIGMA * (ts * ts + ta2) * (ts + ta);
    }
    for (let i = 0; i < count; i++) {
      const i2 = i2Of[i];
      if (i2 < 0) continue;
      const tc = tcOf[i];
      const modelled = 1 / (rInsOf[i] + 1 / (gOf[i] * (Math.PI * outerD[i])));
      const g = useFixed ? fixed : modelled;
      gOf[i] = g;
      oldTc[i] = tc;
      const alpha = alphaOf[i];
      const rPerM = rPerM0[i] * (1 + alpha * (Math.min(tc, tLin[i]) - t0Of[i]));
      let next = tc + dt * invC[i] * (i2 * rPerM - g * (tc - ta));
      const melt = meltOf[i];
      // `!(next < melt)` and not `next >= melt`: a step that overflows (an absurd current, I² = +∞) or
      // gives NaN fuses too, so no temperature, and so no stamp, is ever non-finite.
      if (!(next < melt)) {
        // Fused (F3.6 part 2): the node is held at its melting point, and the connection opens for good.
        next = melt;
        this.fuse(i);
      }
      tcOf[i] = next;
      if (damaged[i] === 0 && next >= damageOf[i]) {
        damaged[i] = 1;
        this.detect(DETECT_INSULATION, tick, i, -1, next);
      }
    }
    // 3. Each landed end's hot spot, against T_c before the conductor's own step; G_fin = √(G′ k A); then
    // its degradation (from T_h before the step), its melting point and the detections.
    for (let i = 0; i < count; i++) {
      const i2 = i2Of[i];
      if (i2 < 0 || kind[i] !== KIND_CONDUCTOR) continue;
      const fin = Math.sqrt(gOf[i] * kA[i]);
      const tc = oldTc[i];
      const alpha = alphaOf[i];
      const t0 = t0Of[i];
      const melt = meltOf[i];
      const amps = nonlinear[i] === 1 ? Math.sqrt(i2) : 0;
      for (let e = 2 * i; e < 2 * i + 2; e++) {
        if (hot[e] !== 1) continue;
        const th = hold >= 0 ? hold : thOf[e];
        const d = degradation[e];
        const regime = regimeOf[e];
        // I² R_end by regime; the ohmic one is part 1's expression, in its order (bit-identical).
        let heat = 0;
        if (regime === REGIME_OHMIC) {
          heat = i2 * (constriction[e] * (1 + alpha * (th - t0)) + film[e]) * d;
        } else if (regime === REGIME_ARC) {
          heat = i2 * (arcV[e] / (amps > ARC_FLOOR ? amps : ARC_FLOOR));
        } else if (regime === REGIME_GLOW) {
          const ohmic = (constriction[e] * (1 + alpha * (th - t0)) + film[e]) * d;
          const f = amps > GLOW_FLOOR ? amps : GLOW_FLOOR;
          const glow = GLOW_V / f + GLOW_W / (f * f);
          heat = i2 * (glow > ohmic ? glow : ohmic);
        }
        let next = hold >= 0 ? hold : th + dt * invCh[e] * (heat - fin * (th - tc) - gTerm[e] * (th - ta));
        // Degradation (ADR 0018 §5): only above the onset, never reversed.
        const excess = th - ONSET_K;
        let dNext = excess > 0 ? d + dt * DEGRADE_RATE * rateMult[e] * excess : d;
        if (!(next < melt)) {
          // Burned open at the metal's melting point (§5); the node is held there (an overflowed or NaN
          // step included, as for the conductor node).
          next = melt;
          const open = BURNED_OHM / rMade[e];
          if (open > dNext) dNext = open;
        }
        if (th < OVERHEAT_K && next >= OVERHEAT_K) this.detect(DETECT_OVERHEAT, tick, i, e - 2 * i, next);
        if (damaged[i] === 0 && next >= damageOf[i]) {
          damaged[i] = 1;
          this.detect(DETECT_INSULATION, tick, i, e - 2 * i, next);
        }
        thOf[e] = next;
        if (dNext !== d) {
          degradation[e] = dNext;
          const made = rMade[e];
          // A regime boundary crossed: the glow onset (a value change), the intermittent onset (listed).
          if (made * d < GLOW_OHM && made * dNext >= GLOW_OHM && stateOf[e] === END_OK) {
            regimeOf[e] = REGIME_GLOW;
            nonlinear[i] = 1;
            this.pending[1] = 1;
          }
          if (made * dNext >= INTERMITTENT_OHM && this.listed[e] === 0) {
            this.listed[e] = 1;
            this.list[this.listCount++] = e;
          }
        }
      }
    }
    // 4. The 1 % rule: the resistance the last solve saw, |ΔV| / |I|, read back from the solution (never cached).
    const nodeA = this.memberNodeA;
    const nodeB = this.memberNodeB;
    const stamp = this.stampOhm;
    const stampAmps = this.stampAmps;
    let resolve = false;
    for (let i = 0; i < count; i++) {
      const i2 = i2Of[i];
      if (branchOf[i] < 0 || i2 <= RESOLVE_MIN_A2) continue;
      const na = nodeA[i];
      const nb = nodeB[i];
      const vr = nodes[2 * na] - nodes[2 * nb];
      const vi = nodes[2 * na + 1] - nodes[2 * nb + 1];
      const solvedOhm = Math.sqrt((vr * vr + vi * vi) / i2);
      stampAmps[i] = nonlinear[i] === 1 ? Math.sqrt(i2) : 0;
      this.computeStamp(i);
      const now = stamp[i];
      if (Math.abs(now - solvedOhm) > RESOLVE_RELTOL * now) resolve = true;
    }
    return resolve;
  }

  /**
   * The protection layer, at cadence ticks right after {@link continuous} (ADR 0018 §6): decides the
   * state of every end in the compact list for the step's bucket, and reports what changed for the
   * electrical layer: {@link CONNECTION_TOPOLOGY_CHANGED} when a connection opened or closed (a fused
   * lead too), {@link CONNECTION_VALUES_CHANGED} when only a state or regime moved, else
   * {@link CONNECTION_UNCHANGED}. Allocates nothing.
   */
  protection(ctx: LayerContext): number {
    let topology = this.pending[0] === 1;
    let values = this.pending[1] === 1;
    this.pending[0] = 0;
    this.pending[1] = 0;
    const bucket = intermittentBucket(ctx.tick);
    const list = this.list;
    const state = this.state;
    for (let k = 0; k < this.listCount; k++) {
      const e = list[k];
      if (this.hot[e] !== 1) continue;
      const before = state[e];
      const after = endStateCode(this.rMade[e] * this.degradation[e], this.drawFirst[e], bucket);
      if (after === before) continue;
      const i = e >> 1;
      const wasOpen = state[2 * i] === END_INTERMITTENT_OPEN || state[2 * i + 1] === END_INTERMITTENT_OPEN;
      state[e] = after;
      this.setRegime(e);
      const isOpen = state[2 * i] === END_INTERMITTENT_OPEN || state[2 * i + 1] === END_INTERMITTENT_OPEN;
      if (wasOpen !== isOpen) topology = true;
      else values = true;
      this.updateNonlinear(i);
    }
    return topology ? CONNECTION_TOPOLOGY_CHANGED : values ? CONNECTION_VALUES_CHANGED : CONNECTION_UNCHANGED;
  }

  /**
   * Member `i`'s conductor node reached its metal's melting point (F3.6 part 2's fusing rule): a
   * conductor's landed ends are burned open (D raised to `BURNED_OPEN_OHM` / R_made, decided open at the
   * protection step), a lead's two end states become `intermittentOpen` for good.
   */
  private fuse(i: number): void {
    if (this.kind[i] === KIND_LEAD) {
      if (this.state[2 * i] === END_INTERMITTENT_OPEN) return;
      this.state[2 * i] = END_INTERMITTENT_OPEN;
      this.state[2 * i + 1] = END_INTERMITTENT_OPEN;
      this.pending[0] = 1;
      return;
    }
    for (let e = 2 * i; e < 2 * i + 2; e++) {
      if (this.hot[e] !== 1) continue;
      const open = BURNED_OHM / this.rMade[e];
      if (open > this.degradation[e]) this.degradation[e] = open;
      if (this.listed[e] === 0) {
        this.listed[e] = 1;
        this.list[this.listCount++] = e;
      }
    }
  }

  /** End `e`'s regime from its state and R_deg (ADR 0018 §6). */
  private setRegime(e: number): void {
    const state = this.state[e];
    this.regime[e] =
      state === END_INTERMITTENT_OPEN
        ? REGIME_OPEN
        : state === END_ARCING
          ? REGIME_ARC
          : state === END_INTERMITTENT_CLOSED || this.rMade[e] * this.degradation[e] >= GLOW_OHM
            ? REGIME_GLOW
            : REGIME_OHMIC;
  }

  private updateNonlinear(i: number): void {
    let nonlinear = 0;
    for (let e = 2 * i; e < 2 * i + 2; e++) {
      if (this.hot[e] === 1 && (this.regime[e] === REGIME_GLOW || this.regime[e] === REGIME_ARC)) nonlinear = 1;
    }
    this.nonlinear[i] = nonlinear;
  }

  // --- building -------------------------------------------------------------------------------

  /** The static data of a connection's catalogue entry, or `null` for a kind the bank doesn't model. */
  private lineStatic(connection: Connection): LineStatic | null {
    const key = `${connection.ref.id}@${connection.ref.version}`;
    const cached = this.statics.get(key);
    if (cached !== undefined) return cached;
    const kind = this.catalog.kindOf(connection.ref);
    const device = this.catalog.device(connection.ref);
    let result: LineStatic | null = null;
    if (device !== undefined && (kind?.kind === 'conductor' || kind?.kind === 'lead')) {
      const lead = kind.kind === 'lead' ? (device.model.params as LeadParams) : null;
      const physics = lead === null ? (conductorPhysics(this.catalog, device) ?? null) : null;
      const line = lead === null ? physics : leadThermalLine(lead);
      if (line !== null) {
        const thermal = conductorThermal(line);
        const zero = this.zeroAlpha;
        const rating = lead !== null ? lead.insulationRatedTempK : (physics?.insulation?.ratedTempDryK ?? null);
        result = {
          kind: lead === null ? KIND_CONDUCTOR : KIND_LEAD,
          line,
          rPerM0: conductorResistanceOhm(line, 1000, line.referenceTemperatureK),
          alpha: zero ? 0 : line.temperatureCoefficientPerK,
          t0: line.referenceTemperatureK,
          tLin: line.linearAlphaMaxK,
          invC: 1 / heatCapacityPerMetre(line),
          rIns: thermal.insulationResistanceKMPerW,
          outerD: thermal.outerDiameterM,
          emissivity: thermal.emissivity,
          kA: thermalConductivityWPerMK(line) * line.areaM2,
          clipsOhm: lead === null ? 0 : 2 * lead.contactResistanceOhm,
          meltK: line.meltingPointK,
          damageK: rating === null ? Number.POSITIVE_INFINITY : rating + DAMAGE_MARGIN_K,
          lead,
          physics,
        };
      }
    }
    this.statics.set(key, result);
    return result;
  }

  /** The method spec an end's termination was made by, or `null` (an unknown device or terminal). */
  private specOf(
    end: NonNullable<End>,
    entities: ReadonlyMap<number, World['entities'][number]>,
  ): TerminalMethodSpec | null {
    const termination = end.termination;
    const entity = entities.get(end.entity);
    if (termination === null || entity === undefined) return null;
    const device = this.catalog.device(entity.ref);
    const terminal = device?.terminals.find((t) => t.id === end.terminal);
    return terminal?.methods.find((m) => m.method === termination.method) ?? null;
  }

  /** A termination's draws (ADR 0015, ADR 0018 §6): its `:intermittent` first output and V_arc, cached by id. */
  private drawsOf(seed: number, id: number): { readonly first: number; readonly arcV: number } {
    let draws = this.draws.get(id);
    if (draws === undefined) {
      const key = terminationStreamKey(id);
      draws = {
        first: deriveStream(seed, `${key}:intermittent`).nextU32(),
        arcV: arcVoltageV(deriveStream(seed, `${key}:arcing`).nextU32()),
      };
      this.draws.set(id, draws);
    }
    return draws;
  }

  /** Rebuilds the membership and every member's state from the live bank, tombstones or world bags. */
  private rebuild(world: World): void {
    const previous = {
      count: this.count,
      ids: this.ids,
      tc: this.tc,
      th: this.th,
      hot: this.hot,
      degradation: this.degradation,
      termId: this.termId,
      state: this.state,
      insulationDamaged: this.insulationDamaged,
    };
    const members: { readonly connection: Connection; readonly line: LineStatic }[] = [];
    for (const connection of world.connections) {
      const line = this.lineStatic(connection);
      if (line !== null) members.push({ connection, line });
    }
    members.sort((x, y) => x.connection.id - y.connection.id);
    const n = members.length;
    this.allocate(n);
    const entities = new Map(world.entities.map((e) => [e.id, e]));
    const landed = this.landedCounts(world, entities);
    // The state at tick T is decided for the bucket of T − 1 (the last cadence step's), as every step does.
    const bucket = intermittentBucket(world.tick - 1);
    let j = 0;
    const retire = (index: number) => {
      const id = previous.ids[index];
      if (id < world.nextConnectionId) this.tombstones.set(id, previousBag(previous, index));
    };
    for (let i = 0; i < n; i++) {
      const { connection, line } = members[i];
      const id = connection.id;
      while (j < previous.count && previous.ids[j] < id) retire(j++);
      const live = j < previous.count && previous.ids[j] === id ? j++ : -1;
      const bag = live >= 0 ? null : (this.tombstones.get(id) ?? connection.sim);
      this.tombstones.delete(id);
      this.ids[i] = id;
      this.branch[i] = -1;
      this.kind[i] = line.kind;
      this.rPerM0[i] = line.rPerM0;
      this.alpha[i] = line.alpha;
      this.t0[i] = line.t0;
      this.tLin[i] = line.tLin;
      this.invC[i] = line.invC;
      this.rIns[i] = line.rIns;
      this.outerD[i] = line.outerD;
      this.emissivity[i] = line.emissivity;
      this.kA[i] = line.kA;
      this.clipsOhm[i] = line.clipsOhm;
      this.meltK[i] = line.meltK;
      this.damageK[i] = line.damageK;
      this.rStatic[i] =
        line.lead !== null
          ? (line.lead.resistivityOhmM * (line.lead.lengthMm / 1000)) / line.lead.conductorAreaM2
          : conductorResistanceOhm(line.line, connection.lengthMm ?? 1000, line.t0);
      const loaded = live >= 0 ? previous.tc[live] : (num(bag ?? undefined, 'conductorTempK') ?? AMBIENT);
      // Within [ambient, melting point]: a save from engine 7 before part 2 may hold more than the
      // melting point, and a schema-valid but absurd bag less than ambient, where the linear α model
      // gives a negative resistance (below about 39 K for copper) and an overflowing current a −∞ step.
      // Nothing the engine writes is outside it (never below ambient without a sink, ADR 0018 §12).
      const tc = clampNodeK(loaded, line.meltK);
      this.tc[i] = tc;
      this.insulationDamaged[i] =
        live >= 0 ? previous.insulationDamaged[live] : bag?.['insulationDamaged'] === true ? 1 : 0;
      for (let side = 0; side < 2; side++) {
        const e = 2 * i + side;
        const end = side === 0 ? connection.a : connection.b;
        this.initEnd(e, side, line, end, live, bag, previous, tc, entities, landed, world.seed, bucket);
      }
      this.updateNonlinear(i);
    }
    while (j < previous.count) retire(j++);
    for (const id of [...this.tombstones.keys()]) if (id >= world.nextConnectionId) this.tombstones.delete(id);
    this.connectionsRef = world.connections;
  }

  /**
   * Conductor ends landed per (entity, terminal, method), over every connection end with a termination
   * whose method spec resolves, netlisted or not (the compiler's count, ADR 0015 implementation note 3).
   */
  private landedCounts(
    world: World,
    entities: ReadonlyMap<number, World['entities'][number]>,
  ): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const connection of world.connections) {
      for (const end of [connection.a, connection.b]) {
        if (end === null || end.termination === null || this.specOf(end, entities) === null) continue;
        const key = `${end.entity}:${end.terminal}:${end.termination.method}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** One end's state under ADR 0015's identity rules and ADR 0018 §6 (see the class comment). */
  private initEnd(
    e: number,
    side: number,
    line: LineStatic,
    end: End,
    live: number,
    bag: StateBag | null,
    previous: PreviousState,
    tc: number,
    entities: ReadonlyMap<number, World['entities'][number]>,
    landed: ReadonlyMap<string, number>,
    seed: number,
    bucket: number,
  ): void {
    this.hot[e] = 0;
    this.th[e] = 0;
    this.constriction[e] = 0;
    this.film[e] = 0;
    this.gTerm[e] = 0;
    this.invCh[e] = 0;
    this.rMade[e] = 0;
    this.rateMult[e] = 1;
    this.drawFirst[e] = 0;
    this.arcV[e] = 0;
    this.regime[e] = REGIME_OHMIC;
    const prefix = side === 0 ? 'endA' : 'endB';
    const pe = live >= 0 ? 2 * live + side : -1;
    let state = pe >= 0 ? previous.state[pe] : (STATE_CODE[String(bag?.[`${prefix}State`] ?? 'ok')] ?? END_OK);
    if (line.kind === KIND_LEAD) {
      // A lead's clips have no termination node: its end keys stay initial, except that a fused lead's
      // two states are `intermittentOpen` for good (F3.6 part 2).
      this.degradation[e] = 1;
      this.termId[e] = -1;
      this.state[e] = state === END_INTERMITTENT_OPEN ? END_INTERMITTENT_OPEN : END_OK;
      this.regime[e] = this.state[e] === END_INTERMITTENT_OPEN ? REGIME_OPEN : REGIME_OHMIC;
      return;
    }
    let temp = pe >= 0 ? (previous.hot[pe] === 1 ? previous.th[pe] : null) : num(bag ?? undefined, `${prefix}TempK`);
    let degradation = pe >= 0 ? previous.degradation[pe] : (num(bag ?? undefined, `${prefix}Degradation`) ?? 1);
    let termId = pe >= 0 ? previous.termId[pe] : (num(bag ?? undefined, `${prefix}TerminationId`) ?? -1);
    const termination = end?.termination ?? null;
    if (end !== null && termination !== null) {
      if (termination.id !== termId) {
        // A new termination: the end resets (ADR 0015, ADR 0018 §6); its state is decided for D = 1 below.
        temp = tc;
        degradation = 1;
        termId = termination.id;
      }
      const spec = this.specOf(end, entities);
      const physics = line.physics;
      if (spec !== null && physics !== null) {
        this.hot[e] = 1;
        const th = temp ?? tc;
        this.th[e] = clampNodeK(th, line.meltK);
        this.gTerm[e] = spec.heatPathWPerK;
        this.invCh[e] = 1 / spec.hotSpotHeatCapacityJPerK;
        const landedCount = landed.get(`${end.entity}:${end.terminal}:${termination.method}`) ?? 1;
        const parts = asMadeContactInto(SCRATCH_PARTS, { termination, spec, landedCount }, physics);
        this.rMade[e] = parts.constrictionOhm + parts.filmOhm;
        this.rateMult[e] = degradationRateMultiplier(spec, physics);
        const draws = this.drawsOf(seed, termination.id);
        this.drawFirst[e] = draws.first;
        this.arcV[e] = draws.arcV;
        // The state at the world's tick: the pure function of (D, R_made, the stream, the bucket).
        state = endStateCode(this.rMade[e] * degradation, draws.first, bucket);
        if (this.rMade[e] * degradation >= INTERMITTENT_OHM) {
          this.listed[e] = 1;
          this.list[this.listCount++] = e;
        }
      }
    }
    this.degradation[e] = degradation;
    this.termId[e] = termId;
    this.state[e] = state;
    if (this.hot[e] === 1) this.setRegime(e);
  }

  /** Each member's branch and static contact values in `netlist` (a recompile may have moved them). */
  refresh(netlist: Netlist): void {
    const branches = netlist.branches;
    if (this.memberOfBranch.length !== branches.length) this.memberOfBranch = new Int32Array(branches.length);
    if (this.readableIsland.length !== netlist.islands.length) {
      this.readableIsland = new Uint8Array(netlist.islands.length);
    }
    this.memberOfBranch.fill(-1);
    this.branch.fill(-1);
    this.constriction.fill(0);
    this.film.fill(0);
    // Connection branches come last, in connection-id order (the netlist's canonical order), as the
    // members do: one merge walk.
    let i = 0;
    for (let k = 0; k < branches.length; k++) {
      const element = branches[k].element;
      if (element.kind !== 'connection') continue;
      const id = element.connection;
      while (i < this.count && this.ids[i] < id) i++;
      if (i >= this.count || this.ids[i] !== id) continue;
      this.branch[i] = k;
      this.memberOfBranch[k] = i;
      this.memberIsland[i] = branches[k].island;
      this.memberNodeA[i] = branches[k].a;
      this.memberNodeB[i] = branches[k].b;
      if (this.kind[i] !== KIND_CONDUCTOR) continue;
      const values = branches[k].values;
      this.constriction[2 * i] = values['endAConstrictionOhm'] ?? 0;
      this.film[2 * i] = values['endAFilmOhm'] ?? 0;
      this.constriction[2 * i + 1] = values['endBConstrictionOhm'] ?? 0;
      this.film[2 * i + 1] = values['endBFilmOhm'] ?? 0;
    }
  }

  private allocate(n: number): void {
    this.count = n;
    this.ids = new Int32Array(n);
    this.branch = new Int32Array(n);
    this.memberIsland = new Int32Array(n);
    this.memberNodeA = new Int32Array(n);
    this.memberNodeB = new Int32Array(n);
    this.scratchI2 = new Float64Array(n);
    this.scratchTs = new Float64Array(n);
    this.scratchG = new Float64Array(n);
    this.scratchTc = new Float64Array(n);
    this.kind = new Uint8Array(n);
    this.rStatic = new Float64Array(n);
    this.rPerM0 = new Float64Array(n);
    this.alpha = new Float64Array(n);
    this.t0 = new Float64Array(n);
    this.tLin = new Float64Array(n);
    this.invC = new Float64Array(n);
    this.rIns = new Float64Array(n);
    this.outerD = new Float64Array(n);
    this.emissivity = new Float64Array(n);
    this.kA = new Float64Array(n);
    this.clipsOhm = new Float64Array(n);
    this.meltK = new Float64Array(n);
    this.damageK = new Float64Array(n);
    this.tc = new Float64Array(n);
    this.insulationDamaged = new Uint8Array(n);
    this.nonlinear = new Uint8Array(n);
    this.stampOhm = new Float64Array(n);
    this.stampAmps = new Float64Array(n);
    this.hot = new Uint8Array(2 * n);
    this.th = new Float64Array(2 * n);
    this.degradation = new Float64Array(2 * n);
    this.termId = new Float64Array(2 * n);
    this.state = new Uint8Array(2 * n);
    this.regime = new Uint8Array(2 * n);
    this.constriction = new Float64Array(2 * n);
    this.film = new Float64Array(2 * n);
    this.gTerm = new Float64Array(2 * n);
    this.invCh = new Float64Array(2 * n);
    this.rMade = new Float64Array(2 * n);
    this.rateMult = new Float64Array(2 * n);
    this.drawFirst = new Uint32Array(2 * n);
    this.arcV = new Float64Array(2 * n);
    this.listed = new Uint8Array(2 * n);
    this.list = new Int32Array(2 * n);
    this.listCount = 0;
    this.viewCursor = -1;
    this.pending.fill(0);
  }
}

/** Every (end A, end B) state pair as the compiler's view, by `4 × a + b` (frozen, shared). */
const TOPOLOGY_VIEWS: readonly ConnectionTopologyView[] = Object.freeze(
  Array.from({ length: 16 }, (_, k) =>
    Object.freeze({ endAState: CONNECTION_END_STATES[k >> 2], endBState: CONNECTION_END_STATES[k & 3] }),
  ),
);

/** A loaded node temperature (K) clamped into [ambient, `meltK`] (rebuild only; see `rebuild`). */
function clampNodeK(t: number, meltK: number): number {
  return t > meltK ? meltK : t < AMBIENT ? AMBIENT : t;
}

/** `asMadeContactInto`'s output slot at a rebuild (read at once). */
const SCRATCH_PARTS: ContactParts = { constrictionOhm: 0, filmOhm: 0 };

interface PreviousState {
  readonly count: number;
  readonly ids: Int32Array;
  readonly tc: Float64Array;
  readonly th: Float64Array;
  readonly hot: Uint8Array;
  readonly degradation: Float64Array;
  readonly termId: Float64Array;
  readonly state: Uint8Array;
  readonly insulationDamaged: Uint8Array;
}

/** A retired member's bag (a tombstone), from the arrays it lived in. */
function previousBag(p: PreviousState, i: number): StateBag {
  const end = (e: number, prefix: string) => ({
    [`${prefix}TempK`]: p.hot[e] === 1 ? p.th[e] : null,
    [`${prefix}Degradation`]: p.degradation[e],
    [`${prefix}TerminationId`]: p.termId[e] < 0 ? null : p.termId[e],
    [`${prefix}State`]: CONNECTION_END_STATES[p.state[e]],
  });
  return {
    conductorTempK: p.tc[i],
    ...end(2 * i, 'endA'),
    ...end(2 * i + 1, 'endB'),
    insulationDamaged: p.insulationDamaged[i] === 1,
  };
}
