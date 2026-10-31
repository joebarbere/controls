import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import { createGame } from '@controls/scripting-api';
import {
  compileNetlist,
  type DcBranchValues,
  dcBranchValues,
  type DcSolution,
  DcSolver,
  type Netlist,
  type NetlistBranch,
  NetlistCompiler,
  SimEngine,
} from '@controls/sim-core';
import type { BenchCalibration, BenchCase, PendingBenchCase } from './bench';
import { CALIBRATION_REFERENCE_MS, runCalibration } from './calibration';
import { buildPlant, type Plant } from './plant';
import {
  bytesPerRead,
  READ_ALLOCATION_GATE_BYTES,
  READ_PLANT,
  snapshotReadRig,
  type SnapshotReadRig,
} from './snapshot-read';

/*
 * The cases `sim bench` runs (plan F2.7). Add a case here with a `budgetMs` and the gate enforces it.
 * Budgets come only from the spec (§4.5 and §4.9), never from a measurement: a case the spec gives no
 * budget for reports its timing with `budgetMs: null`.
 *
 * The netlist cases have no budget of their own. Compiling is only a part of §4.5's re-solve after a
 * topology change (2 ms for a 2,000-node plant, compile and solve together), so its budget belongs to
 * the re-solve case, which is gated against it as scaled by the calibration loop (F2.2 part 3b, see
 * calibration.ts). The per-tick case (F2.3a) is gated.
 */

/** Spec §4.5: a 2,000-node re-solve after a topology change, on the reference machine. */
const RESOLVE_BUDGET_MS = 2;

/** The re-solve gate's calibration (calibration.ts): its budget is scaled by this loop's speed here. */
const CALIBRATION: BenchCalibration = {
  name: 'calibration-loop',
  referenceMs: CALIBRATION_REFERENCE_MS.value,
  run: runCalibration,
};

let plant: { readonly plant: Plant; readonly closed: World; readonly open: World } | null = null;

/** The 2,000-node plant and its toggle pair, built once on first use (not at import: every `sim` run imports this). */
function plantWorlds() {
  if (plant === null) {
    const built = buildPlant();
    const open: World = {
      ...built.world,
      entities: built.world.entities.map((entity) =>
        entity.id === built.toggleSwitch ? { ...entity, state: { closed: false } } : entity,
      ),
    };
    plant = { plant: built, closed: built.world, open };
  }
  return plant;
}

function checksum(netlist: Netlist): string {
  return `${netlist.nodes.length}:${netlist.branches.length}:${netlist.islands.length}:${netlist.topologyHash}`;
}

let toggleCompiler: NetlistCompiler | null = null;

/**
 * The lamps' DC value until F2.5's filament R(T) exists: the 12 V 5 W lamp's hot resistance,
 * V² / P = 144 / 5 = 28.8 Ω, a fixed placeholder so the plant solves. The solve's cost doesn't depend
 * on the value.
 */
function lampAtRatedPower(branch: NetlistBranch, values: DcBranchValues): boolean {
  if (branch.model !== 'lamp.incandescent') return false;
  values.resistor(branch.index, 28.8);
  return true;
}

function solutionChecksum(netlist: Netlist, solution: DcSolution): string {
  // A digest of the result that is cheap to form: the island flags and a sum of the node voltages.
  let sum = 0;
  for (let i = 0; i < solution.nodes.length; i += 2) sum += solution.nodes[i];
  return `${checksum(netlist)}:${solution.islands.map((island) => island.flags).join('')}:${sum}`;
}

/** The re-solve cases' state: a compiler, a solver (with its factorisation cache) and value storage. */
interface Resolver {
  readonly compiler: NetlistCompiler;
  readonly solver: DcSolver;
  values: DcBranchValues | undefined;
}
let warmResolver: Resolver | null = null;
let coldResolver: Resolver | null = null;
const newResolver = (): Resolver => ({
  compiler: new NetlistCompiler(BUILTIN_CATALOG),
  solver: new DcSolver(),
  values: undefined,
});

/** Compiles `world` incrementally and solves it: what the engine does after a topology change. */
function resolve(resolver: Resolver, world: World): string {
  const netlist = resolver.compiler.compile(world);
  resolver.values = dcBranchValues(netlist, lampAtRatedPower, resolver.values);
  return solutionChecksum(netlist, resolver.solver.solve(netlist, resolver.values));
}

/**
 * Loops in the per-tick case's plant: a battery, the catalogue's fuse, its breaker (handle on) and its
 * lamp each, wired in series (F2.5 test review: the real device models, not the synthetic ones).
 */
export const TICK_MIX_LOOPS = 250;
/** The plant is materialised here: the lamps settled (no continuous re-solves), off the solve cadence. */
export const TICK_MIX_START = 2001;

