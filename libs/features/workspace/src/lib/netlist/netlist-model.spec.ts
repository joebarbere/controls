import { fakeSnapshotView, ISLAND_FLAG_SINGULAR, NetlistReadout } from '@controls/sim-protocol';
import {
  bandName,
  buildNetlistTree,
  connectionDetail,
  formatQuantity,
  NO_READING,
  netlistSampler,
  sameNetlistValues,
} from './netlist-model';
import { BENCH_BRANCHES, BENCH_CONNECTIONS, BENCH_NODES, benchDescriptor, connectionRecords } from './netlist.fakes';

describe('formatQuantity', () => {
  it('writes three significant figures with an SI prefix', () => {
    expect(formatQuantity(0, 'A')).toBe('0 A');
    expect(formatQuantity(12.849, 'V')).toBe('12.8 V');
    expect(formatQuantity(0.39064, 'A')).toBe('391 mA');
    expect(formatQuantity(1, 'A')).toBe('1.00 A');
    expect(formatQuantity(277.1, 'V')).toBe('277 V');
    expect(formatQuantity(4800, 'V')).toBe('4.80 kV');
    expect(formatQuantity(2.5e-6, 'A')).toBe('2.50 µA');
    expect(formatQuantity(1.2e-11, 'A')).toBe('12.0 pA');
  });

  it('rounds before choosing the prefix, and never shows a tiny reading as zero', () => {
    expect(formatQuantity(0.99996, 'A')).toBe('1.00 A');
    expect(formatQuantity(999.96, 'V')).toBe('1.00 kV');
    expect(formatQuantity(3.2e-14, 'A')).toBe('3.20e-14 A');
    expect(formatQuantity(5e12, 'V')).toBe('5.00e+12 V');
  });

  it('names bands by the table, and past it by number', () => {
    expect(bandName(0)).toBe('none');
    expect(bandName(1)).toBe('dc12');
    expect(bandName(200)).toBe('band 200');
  });
});

