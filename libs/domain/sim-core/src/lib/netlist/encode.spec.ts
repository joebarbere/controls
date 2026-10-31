import fc from 'fast-check';
import { TopologyWriter } from './encode';
import { topologyBytes } from './hash';
import type { NetlistBranch, NetlistNode } from './types';

/*
 * The compiler's encoder must write exactly `topologyBytes`'s bytes (the netlist property tests check
 * that on every compiled netlist, through the hash). These pin the edges those worlds rarely reach:
 * ids past 2³¹ (where the bit operators would wrap), 255-code-unit strings, buffer growth and reuse,
 * and the refusals.
 */

const node = (index: number, members: [number, string][]): NetlistNode => ({
  index,
  island: 0,
  members: members.map(([entity, terminal]) => ({ entity, terminal })),
});

const branch = (index: number, element: NetlistBranch['element'], a: number, b: number): NetlistBranch => ({
  index,
  element,
  kind: index % 2 === 0 ? 'resistor' : 'vsource',
  model: index % 3 === 0 ? 'lead' : 'm'.repeat(255),
  source: index % 3 === 0 ? null : index % 3 === 1 ? 'dc' : 'ac',
  a,
  b,
  island: 0,
  values: {},
});

/** The index of the first byte where `a` and `b` differ (or the shorter length), or -1 if equal. */
function firstMismatch(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// A byte loop, not `toStrictEqual` over spread arrays: that took seconds on a few hundred KB.
const same = (writer: TopologyWriter, nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]) => {
  const reference = topologyBytes(nodes, branches);
  const written = writer.encode(nodes, branches);
  expect(written.length).toBe(reference.length);
  expect(firstMismatch(written, reference)).toBe(-1);
};

describe('TopologyWriter', () => {
  it('writes topologyBytes exactly: large ids, long strings, every element and source kind', () => {
    const ids = [0, 1, 127, 128, 300, 2 ** 31 - 1, 2 ** 31, 2 ** 32 + 5, 2 ** 40, Number.MAX_SAFE_INTEGER];
    const nodes = ids.map((id, i) => node(i, [[id, i % 2 === 0 ? 'a' : 't'.repeat(255)]]));
    const branches = ids.map((id, i) =>
      branch(
        i,
        i % 2 === 0 ? { kind: 'entity', entity: id, part: 'p'.repeat(1 + i) } : { kind: 'connection', connection: id },
        i,
        9 - i,
      ),
    );
    same(new TopologyWriter(), nodes, branches);
    same(new TopologyWriter(), [], []);
  });

  it('reuses and grows its buffer without leaking an earlier encoding into a later one', () => {
    const writer = new TopologyWriter();
    const small = [node(0, [[1, 'a']])];
    // A few hundred long members are well past the writer's first size guess, so it must grow.
    const big = Array.from({ length: 300 }, (_, i) => node(i, [[i + 1, 'x'.repeat(255 - (i % 7))]]));
    same(writer, small, []);
    same(writer, big, [branch(0, { kind: 'connection', connection: 7 }, 0, 299)]);
    same(writer, small, []);
    same(writer, big, []);
  });

  it('matches topologyBytes on arbitrary nodes and branches (property)', () => {
    const id = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
    const index = fc.integer({ min: 0, max: 2 ** 31 - 1 });
    const ascii = fc.string({
      unit: fc.integer({ min: 0, max: 0x7e }).map((c) => String.fromCharCode(c)),
      maxLength: 255,
    });
    const nodeArb = fc.record({
      index,
      island: index,
      members: fc.array(fc.record({ entity: id, terminal: ascii }), { maxLength: 4 }),
    });
    const branchArb = fc.record({
      index,
      element: fc.oneof(
        fc.record({ kind: fc.constant('entity' as const), entity: id, part: ascii }),
        fc.record({ kind: fc.constant('connection' as const), connection: id }),
      ),
      kind: fc.constantFrom('resistor' as const, 'vsource' as const),
      model: ascii,
      source: fc.constantFrom(null, 'dc' as const, 'ac' as const),
      a: index,
      b: index,
      island: index,
      values: fc.constant({}),
    });
    // One writer across all runs, so reuse after a larger encoding is exercised too.
    const writer = new TopologyWriter();
    fc.assert(
      fc.property(fc.array(nodeArb, { maxLength: 12 }), fc.array(branchArb, { maxLength: 12 }), (nodes, branches) => {
        same(writer, nodes, branches);
      }),
      { numRuns: 200 },
    );
  });

  it('refuses what topologyBytes refuses, with its message', () => {
    for (const terminal of ['é', 'x'.repeat(256)]) {
      const nodes = [node(0, [[1, terminal]])];
      expect(() => new TopologyWriter().encode(nodes, [])).toThrow(/^Not a short ASCII id/);
      expect(() => topologyBytes(nodes, [])).toThrow(/^Not a short ASCII id/);
    }
  });
});
