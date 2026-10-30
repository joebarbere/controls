import { BUILTIN_CATALOG } from '@controls/catalog';
import { sha256, toHex } from '@controls/world-model';
import {
  benchBus,
  benchLamp,
  end,
  LAMP,
  LEAD,
  LEAD_2M,
  origin,
  run,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
} from '../../testing/bench';
import { compileNetlist } from './compile';
import { elementKey, TOPOLOGY_ENCODING_HEADER, topologyBytes } from './hash';
import type { NetlistBranch, NetlistNode } from './types';

/**
 * Golden topology hashes of the bench lamp. They are persisted in every save's `WorldV2.sim` and in
 * snapshots, so a change here moves saves: change the encoding only with a version-byte and
 * `SIM_ENGINE_VERSION` bump, and re-pin these together with the snapshot goldens. Both were
 * cross-checked against Node's `crypto` SHA-256 of the hand-encoded bytes below.
 */
const BENCH_LAMP_CLOSED_TOPOLOGY = 'e9684dfc2521d9ce252757c0a6a4abf1c5312562578fa517f3d6a9d175db61e7';
const BENCH_LAMP_OPEN_TOPOLOGY = 'b0358bd8a604530e0f9667484a4fa1d151edc84cb11c601ee792ebf99002cf0b';

/** A length byte and the ASCII codes of `text`. */
const str = (text: string) => [text.length, ...Array.from(text, (c) => c.charCodeAt(0))];

describe('topologyHash', () => {
  it('digests the canonical bytes: the partition, then each branch’s element, kinds and ends', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    // Hand-encoded from the closed bench lamp (see compile.spec.ts for its nodes and branches).
    const expected = [
      ...TOPOLOGY_ENCODING_HEADER,
      5, // nodes
      ...[1, 1, ...str('neg')],
      ...[1, 1, ...str('pos')],
      ...[2, 2, ...str('a'), 2, ...str('b')], // the closed switch's merged node
      ...[1, 3, ...str('a')],
      ...[1, 3, ...str('b')],
      5, // branches
      ...[0, 1, ...str('cell'), 1, ...str('battery'), 0, 1], // entity 1's cell, vsource, 0 → 1
      ...[0, 3, ...str('filament'), 0, ...str('lamp.incandescent'), 3, 4], // entity 3's filament, resistor
      ...[1, 1, 0, ...str('lead'), 1, 2], // connection 1, resistor
      ...[1, 2, 0, ...str('lead'), 2, 3],
      ...[1, 3, 0, ...str('lead'), 4, 0],
    ];
    const bytes = topologyBytes(netlist.nodes, netlist.branches);
    expect([...bytes]).toStrictEqual(expected);
    expect(netlist.topologyHash).toBe(toHex(sha256(bytes)));
  });

  it('is pinned for the bench lamp (closed and open)', () => {
    expect(compileNetlist(benchLamp(true), BUILTIN_CATALOG).topologyHash).toBe(BENCH_LAMP_CLOSED_TOPOLOGY);
    expect(compileNetlist(benchLamp(false), BUILTIN_CATALOG).topologyHash).toBe(BENCH_LAMP_OPEN_TOPOLOGY);
  });

  it('excludes values: a longer lead and another setpoint keep the hash', () => {
    const build = (lead: typeof LEAD, setpointV: number) => {
      const bus = benchBus(TEST_CATALOG);
      for (const ref of [SUPPLY, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
      run(bus, 'lead.connect', { ref: lead, a: end(1, 'pos'), b: end(2, 'a') });
      run(bus, 'lead.connect', { ref: lead, a: end(2, 'b'), b: end(1, 'neg') });
      run(bus, 'device.operate', { id: 1, control: 'setpointV', value: setpointV });
      return compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    };
    const short = build(LEAD, 12);
    const long = build(LEAD_2M, 3);
    expect(long.branches[2].values['resistanceOhm']).toBeGreaterThan(short.branches[2].values['resistanceOhm']);
    expect(long.topologyHash).toBe(short.topologyHash);
  });

  it('writes multi-byte varints, grows its buffer, and refuses non-ASCII or over-long ids', () => {
    const node = (entity: number, terminal: string): NetlistNode => ({
      index: 0,
      island: 0,
      members: [{ entity, terminal }],
    });
    const branch: NetlistBranch = {
      index: 0,
      element: { kind: 'connection', connection: 300 },
      kind: 'vsource',
      model: 'x',
      source: null,
      a: 0,
      b: 0,
      island: 0,
      values: {},
    };
    // 2^40 is five 7-bit groups of zeros and then 0x20; 300 is 0x2c + 0x80, then 0x02.
    const big = [0x80, 0x80, 0x80, 0x80, 0x80, 0x20];
    expect([...topologyBytes([node(2 ** 40, 'a')], [branch])]).toStrictEqual([
      ...TOPOLOGY_ENCODING_HEADER,
      ...[1, 1, ...big, ...str('a')],
      ...[1, 1, 0xac, 0x02, 1, ...str('x'), 0, 0],
    ]);
    const long = 't'.repeat(255);
    const many = Array.from({ length: 40 }, (_, i) => node(i + 1, long));
    expect(topologyBytes(many, []).length).toBe(4 + 1 + 40 * (1 + 1 + 1 + 255) + 1);
    expect(() => topologyBytes([node(1, 'é')], [])).toThrow(/ASCII/);
    expect(() => topologyBytes([node(1, 'x'.repeat(256))], [])).toThrow(/ASCII/);
  });

  it('names elements by entity and part, or by connection', () => {
    expect(elementKey({ kind: 'entity', entity: 12, part: 'cell' })).toBe('e12.cell');
    expect(elementKey({ kind: 'connection', connection: 7 })).toBe('c7');
  });
});
