import { createReplayLog, createWorld } from '@controls/save-format';
import {
  CONNECTION_OUTPUT_FIELDS,
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  CONNECTION_RECORD_OFFSETS,
  CONNECTION_U8_OFFSET,
  connectionLayoutProblems,
} from './connection-output';
import {
  BREAKER_STATE_VALUES,
  DEVICE_OUTPUT_SCHEMAS,
  deviceOutputSchemaProblems,
  isDeviceReading,
  DEVICE_READING_CURRENT,
  DEVICE_READING_LINE_VOLTAGE,
  DEVICE_READING_LOAD_VOLTAGE,
  DEVICE_READING_NEUTRAL_CURRENT,
  DEVICE_READING_RESIDUAL,
  RECORD_TRIP_CAUSE_VALUES,
  TRIP_CAUSE_VALUES,
} from './device-output';
import {
  CONNECTION_EVENT_KINDS,
  DEVICE_EVENT_KINDS,
  ISLAND_EVENT_KINDS,
  SIM_EVENT_KINDS,
  type SimEvent,
  simEventDetail,
} from './events';
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
import { HostToWorker, parseHostMessage, parseWorkerMessage, SimEventSchema, SimStart, WorkerToHost } from './messages';
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
  connections: [
    { connection: 2, kind: 'lead', recordOffset: 0, branch: 0 },
    { connection: 5, kind: 'conductor', recordOffset: 120, branch: -1 },
  ],
  connectionSchemas: { lead: CONNECTION_OUTPUT_SCHEMAS['lead'], conductor: CONNECTION_OUTPUT_SCHEMAS['conductor'] },
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
    const exported = { tick: 0, entities: [], connections: [], solution: null };
    const messages: unknown[] = [
      { type: 'ready', protocol: 1, transport: 'sab', isolated: true, buffer: shared, tick: 0 },
      { type: 'ready', protocol: 1, transport: 'message', isolated: false, buffer: null, tick: 5 },
      { type: 'topology', descriptor, buffer: null },
      { type: 'topology', descriptor, buffer: shared },
      { type: 'snapshot', buffer: new ArrayBuffer(16) },
      {
        type: 'events',
        events: [{ tick: 3, kind: 'blown', entity: 4, entities: [], connection: null, end: null, detail: {} }],
      },
      {
        type: 'events',
        events: [
          {
            tick: 3,
            kind: 'terminationOverheat',
            entity: null,
            entities: [],
            connection: 7,
            end: 'b',
            detail: { temperatureK: 393.5 },
          },
        ],
      },
      { type: 'trace', id: 1, samples: new Float64Array(4) },
      { type: 'state', id: 1, tick: 0, export: exported, snapshotHash: '0'.repeat(64) },
      { type: 'snapshotBytes', id: 2, tick: 0, bytes: new ArrayBuffer(88) },
      { type: 'error', code: 'desync', message: 'x', seq: 3, tick: 10, reason: null },
      { type: 'error', code: 'start-failed', message: 'x', seq: null, tick: null, reason: 'topology-mismatch' },
    ];
    for (const message of messages) expect(parseWorkerMessage(message)).not.toBeNull();
    expect(WorkerToHost.options.length).toBe(8);
    for (const bad of [
      { type: 'ready', protocol: 1, transport: 'sab', isolated: true, buffer: new ArrayBuffer(8), tick: 0 },
      { type: 'topology', descriptor: { ...descriptor, topologyHash: 'XYZ' }, buffer: null },
      {
        type: 'events',
        events: [{ tick: 3, kind: 'exploded', entity: 4, entities: [], connection: null, end: null, detail: {} }],
      },
      { type: 'events', events: [{ tick: 3, kind: 'blown', entity: 4, entities: [], detail: {} }] },
      {
        type: 'events',
        events: [{ tick: 3, kind: 'blown', entity: 4, entities: [], connection: null, end: 'c', detail: {} }],
      },
      {
        type: 'topology',
        descriptor: { ...descriptor, connections: [{ connection: 2, kind: 'lead', recordOffset: 0, branch: -2 }] },
        buffer: null,
      },
      { type: 'trace', id: 1, samples: [1, 2] },
      { type: 'state', id: 1, tick: 0, export: { ...exported, tick: -1 }, snapshotHash: '0'.repeat(64) },
      { type: 'error', code: 'oops', message: 'x', seq: null, tick: null, reason: null },
      { type: 'error', code: 'desync', message: 'x'.repeat(501), seq: null, tick: null, reason: null },
      { type: 'error', code: 'start-failed', message: 'x', seq: null, tick: null, reason: 'mystery' },
      { type: 'error', code: 'desync', message: 'x', seq: null, tick: null },
    ]) {
      expect(parseWorkerMessage(bad)).toBeNull();
    }
  });

  it('a state export with a non-finite value is refused (engine-threw, never saved)', () => {
    const exported = { tick: 0, entities: [{ id: 1, state: { x: Number.NaN } }], connections: [], solution: null };
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

  it('carries relation contacts and remote earth (protocol 8, engine 8 part 1, ADR 0019)', () => {
    const earthed = {
      ...descriptor,
      nodes: [{ island: 0, members: [{ entity: 0, terminal: 'earth' }] }, ...descriptor.nodes],
      branches: [
        ...descriptor.branches,
        { element: { kind: 'contact', entity: 1, relation: 'earth', contact: 'electrode' }, a: 1, b: 0, island: 0 },
        { element: { kind: 'contact', entity: 4, relation: 'mount', contact: 'line1' }, a: 2, b: 1, island: 0 },
        { element: { kind: 'contact', entity: 4, relation: 'plug', contact: 'hot' }, a: 2, b: 1, island: 0 },
      ],
    };
    expect(TopologyDescriptorSchema.safeParse(earthed).success).toBe(true);
    // Entity 0 is remote earth only, with its one terminal.
    const badEarth = { ...earthed, nodes: [{ island: 0, members: [{ entity: 0, terminal: 'pos' }] }] };
    expect(TopologyDescriptorSchema.safeParse(badEarth).success).toBe(false);
    const contact = (fields: object) => ({
      ...descriptor,
      branches: [
        { element: { kind: 'contact', entity: 1, relation: 'mount', contact: 'x', ...fields }, a: 0, b: 1, island: 0 },
      ],
    });
    expect(TopologyDescriptorSchema.safeParse(contact({ relation: 'cord' })).success).toBe(false);
    expect(TopologyDescriptorSchema.safeParse(contact({ entity: 0 })).success).toBe(false);
    expect(TopologyDescriptorSchema.safeParse(contact({ contact: 'Line-1' })).success).toBe(false);
    expect(TopologyDescriptorSchema.safeParse(contact({ contact: 'a'.repeat(255) })).success).toBe(true);
    // A trace may watch a contact's current.
    const watch = {
      type: 'watch',
      id: 1,
      target: { kind: 'branch', element: { kind: 'contact', entity: 4, relation: 'plug', contact: 'hot' } },
    };
    expect(HostToWorker.safeParse(watch).success).toBe(true);
  });

  it('looks connection record fields up by connection and kind (protocol 7)', () => {
    const index = DescriptorIndex.of(descriptor);
    expect(index.connection(5)).toStrictEqual({ connection: 5, kind: 'conductor', recordOffset: 120, branch: -1 });
    expect(index.connection(3)).toBeUndefined();
    expect(index.connectionField(5, 'endADropV')).toMatchObject({ offset: 120 + 16, type: 'f64' });
    expect(index.connectionField(2, 'status', 'lead')).toMatchObject({ offset: 115, type: 'u8' });
    expect(index.connectionField(2, 'status', 'conductor')).toBeNull(); // joined by (id, kind)
    expect(index.connectionField(2, 'nope')).toBeNull();
    expect(index.connectionField(9, 'currentA')).toBeNull();
    const orphan = { ...descriptor, connections: [{ connection: 7, kind: 'toString', recordOffset: 0, branch: -1 }] };
    expect(DescriptorIndex.of(orphan).connectionField(7, 'currentA')).toBeNull();
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

describe('protocol 8: typed event details, the connection layout and the trip causes', () => {
  const event = (kind: string, detail: object, over: object = {}) => ({
    type: 'events',
    events: [{ tick: 3, kind, entity: 4, entities: [], connection: null, end: null, detail, ...over }],
  });

  it("parses each kind's detail exactly: a cause outside the enum, a missing or extra key is invalid", () => {
    for (const cause of TRIP_CAUSE_VALUES) expect(parseWorkerMessage(event('tripped', { cause }))).not.toBeNull();
    for (const good of [
      event('hiccup', { phase: 'retry' }),
      event('lampBurnout', { filamentTempK: 3200.5 }),
      event('overvoltage', { voltageV: 196.2 }),
      event('insulationDamaged', { temperatureK: 403.2 }, { entity: null, connection: 2, end: 'a' }),
      event('singular', {}, { entity: null, entities: [1, 2] }),
    ]) {
      expect(parseWorkerMessage(good), JSON.stringify(good)).not.toBeNull();
    }
    for (const bad of [
      event('tripped', { cause: 'overload' }), // not a cause
      event('tripped', {}), // the cause is required
      event('tripped', { cause: 'thermal', poles: 2 }), // no extra keys
      event('blown', { cause: 'thermal' }), // a fuse's event has no detail
      event('hiccup', { phase: 'on' }),
      event('lampBurnout', { filamentTempK: '3200' }),
      event('lampBurnout', { filamentTempK: Number.POSITIVE_INFINITY }),
      event('overvoltage', {}),
      event('terminationOverheat', { temperatureK: 393 }, { entity: null, connection: 2, end: 'c' }),
    ]) {
      expect(parseWorkerMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('types a detail by kind through simEventDetail', () => {
    const parsed = parseWorkerMessage(event('tripped', { cause: 'groundFault' }));
    expect(parsed?.type).toBe('events');
    const [trip] = (parsed as { events: SimEvent[] }).events;
    expect(simEventDetail(trip, 'tripped')?.cause).toBe('groundFault');
    expect(simEventDetail(trip, 'lampBurnout')).toBeNull();
    // Every kind has a detail schema, in kind order.
    expect(SimEventSchema.options.map((o) => o.shape.kind.value)).toStrictEqual([...SIM_EVENT_KINDS]);
    expect(SIM_EVENT_KINDS).toContain('lampBurnout');
    expect(SIM_EVENT_KINDS).toContain('overvoltage');
    expect(DEVICE_EVENT_KINDS).toStrictEqual(
      SIM_EVENT_KINDS.filter((k) => !ISLAND_EVENT_KINDS.includes(k) && !CONNECTION_EVENT_KINDS.includes(k)),
    );
  });

  it('records a trip cause by code: none, then the causes', () => {
    expect([...RECORD_TRIP_CAUSE_VALUES]).toStrictEqual([
      'none',
      'thermal',
      'magnetic',
      'groundFault',
      'arcFault',
      'test',
    ]);
    expect(BREAKER_STATE_VALUES).toStrictEqual(['off', 'on', 'tripped']);
  });

  it('lays the connection record out as every f64, then every u8 (the fast path), and checks it', () => {
    expect(CONNECTION_RECORD_BYTES).toBe(120);
    expect(CONNECTION_RECORD_OFFSETS.endADegradation).toBe(96);
    expect(CONNECTION_RECORD_OFFSETS.endBDegradation).toBe(104);
    expect(CONNECTION_U8_OFFSET).toBe(112);
    expect(connectionLayoutProblems(CONNECTION_OUTPUT_FIELDS, CONNECTION_RECORD_BYTES)).toStrictEqual([]);
    // A u8 among the f64s, a gap, or a record too short or misaligned each fail.
    const swapped = [
      CONNECTION_OUTPUT_FIELDS[14],
      ...CONNECTION_OUTPUT_FIELDS.slice(0, 14),
      ...CONNECTION_OUTPUT_FIELDS.slice(15),
    ];
    expect(connectionLayoutProblems(swapped, CONNECTION_RECORD_BYTES).length).toBeGreaterThan(0);
    const gap = CONNECTION_OUTPUT_FIELDS.map((f, i) => (i === 3 ? { ...f, offset: f.offset + 8 } : f));
    expect(connectionLayoutProblems(gap, CONNECTION_RECORD_BYTES)).toContain('endBDropV: at 32, expected 24');
    expect(connectionLayoutProblems(CONNECTION_OUTPUT_FIELDS, 112)).toStrictEqual(['the fields run past the record']);
    expect(connectionLayoutProblems(CONNECTION_OUTPUT_FIELDS, 124)).toStrictEqual([
      'the record is not a multiple of 8 bytes',
    ]);
  });

  it("puts each sensing field's readings bit in its schema, and isDeviceReading reads it (never 0 V)", () => {
    for (const kind of ['breaker.gfci1p', 'breaker.afci1p']) {
      const schema = DEVICE_OUTPUT_SCHEMAS[kind];
      const bit = (name: string) => schema.fields.find((f) => f.name === name)?.readingBit;
      expect(bit('currentA'), kind).toBe(DEVICE_READING_CURRENT);
      expect(bit('neutralCurrentA'), kind).toBe(DEVICE_READING_NEUTRAL_CURRENT);
      expect(bit('lineVoltageV'), kind).toBe(DEVICE_READING_LINE_VOLTAGE);
      expect(bit('loadVoltageV'), kind).toBe(DEVICE_READING_LOAD_VOLTAGE);
      expect(bit('thermalFraction'), kind).toBeUndefined();
      const values = { lineVoltageV: 0, loadVoltageV: 119.8, readings: DEVICE_READING_LOAD_VOLTAGE };
      expect(isDeviceReading(schema, values, 'lineVoltageV')).toBe(false); // 0 here is no reading
      expect(isDeviceReading(schema, values, 'loadVoltageV')).toBe(true);
      expect(isDeviceReading(schema, values, 'thermalFraction')).toBe(true); // no bit: the status rule
      expect(isDeviceReading(schema, values, 'nope')).toBe(true);
    }
    expect(DEVICE_OUTPUT_SCHEMAS['breaker.gfci1p'].fields.find((f) => f.name === 'residualMa')?.readingBit).toBe(
      DEVICE_READING_RESIDUAL,
    );
    // A bit that isn't one bit, or a bit without a readings field, is a schema problem.
    const bad = {
      kind: 'test',
      recordBytes: 16,
      fields: [
        { name: 'volts', type: 'f64' as const, offset: 0, unit: 'V', values: null, readingBit: 3 },
        { name: 'status', type: 'u8' as const, offset: 8, unit: null, values: ['unsolved'] },
      ],
    };
    expect(deviceOutputSchemaProblems(bad)).toStrictEqual([
      'volts: readingBit must be one bit of a u8',
      'volts: a readingBit needs a u8 readings field',
    ]);
    // The descriptor carries the bit.
    const parsed = TopologyDescriptorSchema.parse({
      ...descriptor,
      devices: [{ entity: 1, kind: 'breaker.gfci1p', recordOffset: 0 }],
      schemas: { 'breaker.gfci1p': DEVICE_OUTPUT_SCHEMAS['breaker.gfci1p'] },
    });
    expect(parsed.schemas['breaker.gfci1p'].fields[0].readingBit).toBe(DEVICE_READING_CURRENT);
  });

  it('keeps the device readings bits disjoint', () => {
    const bits = [
      DEVICE_READING_CURRENT,
      DEVICE_READING_NEUTRAL_CURRENT,
      DEVICE_READING_RESIDUAL,
      DEVICE_READING_LINE_VOLTAGE,
      DEVICE_READING_LOAD_VOLTAGE,
    ];
    expect(bits.reduce((a, b) => a | b, 0)).toBe(31);
    expect(new Set(bits).size).toBe(bits.length);
  });
});