let tickMix: World | null = null;
let tickEngine: SimEngine | null = null;

/**
 * The per-tick case's plant, built once: {@link TICK_MIX_LOOPS} loops of a battery, a 1 A fuse, a 15 A
 * breaker and a 12 V lamp (1,000 devices, 1,250 nodes), every layer the catalogue's real models: the
 * battery's coulomb counting and the lamp's filament (continuous), the fuse's two bodies and the
 * breaker's bimetal (protection). Materialised at {@link TICK_MIX_START}, so the lamps have settled (a
 * timed step never re-solves) and the step isn't a cadence tick.
 */
function tickMixWorld(): World {
  if (tickMix === null) {
    const game = createGame({ seed: 1 });
    const lead = { id: 'lead.quillfern-test-1m', version: 1 };
    const at = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < TICK_MIX_LOOPS; k++) {
      const battery = 4 * k + 1;
      game.execOrThrow('entity.place', { ref: { id: 'battery.ferrovane-12v-7ah', version: 1 }, positionMm: at });
      game.execOrThrow('entity.place', { ref: { id: 'fuse.emberlyn-5x20-fa-1a', version: 1 }, positionMm: at });
      game.execOrThrow('entity.place', { ref: { id: 'breaker.saltmere-1p-15a', version: 1 }, positionMm: at });
      game.execOrThrow('entity.place', { ref: { id: 'lamp.lumivane-12v-5w', version: 1 }, positionMm: at });
      game.execOrThrow('device.operate', { id: battery + 2, control: 'on', value: true });
      const end = (offset: number, terminal: string) => ({ entity: battery + offset, terminal });
      game.execOrThrow('lead.connect', { ref: lead, a: end(0, 'pos'), b: end(1, 'a') });
      game.execOrThrow('lead.connect', { ref: lead, a: end(1, 'b'), b: end(2, 'line') });
      game.execOrThrow('lead.connect', { ref: lead, a: end(2, 'load'), b: end(3, 'a') });
      game.execOrThrow('lead.connect', { ref: lead, a: end(3, 'b'), b: end(0, 'neg') });
    }
    game.advanceTo(TICK_MIX_START);
    tickMix = game.materialisedWorld() as World;
  }
  return tickMix;
}

let readRig: SnapshotReadRig | null = null;
/** The read rig, built on first use (every `sim` command imports the cases). */
function rig(): SnapshotReadRig {
  readRig ??= snapshotReadRig();
  return readRig;
}

/**
 * ADR 0011 §9.2's per-frame read (plan F2.3b): reported, not time-gated (the budget is 0.1 ms at p99
 * and measured at a seventh of it; a raw-ms gate would need the calibrated headroom first). Gated on
 * allocation: a read must allocate nothing.
 */
/**
 * The allocation probe's smoke form: windows of 5,000 reads (a read that allocates a boxed double,
 * 12 B, still shows as 12 B; a one-off 11 kB step would be 2.2 B, but it must land in every window of
 * a size to count, and the smallest of 3 is kept), the warm-up to optimised code unchanged.
 */
const SMOKE_READS = 5_000;
const SMOKE_WINDOWS = 3;

export const SNAPSHOT_READ_CASE: BenchCase = {
  name: 'snapshot-read-500-devices',
  warmup: 2_000,
  runs: 5_000,
  budgetMs: null,
  prepare: () => rig().announce(),
  run: () => {
    rig().read();
    return String(rig().sum());
  },
  invariant: (smoke) => {
    const bytes = smoke ? bytesPerRead(rig(), SMOKE_READS, SMOKE_WINDOWS) : bytesPerRead(rig());
    return {
      value: bytes,
      failure:
        bytes < READ_ALLOCATION_GATE_BYTES
          ? null
          : `a read of ${READ_PLANT.devices} devices allocated ${bytes.toFixed(1)} B (the gate: under ${READ_ALLOCATION_GATE_BYTES} B)`,
    };
  },
};

