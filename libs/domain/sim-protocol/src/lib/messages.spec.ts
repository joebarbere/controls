import { createReplayLog, createWorld } from '@controls/save-format';
import { DescriptorIndex, type TopologyDescriptor, TopologyDescriptorSchema } from './descriptor';
import {
  ISLAND_FLAG_NON_CONVERGED,
  ISLAND_FLAG_SINGULAR,
  ISLAND_KIND_AC,
  ISLAND_KIND_DC,
  ISLAND_KIND_MIXED,
  SIM_PROTOCOL_VERSION,
} from './layout';
import { islandStatus } from './island-status';
import { HostToWorker, parseHostMessage, parseWorkerMessage, SimStart, WorkerToHost } from './messages';
import { createSnapshotBuffer } from './buffer';

/*
 * The message protocol and the descriptor (ADR 0011 §4, §7): every message parses at both ends,
 * nothing malformed gets through, and the descriptor's lookups join by entity and kind.
 */

const world = createWorld({ seed: 3 });
const entry = { seq: 0, tick: 0, id: 'sim.step', args: { ticks: 10 } };

const descriptor: TopologyDescriptor = {
  protocol: SIM_PROTOCOL_VERSION,
  generation: 2,
  topologyHash: 'ab'.repeat(32),
  nodes: [
    { island: 0, members: [{ entity: 1, terminal: 'neg' }] },
    { island: 0, members: [{ entity: 1, terminal: 'pos' }] },
  ],
  branches: [{ element: { kind: 'entity', entity: 1, part: 'cell' }, a: 0, b: 1, island: 0 }],
  islands: [{ kind: 'dc', nodes: [0, 1] }],
  devices: [
    { entity: 1, kind: 'battery', recordOffset: 0 },
    { entity: 4, kind: 'lamp.incandescent', recordOffset: 32 },
  ],
  schemas: {
    battery: {
      kind: 'battery',
      recordBytes: 32,
      fields: [{ name: 'terminalV', type: 'f64', offset: 8, unit: 'V', values: null }],
    },
    'lamp.incandescent': {
      kind: 'lamp.incandescent',
      recordBytes: 24,
      fields: [{ name: 'lightOutputRel', type: 'f64', offset: 8, unit: null, values: null }],
    },
  },
};

describe('the message protocol', () => {
  it('parses every host message', () => {
    const messages: unknown[] = [
      { type: 'init', protocol: SIM_PROTOCOL_VERSION, transport: 'sab', start: { kind: 'world', world, firstSeq: 0 } },
      { type: 'init', protocol: 1, transport: 'message', start: { kind: 'replay', log: createReplayLog(world, []) } },
      { type: 'advance', tick: 10 },
      { type: 'command', entry },
      { type: 'query', id: 1, query: 'state', tick: 10 },
      { type: 'query', id: 2, query: 'snapshot', tick: 10 },
      { type: 'watch', id: 3, target: { kind: 'device', entity: 4, field: 'powerW' } },
      { type: 'watch', id: 4, target: { kind: 'branch', element: { kind: 'connection', connection: 1 } } },
      { type: 'unwatch', id: 3 },
      { type: 'release', buffer: new ArrayBuffer(8) },
      { type: 'stop' },
    ];
    for (const message of messages) expect(parseHostMessage(message)).not.toBeNull();
    expect(HostToWorker.options.length).toBe(8);
    expect(SimStart.safeParse({ kind: 'world', world, firstSeq: -1 }).success).toBe(false);
  });

  it('refuses malformed host messages without echoing them', () => {
    for (const bad of [
      null,
      'stop',
      { type: 'advance', tick: -1 },
      { type: 'advance', tick: 1.5 },
      { type: 'command', entry: { ...entry, seq: -1 } },
      { type: 'query', id: 1, query: 'world', tick: 0 },
      { type: 'release', buffer: new Uint8Array(8) },
      { type: 'release', buffer: new SharedArrayBuffer(8) },
      { type: 'stop', extra: 1 },
    ]) {
      expect(parseHostMessage(bad)).toBeNull();
    }
  });

  it('parses every worker message, and refuses malformed ones', () => {
    const shared = createSnapshotBuffer(128, true) as SharedArrayBuffer;
    const exported = { tick: 0, entities: [], solution: null };
    const messages: unknown[] = [
      { type: 'ready', protocol: 1, transport: 'sab', isolated: true, buffer: shared, tick: 0 },
      { type: 'ready', protocol: 1, transport: 'message', isolated: false, buffer: null, tick: 5 },
      { type: 'topology', descriptor, buffer: null },
      { type: 'topology', descriptor, buffer: shared },
      { type: 'snapshot', buffer: new ArrayBuffer(16) },
      { type: 'events', events: [{ tick: 3, kind: 'blown', entity: 4, entities: [], detail: {} }] },
      { type: 'trace', id: 1, samples: new Float64Array(4) },
      { type: 'state', id: 1, tick: 0, export: exported, snapshotHash: '0'.repeat(64) },
      { type: 'snapshotBytes', id: 2, tick: 0, bytes: new ArrayBuffer(88) },
      { type: 'error', code: 'desync', message: 'x', seq: 3, tick: 10 },
    ];
    for (const message of messages) expect(parseWorkerMessage(message)).not.toBeNull();
    expect(WorkerToHost.options.length).toBe(8);
    for (const bad of [
      { type: 'ready', protocol: 1, transport: 'sab', isolated: true, buffer: new ArrayBuffer(8), tick: 0 },
      { type: 'topology', descriptor: { ...descriptor, topologyHash: 'XYZ' }, buffer: null },
      { type: 'events', events: [{ tick: 3, kind: 'exploded', entity: 4, entities: [], detail: {} }] },
      { type: 'trace', id: 1, samples: [1, 2] },
      { type: 'state', id: 1, tick: 0, export: { ...exported, tick: -1 }, snapshotHash: '0'.repeat(64) },
      { type: 'error', code: 'oops', message: 'x', seq: null, tick: null },
      { type: 'error', code: 'desync', message: 'x'.repeat(501), seq: null, tick: null },
    ]) {
      expect(parseWorkerMessage(bad)).toBeNull();
    }
  });

  it('a state export with a non-finite value is refused (engine-threw, never saved)', () => {
    const exported = { tick: 0, entities: [{ id: 1, state: { x: Number.NaN } }], solution: null };
    expect(
      parseWorkerMessage({ type: 'state', id: 1, tick: 0, export: exported, snapshotHash: '0'.repeat(64) }),
    ).toBeNull();
  });
});