describe('buildNetlistTree', () => {
  it("lists islands, then each island's nodes (with members) and branches, named as netlist.dump names them", () => {
    const tree = buildNetlistTree(benchDescriptor());
    expect(tree.map((i) => `${i.level} ${i.label}`)).toEqual([
      '1 Island 0 · DC',
      '2 Nodes (5)',
      '3 Node 0: 1:neg',
      '3 Node 1: 1:pos',
      '3 Node 2: 2:a 2:b',
      '3 Node 3: 3:a',
      '3 Node 4: 3:b',
      '2 Branches (5)',
      '3 Branch 0 e1.cell: 0 -> 1',
      '3 Branch 1 e3.filament: 3 -> 4',
      '3 Branch 2 c1: 1 -> 2',
      '3 Branch 3 c2: 2 -> 3',
      '3 Branch 4 c3: 4 -> 0',
      '1 Island 1 · AC',
      '2 Nodes (2)',
      '3 Node 5: 4:l1',
      '3 Node 6: 4:n',
      '2 Branches (1)',
      '3 Branch 5 e4.l1: 6 -> 5',
    ]);
    const node = tree.find((i) => i.key === 'n:2:a');
    expect(node).toMatchObject({ kind: 'node', parent: 'i:n:1:neg/nodes', setSize: 5, posInSet: 3 });
    expect(node?.members).toEqual([
      { entity: 2, terminal: 'a' },
      { entity: 2, terminal: 'b' },
    ]);
    expect(tree.find((i) => i.key === 'b:e3.filament')?.index).toBe(1);
  });

  it('keys rows by identity, so a renumbered generation keeps them', () => {
    const keys = buildNetlistTree(benchDescriptor(1)).map((i) => i.key);
    expect(buildNetlistTree(benchDescriptor(2)).map((i) => i.key)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('connectionDetail (protocol 7)', () => {
  const descriptor = benchDescriptor();
  const read = (connections: Uint8Array, islands = [{ band: 1 }, {}]) =>
    netlistSampler()(
      fakeSnapshotView({ descriptor, nodes: BENCH_NODES, branches: BENCH_BRANCHES, islands, connections }),
    );

  it("shows a lead's drop and temperature (its ends have no termination node), on its branch row", () => {
    const values = read(BENCH_CONNECTIONS);
    expect(values.connections).toEqual([
      null, // the battery's cell
      null, // the lamp's filament
      'drop 30.0 mV · 293 K',
      'drop 0 V · 293 K',
      'drop 16.0 mV · 293 K',
      null, // the AC island's source
    ]);
  });

  it("shows a wire's end drops, hot spots and non-ok states; no reading unless solved; open when not netlisted", () => {
    const wire = connectionRecords([
      {
        conductorDropV: 0.2011,
        endADropV: 0.300478,
        endBDropV: 0.0061,
        conductorTempK: 303.03,
        endATempK: 393.82,
        endBTempK: 301.7,
        endAState: 1,
        endBState: 3,
        insulationDamaged: 1,
        status: 1,
      },
      { conductorTempK: 300, endATempK: 310, endAState: 2, status: 2 },
      { conductorTempK: 300, status: 0 },
      { conductorTempK: 293.15, endATempK: 293.15, endAState: 1, status: 4 },
    ]);
    const values = read(wire);
    expect(values.connections[2]).toBe(
      'drop 201 mV · 303 K · a 300 mV 394 K · b 6.10 mV 302 K arcing · insulation damaged',
    );
    expect(values.connections[3]).toBe(`drop ${NO_READING} · 300 K · a ${NO_READING} 310 K intermittent`);
    expect(values.connections[4]).toBe(`drop ${NO_READING} · 300 K`);
    const reading = NetlistReadout.of(descriptor).createReading();
    NetlistReadout.of(descriptor).read(fakeSnapshotView({ descriptor, connections: wire }), reading);
    expect(connectionDetail(reading, 3)).toBe('open · 293 K · a 293 K');
  });
});

describe('netlistSampler', () => {
  it('formats solved values, and "no reading" for an unsolved island and an island with no reference', () => {
    const descriptor = benchDescriptor();
    const sample = netlistSampler();
    const values = sample(
      fakeSnapshotView({
        descriptor,
        tick: 1500,
        nodes: BENCH_NODES,
        branches: BENCH_BRANCHES,
        islands: [{ band: 1 }, { reference: -1 }],
      }),
    );
    expect(values.tick).toBe(1500);
    expect(values.islands).toEqual(['solved · band dc12', 'solved · band none']);
    expect(values.nodes).toEqual(['0 V', '12.9 V', '12.8 V', '12.8 V', '16.0 mV', NO_READING, NO_READING]);
    expect(values.branches.slice(0, 2)).toEqual(['391 mA, b -> a', '391 mA, a -> b']);
    expect(values.branches[5]).toBe('0 A'); // AC: magnitude only, no direction

    const singular = sample(
      fakeSnapshotView({
        descriptor,
        nodes: BENCH_NODES,
        islands: [{ flags: ISLAND_FLAG_SINGULAR }, { iterations: 0 }],
      }),
    );
    expect(singular.islands).toEqual(['singular · band none', 'unmodelled · band none']);
    expect(singular.nodes.every((v) => v === NO_READING)).toBe(true);
    expect(singular.branches.every((v) => v === NO_READING)).toBe(true);
  });

  it('allocates its reading once per descriptor, and equal text compares equal', () => {
    const create = vi.spyOn(NetlistReadout.prototype, 'createReading');
    const read = vi.spyOn(NetlistReadout.prototype, 'read');
    const sample = netlistSampler();
    const first = benchDescriptor(1);
    const a = sample(fakeSnapshotView({ descriptor: first, nodes: BENCH_NODES, tick: 1 }));
    const b = sample(fakeSnapshotView({ descriptor: first, nodes: BENCH_NODES, tick: 1 }));
    expect(create).toHaveBeenCalledTimes(1);
    // One readout per descriptor: both samples read through the same instance, into the same reading.
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.contexts[1]).toBe(read.mock.contexts[0]);
    expect(read.mock.contexts[0]).toBe(NetlistReadout.of(first));
    expect(read.mock.calls[1][1]).toBe(read.mock.calls[0][1]);
    expect(sameNetlistValues(a, b)).toBe(true);
    const c = sample(
      fakeSnapshotView({
        descriptor: first,
        nodes: [
          [0, 0],
          [12.7, 0],
        ],
        tick: 1,
      }),
    );
    expect(sameNetlistValues(a, c)).toBe(false);
    const d = sample(fakeSnapshotView({ descriptor: benchDescriptor(2), nodes: BENCH_NODES, tick: 1 }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(sameNetlistValues(a, d)).toBe(false); // a new generation is always a new sample
    expect(sameNetlistValues(null, null)).toBe(true);
    expect(sameNetlistValues(a, null)).toBe(false);
    create.mockRestore();
    read.mockRestore();
  });
});
