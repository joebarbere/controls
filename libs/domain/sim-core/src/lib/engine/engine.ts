import { BUILTIN_CATALOG, type Catalog, regionProfile } from '@controls/catalog';
import type { ReplayEntry, World } from '@controls/save-format';
import {
  compareSimEvents,
  encodeSnapshot,
  ISLAND_KIND_AC,
  ISLAND_KIND_DC,
  ISLAND_KIND_EMPTY,
  ISLAND_KIND_MIXED,
  type SimEvent,
  type SimEventKind,
  type SimStateExport,
  snapshotHash,
  snapshotHashedBytes,
  snapshotSlotBytes,
  type SnapshotSource,
} from '@controls/sim-protocol';
import { deriveStream, entityStreamKey } from '@controls/world-model';
import {
  createDcSolution,
  type DcIterationHook,
  type DcSolution,
  DcSolver,
  ISLAND_FLAG_NON_CONVERGED,
  ISLAND_FLAG_SINGULAR,
  islandReferenceNode,
} from '../mna/dc';
import { AcSolver } from '../mna/ac';
import { AC_DEFAULT_VALUES, AC_STAMP_UNSET, AcBranchValues, type AcDefaultValue } from '../mna/ac-values';
import { DC_DEFAULT_VALUES, DcBranchValues, type DcDefaultValue } from '../mna/values';
import { isEmptyNetlist, NetlistCompiler } from '../netlist/compile';
import { BUILTIN_NETLIST_MODELS, type NetlistModels, ownModel } from '../netlist/models';
import type { IslandKind, Netlist, NetlistIsland, StateBag, TerminalRef } from '../netlist/types';
import { SOLVE_INTERVAL_TICKS, TICK_S } from './constants';
import {
  BUILTIN_DEVICE_MODELS,
  type LayerContext,
  type SimDevice,
  type SimDeviceBank,
  type SimDeviceModel,
} from './device-model';

/*
 * The sim clock and engine loop (plan F2.3a, ADR 0011 §2–§4, §9.6): `SimEngine` follows a world bus
 * deterministically. The same engine runs headless (the scripting API's time host, `sim-cli`) and,
 * from F2.3b, in the sim worker; the two differ only in transport.
 *
 * **Time.** Ticks are integers, 1 tick = 1 ms. The state at tick T is the state after every command
 * logged at T so far, before step T's cadence solve. `advanceTo(target)` runs the steps T, T+1, …,
 * target − 1. Step t, over [t, t+1):
 *
 * 1. the electrical layer, if t is a multiple of `SOLVE_INTERVAL_TICKS` (absolute ticks) and nothing
 *    has solved at t yet;
 * 2. the discrete layer, then continuous, then protection, each over every bank (banks in model-kind
 *    order, devices in entity order);
 * 3. if a layer changed the topology (a fuse blew, a breaker tripped), recompile and solve at t+1, in
 *    the same step: the state at t+1 already has the post-trip solution, and the event is at t+1.
 *
 * **Commands.** `applied(entry, world)` takes each logged command at its tick, before that tick's
 * step. If the commanded world changed the netlist (its topology or a value), the engine recompiles
 * and solves at once, so a paused player who flips a switch sees the result at that tick. The engine
 * never reads a command's intent beyond the world it produced: commands never read sim-owned state.
 *
 * **What is persisted.** `exportState()` is every netlisted device's sim bag and the last solution
 * (the solution record, ADR 0011 §9.6), from which `start` continues bit-exactly. Every solve's warm
 * start is that record; banks are rebuilt from bags at every topology change. Nothing else carries
 * over (the factorisation cache never changes results, and tombstones are never persisted).
 *
 * **Honest results.** A singular island, an island the outer loop didn't converge, an island with an
 * element no model can value (unmodelled: the lamp until F2.5) and an AC or mixed island (until F2.2
 * part 2's phasor solver) are never presented as readings: `probe` refuses them, `islands()` says
 * why, and singular and non-converged islands raise sim events on their rising edge.
 */

/** Why a world can't start the engine (ADR 0011 §9.6, `start-failed`). Never a silent re-solve. */
export type SimStartFailure =
  /** The netlist is empty, but the world holds a solution record (ADR 0013's empty-netlist rule). */
  | 'solution-on-empty-netlist'
  /** The record's `topologyHash` isn't the compiled netlist's. */
  | 'topology-mismatch'
  /** The record's node, branch or island counts don't match the compiled netlist. */
  | 'length-mismatch';

/** Thrown by {@link SimEngine.start}: the world's sim state doesn't fit its netlist. Never echoes values. */
export class SimStartError extends Error {
  readonly code = 'start-failed';
  constructor(
    readonly reason: SimStartFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SimStartError';
  }
}

/** The engine was handed something out of step with it: an entry at another tick (a desync). */
export class SimDesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimDesyncError';
  }
}

