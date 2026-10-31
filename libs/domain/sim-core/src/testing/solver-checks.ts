import { expect } from 'vitest';
import { type DcSolution, ISLAND_FLAG_SINGULAR } from '../lib/mna/dc';
import { DC_STAMP_RESISTOR, type DcBranchValues } from '../lib/mna/values';
import type { Netlist } from '../lib/netlist/types';
import { kcl, power, sourceRows } from './mna';

/*
 * Assertions shared by the DC solver specs (F2.2 parts 1 and 3), under the plan's F2.2 floor policy.
 * Specs only; excluded from the lib build.
 */

export interface Circuit {
  readonly netlist: Netlist;
  readonly values: DcBranchValues;
}

export const isSingular = (solution: DcSolution, island: number): boolean =>
  (solution.islands[island].flags & ISLAND_FLAG_SINGULAR) !== 0;

/**
 * Checks every equation of the system on every solved, non-singular island: KCL at every node, every
 * source row, and each resistor's own law (`resistorRows`), with the singular contract on the rest.
 * `withPower` adds the power balance, gmin losses included.
 */
export function checkRows({ netlist, values }: Circuit, solution: DcSolution, withPower = false): void {
  for (const v of solution.nodes) expect(Number.isFinite(v)).toBe(true);
  for (const v of solution.branches) expect(Number.isFinite(v)).toBe(true);
  for (const island of netlist.islands) {
    if (!solution.islands[island.index].solved) continue;
    if (isSingular(solution, island.index)) {
      for (const node of island.nodes) expect(Object.is(solution.nodes[2 * node], 0)).toBe(true);
      for (const b of island.branches) expect(Object.is(solution.branches[2 * b], 0)).toBe(true);
      continue;
    }
    expect(kcl(netlist, values, solution, island), `KCL on island ${island.index}`).toBeLessThanOrEqual(1);
    expect(sourceRows(netlist, values, solution, island), `source rows on island ${island.index}`).toBeLessThanOrEqual(
      1,
    );
    resistorRows({ netlist, values }, solution, island.branches);
    if (withPower) {
      const { delivered, dissipated, scale, floor } = power(netlist, values, solution, island);
      expect(Math.abs(delivered - dissipated), `power on island ${island.index}`).toBeLessThanOrEqual(
        1e-9 * scale + floor,
      );
    }
  }
}

/**
 * Each resistor's own equation, I = (Va − Vb) / R, within 1e-12 · |I| + 64 ε (|Va| + |Vb|) / R: the
 * current comes from voltages known only to an ulp (#49 review). KCL and the source rows alone
 * can't see a resistor whose current fits its nodes' balance but not its resistance (values left
 * different from the ones a solution was solved with).
 */
export function resistorRows({ netlist, values }: Circuit, solution: DcSolution, branches: readonly number[]): void {
  for (const b of branches) {
    if (values.stamps[b] !== DC_STAMP_RESISTOR) continue;
    const branch = netlist.branches[b];
    if (branch.a === branch.b) continue;
    const va = solution.nodes[2 * branch.a];
    const vb = solution.nodes[2 * branch.b];
    const want = (va - vb) / values.ohms[b];
    const floor =
      1e-12 * Math.abs(want) + (64 * Number.EPSILON * (Math.abs(va) + Math.abs(vb))) / values.ohms[b] + 1e-300;
    expect(Math.abs(solution.branches[2 * b] - want), `Ohm's law on branch ${b}`).toBeLessThanOrEqual(floor);
  }
}

/** `checkRows` plus the power balance. */
export function checkPhysics(circuit: Circuit, solution: DcSolution): void {
  checkRows(circuit, solution, true);
}

/** Field-by-field `Object.is` equality of two solutions. */
export function expectSameBits(actual: DcSolution, expected: DcSolution): void {
  expect(actual.topologyHash).toBe(expected.topologyHash);
  expect(actual.nodes.length).toBe(expected.nodes.length);
  expect(actual.branches.length).toBe(expected.branches.length);
  actual.nodes.forEach((v, i) => expect(Object.is(v, expected.nodes[i]), `node value ${i}`).toBe(true));
  actual.branches.forEach((v, i) => expect(Object.is(v, expected.branches[i]), `branch value ${i}`).toBe(true));
  expect(actual.islands).toStrictEqual(expected.islands);
}

/** Whether two solutions are equal bit for bit (no assertion: for counting in generator health). */
export function sameBits(x: DcSolution, y: DcSolution): boolean {
  if (x.nodes.length !== y.nodes.length || x.branches.length !== y.branches.length) return false;
  for (let i = 0; i < x.nodes.length; i++) if (!Object.is(x.nodes[i], y.nodes[i])) return false;
  for (let i = 0; i < x.branches.length; i++) if (!Object.is(x.branches[i], y.branches[i])) return false;
  return true;
}
