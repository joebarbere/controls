import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GMIN_S } from '../lib/constants';
import { AcSolver } from '../lib/mna/ac';
import { AC_STAMP_CAPACITOR, AC_STAMP_INDUCTOR, AC_STAMP_RESISTOR, type AcBranchValues } from '../lib/mna/ac-values';
import { type DcSolution, islandReferenceNode } from '../lib/mna/dc';
import { angularFrequency } from '../lib/mna/phasor';
import type { Netlist } from '../lib/netlist/types';
import { acKcl, acSourceRows, type AcCircuit } from '../testing/ac';
import { compareOracle, type OracleWorst } from './compare';
import { oracleCorpus, oracleResultsPath } from './corpus';
import { oracleAcInput } from './netlist';
import { type OracleCircuitResult, parseOracleResults } from './results';

/*
 * sim-core's phasor solver against the AC oracle corpus (plan F2.7 and F2.2 part 2, ADR 0012), in
 * `pnpm verify`. Each AC circuit is adapted to the solver's real input (`oracleAcInput`: an F2.1
 * `Netlist` plus `AcBranchValues`, R, L and C as `resistor` elements with their AC stamp, phasor
 * sources from the exact angle constants), solved by `AcSolver` at 60 Hz, and its **values** compared
 * with ngspice's at ADR 0012's tolerance, with complex magnitudes. sim-core's own complex residual
 * checks (KCL and the source rows, `testing/ac.ts`) run on the same solution.
 *
 * As the DC comparison, it runs twice: the default solver (the corpus's 2–30-node circuits stay on
 * complex dense LU) and every island forced onto complex sparse LU.
 */

const PATHS = [
  { name: 'default (dense below SPARSE_MIN_UNKNOWNS)', options: {} },
  { name: 'forced sparse', options: { sparseMinUnknowns: 1 } },
] as const;

const circuits = oracleCorpus('ac');
const results = parseOracleResults(
  readFileSync(join(import.meta.dirname, '../../oracle', oracleResultsPath('ac')), 'utf8'),
);

/**
 * The worst residual of ngspice's solution against the adapted AC input: each branch's equation by
 * its stamp (V = Z I for R and L, I = jωC V for C, the source row), and KCL with `GMIN_S`, normalised
 * by the circuit's largest |V| (element equations) or |I| (the capacitor's law, KCL).
 */
function adaptedResidual(netlist: Netlist, values: AcBranchValues, result: OracleCircuitResult): number {
  const omega = angularFrequency(60);
  const v = (n: number): [number, number] => [result.nodes[2 * n], result.nodes[2 * n + 1]];
  const i = (k: number): [number, number] => [result.branches[2 * k], result.branches[2 * k + 1]];
  const abs = ([re, im]: [number, number]) => Math.hypot(re, im);
  let vScale = 0;
  for (let n = 0; n < netlist.nodes.length; n++) vScale = Math.max(vScale, abs(v(n)));
  let iScale = 0;
  for (let k = 0; k < netlist.branches.length; k++) iScale = Math.max(iScale, abs(i(k)));
  const kcl = netlist.nodes.map((node) =>
    node.index === 0 ? [0, 0] : [GMIN_S.value * v(node.index)[0], GMIN_S.value * v(node.index)[1]],
  );
  let worst = 0;
  for (const branch of netlist.branches) {
    const k = branch.index;
    const [va, vb, ik] = [v(branch.a), v(branch.b), i(k)];
    const drop: [number, number] = [va[0] - vb[0], va[1] - vb[1]];
    let residual: [number, number];
    let scale = vScale;
    switch (values.stamps[k]) {
      case AC_STAMP_RESISTOR:
        residual = [drop[0] - ik[0] * values.ohms[k], drop[1] - ik[1] * values.ohms[k]];
        break;
      case AC_STAMP_INDUCTOR: {
        const x = omega * values.henries[k];
        residual = [drop[0] + x * ik[1], drop[1] - x * ik[0]];
        break;
      }
      case AC_STAMP_CAPACITOR: {
        const b = omega * values.farads[k];
        residual = [ik[0] + b * drop[1], ik[1] - b * drop[0]];
        scale = iScale;
        break;
      }
      default: {
        const r = values.ohms[k];
        residual = [-drop[0] - (values.emfRe[k] - ik[0] * r), -drop[1] - (values.emfIm[k] - ik[1] * r)];
      }
    }
    worst = Math.max(worst, abs(residual) / scale);
    kcl[branch.a][0] += ik[0];
    kcl[branch.a][1] += ik[1];
    kcl[branch.b][0] -= ik[0];
    kcl[branch.b][1] -= ik[1];
  }
  for (let n = 1; n < kcl.length; n++) worst = Math.max(worst, Math.hypot(kcl[n][0], kcl[n][1]) / iScale);
  return worst;
}

describe.each(PATHS)('sim-core against the AC oracle corpus, $name', ({ options }) => {
  /** Every AC circuit adapted and solved once, with one reused solver (as the engine will). */
  const solved: (AcCircuit & { solution: DcSolution })[] = [];
  beforeAll(() => {
    const solver = new AcSolver(options);
    for (const circuit of circuits) {
      const input = oracleAcInput(circuit);
      solved.push({ ...input, solution: solver.solve(input.netlist, input.values, input.frequencyHz) });
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

  it("AcSolver's values match ngspice's within ADR 0012's tolerance, and its own KCL and source rows hold", () => {
    const failures: string[] = [];
    const worst = { node: { ratio: 0, circuit: '' }, branch: { ratio: 0, circuit: '' } };
    const note = (which: 'node' | 'branch', w: OracleWorst, circuit: string) => {
      if (w.ratio > worst[which].ratio) worst[which] = { ratio: w.ratio, circuit: `${circuit} ${which} ${w.index}` };
    };
    results.circuits.forEach((result, k) => {
      const circuit = solved[k];
      const { netlist, solution } = circuit;
      const name = circuits[k].name;
      const record = solution.islands[0];
      if (!record.solved || record.flags !== 0)
        failures.push(`${name}: solved ${record.solved}, flags ${record.flags}`);
      const comparison = compareOracle(result, solution);
      for (const m of comparison.mismatches) {
        failures.push(`${name} ${m.quantity} ${m.index}: |error| ${m.error} > ${m.allowed}`);
      }
      note('node', comparison.worstNode, name);
      note('branch', comparison.worstBranch, name);
      const island = netlist.islands[0];
      const rows = Math.max(acKcl(circuit, solution, island), acSourceRows(circuit, solution, island));
      if (!(rows <= 1)) failures.push(`${name}: sim-core residual ${rows} of its floor`);
    });
    expect(failures).toStrictEqual([]);
    // ADR 0012 records these: the worst share of the allowance used, for volts and for amps. The plan
    // asks for a margin of at least 10× (a share under 0.1).
    expect(worst.node.ratio, worst.node.circuit).toBeLessThan(0.1);
    expect(worst.branch.ratio, worst.branch.circuit).toBeLessThan(0.1);
  });
});
