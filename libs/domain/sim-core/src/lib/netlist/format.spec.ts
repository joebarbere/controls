import { formatNetlist } from './format';
import type { Netlist } from './types';

describe('formatNetlist', () => {
  it('writes singular counts, islands without branches, sorted values and every diagnostic', () => {
    const netlist: Netlist = {
      nodes: [{ index: 0, island: 0, members: [{ entity: 4, terminal: 'a' }] }],
      branches: [
        {
          index: 0,
          element: { kind: 'connection', connection: 9 },
          kind: 'resistor',
          model: 'lead',
          source: null,
          a: 0,
          b: 0,
          island: 0,
          values: { z: 1e-21, a: 0.1 },
        },
      ],
      islands: [
        { index: 0, kind: 'empty', nodes: [0], branches: [0] },
        { index: 1, kind: 'mixed', nodes: [1], branches: [] },
      ],
      devices: [],
      topologyHash: 'f'.repeat(64),
      diagnostics: [
        { code: 'unknown-device', entity: 2 },
        { code: 'no-model', entity: 3, kind: 'mod.relay' },
        { code: 'absent-connection', connection: 5, reason: 'absent-end' },
        { code: 'mixed-island', island: 1 },
      ],
    };
    expect(formatNetlist(netlist)).toBe(
      [
        'netlist 1 node, 1 branch, 2 islands',
        `topology ${'f'.repeat(64)}`,
        'island 0 empty nodes 0 branches 0',
        'island 1 mixed nodes 1 branches',
        'node 0 island 0: 4:a',
        'branch 0 c9 resistor lead 0 -> 0 island 0 a=0.1 z=1e-21',
        'diagnostic unknown-device entity 2',
        'diagnostic no-model entity 3 kind mod.relay',
        'diagnostic absent-connection connection 5 absent-end',
        'diagnostic mixed-island island 1',
        '',
      ].join('\n'),
    );
  });
});
