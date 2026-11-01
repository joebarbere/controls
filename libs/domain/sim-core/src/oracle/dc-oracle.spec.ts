import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GMIN_S } from '../lib/constants';
import { type DcSolution, DcSolver, islandReferenceNode } from '../lib/mna/dc';
import { DC_STAMP_ISOURCE, DC_STAMP_RESISTOR, type DcBranchValues } from '../lib/mna/values';
import type { Netlist } from '../lib/netlist/types';
import { kcl, sourceRows } from '../testing/mna';
import { compareOracle, type OracleWorst } from './compare';
import { oracleCorpus, oracleResultsPath } from './corpus';
import { oracleDcInput } from './netlist';
import { type OracleCircuitResult, parseOracleResults } from './results';

/*
 * sim-core's DC solver against the DC oracle corpus (plan F2.7 and F2.2 part 1, ADR 0012), in
 * `pnpm verify`. Each DC circuit is adapted to the solver's real input (`oracleDcInput`: an F2.1
 * `Netlist` plus `DcBranchValues`, an isource as a `resistor` element stamped `DC_STAMP_ISOURCE`),
 * solved by `DcSolver`, and its **values** compared with ngspice's at ADR 0012's tolerance. sim-core's
 * own residual checks (KCL and the source rows, `testing/mna.ts`) run on the same solution: a residual
 * check against ngspice's rounded numbers isn't meaningful (ADR 0012). The corpus's own staleness and
 * consistency checks are `corpus.spec.ts`.
 *
 * It runs twice (F2.2 part 3): with the default solver, where the corpus's 2–30-node circuits stay
 * on dense LU (below `SPARSE_MIN_UNKNOWNS`), and with every island forced onto sparse LU, so the
 * oracle holds whichever path a circuit takes.
 */

const PATHS = [
  { name: 'default (dense below SPARSE_MIN_UNKNOWNS)', options: {} },
  { name: 'forced sparse', options: { sparseMinUnknowns: 1 } },
] as const;

const circuits = oracleCorpus('dc');
const results = parseOracleResults(
  readFileSync(join(import.meta.dirname, '../../oracle', oracleResultsPath('dc')), 'utf8'),
);

describe.each(PATHS)('sim-core against the DC oracle corpus, $name', ({ options }) => {
  /** Every DC circuit adapted and solved once, with one reused solver (as the engine will). */
  const solved: { netlist: Netlist; values: DcBranchValues; solution: DcSolution }[] = [];
  beforeAll(() => {
    const solver = new DcSolver(options);
    for (const circuit of circuits) {
      const { netlist, values } = oracleDcInput(circuit);
      solved.push({ netlist, values, solution: solver.solve(netlist, values) });
    }
  });

  it("the solver's reference is node 0, SPICE's ground, for every circuit", () => {
    const off = circuits.filter(
      (_, k) =>
        islandReferenceNode(solved[k].netlist, solved[k].netlist.islands[0]) !== 0 ||
        solved[k].solution.islands[0].referenceNode !== 0,
    );
    expect(off.map((circuit) => circuit.name)).toStrictEqual([]);
  });

  it("ngspice's solution satisfies the adapted netlist's element equations and KCL", () => {
    let worst = 0;
    results.circuits.forEach((result, k) => {
      worst = Math.max(worst, adaptedResidual(solved[k].netlist, solved[k].values, result));
    });
    expect(worst).toBeLessThan(1e-7);
  });

  it("DcSolver's values match ngspice's within ADR 0012's tolerance, and its own KCL and source rows hold", () => {
    const failures: string[] = [];
    const worst = { node: { ratio: 0, circuit: '' }, branch: { ratio: 0, circuit: '' } };
    const note = (which: 'node' | 'branch', w: OracleWorst, circuit: string) => {
      if (w.ratio > worst[which].ratio) worst[which] = { ratio: w.ratio, circuit: `${circuit} ${which} ${w.index}` };
    };
    results.circuits.forEach((result, k) => {
      const { netlist, values, solution } = solved[k];
      const name = circuits[k].name;
      if (solution.islands[0].flags !== 0) failures.push(`${name}: flags ${solution.islands[0].flags}`);
      const comparison = compareOracle(result, solution);
      for (const m of comparison.mismatches) {
        failures.push(`${name} ${m.quantity} ${m.index}: |error| ${m.error} > ${m.allowed}`);
      }
      note('node', comparison.worstNode, name);
      note('branch', comparison.worstBranch, name);
      const island = netlist.islands[0];
      const rows = Math.max(kcl(netlist, values, solution, island), sourceRows(netlist, values, solution, island));
      if (!(rows <= 1)) failures.push(`${name}: sim-core residual ${rows} of its floor`);
    });
    expect(failures).toStrictEqual([]);
    // ADR 0012 records these: the worst share of the allowance used, for volts and for amps.
    // A margin of at least 10× on both quantities, as the AC comparison asserts (measured: 1.06e-3 and 4.6e-4).
    expect(worst.node.ratio, worst.node.circuit).toBeLessThan(0.1);
    expect(worst.branch.ratio, worst.branch.circuit).toBeLessThan(0.1);
  });
});

/**
 * The worst residual of ngspice's solution against the adapted DC input (the solver's real
 * `Netlist` and `DcBranchValues`): each branch's equation by its stamp, and KCL with `GMIN_S` at every
 * non-reference node, normalised by the circuit's largest
 * voltage (element equations) or current (current sources, KCL).
 */
function adaptedResidual(netlist: Netlist, values: DcBranchValues, result: OracleCircuitResult): number {
  const v = (n: number) => result.nodes[2 * n];
  const i = (k: number) => result.branches[2 * k];
  let vScale = 0;
  for (let n = 0; n < netlist.nodes.length; n++) vScale = Math.max(vScale, Math.abs(v(n)));
  let iScale = 0;
  for (let k = 0; k < netlist.branches.length; k++) iScale = Math.max(iScale, Math.abs(i(k)));
  const kclSum = netlist.nodes.map((node) => (node.index === 0 ? 0 : GMIN_S.value * v(node.index)));
  let worst = 0;
  for (const branch of netlist.branches) {
    const k = branch.index;
    const stamp = values.stamps[k];
    const residual =
      stamp === DC_STAMP_RESISTOR
        ? (v(branch.a) - v(branch.b) - i(k) * values.ohms[k]) / vScale
        : stamp === DC_STAMP_ISOURCE
          ? (i(k) - values.amps[k]) / iScale
          : (v(branch.b) - v(branch.a) - (values.emfV[k] - values.ohms[k] * i(k))) / vScale;
    worst = Math.max(worst, Math.abs(residual));
    kclSum[branch.a] += i(k);
    kclSum[branch.b] -= i(k);
  }
  for (let n = 1; n < kclSum.length; n++) worst = Math.max(worst, Math.abs(kclSum[n]) / iScale);
  return worst;
}
