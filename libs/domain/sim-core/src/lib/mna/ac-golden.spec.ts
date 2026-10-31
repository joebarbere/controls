import { acGoldens } from '../../testing/ac-goldens';
import { checkAcRows } from '../../testing/ac';
import { AcSolver } from './ac';

/**
 * Golden phasor fixtures (plan F2.2 part 2): the hand calculations are in `src/testing/ac-goldens.ts`.
 * Each is solved on the dense path (the default for these small islands) and forced onto sparse LU.
 */
describe.each([
  { path: 'dense', options: {} },
  { path: 'sparse', options: { sparseMinUnknowns: 1 } },
])('AC MNA goldens ($path)', ({ options }) => {
  for (const golden of acGoldens()) {
    it(golden.name, () => {
      const solution = new AcSolver(options).solve(golden.netlist, golden.values, golden.frequencyHz);
      for (const check of golden.checks) {
        const actual = check.actual(solution);
        const tolerance = check.tolerance ?? golden.tolerance;
        const bound = tolerance * Math.abs(check.expected) + (check.absolute ?? 1e-12);
        expect(
          Math.abs(actual - check.expected),
          `${check.label}: got ${actual}, expected ${check.expected}`,
        ).toBeLessThanOrEqual(bound);
      }
      for (const island of golden.netlist.islands) expect(solution.islands[island.index].flags).toBe(0);
      checkAcRows(golden, solution, true);
    });
  }
});
