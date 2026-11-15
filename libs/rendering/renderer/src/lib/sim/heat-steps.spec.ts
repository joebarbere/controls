import {
  CONNECTION_OUTPUT_FIELDS,
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  CONNECTION_RECORD_OPEN,
  fakeSnapshotView,
  NetlistReadout,
  SIM_PROTOCOL_VERSION,
  type TopologyDescriptor,
} from '@controls/sim-protocol';
import { heatStep } from './heat-scale';
import { createHeatSteps, joinHeat, updateHeatSteps } from './heat-steps';
import { STEP_UNKNOWN } from './overlay-scale';

/** Connection record bytes: per record, values by field name (u8 fields by code). */
function connectionBytes(records: readonly Readonly<Record<string, number>>[]): Uint8Array {
  const bytes = new Uint8Array(records.length * CONNECTION_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  records.forEach((record, i) => {
    for (const [name, value] of Object.entries(record)) {
      const field = CONNECTION_OUTPUT_FIELDS.find((f) => f.name === name);
      if (field === undefined) throw new Error(`no field ${name}`);
      const at = i * CONNECTION_RECORD_BYTES + field.offset;
      if (field.type === 'f64') view.setFloat64(at, value, true);
      else view.setUint8(at, value);
    }
  });
  return bytes;
}

const OK = 1;
const INTERMITTENT_OPEN = 3;

/** Two conductors (1 netlisted, 2 not) and a lead (3), one DC island; connection 4 has no record. */
const descriptor = (
  generation = 1,
  kinds: readonly string[] = ['conductor', 'conductor', 'lead'],
): TopologyDescriptor => ({
  protocol: SIM_PROTOCOL_VERSION,
  generation,
  topologyHash: 'ab'.repeat(32),
  nodes: [
    { island: 0, members: [{ entity: 1, terminal: 'a' }] },
    { island: 0, members: [{ entity: 2, terminal: 'a' }] },
  ],
  branches: [
    { element: { kind: 'connection', connection: 1 }, a: 0, b: 1, island: 0 },
    { element: { kind: 'connection', connection: 3 }, a: 1, b: 0, island: 0 },
  ],
  islands: [{ kind: 'dc', nodes: [0, 1] }],
  devices: [],
  schemas: {},
  connections: [
    { connection: 1, kind: kinds[0], recordOffset: 0, branch: 0 },
    { connection: 2, kind: kinds[1], recordOffset: CONNECTION_RECORD_BYTES, branch: -1 },
    { connection: 3, kind: kinds[2], recordOffset: 2 * CONNECTION_RECORD_BYTES, branch: 1 },
  ],
  connectionSchemas: Object.fromEntries(
    kinds.filter((k) => k in CONNECTION_OUTPUT_SCHEMAS).map((k) => [k, CONNECTION_OUTPUT_SCHEMAS[k]]),
  ),
});

/** The bad-termination figures: a loose end a at 394 K on a 303 K conductor; a wire with a free end; a warm lead. */
const records = (endA = 393.822) =>
  connectionBytes([
    { conductorTempK: 303.033, endATempK: endA, endAState: OK, endBTempK: 301.709, endBState: OK, status: 1 },
    // Not netlisted (a free end a, state none, temperature written 0); its landed end b is open and hot.
    { conductorTempK: 293.15, endBTempK: 450, endBState: INTERMITTENT_OPEN, status: CONNECTION_RECORD_OPEN },
    // A lead: clip ends have no termination node.
    { conductorTempK: 317, status: 1 },
  ]);

function setup(d: TopologyDescriptor = descriptor()) {
  const readout = NetlistReadout.of(d);
  const reading = readout.createReading();
  const read = (bytes: Uint8Array) => readout.read(fakeSnapshotView({ descriptor: d, connections: bytes }), reading);
  return { readout, reading, read };
}

describe('heat steps (F3.6 part 3)', () => {
  it('shows each half’s hottest node: the end’s hot spot or the conductor', () => {
    const { readout, reading, read } = setup();
    read(records());
    const join = joinHeat([1, 2, 3, 4], readout);
    expect(Array.from(join)).toStrictEqual([0, 1, 2, -1]);
    const steps = createHeatSteps(4);
    expect(updateHeatSteps(steps, reading, join)).toBe(true);
    const fresh = (t: number) => heatStep(t, STEP_UNKNOWN);
    // Wire 1: the loose end's half is hot (bin 16, the overheat point), the good end's shows its 302 K.
    // Wire 2: open, not netlisted, still has temperatures (own state): its free end's half shows the
    // conductor at ambient (bin 0, a reading), its open end's half the 450 K end.
    // The lead: both halves its conductor. Connection 4: no record, so no reading (never cold).
    expect([Array.from(steps.a), Array.from(steps.b)]).toStrictEqual([
      [16, fresh(293.15), fresh(317), STEP_UNKNOWN],
      [fresh(303.033), 16, fresh(317), STEP_UNKNOWN],
    ]);
    expect(fresh(303.033)).toBe(1);
    expect(fresh(293.15)).toBe(0);
  });

  it('a cooler end never pulls its half below the conductor', () => {
    const { readout, reading, read } = setup();
    read(
      connectionBytes([{ conductorTempK: 380, endATempK: 300, endAState: OK, endBTempK: 0, endBState: OK, status: 1 }]),
    );
    const steps = createHeatSteps(1);
    updateHeatSteps(steps, reading, joinHeat([1], readout));
    expect([steps.a[0], steps.b[0]]).toStrictEqual([heatStep(380, STEP_UNKNOWN), heatStep(380, STEP_UNKNOWN)]);
  });

  it('no snapshot, no record or a zeroed record is no reading, never cold', () => {
    const steps = createHeatSteps(3);
    expect(updateHeatSteps(steps, null, Int32Array.of(0, 1, 2))).toBe(false); // created unknown, stays unknown
    expect(Array.from(steps.a)).toStrictEqual([STEP_UNKNOWN, STEP_UNKNOWN, STEP_UNKNOWN]);
    // A kind the readout doesn't know reads as zeros: unknown.
    const { readout, reading, read } = setup(descriptor(1, ['conductor', 'mystery', 'lead']));
    read(records());
    updateHeatSteps(steps, reading, joinHeat([1, 2, 3], readout));
    expect([steps.a[1], steps.b[1]]).toStrictEqual([STEP_UNKNOWN, STEP_UNKNOWN]);
    expect(steps.a[0]).toBe(16);
    // A source reset (null reading) takes everything back to unknown.
    expect(updateHeatSteps(steps, null, joinHeat([1, 2, 3], readout))).toBe(true);
    expect(Array.from(steps.b)).toStrictEqual([STEP_UNKNOWN, STEP_UNKNOWN, STEP_UNKNOWN]);
  });

  it('reports a change only when a step moves (hysteresis holds a steady node)', () => {
    const { readout, reading, read } = setup();
    const join = joinHeat([1, 2, 3], readout);
    const steps = createHeatSteps(3);
    read(records());
    expect(updateHeatSteps(steps, reading, join)).toBe(true);
    read(records(394.5)); // within the bin's hysteresis
    expect(updateHeatSteps(steps, reading, join)).toBe(false);
    read(records(520)); // the loose end runs away
    expect(updateHeatSteps(steps, reading, join)).toBe(true);
    expect(steps.a[0]).toBe(heatStep(520, STEP_UNKNOWN));
  });

  it('carries steps across a new descriptor by connection id (ADR 0011 amendment §6)', () => {
    const first = setup();
    first.read(records());
    const steps = createHeatSteps(3);
    updateHeatSteps(steps, first.reading, joinHeat([1, 2, 3], first.readout));
    // An intermittent toggle recompiles: connection 3's record moves to index 0 in the new generation.
    const moved: TopologyDescriptor = {
      ...descriptor(2),
      connections: [
        { connection: 3, kind: 'lead', recordOffset: 0, branch: 1 },
        { connection: 1, kind: 'conductor', recordOffset: CONNECTION_RECORD_BYTES, branch: 0 },
      ],
    };
    const second = setup(moved);
    second.read(
      connectionBytes([
        { conductorTempK: 317, status: 1 },
        { conductorTempK: 303.033, endATempK: 393.822, endAState: OK, endBTempK: 301.709, endBState: OK, status: 1 },
      ]),
    );
    const join = joinHeat([1, 2, 3], second.readout);
    expect(Array.from(join)).toStrictEqual([1, -1, 0]);
    updateHeatSteps(steps, second.reading, join);
    expect([steps.a[0], steps.a[2]]).toStrictEqual([16, heatStep(317, STEP_UNKNOWN)]);
    expect(steps.a[1]).toBe(STEP_UNKNOWN); // wire 2 left the bank
  });
});
