import { dcGoldens } from '../../testing/dc-goldens';
import { kcl, power } from '../../testing/mna';
import { DcSolver, ISLAND_FLAG_SINGULAR } from './dc';

/** Golden DC fixtures (plan F2.2 part 1). The hand calculations are in `src/testing/dc-goldens.ts`. */
describe('DC MNA goldens', () => {
  for (const golden of dcGoldens()) {
    it(golden.name, () => {
      const solution = new DcSolver().solve(golden.netlist, golden.values);
      for (const check of golden.checks) {
        const actual = check.actual(solution);
        const tolerance = check.tolerance ?? golden.tolerance;
        const bound = tolerance * Math.abs(check.expected) + (check.absolute ?? 1e-12);
        expect(
          Math.abs(actual - check.expected),
          `${check.label}: got ${actual}, expected ${check.expected}`,
        ).toBeLessThanOrEqual(bound);
      }
      const singular = new Set(golden.singular ?? []);
      for (const island of golden.netlist.islands) {
        const result = solution.islands[island.index];
        expect(result.solved).toBe(true);
        expect((result.flags & ISLAND_FLAG_SINGULAR) !== 0, `island ${island.index} singular`).toBe(
          singular.has(island.index),
        );
        if (singular.has(island.index)) continue;
        expect(kcl(golden.netlist, golden.values, solution, island)).toBeLessThanOrEqual(1);
        const { delivered, dissipated, scale, floor } = power(golden.netlist, golden.values, solution, island);
        expect(Math.abs(delivered - dissipated)).toBeLessThanOrEqual(1e-9 * scale + floor);
      }
      for (const value of [...solution.nodes, ...solution.branches]) expect(Number.isFinite(value)).toBe(true);
    });
  }
});
