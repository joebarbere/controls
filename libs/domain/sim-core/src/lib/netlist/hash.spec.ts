import { BUILTIN_CATALOG } from '@controls/catalog';
import { sha256, toHex } from '@controls/world-model';
import {
  BATTERY,
  benchBus,
  benchLamp,
  end,
  LAMP,
  LEAD,
  LEAD_2M,
  origin,
  run,
  SPST,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
} from '../../testing/bench';
import { compileNetlist } from './compile';
import { computeTopologyHash, elementKey, TOPOLOGY_ENCODING_HEADER, topologyBytes } from './hash';
import type { NetlistBranch, NetlistNode } from './types';
import { BENCH_SUPPLY, DIN_PSU } from '../../testing/sources';
import { MODEL_KINDS } from '@controls/catalog';

/**
 * Golden topology hashes of the bench lamp. They are persisted in every save's `WorldV2.sim` and in
 * snapshots, so a change here moves saves: change the encoding only with a version-byte and
 * `SIM_ENGINE_VERSION` bump, and re-pin these together with the snapshot goldens. Both were
 * cross-checked against Node's `crypto` SHA-256 of the hand-encoded bytes below.
 */
const BENCH_LAMP_CLOSED_TOPOLOGY = '79811fe207820438f90b52e9eebe0ee9d98596c279976850c7835531a0a158e5';
const BENCH_LAMP_OPEN_TOPOLOGY = '31b0bfb84ceceab420f34bd6f171ec539bea579edc8fef584210ecb295272fad';

/** One golden per built-in netlist model kind (a lone device; for the lead, one between two lamps). */
const MODEL_KIND_TOPOLOGY = {
  battery: 'fc48b347b0a7328f4f20bd4a3db030c7cbefbdfb00b941d135c858618d66c9ae',
  lampIncandescent: '10e8b4bf4f56b063d68df2b6300d831d965740e0b1acdf41e1271e8ec4b545a4',
  switchSpstOpen: '8d7d96ae3f1d9482fb364f073f7d7eddeef3c6f1840a08701a49f8c05fd692e4',
  switchSpstClosed: '4d3eebc10ede9b149d9e60ef2b58c876f63abf731e8bc050599ade2ce1d75ec6',
  lead: '1b026937ba140eaab9f3a11092eff4883b8fa9b4a8e68c200244599e8fbbd279',
  supplyBench: '7732d91373abae4657ac515c62277f699d9ddf951682082bafde8072c479c586',
  supplyDinPsu: '80deabcc976dfdabbaf5ad3e701a428f0c2d04cce25a9b2588b231b3c09b7d7e',
};

/** The model kind each golden above covers: together, every kind in `MODEL_KINDS` (a test checks). */
const PINNED_KIND: Readonly<Record<keyof typeof MODEL_KIND_TOPOLOGY, string>> = {
  battery: 'battery',
  lampIncandescent: 'lamp.incandescent',
  switchSpstOpen: 'switch.spst',
  switchSpstClosed: 'switch.spst',
  lead: 'lead',
  supplyBench: 'supply.bench',
  supplyDinPsu: 'supply.dinPsu',
};

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
      ...[0, 1, ...str('cell'), 1, 1, ...str('battery'), 0, 1], // entity 1's cell, vsource, dc, 0 → 1
      ...[0, 3, ...str('filament'), 0, 0, ...str('lamp.incandescent'), 3, 4], // entity 3's filament, resistor, passive
      ...[1, 1, 0, 0, ...str('lead'), 1, 2], // connection 1, resistor, passive
      ...[1, 2, 0, 0, ...str('lead'), 2, 3],
      ...[1, 3, 0, 0, ...str('lead'), 4, 0],
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
      ...[1, 1, 0xac, 0x02, 1, 0, ...str('x'), 0, 0],
    ]);
    const long = 't'.repeat(255);
    const many = Array.from({ length: 40 }, (_, i) => node(i + 1, long));
    expect(topologyBytes(many, []).length).toBe(4 + 1 + 40 * (1 + 1 + 1 + 255) + 1);
    expect(() => topologyBytes([node(1, 'é')], [])).toThrow(/ASCII/);
    expect(() => topologyBytes([node(1, 'x'.repeat(256))], [])).toThrow(/ASCII/);
  });

  it('encodes the source domain, so a DC and an AC source of the same shape never collide', () => {
    const branch = (source: 'dc' | 'ac'): NetlistBranch => ({
      index: 0,
      element: { kind: 'entity', entity: 1, part: 'cell' },
      kind: 'vsource',
      model: 'm',
      source,
      a: 0,
      b: 1,
      island: 0,
      values: {},
    });
    const nodes: NetlistNode[] = [
      { index: 0, island: 0, members: [{ entity: 1, terminal: 'a' }] },
      { index: 1, island: 0, members: [{ entity: 1, terminal: 'b' }] },
    ];
    expect(computeTopologyHash(nodes, [branch('dc')])).not.toBe(computeTopologyHash(nodes, [branch('ac')]));
  });

  it('is pinned for every built-in model kind, so a silent netlist-model change fails the build', () => {
    // A change here needs a SIM_ENGINE_VERSION bump (ADR 0013, "Solution order and topologyHash").
    const one = (ref: typeof LEAD, closed?: boolean) => {
      const bus = benchBus();
      run(bus, 'entity.place', { ref, positionMm: origin });
      if (closed !== undefined) run(bus, 'device.operate', { id: 1, control: 'closed', value: closed });
      return compileNetlist(bus.state, BUILTIN_CATALOG).topologyHash;
    };
    const lead = () => {
      const bus = benchBus();
      for (const ref of [LAMP, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
      run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'b'), b: end(2, 'a') });
      return compileNetlist(bus.state, BUILTIN_CATALOG).topologyHash;
    };
    expect({
      battery: one(BATTERY),
      lampIncandescent: one(LAMP),
      switchSpstOpen: one(SPST, false),
      switchSpstClosed: one(SPST, true),
      lead: lead(),
      supplyBench: one(BENCH_SUPPLY),
      supplyDinPsu: one(DIN_PSU),
    }).toStrictEqual(MODEL_KIND_TOPOLOGY);
  });

  it('pins every model kind in MODEL_KINDS (a new kind without a pin fails here)', () => {
    expect([...new Set(Object.values(PINNED_KIND))].sort()).toStrictEqual(Object.keys(MODEL_KINDS).sort());
  });

  it('names elements by entity and part, or by connection', () => {
    expect(elementKey({ kind: 'entity', entity: 12, part: 'cell' })).toBe('e12.cell');
    expect(elementKey({ kind: 'connection', connection: 7 })).toBe('c7');
  });
});