/** A probe end that names no netlisted terminal. */
export class SimProbeError extends Error {
  readonly code = 'unknown-terminal';
  constructor(readonly end: 'a' | 'b') {
    super(`Probe end ${end} is not a terminal of a netlisted device`);
    this.name = 'SimProbeError';
  }
}

/**
 * Why an island's values are or aren't a reading:
 *
 * - `solved`: a reading;
 * - `singular`: a loop of ideal sources (ADR 0011 §5.3): its zeros are not 0 V;
 * - `nonConverged`: the outer loop hit its cap: values that look real but aren't settled;
 * - `unmodelled`: an element no device model can value yet (the lamp until F2.5): not solved;
 * - `mixed`: DC and AC sources in one island (P2 has no converters): not solved.
 */
export type SimIslandStatus = 'solved' | 'singular' | 'nonConverged' | 'unmodelled' | 'mixed';

/** One island of the current netlist, for scripts, the console and the inspector (F2.6). */
export interface SimIslandInfo {
  readonly index: number;
  readonly kind: IslandKind;
  readonly status: SimIslandStatus;
  /** Entities with a terminal in the island, ascending. */
  readonly entities: readonly number[];
  /** Outer-loop iterations of its last solve; 0 when not solved. */
  readonly iterations: number;
}

/**
 * An ideal, non-loading probe between two terminals (`game.probe`, plan F2.3a): what an ideal
 * voltmeter would read, red on `a`, black on `b`, without being part of the circuit. Only `dc` is a
 * reading; every other kind says why there is none.
 */
export type ProbeReading =
  /** V(a) − V(b), in volts, from the solution at `solvedAt`. */
  | { readonly kind: 'dc'; readonly volts: number; readonly tick: number; readonly solvedAt: number }
  /**
   * An AC island: the phasor V(a) − V(b) = `re` + j·`im` (RMS volts) at the region frequency, and its
   * RMS magnitude `rmsVolts` = |V(a) − V(b)| (what a meter shows by default). No angle is computed
   * here: an angle needs atan2, which D6 keeps out of `sim-core`; the scripting API derives one for
   * display only, and it never enters a hash.
   */
  | {
      readonly kind: 'ac';
      readonly rmsVolts: number;
      readonly re: number;
      readonly im: number;
      readonly frequencyHz: number;
      readonly tick: number;
      readonly solvedAt: number;
    }
  /** The terminals are on different islands: their voltages aren't comparable (no common reference). */
  | { readonly kind: 'floating'; readonly tick: number }
  /** The island is singular: there is no defined reading. */
  | { readonly kind: 'singular'; readonly tick: number; readonly island: number }
  /** The island's outer loop didn't converge: unsettled, never a steady reading. */
  | { readonly kind: 'unsettled'; readonly tick: number; readonly island: number }
  /** The island isn't solved (`unmodelled` or `mixed`). */
  | {
      readonly kind: 'unsolved';
      readonly tick: number;
      readonly island: number;
      readonly reason: 'unmodelled' | 'mixed';
    };

export interface SimEngineOptions {
  /** The device catalogue (default the built-in one). The world registry must use the same one. */
  readonly catalog?: Catalog;
  /** Netlist models (default the built-in ones); tests add synthetic kinds. */
  readonly netlistModels?: NetlistModels;
  /** Engine device models by kind (default {@link BUILTIN_DEVICE_MODELS}); tests add synthetic kinds. */
  readonly deviceModels?: Readonly<Record<string, SimDeviceModel>>;
}

/** Counts, for tests and diagnostics: never part of any result. */
export interface SimEngineStats {
  /** Cadence solves (step 1). */
  cadenceSolves: number;
  /** Solves after a command changed the netlist. */
  commandSolves: number;
  /** Solves after a layer changed the topology (a trip), in the same step. */
  layerSolves: number;
  /** The start's solve (a world with `sim: null`). */
  startSolves: number;
  /** Banks built (each topology change rebuilds them). */
  bankBuilds: number;
}

interface Bank {
  readonly kind: string;
  readonly model: SimDeviceModel;
  readonly bank: SimDeviceBank;
  readonly entities: readonly number[];
}

/** A netlisted device: its bank and its index there, or carried (no engine model: its bag as loaded). */
type DeviceSlot = { readonly bank: Bank; readonly index: number } | { readonly bank: null; readonly bag: StateBag };

const KIND_CODES: Readonly<Record<IslandKind, number>> = {
  empty: ISLAND_KIND_EMPTY,
  dc: ISLAND_KIND_DC,
  ac: ISLAND_KIND_AC,
  mixed: ISLAND_KIND_MIXED,
};

const terminalKey = (ref: TerminalRef): string => `${ref.entity}:${ref.terminal}`;

