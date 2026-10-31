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

const same = (writer: TopologyWriter, nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]) =>
  expect([...writer.encode(nodes, branches)]).toStrictEqual([...topologyBytes(nodes, branches)]);

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
    const big = Array.from({ length: 3000 }, (_, i) => node(i, [[i + 1, 'x'.repeat(i % 256)]]));
    same(writer, small, []);
    same(writer, big, [branch(0, { kind: 'connection', connection: 7 }, 0, 2999)]);
    same(writer, small, []);
    same(writer, big, []);
  });

  it('refuses what topologyBytes refuses, with its message', () => {
    for (const terminal of ['é', 'x'.repeat(256)]) {
      const nodes = [node(0, [[1, terminal]])];
      expect(() => new TopologyWriter().encode(nodes, [])).toThrow(/^Not a short ASCII id/);
      expect(() => topologyBytes(nodes, [])).toThrow(/^Not a short ASCII id/);
    }
  });
});