describe('the topology descriptor', () => {
  it('parses with its schema and looks fields up by entity and kind, cached by identity', () => {
    expect(TopologyDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(TopologyDescriptorSchema.safeParse({ ...descriptor, nodes: [{ island: 0, members: [] }] }).success).toBe(
      false,
    );
    const index = DescriptorIndex.of(descriptor);
    expect(DescriptorIndex.of(descriptor)).toBe(index);
    expect(index.field(4, 'lightOutputRel')).toMatchObject({ offset: 40, type: 'f64' });
    expect(index.field(4, 'lightOutputRel', 'lamp.incandescent')?.offset).toBe(40);
    expect(index.field(4, 'lightOutputRel', 'battery')).toBeNull(); // joined by (id, kind)
    expect(index.field(1, 'terminalV')?.offset).toBe(8);
    expect(index.field(1, 'nope')).toBeNull();
    expect(index.field(9, 'terminalV')).toBeNull();
    const orphan = { ...descriptor, devices: [{ entity: 7, kind: 'toString', recordOffset: 0 }] };
    expect(DescriptorIndex.of(orphan).field(7, 'x')).toBeNull();
  });
});

describe('islandStatus', () => {
  it('reads a status from kind, flags and iterations, mixed first', () => {
    expect(islandStatus(ISLAND_KIND_DC, 0, 1)).toBe('solved');
    expect(islandStatus(ISLAND_KIND_AC, 0, 1)).toBe('solved');
    expect(islandStatus(ISLAND_KIND_DC, 0, 0)).toBe('unmodelled');
    expect(islandStatus(ISLAND_KIND_DC, ISLAND_FLAG_SINGULAR, 1)).toBe('singular');
    expect(islandStatus(ISLAND_KIND_DC, ISLAND_FLAG_SINGULAR | ISLAND_FLAG_NON_CONVERGED, 3)).toBe('singular');
    expect(islandStatus(ISLAND_KIND_DC, ISLAND_FLAG_NON_CONVERGED, 50)).toBe('nonConverged');
    expect(islandStatus(ISLAND_KIND_MIXED, 0, 0)).toBe('mixed');
    expect(islandStatus(ISLAND_KIND_MIXED, ISLAND_FLAG_SINGULAR, 1)).toBe('mixed');
    expect(islandStatus(ISLAND_KIND_DC, ISLAND_FLAG_SINGULAR, 0)).toBe('unmodelled');
  });
});