/** The headless sim engine. Start it with {@link SimEngine.start}. */
export class SimEngine {
  readonly stats: SimEngineStats = {
    cadenceSolves: 0,
    commandSolves: 0,
    layerSolves: 0,
    startSolves: 0,
    bankBuilds: 0,
  };
  private readonly catalog: Catalog;
  private readonly deviceModels: Readonly<Record<string, SimDeviceModel>>;
  private readonly compiler: NetlistCompiler;
  private readonly solver = new DcSolver();
  private world: World;
  private current: Netlist;
  private tickNow: number;
  private lastSolve = -1;
  /** Whether `solution` holds a solve of `current` (false only for an empty netlist). */
  private solved = false;
  private solution: DcSolution;
  private spare: DcSolution;
  private values: DcBranchValues;
  private acValues: AcBranchValues;
  private readonly acSolver = new AcSolver();
  /** The region's supply frequency (`RegionProfile.frequencyHz`, 60 Hz for NEC): the AC islands' analysis frequency. */
  private readonly frequencyHz: number;
  /** Whether the current netlist has an `ac` island (so a solve runs the phasor solver too). */
  private hasAc = false;
  private generation = 0;
  private revisionCount = 0;
  // Devices and banks (rebuilt at every topology change).
  private discreteBanks: SimDeviceBank[] = [];
  private continuousBanks: SimDeviceBank[] = [];
  private protectionBanks: SimDeviceBank[] = [];
  private devices = new Map<number, DeviceSlot>();
  private readonly tombstones = new Map<number, StateBag>();
  // Per branch: the bank and device index that values it, and the kind's default.
  private branchBank: (SimDeviceBank | null)[] = [];
  private branchDevice = new Int32Array(0);
  private branchDefault: (DcDefaultValue | undefined)[] = [];
  private branchAcDefault: (AcDefaultValue | undefined)[] = [];
  // Per island: unmodelled, the entities, the flags of the last solve, and the snapshot's arrays.
  private unmodelled = new Uint8Array(0);
  private islandEntities: (readonly number[])[] = [];
  private previousFlags = new Uint8Array(0);
  private islandKinds = new Uint8Array(0);
  private islandFlags = new Uint8Array(0);
  private islandIterations = new Uint16Array(0);
  private islandReferences = new Int32Array(0);
  private islandUnknowns = new Uint32Array(0);
  private islandBands = new Uint8Array(0);
  private readonly nodeOf = new Map<string, number>();
  // Device records in the snapshot: per record, its bank, device index and byte offset.
  private records: { readonly bank: SimDeviceBank; readonly index: number; readonly offset: number }[] = [];
  private deviceDataBytes = 0;
  private slot = new Uint8Array(0);
  private events: SimEvent[] = [];
  private readonly ctx: {
    tick: number;
    dtS: number;
    netlist: Netlist;
    solution: DcSolution;
    islandReadable(island: number): boolean;
    emit: LayerContext['emit'];
  };
  private readonly hook: DcIterationHook;
  private readonly nonlinear: { hook: DcIterationHook; warmStart: DcSolution | null };
  private readonly simOf = (entity: number): StateBag | undefined => this.liveBag(entity);

  private constructor(world: World, options: SimEngineOptions) {
    this.catalog = options.catalog ?? BUILTIN_CATALOG;
    this.deviceModels = options.deviceModels ?? BUILTIN_DEVICE_MODELS;
    this.compiler = new NetlistCompiler(this.catalog, { models: options.netlistModels ?? BUILTIN_NETLIST_MODELS });
    this.world = world;
    this.tickNow = world.tick;
    // The world's sim bags are what was materialised: right at a start (CompileOptions.sim falls back to them).
    this.current = this.compiler.compile(world, { sim: this.simOf });
    this.solution = createDcSolution(this.current);
    this.spare = createDcSolution(this.current);
    this.values = new DcBranchValues(this.current.branches.length);
    this.acValues = new AcBranchValues(this.current.branches.length);
    this.frequencyHz = regionProfile(world.regionId).frequencyHz.value;
    this.hook = (island, iterate, values) => {
      const netlist = this.current;
      const branches = island.branches;
      for (let i = 0; i < branches.length; i++) {
        const index = branches[i];
        const bank = this.branchBank[index];
        if (bank?.iterate !== undefined)
          bank.iterate(this.branchDevice[index], netlist.branches[index], iterate, values);
      }
    };
    this.nonlinear = { hook: this.hook, warmStart: null };
    this.ctx = {
      tick: this.tickNow,
      dtS: TICK_S.value,
      netlist: this.current,
      solution: this.solution,
      islandReadable: (island) => this.readable(island),
      emit: (kind, entity, detail = {}) => this.emit(kind, entity, [], detail, this.ctx.tick + 1),
    };
    this.rebuild();
  }