export const BENCH_CASES: readonly BenchCase[] = [
  {
    // A from-scratch compile, as on a load or a session start: a new compiler, no cached fragments.
    name: 'plant-compile',
    warmup: 10,
    runs: 51,
    budgetMs: null,
    run: () => checksum(compileNetlist(plantWorlds().closed, BUILTIN_CATALOG)),
  },
  {
    // One topology change, the netlist's share of the re-solve after one: `prepare` (untimed) leaves
    // the compiler on the closed plant, and the timed run opens a feeder's root switch, a structural
    // recompile that renumbers and rehashes the whole plant from cached fragments. Per change, as the
    // 2 ms re-solve budget is, so the re-solve case can extend it (F2.2 part 3).
    name: 'plant-recompile-switch',
    warmup: 10,
    runs: 51,
    budgetMs: null,
    prepare: () => {
      toggleCompiler ??= new NetlistCompiler(BUILTIN_CATALOG);
      toggleCompiler.compile(plantWorlds().closed);
    },
    run: () => checksum((toggleCompiler as NetlistCompiler).compile(plantWorlds().open)),
  },
  {
    // Spec §4.5's re-solve after a topology change, compile and solve together. `prepare` (untimed)
    // leaves the compiler and the solver on the closed plant; the timed run opens the feeder's root
    // switch, recompiles (structurally, from cached fragments), fills the values and solves the 8
    // islands (about 250 unknowns each, so sparse LU). The factorisation cache holds both switch
    // states after the first warm-up run, as it does for a player toggling a switch. Gated at the
    // spec's 2 ms on the reference machine, scaled to this one by the calibration loop timed beside
    // it (F2.2 part 3b, the user's decision of 2026-10-31): a raw 2 ms gate would fail the CI runners
    // (2.12, 3.74 and 4.77 ms on Ubuntu, macOS and Windows before the recompile was optimised).
    name: 'plant-resolve-topology-change',
    warmup: 10,
    runs: 51,
    budgetMs: RESOLVE_BUDGET_MS,
    calibration: CALIBRATION,
    prepare: () => {
      warmResolver ??= newResolver();
      resolve(warmResolver, plantWorlds().closed);
    },
    run: () => resolve(warmResolver as Resolver, plantWorlds().open),
  },
  {
    // The same change to a topology the cache has never seen (a new wiring, or one evicted): every
    // island's symbolic factorisation (pattern and AMD order) is rebuilt. Reported, with no budget of
    // its own in the spec.
    name: 'plant-resolve-new-topology',
    warmup: 10,
    runs: 51,
    budgetMs: null,
    prepare: () => {
      coldResolver ??= newResolver();
      resolve(coldResolver, plantWorlds().closed);
      coldResolver.solver.cache.clear();
    },
    run: () => resolve(coldResolver as Resolver, plantWorlds().open),
  },
  {
    // Spec §4.5's per-tick budget: one step's discrete, continuous and protection layers, no solve.
    // `prepare` (untimed) starts an engine on the plant at TICK_MIX_START, which isn't a cadence tick,
    // so the timed run is that step's layers only (the lamps have settled: no continuous re-solve).
    // Every run starts from the same state, so the checksum holds.
    name: 'tick-device-mix',
    warmup: 20,
    runs: 101,
    budgetMs: 0.3,
    prepare: () => {
      tickEngine = SimEngine.start(tickMixWorld());
    },
    run: () => {
      const engine = tickEngine as SimEngine;
      engine.advanceTo(TICK_MIX_START + 1);
      return `${engine.tick}:${engine.lastSolveTick}:${engine.stats.cadenceSolves}:${engine.stats.continuousSolves}:${engine.netlist.devices.length}`;
    },
    // A digest of the bags the layers wrote (Σ charge, Σ filament temperature, Σ fuse heat, Σ bimetal),
    // untimed: idle layers can't pass.
    checksum: () => bagDigest(tickEngine as SimEngine),
  },
  {
    // The basis of `MAX_VERIFY_TICKS` (scripting-api): load verification replays a log tick by tick,
    // cadence solves included. 1,000 ticks of the 2,000-node plant with no command: 100 cadence
    // solves (unchanged topology, warm factorisation cache) and 1,000 steps of the layers.
    name: 'plant-advance-1000-ticks',
    warmup: 3,
    runs: 21,
    budgetMs: null,
    prepare: () => {
      plantEngine ??= SimEngine.start(plantWorlds().closed);
    },
    run: () => {
      const engine = plantEngine as SimEngine;
      engine.advanceTo(engine.tick + 1_000);
      return `${engine.stats.cadenceSolves % 100}:${engine.netlist.topologyHash}`;
    },
  },
  SNAPSHOT_READ_CASE,
];

let plantEngine: SimEngine | null = null;

/** Σ of each layer-written key over the engine's exported bags. */
function bagDigest(engine: SimEngine): string {
  const sums = { stateOfCharge: 0, filamentTempK: 0, elementHeat: 0, bodyHeat: 0, thermal: 0 };
  for (const { state } of engine.exportState().entities) {
    for (const key of Object.keys(sums) as (keyof typeof sums)[]) {
      const value = state[key];
      if (typeof value === 'number') sums[key] += value;
    }
  }
  return Object.values(sums).join(':');
}

/** Spec §4.5's cases that wait for the code they measure. Listed in the report; not run. */
export const PENDING_BENCH_CASES: readonly PendingBenchCase[] = [];
