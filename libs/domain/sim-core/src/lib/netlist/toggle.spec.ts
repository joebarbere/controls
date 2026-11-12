import { BUILTIN_CATALOG } from '@controls/catalog';
import { World } from '@controls/save-format';
import fc from 'fast-check';
import { wiredLoopWorld } from '../../testing/wired-loop';
import { createDcSolution, DcSolver } from '../mna/dc';
import { dcBranchValues, type DcBranchValues } from '../mna/values';
import { compileNetlist, NetlistCompiler } from './compile';
import { computeTopologyHash } from './hash';
import type { NetlistBranch } from './types';

/*
 * The open-toggle path (F3.6 part 2, perf): a recompile of the same world whose only change is which
 * connections have an open end re-assembles from the previous netlist (`NetlistCompiler.toggleOnly`),
 * and `DcSolver({ reuseUnchangedIslands })` copies the islands the toggle didn't touch. Both must be
 * exactly what a from-scratch compile and a fresh solve give: the netlist deep-equal (its
 * `topologyHash` and diagnostics included) and the solution bit for bit.
 */

const LOOPS = 4;
const PER_LOOP_ENTITIES = 5;
const PER_LOOP_CONNECTIONS = 7;

/** `LOOPS` copies of the wired loop (each a battery, breaker, two nuts and a heater, 7 connections), ids offset. */
function loops(tripped: readonly boolean[] = []): World {
  const one = wiredLoopWorld();
  const entities = [];
  const connections = [];
  for (let k = 0; k < LOOPS; k++) {
    const e = (id: number) => id + k * PER_LOOP_ENTITIES;
    for (const entity of one.entities) {
      const sim = entity.ref.id.startsWith('breaker.') ? { thermal: 0, tripped: tripped[k] === true } : entity.sim;
      entities.push({ ...entity, id: e(entity.id), sim });
    }
    for (const connection of one.connections) {
      const end = (x: (typeof connection)['a']) =>
        x === null
          ? null
          : {
              ...x,
              entity: e(x.entity),
              termination: x.termination === null ? null : { ...x.termination, id: x.termination.id + k * 7 },
            };
      connections.push({
        ...connection,
        id: connection.id + k * PER_LOOP_CONNECTIONS,
        a: end(connection.a),
        b: end(connection.b),
      });
    }
  }
  return World.parse({
    ...one,
    nextEntityId: LOOPS * PER_LOOP_ENTITIES + 1,
    nextConnectionId: LOOPS * PER_LOOP_CONNECTIONS + 1,
    nextTerminationId: LOOPS * 7 + 1,
    entities,
    connections,
  });
}

const OPEN = Object.freeze({ endAState: 'intermittentOpen', endBState: 'ok' });
const CLOSED = Object.freeze({ endAState: 'ok', endBState: 'ok' });
const viewOf = (open: ReadonlySet<number>) => (id: number) => (open.has(id) ? OPEN : CLOSED);

/** A resistor for every branch the DC defaults leave unvalued (the heater's element has a default). */
const hook = (branch: NetlistBranch, values: DcBranchValues): boolean => {
  if (branch.element.kind !== 'connection') return false;
  values.resistor(branch.index, 0.05);
  return true;
};

describe('the open-toggle path (F3.6 part 2)', () => {
  const steps = fc.array(
    fc.record({
      open: fc.uniqueArray(fc.integer({ min: 1, max: LOOPS * PER_LOOP_CONNECTIONS }), { maxLength: 6 }),
      // Now and then a breaker trips or resets (an entity sim view change: the full path's job).
      trip: fc.option(fc.integer({ min: 0, max: LOOPS - 1 }), { nil: undefined, freq: 4 }),
    }),
    { minLength: 1, maxLength: 12 },
  );

  it('recompiles to exactly what a from-scratch compile gives, topologyHash and diagnostics included', () => {
    fc.assert(
      fc.property(steps, (sequence) => {
        const compiler = new NetlistCompiler(BUILTIN_CATALOG);
        const tripped = Array.from({ length: LOOPS }, () => false);
        let world = loops(tripped);
        for (const { open, trip } of sequence) {
          if (trip !== undefined) {
            tripped[trip] = !tripped[trip];
            world = loops(tripped);
          }
          const options = { connectionSim: viewOf(new Set(open)) };
          const netlist = compiler.compile(world, options);
          const full = compileNetlist(world, BUILTIN_CATALOG, options);
          expect(netlist).toStrictEqual(full);
          expect(netlist.topologyHash).toBe(computeTopologyHash(netlist.nodes, netlist.branches));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('takes the toggle path for an open-only change of the same world, and returns the same netlist for none', () => {
    const compiler = new NetlistCompiler(BUILTIN_CATALOG);
    const world = loops();
    const closed = compiler.compile(world, { connectionSim: viewOf(new Set()) });
    expect(compiler.compile(world, { connectionSim: viewOf(new Set()) })).toBe(closed);
    const before = { ...compiler.stats };
    const open = compiler.compile(world, { connectionSim: viewOf(new Set([2])) });
    expect(compiler.stats).toStrictEqual({ ...before, structural: before.structural + 1 });
    expect(open.diagnostics).toContainEqual({ code: 'absent-connection', connection: 2, reason: 'intermittent-open' });
    expect(open.branches).toHaveLength(closed.branches.length - 1);
    // Back closed: the same netlist as the first compile, deeply.
    expect(compiler.compile(world, { connectionSim: viewOf(new Set()) })).toStrictEqual(closed);
  });

  it('a solver reusing unchanged islands solves bit for bit what a fresh solver does', () => {
    fc.assert(
      fc.property(steps, (sequence) => {
        const compiler = new NetlistCompiler(BUILTIN_CATALOG);
        const reusing = new DcSolver({ reuseUnchangedIslands: true });
        const tripped = Array.from({ length: LOOPS }, () => false);
        let world = loops(tripped);
        let values: DcBranchValues | undefined;
        let out = undefined as ReturnType<DcSolver['solve']> | undefined;
        for (const { open, trip } of sequence) {
          if (trip !== undefined) {
            tripped[trip] = !tripped[trip];
            world = loops(tripped);
          }
          const netlist = compiler.compile(world, { connectionSim: viewOf(new Set(open)) });
          values = dcBranchValues(netlist, hook, values);
          // Into the previous solution's storage when it fits, as a resolver reusing its buffers does.
          out = reusing.solve(netlist, values, out);
          const fresh = new DcSolver().solve(netlist, values);
          expect(out).toStrictEqual(fresh);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('copies the islands one opened connection left alone, and re-solves only the one it touched', () => {
    const compiler = new NetlistCompiler(BUILTIN_CATALOG);
    const solver = new DcSolver({ reuseUnchangedIslands: true });
    const world = loops();
    const closed = compiler.compile(world, { connectionSim: viewOf(new Set()) });
    solver.solve(closed, dcBranchValues(closed, hook));
    expect(solver.reusedIslands).toBe(0);
    const open = compiler.compile(world, { connectionSim: viewOf(new Set([2])) });
    const solution = solver.solve(open, dcBranchValues(open, hook), createDcSolution(open));
    // Opening loop 1's breaker conductor leaves loops 2–4 (an island each) untouched.
    expect(solver.reusedIslands).toBe(LOOPS - 1);
    expect(solution).toStrictEqual(new DcSolver().solve(open, dcBranchValues(open, hook)));
  });
});
