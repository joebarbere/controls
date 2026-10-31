import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import { compileNetlist, type Netlist, NetlistCompiler } from '@controls/sim-core';
import type { BenchCase, PendingBenchCase } from './bench';
import { buildPlant, type Plant } from './plant';

/*
 * The cases `sim bench` runs (plan F2.7). Add a case here with a `budgetMs` and the gate enforces it.
 * Budgets come only from the spec (§4.5 and §4.9), never from a measurement: a case the spec gives no
 * budget for reports its timing with `budgetMs: null`.
 *
 * The netlist cases have no budget of their own. Compiling is only a part of §4.5's re-solve after a
 * topology change (2 ms for a 2,000-node plant, compile and solve together), so its budget belongs to
 * the re-solve case, which switches on with F2.2 part 3, and the per-tick case with F2.3a. Until then
 * they are listed in the report as pending, with their budgets.
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
];

/** Spec §4.5's cases that wait for the code they measure. Listed in the report; not run. */
export const PENDING_BENCH_CASES: readonly PendingBenchCase[] = [
  { name: 'plant-resolve-topology-change', budgetMs: 2, enabledBy: 'F2.2 part 3' },
  { name: 'plant-tick', budgetMs: 0.3, enabledBy: 'F2.3a' },
];
