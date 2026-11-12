import {
  type Catalog,
  CONNECTION_END_STATES,
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
import { AMBIENT_TEMPERATURE_K } from '../constants';
import { SOLVE_INTERVAL_TICKS, TICK_S } from '../engine/constants';
import type { LayerContext } from '../engine/device-model';
import type { AcBranchValues } from '../mna/ac-values';
import type { DcBranchValues } from '../mna/values';
import type { Netlist, NetlistBranch, StateBag } from '../netlist/types';
import { CONNECTION_RESOLVE_MIN_A, CONNECTION_RESOLVE_RELTOL } from './constants';

/*
 * The connection thermal bank (F3.6 part 1, D2, D7, ADR 0018 §3, ADR 0015 "Connection state bags"):
 * the continuous layer of every connection of a known connection kind, leads and conductors, netlisted
 * or not. It owns their ten `sim` keys, stamps each netlisted connection's solve-time value, and
 * integrates its thermal nodes on the fixed absolute schedule.
 *
 * **Nodes.** One lumped conductor node per connection (per metre, so the length cancels): C′ dT_c/dt =
 * I² R′(T_c) − G′(T_c) (T_c − T_a). One hot-spot node per landed conductor end (lead clips have none):
 * C_h dT_h/dt = I² R_end(T_h) − G_fin (T_h − T_c) − G_term (T_h − T_a), with G_fin = √(G′ k A) (the
 * conductor leaving the terminal as a semi-infinite fin, one-way: the hot spot doesn't heat the lumped
 * node) and G_term, C_h from the terminal's method spec.
 *
 * **Schedule.** `continuous` runs only at ticks with t % `SOLVE_INTERVAL_TICKS` = 0 (the engine calls
 * it there), after that tick's cadence solve, by forward Euler over the exact dt = 10 × `TICK_S` =
 * 0.01 s, with the current from the solution at t (zero-order hold). The bags at any tick hold the
 * state after the last scheduled step, so a save anywhere continues identically: no "last integrated"
 * key, never staggered by id.
 *
 * **Stamps.** R = R_cond(T_c) + R_end,a(T_h,a) + R_end,b(T_h,b): R_cond = R_cond(T₀) (1 + α (T_e − T₀)),
 * T_e = min(T_c, T_lin) (the compiler's static value, scaled, so the two agree bit for bit at T₀);
 * R_end = (a (1 + α (T_h − T₀)) + b) · D, with a the constriction part (it carries the metal's α) and b
 * the film part (none), from the compiler's static values; D is the bag's degradation (1 until part 2
 * makes it grow). A lead's is its conductor at its temperature plus its two constant clip contacts.
 *
 * **The 1 % rule.** After a step, a netlisted connection carrying at least `CONNECTION_RESOLVE_MIN_A`
 * whose value moved more than `CONNECTION_RESOLVE_RELTOL` from the one the last solve saw, read back
 * from the solution as |ΔV| / |I| (never a value cached at the solve), asks for a value-only re-solve.
 *
 * **Readings only.** On an island that isn't a reading (unmodelled, mixed, singular, non-converged)
 * the current is unknown, so the connection and its ends are frozen, as the lamp's filament is. A
 * connection that isn't netlisted carries no current and relaxes towards ambient.
 *
 * **Bags (ADR 0015's identity rules).** For a conductor end: an unlanded end's temperature is null and
 * its degradation, state and termination id are kept; a termination whose id equals the bag's
 * `end*TerminationId` continues; any other resets (temperature = the conductor's, degradation 1, the new
 * id, the state decided for D = 1: `ok` until part 2 adds the decision). A landed end whose
 * temperature is null starts at T_c. A conductor whose temperature is null starts at ambient. A
 * lead's end keys stay at their initial values. Deleted connections keep their bags as tombstones
 * while their id can't be reused, so undoing the delete restores them.
 *
 * **Layout.** Struct of arrays, sized at a rebuild (membership or termination change), indexed in
 * connection-id order; a step and a stamp allocate nothing.
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

/** The connection kinds the bank models. */
export const THERMAL_CONNECTION_KINDS: readonly string[] = ['conductor', 'lead'];

/** A connection end's state code: its index in `CONNECTION_END_STATES` (`ok` = 0). */
const STATE_CODE: Readonly<Record<string, number>> = Object.fromEntries(CONNECTION_END_STATES.map((s, i) => [s, i]));

/** Test parameters (ADR 0018 §3.5): a fixed G′ for the linearised goldens, α = 0 for the time constant. */
export interface ConnectionBankOptions {
  /** A fixed conductor conductance to air G′ (W/(m·K)) instead of the surface model. */
  readonly fixedConductanceWPerMK?: number;
  /** Take every temperature coefficient as 0 (the conductor's R and the ends' constriction). */
  readonly zeroAlpha?: boolean;
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
  readonly lead: LeadParams | null;
}

/** One connection's bag in an export (`SimStateExport.connections`). */
export interface ConnectionBagExport {
  readonly id: number;
  readonly state: Record<string, DeviceStateValue>;
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
  private tc = new Float64Array(0);
  private insulationDamaged = new Uint8Array(0);
  /** The solve-time value each `dcValue`/`acValue` wrote (scratch: never read back by the 1 % rule). */
  private stampOhm = new Float64Array(0);
  // Per end (2 × member + 0 for a, + 1 for b).
  private hot = new Uint8Array(0);
  private th = new Float64Array(0);
  private degradation = new Float64Array(0);
  private termId = new Float64Array(0);
  private state = new Uint8Array(0);
  private constriction = new Float64Array(0);
  private film = new Float64Array(0);
  private gTerm = new Float64Array(0);
  private invCh = new Float64Array(0);

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
  private connectionsRef: readonly Connection[] | null = null;
  private readonly statics = new Map<string, LineStatic | null>();
  private readonly tombstones = new Map<number, StateBag>();
  /** A test parameter: a fixed G′ (W/(m·K)), or −1 for the surface model; a slot, so the step reads it unboxed. */
  private readonly fixedG = new Float64Array(1);
  private readonly zeroAlpha: boolean;

  constructor(
    private readonly catalog: Catalog,
    options: ConnectionBankOptions = {},
  ) {
    this.fixedG[0] = options.fixedConductanceWPerMK ?? -1;
    this.zeroAlpha = options.zeroAlpha === true;
  }

  /**
   * Brings the bank up to `world` and `netlist`: rebuilds it when the world's connections changed
   * (membership, an end, a termination: ADR 0015's identity rules), else only refreshes each member's
   * branch and static contact values (a recompile moved them). Allocates (commands and recompiles only).
   */
  sync(world: World, netlist: Netlist): void {
    if (world.connections !== this.connectionsRef) this.rebuild(world);
    this.refresh(netlist);
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

  /** The member netlist branch `branch` belongs to, or −1 (not a connection's, or not a member). */
  memberOf(branch: number): number {
    return branch < this.memberOfBranch.length ? this.memberOfBranch[branch] : -1;
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

  /** Member `i`'s solve-time resistance (Ω) from its current temperatures and degradation (allocates nothing). */
  resistanceOhm(i: number): number {
    this.computeStamp(i);
    return this.stampOhm[i];
  }

  /**
   * Writes member `i`'s solve-time value into `stampOhm[i]`: R_cond(T_c) + each end's
   * (a (1 + α (T_h − T₀)) + b) · D, or a lead's conductor plus its clips. A slot, never a returned
   * double, and no calls: on a per-solve path a double crossing a call V8 doesn't inline is boxed
   * (simulation caveats, "Pass a slot, not a value").
   */
  private computeStamp(i: number): void {
    const alpha = this.alpha[i];
    const t0 = this.t0[i];
    const te = Math.min(this.tc[i], this.tLin[i]);
    let r = this.rStatic[i] * (1 + alpha * (te - t0));
    if (this.kind[i] === KIND_LEAD) {
      r += this.clipsOhm[i];
    } else {
      const a = 2 * i;
      if (this.hot[a] === 1) {
        r += (this.constriction[a] * (1 + alpha * (this.th[a] - t0)) + this.film[a]) * this.degradation[a];
      }
      const b = a + 1;
      if (this.hot[b] === 1) {
        r += (this.constriction[b] * (1 + alpha * (this.th[b] - t0)) + this.film[b]) * this.degradation[b];
      }
    }
    this.stampOhm[i] = r;
  }

  /** `SimDeviceBank.dcValue` for member `i`'s branch. */
  dcValue(i: number, branch: NetlistBranch, values: DcBranchValues): boolean {
    this.computeStamp(i);
    values.resistorAt(branch.index, this.stampOhm, i);
    return true;
  }

  /** `SimDeviceBank.acValue`: purely resistive on AC (ADR 0015). */
  acValue(i: number, branch: NetlistBranch, values: AcBranchValues): boolean {
    this.computeStamp(i);
    values.resistorAt(branch.index, this.stampOhm, i);
    return true;
  }

  /**
   * One scheduled step over [t, t + 10) (the engine calls it only at t % `SOLVE_INTERVAL_TICKS` = 0):
   * forward Euler on every conductor and hot-spot node with the solution at t. Returns whether a
   * netlisted connection's value moved more than 1 % from what the last solve saw.
   *
   * Allocates nothing: one loop over typed arrays with every formula written out, no call but
   * `Math.sqrt`/`Math.min`/`Math.max` (intrinsics) and the void `computeStamp`. G′ is
   * `conductanceToAirOf`'s exact sequence of operations, so the bank and the derived ampacity agree bit
   * for bit (a spec pins it).
   */
  continuous(ctx: LayerContext): boolean {
    const dt = CONNECTION_STEP_S;
    const ta = AMBIENT;
    const ta2 = ta * ta;
    const branches = ctx.solution.branches;
    const nodes = ctx.solution.nodes;
    const fixed = this.fixedG[0];
    const useFixed = fixed >= 0;
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
    const hot = this.hot;
    const thOf = this.th;
    const constriction = this.constriction;
    const film = this.film;
    const degradation = this.degradation;
    const invCh = this.invCh;
    const gTerm = this.gTerm;
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
      tcOf[i] = tc + dt * invC[i] * (i2 * rPerM - g * (tc - ta));
    }
    // 3. Each landed end's hot spot, against T_c before the conductor's own step; G_fin = √(G′ k A).
    for (let i = 0; i < count; i++) {
      const i2 = i2Of[i];
      if (i2 < 0 || kind[i] !== KIND_CONDUCTOR) continue;
      const fin = Math.sqrt(gOf[i] * kA[i]);
      const tc = oldTc[i];
      const alpha = alphaOf[i];
      const t0 = t0Of[i];
      for (let e = 2 * i; e < 2 * i + 2; e++) {
        if (hot[e] !== 1) continue;
        const th = thOf[e];
        const heat = i2 * (constriction[e] * (1 + alpha * (th - t0)) + film[e]) * degradation[e];
        thOf[e] = th + dt * invCh[e] * (heat - fin * (th - tc) - gTerm[e] * (th - ta));
      }
    }
    // 4. The 1 % rule: the resistance the last solve saw, |ΔV| / |I|, read back from the solution (never cached).
    const nodeA = this.memberNodeA;
    const nodeB = this.memberNodeB;
    const stamp = this.stampOhm;
    let resolve = false;
    for (let i = 0; i < count; i++) {
      const i2 = i2Of[i];
      if (branchOf[i] < 0 || i2 <= RESOLVE_MIN_A2) continue;
      const na = nodeA[i];
      const nb = nodeB[i];
      const vr = nodes[2 * na] - nodes[2 * nb];
      const vi = nodes[2 * na + 1] - nodes[2 * nb + 1];
      const solvedOhm = Math.sqrt((vr * vr + vi * vi) / i2);
      this.computeStamp(i);
      const now = stamp[i];
      if (Math.abs(now - solvedOhm) > RESOLVE_RELTOL * now) resolve = true;
    }
    return resolve;
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
      const line = lead === null ? conductorPhysics(this.catalog, device) : leadThermalLine(lead);
      if (line !== undefined) {
        const thermal = conductorThermal(line);
        const zero = this.zeroAlpha;
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
          lead,
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
      this.rStatic[i] =
        line.lead !== null
          ? (line.lead.resistivityOhmM * (line.lead.lengthMm / 1000)) / line.lead.conductorAreaM2
          : conductorResistanceOhm(line.line, connection.lengthMm ?? 1000, line.t0);
      const tc = live >= 0 ? previous.tc[live] : (num(bag ?? undefined, 'conductorTempK') ?? AMBIENT);
      this.tc[i] = tc;
      this.insulationDamaged[i] =
        line.kind === KIND_LEAD
          ? 0
          : live >= 0
            ? previous.insulationDamaged[live]
            : bag?.['insulationDamaged'] === true
              ? 1
              : 0;
      for (let side = 0; side < 2; side++) {
        const e = 2 * i + side;
        this.initEnd(e, side, line.kind, side === 0 ? connection.a : connection.b, live, bag, previous, tc, entities);
      }
    }
    while (j < previous.count) retire(j++);
    for (const id of [...this.tombstones.keys()]) if (id >= world.nextConnectionId) this.tombstones.delete(id);
    this.connectionsRef = world.connections;
  }

  /** One end's state under ADR 0015's identity rules (see the class comment). */
  private initEnd(
    e: number,
    side: number,
    kind: number,
    end: End,
    live: number,
    bag: StateBag | null,
    previous: PreviousState,
    tc: number,
    entities: ReadonlyMap<number, World['entities'][number]>,
  ): void {
    this.hot[e] = 0;
    this.th[e] = 0;
    this.constriction[e] = 0;
    this.film[e] = 0;
    this.gTerm[e] = 0;
    this.invCh[e] = 0;
    if (kind === KIND_LEAD) {
      // A lead's clips have no termination node: its end keys stay at their initial values.
      this.degradation[e] = 1;
      this.termId[e] = -1;
      this.state[e] = 0;
      return;
    }
    const prefix = side === 0 ? 'endA' : 'endB';
    const pe = live >= 0 ? 2 * live + side : -1;
    let temp = pe >= 0 ? (previous.hot[pe] === 1 ? previous.th[pe] : null) : num(bag ?? undefined, `${prefix}TempK`);
    let degradation = pe >= 0 ? previous.degradation[pe] : (num(bag ?? undefined, `${prefix}Degradation`) ?? 1);
    let termId = pe >= 0 ? previous.termId[pe] : (num(bag ?? undefined, `${prefix}TerminationId`) ?? -1);
    let state = pe >= 0 ? previous.state[pe] : (STATE_CODE[String(bag?.[`${prefix}State`] ?? 'ok')] ?? 0);
    const termination = end?.termination ?? null;
    if (end !== null && termination !== null) {
      if (termination.id !== termId) {
        // A new termination: the end resets (ADR 0015, ADR 0018 §6); its state is decided for D = 1.
        temp = tc;
        degradation = 1;
        termId = termination.id;
        state = 0;
      }
      const spec = this.specOf(end, entities);
      if (spec !== null) {
        this.hot[e] = 1;
        this.th[e] = temp ?? tc;
        this.gTerm[e] = spec.heatPathWPerK;
        this.invCh[e] = 1 / spec.hotSpotHeatCapacityJPerK;
      }
    }
    this.degradation[e] = degradation;
    this.termId[e] = termId;
    this.state[e] = state;
  }

  /** Each member's branch and static contact values in `netlist` (a recompile may have moved them). */
  private refresh(netlist: Netlist): void {
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
    this.tc = new Float64Array(n);
    this.insulationDamaged = new Uint8Array(n);
    this.stampOhm = new Float64Array(n);
    this.hot = new Uint8Array(2 * n);
    this.th = new Float64Array(2 * n);
    this.degradation = new Float64Array(2 * n);
    this.termId = new Float64Array(2 * n);
    this.state = new Uint8Array(2 * n);
    this.constriction = new Float64Array(2 * n);
    this.film = new Float64Array(2 * n);
    this.gTerm = new Float64Array(2 * n);
    this.invCh = new Float64Array(2 * n);
  }
}

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