  /**
   * Starts the engine on a (validated, materialised) world: its devices' sim bags and its solution
   * record are the state to continue from. With `sim: null` and a non-empty netlist it solves at the
   * world's tick; with a record, it adopts it after checking it against the compiled netlist. Throws a
   * {@link SimStartError} when the record doesn't fit (ADR 0011 §9.6): never a silent re-solve.
   */
  static start(world: World, options: SimEngineOptions = {}): SimEngine {
    const engine = new SimEngine(world, options);
    engine.adopt(world.sim);
    return engine;
  }

  /** The engine's tick: the state after every command applied at it, before its cadence solve. */
  get tick(): number {
    return this.tickNow;
  }

  /** The tick of the solution the engine holds; −1 when it holds none (an empty netlist). */
  get lastSolveTick(): number {
    return this.solved ? this.lastSolve : -1;
  }

  /** The current netlist. Read-only. */
  get netlist(): Netlist {
    return this.current;
  }

  /** Counts topology changes since this engine started (unhashed; the descriptor joins on it, F2.3b). */
  get topologyGeneration(): number {
    return this.generation;
  }

  /** Changes whenever the engine's state may have changed: a cache key for hashes and exports. */
  get revision(): number {
    return this.revisionCount;
  }

  /**
   * Runs every step from the current tick up to `tick` (exclusive), so the engine is at the start of
   * `tick`. A no-op for the current tick; a `RangeError` for an unsafe or earlier tick.
   */
  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick)) throw new RangeError(`advanceTo needs a safe integer tick, got ${tick}`);
    if (tick < this.tickNow) throw new RangeError(`advanceTo(${tick}) is before the engine's tick ${this.tickNow}`);
    if (tick === this.tickNow) return;
    while (this.tickNow < tick) this.step(this.tickNow);
    this.revisionCount++;
  }

  /**
   * A logged command ran at the engine's tick and produced `world` (the bus's new state). Recompiles
   * and solves at once if the netlist changed. Throws a {@link SimDesyncError} for an entry at another
   * tick: the host must advance the engine to an entry's tick first.
   */
  applied(entry: ReplayEntry, world: World): void {
    if (entry.tick !== this.tickNow || world.tick !== this.tickNow) {
      throw new SimDesyncError(`Entry ${entry.seq} is at tick ${entry.tick}; the engine is at tick ${this.tickNow}`);
    }
    if (world === this.world) return;
    this.world = world;
    this.revisionCount++;
    if (this.recompile()) this.solve(this.tickNow, 'command');
  }

  /** The sim-owned state to materialise into the world at this tick (ADR 0011 §4, §9.6). */
  exportState(): SimStateExport {
    const entities = this.current.devices.map((device) => ({
      id: device.entity,
      state: { ...this.liveBag(device.entity) },
    }));
    const s = this.solution;
    const solution =
      this.solved && !isEmptyNetlist(this.current)
        ? {
            lastSolveTick: this.lastSolve,
            topologyHash: this.current.topologyHash,
            nodes: Array.from(s.nodes),
            branches: Array.from(s.branches),
            islands: s.islands.map((island) => ({ flags: island.flags, iterations: island.iterations })),
          }
        : null;
    return { tick: this.tickNow, entities, solution };
  }

  /** The snapshot at this tick: a copy of its hashed bytes (ADR 0011 §5.2, `game.snapshot()`). */
  snapshot(): Uint8Array {
    return this.encode().slice();
  }

  /** SHA-256 of the snapshot's hashed bytes (`snapshotHash`), lower-case hex. */
  snapshotHash(): string {
    return snapshotHash(this.encode());
  }

  /** Events since the last call, in delivery order (tick, entity, kind). Never in any hash. */
  takeEvents(): SimEvent[] {
    const events = this.events;
    this.events = [];
    return events.sort(compareSimEvents);
  }

  /** Every island of the current netlist and whether its values are a reading. */
  islands(): SimIslandInfo[] {
    return this.current.islands.map((island) => ({
      index: island.index,
      kind: island.kind,
      status: this.status(island.index),
      entities: this.islandEntities[island.index],
      iterations: this.solution.islands[island.index].iterations,
    }));
  }

  /**
   * An ideal, non-loading probe from terminal `a` to `b` (see {@link ProbeReading}). Throws a
   * {@link SimProbeError} for an end that isn't a terminal of a netlisted device.
   */
  probe(a: TerminalRef, b: TerminalRef): ProbeReading {
    const na = this.nodeOf.get(terminalKey(a));
    if (na === undefined) throw new SimProbeError('a');
    const nb = this.nodeOf.get(terminalKey(b));
    if (nb === undefined) throw new SimProbeError('b');
    const tick = this.tickNow;
    const island = this.current.nodes[na].island;
    if (this.current.nodes[nb].island !== island) return { kind: 'floating', tick };
    const status = this.status(island);
    switch (status) {
      case 'solved': {
        const nodes = this.solution.nodes;
        const re = nodes[2 * na] - nodes[2 * nb] + 0;
        if (this.current.islands[island].kind !== 'ac')
          return { kind: 'dc', volts: re, tick, solvedAt: this.lastSolve };
        const im = nodes[2 * na + 1] - nodes[2 * nb + 1] + 0;
        const rmsVolts = Math.sqrt(re * re + im * im);
        return { kind: 'ac', rmsVolts, re, im, frequencyHz: this.frequencyHz, tick, solvedAt: this.lastSolve };
      }
      case 'singular':
        return { kind: 'singular', tick, island };
      case 'nonConverged':
        return { kind: 'unsettled', tick, island };
      default:
        return { kind: 'unsolved', tick, island, reason: status };
    }
  }

  // --- the loop -------------------------------------------------------------------------------

  private step(t: number): void {
    if (t % SOLVE_INTERVAL_TICKS.value === 0 && this.lastSolve !== t) this.solve(t, 'cadence');
    const ctx = this.ctx;
    ctx.tick = t;
    ctx.netlist = this.current;
    ctx.solution = this.solution;
    // Indexed loops over preallocated arrays: a step allocates nothing (no iterators, no closures).
    let topologyChanged = false;
    const discrete = this.discreteBanks;
    for (let i = 0; i < discrete.length; i++) {
      if ((discrete[i].discrete as (c: LayerContext) => boolean)(ctx)) topologyChanged = true;
    }
    const continuous = this.continuousBanks;
    for (let i = 0; i < continuous.length; i++) (continuous[i].continuous as (c: LayerContext) => void)(ctx);
    const protection = this.protectionBanks;
    for (let i = 0; i < protection.length; i++) {
      if ((protection[i].protection as (c: LayerContext) => boolean)(ctx)) topologyChanged = true;
    }
    this.tickNow = t + 1;
    if (topologyChanged && this.recompile()) this.solve(t + 1, 'layer');
  }

  /** Recompiles the commanded world with the live sim state; true if the netlist changed. */
  private recompile(): boolean {
    const next = this.compiler.compile(this.world, { sim: this.simOf });
    if (next === this.current) return false;
    const structural = next.nodes !== this.current.nodes || next.devices !== this.current.devices;
    const previousFlags = structural ? this.flagsByEntity() : null;
    this.current = next;
    if (structural) {
      this.rebuild();
      this.solution = createDcSolution(next);
      this.spare = createDcSolution(next);
      this.values = new DcBranchValues(next.branches.length);
      this.acValues = new AcBranchValues(next.branches.length);
      this.solved = false;
      // A flag rises only if no island these devices were in before the change already had it (a merge
      // or a split of a singular island isn't a new loop).
      next.islands.forEach((island) => {
        let flags = 0;
        for (const entity of this.islandEntities[island.index]) flags |= previousFlags?.get(entity) ?? 0;
        this.previousFlags[island.index] = flags;
      });
      this.generation++;
    }
    return true;
  }

  /** Each entity's island's flags, for judging rising edges across a topology change. */
  private flagsByEntity(): Map<number, number> {
    const flags = new Map<number, number>();
    for (const island of this.current.islands) {
      for (const entity of this.islandEntities[island.index]) flags.set(entity, this.previousFlags[island.index]);
    }
    return flags;
  }

  private adopt(record: World['sim']): void {
    const netlist = this.current;
    if (record === null) {
      if (!isEmptyNetlist(netlist)) this.solve(this.tickNow, 'start');
      return;
    }
    if (isEmptyNetlist(netlist)) {
      throw new SimStartError(
        'solution-on-empty-netlist',
        'The world holds a solution record but its netlist is empty',
      );
    }
    if (record.topologyHash !== netlist.topologyHash) {
      throw new SimStartError('topology-mismatch', "The solution record's topologyHash isn't the world's netlist's");
    }
    if (
      record.nodes.length !== 2 * netlist.nodes.length ||
      record.branches.length !== 2 * netlist.branches.length ||
      record.islands.length !== netlist.islands.length
    ) {
      throw new SimStartError('length-mismatch', "The solution record's sizes don't match the world's netlist");
    }
    const s = this.solution;
    s.nodes.set(record.nodes);
    s.branches.set(record.branches);
    for (const island of netlist.islands) {
      const { flags, iterations } = record.islands[island.index];
      const result = s.islands[island.index];
      result.solved = iterations > 0;
      result.flags = flags;
      result.iterations = iterations;
      result.referenceNode = islandReferenceNode(netlist, island);
      result.unknowns = this.unknownsOf(island, iterations > 0);
      this.previousFlags[island.index] = flags;
    }
    this.lastSolve = record.lastSolveTick;
    this.solved = true;
  }

  /** The order of an island's MNA system (as the solver lays it out), or 0 when it isn't solved. */
  private unknownsOf(island: NetlistIsland, solved: boolean): number {
    if (!solved) return 0;
    let sources = 0;
    const branches = island.branches;
    for (let i = 0; i < branches.length; i++) if (this.current.branches[branches[i]].kind === 'vsource') sources++;
    return island.nodes.length - 1 + sources;
  }

  private solve(tick: number, why: 'cadence' | 'command' | 'layer' | 'start'): void {
    const netlist = this.current;
    if (isEmptyNetlist(netlist)) {
      this.solved = false;
      return;
    }
    this.fillValues();
    const warmStart = this.solved ? this.solution : null;
    // One options object for every solve (no allocation per cadence solve): only its warm start moves.
    this.nonlinear.warmStart = warmStart;
    const next = this.solver.solveNonlinear(netlist, this.values, this.nonlinear, this.spare);
    // Then the AC islands, into the same record: the DC solve left them zeroed and unsolved, and the
    // phasor solver writes only `ac` islands (mixed islands stay unsolved: P2 has no converters).
    if (this.hasAc) this.acSolver.solve(netlist, this.acValues, this.frequencyHz, next);
    // Indexed loops throughout: a cadence solve allocates nothing of the engine's own.
    const islands = netlist.islands;
    for (let k = 0; k < islands.length; k++) {
      const island = islands[k];
      const result = next.islands[island.index];
      if (this.unmodelled[island.index] === 1) {
        // Placeholder values only kept the solver going: nothing here is a reading.
        const nodes = island.nodes;
        for (let i = 0; i < nodes.length; i++) next.nodes[2 * nodes[i]] = next.nodes[2 * nodes[i] + 1] = 0;
        const branches = island.branches;
        for (let i = 0; i < branches.length; i++)
          next.branches[2 * branches[i]] = next.branches[2 * branches[i] + 1] = 0;
        result.solved = false;
        result.flags = 0;
        result.iterations = 0;
      }
      result.unknowns = this.unknownsOf(island, result.iterations > 0);
    }
    this.spare = this.solution;
    this.solution = next;
    this.solved = true;
    this.lastSolve = tick;
    this.revisionCount++;
    if (why === 'cadence') this.stats.cadenceSolves++;
    else if (why === 'command') this.stats.commandSolves++;
    else if (why === 'layer') this.stats.layerSolves++;
    else this.stats.startSolves++;
    // Island events on the rising edge of their flags (ADR 0011 §4).
    for (let k = 0; k < islands.length; k++) {
      const island = islands[k];
      const flags = next.islands[island.index].flags;
      const rising = flags & ~this.previousFlags[island.index];
      const entities = this.islandEntities[island.index];
      if ((rising & ISLAND_FLAG_SINGULAR) !== 0) this.emit('singular', null, entities, {}, tick);
      if ((rising & ISLAND_FLAG_NON_CONVERGED) !== 0) this.emit('nonConverged', null, entities, {}, tick);
      this.previousFlags[island.index] = flags;
    }
  }

  /** Every DC island's branch values: a bank's, else the kind's default, else a placeholder (unmodelled). */
  private fillValues(): void {
    const netlist = this.current;
    const values = this.values;
    values.clear();
    const islands = netlist.islands;
    for (let k = 0; k < islands.length; k++) {
      const island = islands[k];
      this.unmodelled[island.index] = 0;
      if (island.kind === 'ac') {
        this.fillAcValues(island);
        continue;
      }
      if (island.kind !== 'dc' && island.kind !== 'empty') continue;
      const branches = island.branches;
      for (let i = 0; i < branches.length; i++) {
        const index = branches[i];
        const branch = netlist.branches[index];
        const bank = this.branchBank[index];
        if (bank?.dcValue !== undefined && bank.dcValue(this.branchDevice[index], branch, values)) {
          if (values.stamps[index] === 0)
            throw new Error(`A device model returned true for branch ${index} without a value`);
          continue;
        }
        const fallback = this.branchDefault[index];
        if (fallback !== undefined) {
          fallback(branch, values);
          continue;
        }
        // No model can value it: keep the solver going with a harmless stamp, then discard the island.
        if (branch.kind === 'vsource') values.isource(index, 0);
        else values.resistor(index, 1);
        this.unmodelled[island.index] = 1;
      }
    }
  }

  /** An AC island's phasor values: a bank's, else the kind's default (a lead), else unmodelled. */
  private fillAcValues(island: NetlistIsland): void {
    const netlist = this.current;
    const values = this.acValues;
    const branches = island.branches;
    for (let i = 0; i < branches.length; i++) {
      const index = branches[i];
      const branch = netlist.branches[index];
      values.stamps[index] = AC_STAMP_UNSET;
      const bank = this.branchBank[index];
      if (bank?.acValue !== undefined && bank.acValue(this.branchDevice[index], branch, values)) {
        if (values.stamps[index] === AC_STAMP_UNSET) {
          throw new Error(`A device model returned true for AC branch ${index} without a value`);
        }
        continue;
      }
      const fallback = this.branchAcDefault[index];
      if (fallback !== undefined) {
        fallback(branch, values);
        continue;
      }
      // No model can value it: a harmless stamp keeps the phasor solver going, then the island is discarded.
      if (branch.kind === 'vsource') values.vsource(index, 0, 0, 1);
      else values.resistor(index, 1);
      this.unmodelled[island.index] = 1;
    }
  }

  private readable(island: number): boolean {
    return this.status(island) === 'solved';
  }

  /**
   * From the netlist and the solution record alone, so a loaded engine says what a straight run says:
   * a DC island that wasn't solved (0 iterations) had an element no model could value.
   */
  private status(island: number): SimIslandStatus {
    const kind = this.current.islands[island].kind;
    if (kind === 'mixed') return 'mixed';
    const result = this.solution.islands[island];
    if (result.iterations === 0) return 'unmodelled';
    const flags = result.flags;
    if ((flags & ISLAND_FLAG_SINGULAR) !== 0) return 'singular';
    if ((flags & ISLAND_FLAG_NON_CONVERGED) !== 0) return 'nonConverged';
    return 'solved';
  }

  private emit(
    kind: SimEventKind,
    entity: number | null,
    entities: readonly number[],
    detail: Readonly<Record<string, number | string | boolean>>,
    tick: number,
  ): void {
    this.events.push({ tick, kind, entity, entities, detail: { ...detail } });
  }

  // --- devices --------------------------------------------------------------------------------

  /** A device's live sim bag: its bank's, its carried bag, or (deleted, then reinserted) its tombstone. */
  private liveBag(entity: number): StateBag | undefined {
    const slot = this.devices.get(entity);
    if (slot !== undefined) return slot.bank === null ? slot.bag : slot.bank.bank.bag(slot.index);
    return entity < this.world.nextEntityId ? this.tombstones.get(entity) : undefined;
  }

  /**
   * Rebuilds the banks and the per-branch and per-island tables for the current netlist (at the start
   * and after every structural change), carrying each device's state through its bag:
   *
   * - a device that stays keeps its live bag;
   * - a device that leaves is kept as a tombstone if its id can't be reused (`id < nextEntityId`: it was
   *   deleted, so undoing the delete restores it, a blown fuse still blown); one whose `entity.place`
   *   was undone is dropped (ADR 0011 §3). Tombstones are never persisted;
   * - a device that arrives takes its tombstone, else the world's bag (a new device's initial values,
   *   or what a load materialised).
   */
  private rebuild(): void {
    const netlist = this.current;
    const world = this.world;
    const live = new Map<number, StateBag>();
    for (const [entity] of this.devices) live.set(entity, this.liveBag(entity) as StateBag);
    const present = new Set(netlist.devices.map((d) => d.entity));
    for (const [entity, bag] of live) if (!present.has(entity)) this.tombstones.set(entity, bag);
    for (const entity of [...this.tombstones.keys()]) if (entity >= world.nextEntityId) this.tombstones.delete(entity);

    const entities = new Map(world.entities.map((e) => [e.id, e]));
    const byKind = new Map<string, SimDevice[]>();
    const devices = new Map<number, DeviceSlot>();
    const branchesOf = new Map<number, number[]>();
    for (const branch of netlist.branches) {
      if (branch.element.kind !== 'entity') continue;
      let list = branchesOf.get(branch.element.entity);
      if (list === undefined) branchesOf.set(branch.element.entity, (list = []));
      list.push(branch.index);
    }
    for (const device of netlist.devices) {
      const entity = entities.get(device.entity) as World['entities'][number];
      const bag = live.get(device.entity) ?? this.tombstones.get(device.entity) ?? entity.sim;
      this.tombstones.delete(device.entity);
      const model = ownModel(this.deviceModels, device.kind);
      if (model === undefined) {
        devices.set(device.entity, { bank: null, bag });
        continue;
      }
      const params = (this.catalog.device(entity.ref) as NonNullable<ReturnType<Catalog['device']>>).model.params;
      const seed = world.seed;
      const id = device.entity;
      let list = byKind.get(device.kind);
      if (list === undefined) byKind.set(device.kind, (list = []));
      list.push({
        entity: id,
        params,
        bag,
        branches: branchesOf.get(id) ?? [],
        stream: () => deriveStream(seed, entityStreamKey(id)),
      });
    }

    const banks: Bank[] = [];
    for (const kind of [...byKind.keys()].sort()) {
      const list = byKind.get(kind) as SimDevice[];
      const model = ownModel(this.deviceModels, kind) as SimDeviceModel;
      const bank: Bank = { kind, model, bank: model.bank(list), entities: list.map((d) => d.entity) };
      banks.push(bank);
      bank.entities.forEach((entity, index) => devices.set(entity, { bank, index }));
      this.stats.bankBuilds++;
    }
    this.devices = devices;
    this.discreteBanks = banks.filter((b) => b.bank.discrete !== undefined).map((b) => b.bank);
    this.continuousBanks = banks.filter((b) => b.bank.continuous !== undefined).map((b) => b.bank);
    this.protectionBanks = banks.filter((b) => b.bank.protection !== undefined).map((b) => b.bank);

    const branchCount = netlist.branches.length;
    this.branchBank = new Array<SimDeviceBank | null>(branchCount).fill(null);
    this.branchDevice = new Int32Array(branchCount);
    this.branchDefault = netlist.branches.map((branch) => ownModel(DC_DEFAULT_VALUES, branch.model));
    this.branchAcDefault = netlist.branches.map((branch) => ownModel(AC_DEFAULT_VALUES, branch.model));
    this.hasAc = netlist.islands.some((island) => island.kind === 'ac');
    for (const branch of netlist.branches) {
      if (branch.element.kind !== 'entity') continue;
      const slot = devices.get(branch.element.entity);
      if (slot === undefined || slot.bank === null) continue;
      this.branchBank[branch.index] = slot.bank.bank;
      this.branchDevice[branch.index] = slot.index;
    }

    const islandCount = netlist.islands.length;
    this.unmodelled = new Uint8Array(islandCount);
    this.previousFlags = new Uint8Array(islandCount);
    this.islandKinds = new Uint8Array(netlist.islands.map((island) => KIND_CODES[island.kind]));
    this.islandFlags = new Uint8Array(islandCount);
    this.islandIterations = new Uint16Array(islandCount);
    this.islandReferences = new Int32Array(islandCount);
    this.islandUnknowns = new Uint32Array(islandCount);
    this.islandBands = new Uint8Array(islandCount);
    this.islandEntities = netlist.islands.map((island) => {
      const members = new Set<number>();
      for (const node of island.nodes) for (const member of netlist.nodes[node].members) members.add(member.entity);
      return Object.freeze([...members].sort((x, y) => x - y));
    });
    this.nodeOf.clear();
    for (const node of netlist.nodes)
      for (const member of node.members) this.nodeOf.set(terminalKey(member), node.index);

    const records: { bank: SimDeviceBank; index: number; offset: number }[] = [];
    let offset = 0;
    for (const device of netlist.devices) {
      const slot = devices.get(device.entity);
      if (slot === undefined || slot.bank === null || slot.bank.model.output === null) continue;
      records.push({ bank: slot.bank.bank, index: slot.index, offset });
      offset += slot.bank.model.output.recordBytes;
    }
    this.records = records;
    this.deviceDataBytes = offset;
  }

  // --- the snapshot ---------------------------------------------------------------------------

  /** Encodes the snapshot at this tick into the reusable slot and returns a view of its hashed bytes. */
  private encode(): Uint8Array {
    const netlist = this.current;
    const s = this.solution;
    // An empty netlist has no islands, so every island here has been solved or adopted.
    for (const island of netlist.islands) {
      const i = island.index;
      const result = s.islands[i];
      const solved = result.iterations > 0;
      this.islandFlags[i] = result.flags;
      this.islandIterations[i] = result.iterations;
      this.islandReferences[i] = solved ? islandReferenceNode(netlist, island) : -1;
      this.islandUnknowns[i] = result.unknowns;
    }
    const source: SnapshotSource = {
      topologyGeneration: this.generation,
      tick: this.tickNow,
      // Only an exported solution's tick: with none (an empty netlist), 0, as a loaded engine has.
      lastSolveTick: this.solved ? this.lastSolve : 0,
      topologyHash: netlist.topologyHash,
      nodeCount: netlist.nodes.length,
      branchCount: netlist.branches.length,
      nodes: s.nodes,
      branches: s.branches,
      islandCount: netlist.islands.length,
      islandKinds: this.islandKinds,
      islandFlags: this.islandFlags,
      islandIterations: this.islandIterations,
      islandReferences: this.islandReferences,
      islandUnknowns: this.islandUnknowns,
      islandBands: this.islandBands,
      deviceCount: this.records.length,
      deviceDataBytes: this.deviceDataBytes,
      writeDevices: (view, base) => {
        const ctx = this.ctx;
        ctx.tick = this.tickNow;
        ctx.netlist = netlist;
        ctx.solution = s;
        for (const record of this.records) record.bank.writeRecord?.(record.index, view, base + record.offset, ctx);
      },
    };
    const bytes = snapshotSlotBytes(source);
    if (this.slot.byteLength < bytes) this.slot = new Uint8Array(bytes);
    encodeSnapshot(source, this.slot);
    return snapshotHashedBytes(this.slot);
  }
}
