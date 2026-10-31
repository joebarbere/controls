import {
  createSnapshotBuffer,
  decodeSnapshot,
  DescriptorIndex,
  islandStatus,
  SIM_PROTOCOL_VERSION,
  slotCapacityFor,
  SnapshotReader,
  snapshotHashedBytes,
  snapshotViewFromBytes,
  SnapshotWriter,
  TopologyDescriptorSchema,
} from '@controls/sim-protocol';
import { LAMP, origin } from '../../testing/bench';
import { ENGINE_BENCH, engineBus, engineTestOptions, TWIN_SUPPLY } from '../../testing/engine';
import { SimEngine } from './engine';

/*
 * The engine's side of the F2.3b transport (ADR 0011 §5–§7): the topology descriptor it builds per
 * generation, `encodeInto` (the worker's slot writer), and island status read from a snapshot exactly
 * as `islands()` reports it (`islandStatus`, #52 review).
 */

/** The engine bench (battery, switch, thermal load, I²t fuse) run to `ticks`, plus extra commands. */
function bench(extra: readonly (readonly [string, object])[] = [], ticks = 25) {
  const bus = engineBus();
  const engine = SimEngine.start(bus.state, engineTestOptions());
  const run = (id: string, args: object) => {
    const result = bus.exec(id, args);
    if (!result.ok || !result.logged) throw new Error(`${id} failed: ${result.ok ? 'unlogged' : result.error.message}`);
    engine.applied(result.entry, bus.state);
  };
  for (const [id, args] of [...ENGINE_BENCH, ...extra]) run(id, args);
  engine.advanceTo(ticks);
  bus.advanceTo(ticks);
  return { bus, engine };
}

describe('the topology descriptor', () => {
  it("matches the netlist, parses with the protocol's schema, and joins the device records", () => {
    const { engine } = bench();
    const descriptor = engine.topologyDescriptor();
    expect(TopologyDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.nodes[0])).toBe(true);
    const netlist = engine.netlist;
    expect(descriptor.protocol).toBe(SIM_PROTOCOL_VERSION);
    expect(descriptor.generation).toBe(engine.topologyGeneration);
    expect(descriptor.topologyHash).toBe(netlist.topologyHash);
    expect(descriptor.nodes.map((n) => n.members)).toEqual(netlist.nodes.map((n) => n.members));
    expect(descriptor.branches.map((b) => [b.element, b.a, b.b, b.island])).toEqual(
      netlist.branches.map((b) => [b.element, b.a, b.b, b.island]),
    );
    expect(descriptor.islands).toEqual(netlist.islands.map((i) => ({ kind: i.kind, nodes: i.nodes })));
    // The battery (1, since F2.4), the thermal load (3) and the I²t fuse (4) publish records; the switch doesn't.
    expect(descriptor.devices.map((d) => [d.entity, d.kind])).toEqual([
      [1, 'battery'],
      [3, 'test.thermalLoad'],
      [4, 'test.i2tFuse'],
    ]);
    expect(Object.keys(descriptor.schemas).sort()).toEqual(['battery', 'test.i2tFuse', 'test.thermalLoad']);
    // Cached by identity within a generation; a topology change makes a new object.
    expect(engine.topologyDescriptor()).toBe(descriptor);
  });

  it('is a new object for each generation, with records the view reads back by field', () => {
    const { bus, engine } = bench();
    const before = engine.topologyDescriptor();
    const result = bus.exec('device.operate', { id: 2, control: 'closed', value: false });
    if (!result.ok || !result.logged) throw new Error('operate failed');
    engine.applied(result.entry, bus.state);
    const after = engine.topologyDescriptor();
    expect(after).not.toBe(before);
    expect(after.generation).toBe(before.generation + 1);
    const view = snapshotViewFromBytes(engine.snapshot(), after);
    for (const device of after.devices) {
      for (const field of after.schemas[device.kind].fields) {
        const ref = DescriptorIndex.of(after).field(device.entity, field.name, device.kind);
        expect(ref).not.toBeNull();
        if (ref !== null) expect(Number.isFinite(view.read(ref))).toBe(true);
      }
    }
  });
});

describe('encodeInto', () => {
  it('writes the same hashed bytes as snapshot(), into any slot, with the seqlock word it is given', () => {
    const { engine } = bench([], 137);
    const slot = new Uint8Array(engine.snapshotBytes() + 64);
    const used = engine.encodeInto(slot, 5);
    expect(used).toBe(engine.snapshotBytes());
    expect(new DataView(slot.buffer).getInt32(0, true)).toBe(5);
    expect(snapshotHashedBytes(slot)).toEqual(engine.snapshot());
    // Through the seqlock writer and reader, as the worker publishes it.
    const buffer = createSnapshotBuffer(slotCapacityFor(used) as number, true);
    const writer = new SnapshotWriter(buffer);
    writer.publish((target, seq) => void engine.encodeInto(target, seq));
    const reader = new SnapshotReader();
    reader.attach(buffer);
    reader.setDescriptor(engine.topologyDescriptor());
    expect(reader.latest()?.hashedBytes()).toEqual(engine.snapshot());
  });
});

describe('islandStatus agrees with islands()', () => {
  it('for solved, singular and unmodelled islands, read from the snapshot', () => {
    const twin: (readonly [string, object])[] = [
      ['entity.place', { ref: TWIN_SUPPLY, positionMm: origin }], // a singular island of its own
      ['entity.place', { ref: LAMP, positionMm: origin }], // unwired: an unmodelled island
    ];
    const { engine } = bench(twin, 40);
    const decoded = decodeSnapshot(engine.snapshot());
    const statuses = engine.islands().map((island) => island.status);
    expect([...new Set(statuses)].sort()).toEqual(['singular', 'solved', 'unmodelled']);
    decoded.islands.forEach((island, i) => {
      const kind = ['empty', 'dc', 'ac', 'mixed'].indexOf(island.kind);
      expect(islandStatus(kind, island.flags, island.iterations)).toBe(statuses[i]);
    });
  });
});
