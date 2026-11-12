import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import {
  ConnectionThermalBank,
  type DcBranchValues,
  dcBranchValues,
  DcSolver,
  type Netlist,
  type NetlistBranch,
  NetlistCompiler,
  SimEngine,
} from '@controls/sim-core';
import { materialiseWorld } from '@controls/sim-protocol';
import { GCProfiler, getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { BenchCalibration, BenchCase } from './bench';
import { buildWiredPlant } from './wired-plant';

/*
 * F3.6 part 1's bench cases (plan P3 "Budgets", ADR 0015, ADR 0018 §10): the connection thermal bank
 * on a wired plant.
 *
 * - `tick-wired-plant` times the layers of one **cadence** tick (the bank integrates only there, ADR
 *   0018 §3.4) on 1,000 catalogue devices and 2,000 landed conductors (plus their loops' 600 leads),
 *   the solve excluded: `prepare` starts an engine on the plant at a cadence tick, which solves there
 *   (untimed), so the timed `advanceTo(t + 1)` is that tick's discrete, continuous (the devices' and
 *   the bank's) and protection layers only. Gated at spec §4.5's 0.3 ms per tick, and on allocation.
 * - `plant-resolve-topology-change-wired`: `plant-resolve-topology-change` (spec §4.5's 2 ms re-solve
 *   after a topology change on the 2,000-node plant, calibrated) with the connection bank in the loop,
 *   as the engine runs it: after the recompile the bank is synced to the new netlist (branch indices,
 *   static contact values) and stamps every connection branch's solve-time value. Every one of the
 *   plant's connections (its test leads, which join the thermal model, D2) carries thermal state.
 */

/** The cadence tick the wired plant is materialised at (a multiple of `SOLVE_INTERVAL_TICKS`). */
export const WIRED_START = 3000;

let wiredWorld: World | null = null;

/** The wired plant run to {@link WIRED_START} and materialised there (lamps settled, conductors warm), built once. */
export function wiredPlantWorld(): World {
  if (wiredWorld === null) {
    const world = buildWiredPlant();
    const engine = SimEngine.start(world);
    engine.advanceTo(WIRED_START);
    wiredWorld = materialiseWorld({ ...world, tick: WIRED_START }, engine.exportState());
  }
  return wiredWorld;
}

/** A fresh engine on the wired plant that has solved at {@link WIRED_START} (`sim: null` starts with a solve). */
function startWired(): SimEngine {
  return SimEngine.start({ ...wiredPlantWorld(), sim: null });
}

/**
 * The allocation gate, bytes per tick averaged over windows of ticks (each tenth a cadence tick with
 * its solve and the bank's step): under 1 B, so an object allocated on every cadence tick (16 B or
 * more, a boxed double, is 1.6 B per tick) fails.
 */
export const WIRED_ALLOCATION_GATE_BYTES = 1;

/**
 * Bytes the engine allocates per tick on the wired plant, as `bytesPerRead` measures a read: a warm-up
 * to optimised code, a collection before each window, heap growth plus what each GC freed, the
 * smallest of several windows, and the slope between window sizes so a fixed per-window cost cancels.
 */
export function wiredBytesPerTick(ticks = 5_000, windows = 4, warmup = 20_000): number {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  const engine = startWired();
  engine.advanceTo(engine.tick + warmup);
  const window = (count: number) => {
    collect();
    const profiler = new GCProfiler();
    const start = getHeapStatistics().used_heap_size;
    profiler.start();
    engine.advanceTo(engine.tick + count);
    const stats = profiler.stop()?.statistics ?? [];
    const freed = stats.reduce(
      (sum, s) => sum + s.beforeGC.heapStatistics.usedHeapSize - s.afterGC.heapStatistics.usedHeapSize,
      0,
    );
    return getHeapStatistics().used_heap_size - start + freed;
  };
  for (const count of [ticks, 2 * ticks, 3 * ticks]) window(count);
  const smallest = (count: number) => Math.min(...Array.from({ length: windows }, () => window(count)));
  const [one, two, three] = [smallest(ticks), smallest(2 * ticks), smallest(3 * ticks)];
  return Math.max(0, Math.min(two - one, three - two) / ticks);
}

let tickEngine: SimEngine | null = null;

/** Σ of the conductor and hot-spot temperatures over the engine's exported connection bags. */
function connectionDigest(engine: SimEngine): string {
  let conductors = 0;
  let ends = 0;
  let members = 0;
  for (const { state } of engine.exportState().connections) {
    members++;
    conductors += state['conductorTempK'] as number;
    for (const key of ['endATempK', 'endBTempK']) {
      const value = state[key];
      if (typeof value === 'number') ends += value;
    }
  }
  return `${members}:${conductors}:${ends}`;
}

export const TICK_WIRED_CASE: BenchCase = {
  name: 'tick-wired-plant',
  warmup: 20,
  runs: 101,
  budgetMs: 0.3,
  prepare: () => {
    tickEngine = startWired();
  },
  run: () => {
    const engine = tickEngine as SimEngine;
    engine.advanceTo(WIRED_START + 1);
    // lastSolveTick stays at the start's solve (no cadence solve timed) and no continuous re-solve ran.
    return `${engine.tick}:${engine.lastSolveTick}:${engine.stats.cadenceSolves}:${engine.stats.continuousSolves}:${engine.netlist.branches.length}`;
  },
  // A digest of what the bank's step wrote, untimed: an idle bank can't pass.
  checksum: () => connectionDigest(tickEngine as SimEngine),
  invariant: (smoke) => {
    const bytes = smoke ? wiredBytesPerTick(2_000, 2, 5_000) : wiredBytesPerTick();
    return {
      value: bytes,
      failure:
        bytes < WIRED_ALLOCATION_GATE_BYTES
          ? null
          : `the wired plant allocated ${bytes.toFixed(2)} B per tick (the gate: under ${WIRED_ALLOCATION_GATE_BYTES} B)`,
    };
  },
};

/** What the wired re-solve keeps between runs: a compiler, a solver (its factorisation cache), a bank, value storage. */
interface WiredResolver {
  readonly compiler: NetlistCompiler;
  readonly solver: DcSolver;
  readonly bank: ConnectionThermalBank;
  values: DcBranchValues | undefined;
  /** The value hook: connection branches from the bank, lamps at their rated hot resistance (the plain case's placeholder). */
  readonly hook: (branch: NetlistBranch, values: DcBranchValues) => boolean;
}

function wiredResolver(solver = new DcSolver()): WiredResolver {
  const bank = new ConnectionThermalBank(BUILTIN_CATALOG);
  return {
    compiler: new NetlistCompiler(BUILTIN_CATALOG),
    solver,
    bank,
    values: undefined,
    hook: (branch, values) => {
      if (branch.element.kind === 'connection') return bank.dcValue(bank.memberOf(branch.index), branch, values);
      if (branch.model !== 'lamp.incandescent') return false;
      values.resistor(branch.index, 28.8);
      return true;
    },
  };
}

/** Recompiles, syncs the bank, fills the values (the bank's for connections) and solves. */
function resolveWired(resolver: WiredResolver, world: World): string {
  const netlist: Netlist = resolver.compiler.compile(world);
  resolver.bank.sync(world, netlist);
  resolver.values = dcBranchValues(netlist, resolver.hook, resolver.values);
  const solution = resolver.solver.solve(netlist, resolver.values);
  let sum = 0;
  for (let i = 0; i < solution.nodes.length; i += 2) sum += solution.nodes[i];
  return `${netlist.nodes.length}:${netlist.branches.length}:${netlist.topologyHash}:${resolver.bank.count}:${sum}`;
}

let warmWired: WiredResolver | null = null;

/**
 * The connection `intermittent-toggle-wired` opens: the first loop's breaker → nut conductor (its first
 * conductor), so every conductor of that loop loses its current and its island splits.
 */
export const TOGGLED_CONNECTION = 2;

/** The end states the toggled connection compiles with in the timed run: its breaker end open. */
const OPEN_END = Object.freeze({ endAState: 'intermittentOpen', endBState: 'ok' });

/** What `intermittent-toggle-wired` keeps between runs: the wired resolver, and whether the toggled end is open. */
interface ToggleResolver extends WiredResolver {
  open: boolean;
}

/** Recompiles with the toggled end open or not (read through `connectionSim`, as the engine does), syncs, fills, solves. */
function resolveToggle(resolver: ToggleResolver, world: World): string {
  const bank = resolver.bank;
  const netlist: Netlist = resolver.compiler.compile(world, {
    connectionSim: (id) => (resolver.open && id === TOGGLED_CONNECTION ? OPEN_END : bank.topologyView(id)),
  });
  bank.sync(world, netlist);
  resolver.values = dcBranchValues(netlist, resolver.hook, resolver.values);
  const solution = resolver.solver.solve(netlist, resolver.values);
  let sum = 0;
  for (let i = 0; i < solution.nodes.length; i += 2) sum += solution.nodes[i];
  return `${netlist.nodes.length}:${netlist.branches.length}:${netlist.islands.length}:${netlist.topologyHash}:${sum}`;
}

let toggleWired: ToggleResolver | null = null;

/**
 * `intermittent-toggle-wired` (ADR 0015, ADR 0018 §10, F3.6 part 2): one end entering
 * `intermittentOpen` on the wired plant (1,000 devices, 2,000 landed conductors, materialised at
 * {@link WIRED_START}): the structural recompile that drops its branch (the compiler's open-toggle
 * path: the same world with one end's state changed re-assembles branches and islands from the
 * previous netlist and resumes the topology hash after its unchanged node section), the bank's sync to
 * the new netlist, the values (the bank's for every connection) and the linear solve, with
 * `reuseUnchangedIslands` (the 199 loops the toggle didn't touch are copied, bit-identical). `prepare`
 * (untimed) leaves everything on the closed plant, so every run is the same toggle. Gated at spec
 * §4.5's 2 ms re-solve, calibrated (as the plain re-solve). The engine's own solve after a toggle is
 * `solveNonlinear`, which never reuses an island (a cold-started nonlinear island isn't bit-identical
 * to a warm-started one), so this case times the compile path the engine shares and a linear solve.
 */
export function intermittentToggleCase(budgetMs: number, calibration: BenchCalibration): BenchCase {
  return {
    name: 'intermittent-toggle-wired',
    warmup: 20,
    runs: 101,
    budgetMs,
    calibration,
    prepare: () => {
      toggleWired ??= { ...wiredResolver(new DcSolver({ reuseUnchangedIslands: true })), open: false };
      toggleWired.open = false;
      resolveToggle(toggleWired, wiredPlantWorld());
    },
    run: () => {
      const resolver = toggleWired as ToggleResolver;
      resolver.open = true;
      return resolveToggle(resolver, wiredPlantWorld());
    },
  };
}

/** `plant-resolve-topology-change-wired`, on the plant's closed and open worlds (cases.ts builds them). */
export function resolveWiredCase(
  worlds: () => { readonly closed: World; readonly open: World },
  budgetMs: number,
  calibration: BenchCalibration,
): BenchCase {
  return {
    name: 'plant-resolve-topology-change-wired',
    warmup: 10,
    runs: 51,
    budgetMs,
    calibration,
    prepare: () => {
      warmWired ??= wiredResolver();
      resolveWired(warmWired, worlds().closed);
    },
    run: () => resolveWired(warmWired as WiredResolver, worlds().open),
  };
}
