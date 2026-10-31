import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import {
  compileNetlist,
  type DcBranchValues,
  dcBranchValues,
  type DcSolution,
  DcSolver,
  type Netlist,
  type NetlistBranch,
  NetlistCompiler,
} from '@controls/sim-core';
import type { BenchCase, PendingBenchCase } from './bench';
import { buildPlant, type Plant } from './plant';

/*
 * The cases `sim bench` runs (plan F2.7). Add a case here with a `budgetMs` and the gate enforces it.
 * Budgets come only from the spec (§4.5 and §4.9), never from a measurement: a case the spec gives no
 * budget for reports its timing with `budgetMs: null`.
 *
 * The netlist cases have no budget of their own. Compiling is only a part of §4.5's re-solve after a
 * topology change (2 ms for a 2,000-node plant, compile and solve together), so its budget belongs to
 * the re-solve case (F2.2 part 3), which runs and reports its timing while its gate is pending (see
 * the case). The per-tick case waits for F2.3a. Both are listed as pending, with their budgets.
 */

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
    // states after the first warm-up run, as it does for a player toggling a switch. Reported without
    // a gate for now: its 2 ms budget stays in PENDING_BENCH_CASES until the CI runners' numbers are
    // in and the user decides how it is gated (F2.2 part 3 PR; measured 1.45 ms alone on a Ryzen 5
    // 5600X, but 2.3–2.6 ms beside `pnpm verify`'s parallel test workers).
    name: 'plant-resolve-topology-change',
    warmup: 10,
    runs: 51,
    budgetMs: null,
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
];

/** Spec §4.5's cases that wait for the code they measure. Listed in the report; not run. */
export const PENDING_BENCH_CASES: readonly PendingBenchCase[] = [
  // Runs and reports above (`plant-resolve-topology-change`); its gate waits for the user's decision.
  { name: 'plant-resolve-topology-change', budgetMs: 2, enabledBy: 'the CI-runner decision (F2.2 part 3)' },
  { name: 'plant-tick', budgetMs: 0.3, enabledBy: 'F2.3a' },
];
