import {
  fakeSnapshotView,
  ISLAND_FLAG_NON_CONVERGED,
  ISLAND_FLAG_SINGULAR,
  NetlistReadout,
  SIM_PROTOCOL_VERSION,
  type FakeIsland,
  type TopologyDescriptor,
} from '@controls/sim-protocol';
import { OVER_RANGE_BIN, scalesByBand, STEP_NO_SCALE, STEP_UNKNOWN } from './overlay-scale';
import { createOverlaySteps, joinOverlayItems, updateOverlaySteps, type OverlayItems } from './overlay-steps';

/**
 * A synthetic bands table (the engine's `NOMINAL_BANDS` holds only `none` until sources choose a
 * band): index 1 is the 12 V DC scale, 2 the 208Y/120 AC one, 3 a band with no scale.
 */
const BANDS = ['none', 'dc12', 'ac208y120', 'not-a-scale'];
const scales = scalesByBand(BANDS);

/** A battery (1) and a switch (2) in one island with two leads; a lamp (3) alone in another. */
const descriptor = (kind: 'dc' | 'ac' | 'mixed' = 'dc'): TopologyDescriptor => ({
  protocol: SIM_PROTOCOL_VERSION,
  generation: 1,
  topologyHash: '12'.repeat(32),
  nodes: [
    {
      island: 0,
      members: [
        { entity: 1, terminal: 'neg' },
        { entity: 2, terminal: 'b' },
      ],
    },
    {
      island: 0,
      members: [
        { entity: 1, terminal: 'pos' },
        { entity: 2, terminal: 'a' },
      ],
    },
    { island: 1, members: [{ entity: 3, terminal: 'a' }] },
    { island: 1, members: [{ entity: 3, terminal: 'b' }] },
  ],
  branches: [
    { element: { kind: 'entity', entity: 1, part: 'cell' }, a: 0, b: 1, island: 0 },
    { element: { kind: 'connection', connection: 1 }, a: 1, b: 1, island: 0 },
    { element: { kind: 'connection', connection: 2 }, a: 0, b: 0, island: 0 },
  ],
  islands: [
    { kind, nodes: [0, 1] },
    { kind: 'empty', nodes: [2, 3] },
  ],
  devices: [],
  schemas: {},
});

const items: OverlayItems = {
  terminals: [
    { entity: 1, terminal: 'neg' },
    { entity: 1, terminal: 'pos' },
    { entity: 2, terminal: 'a' },
    { entity: 3, terminal: 'a' },
    { entity: 9, terminal: 'x' }, // not in the netlist (an unknown device)
  ],
  leads: [
    { connection: 1, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } },
    { connection: 2, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } },
    { connection: 7, a: { entity: 1, terminal: 'pos' }, b: { entity: 3, terminal: 'a' } }, // added since this generation
  ],
};

/** Steps after one snapshot of the bench, with island 0 as given. */
function run(island0: FakeIsland, options: { amps?: number; volts?: number; kind?: 'dc' | 'ac' | 'mixed' } = {}) {
  const d = descriptor(options.kind);
  const readout = NetlistReadout.of(d);
  const reading = readout.createReading();
  const join = joinOverlayItems(items, readout);
  const steps = createOverlaySteps(items.terminals.length, items.leads.length);
  const amps = options.amps ?? 0.42;
  readout.read(
    fakeSnapshotView({
      descriptor: d,
      nodes: [
        [0, 0],
        [options.volts ?? 12, 0],
      ],
      branches: [
        [-amps, 0],
        [amps, 0],
        [-amps, 0],
      ],
      islands: [
        { reference: 0, ...island0 },
        { iterations: 0, reference: -1 },
      ],
    }),
    reading,
  );
  const changed = updateOverlaySteps(steps, { readout, reading, join, scales });
  return { steps, changed, readout, reading, join };
}

describe('overlay display steps', () => {
  it('joins drawn terminals and leads to the descriptor; items missing from it are unknown', () => {
    const join = joinOverlayItems(items, NetlistReadout.of(descriptor()));
    expect([...join.terminalNode]).toStrictEqual([0, 1, 1, 2, -1]);
    expect([...join.leadBranch]).toStrictEqual([1, 2, -1]);
    expect([...join.leadNodeA]).toStrictEqual([1, 0, 1]);
    expect([...join.leadNodeB]).toStrictEqual([1, 0, 2]);
    expect([...joinOverlayItems(items, null).terminalNode]).toStrictEqual([-1, -1, -1, -1, -1]);
  });

  it('a solved island with a scale gets bins; its |V| is against the island reference', () => {
    const { steps, changed } = run({ band: 1 });
    expect(changed).toBe(true);
    // dc12: 16 V full scale, 0.5 V a bin: 0 V → bin 0, 12 V → bin 24.
    expect([...steps.terminalVolts]).toStrictEqual([0, 24, 24, STEP_UNKNOWN, STEP_UNKNOWN]);
    expect([...steps.leadVoltsA]).toStrictEqual([24, 0, 24]);
    expect([...steps.leadVoltsB]).toStrictEqual([24, 0, STEP_UNKNOWN]);
  });

  it('band 0 is no scale: no bin at all, not the first bin of a scale', () => {
    const { steps } = run({ band: 0 });
    expect([...steps.terminalVolts]).toStrictEqual([
      STEP_NO_SCALE,
      STEP_NO_SCALE,
      STEP_NO_SCALE,
      STEP_UNKNOWN,
      STEP_UNKNOWN,
    ]);
    // A band the renderer has no scale for is no scale too.
    expect(run({ band: 3 }).steps.terminalVolts[1]).toBe(STEP_NO_SCALE);
    expect(run({ band: 200 }).steps.terminalVolts[1]).toBe(STEP_NO_SCALE);
    // Current has one scale for every band, so band 0 still shows current.
    expect(run({ band: 0 }).steps.leadAmps[0]).toBeGreaterThan(0);
  });

  it.each<[string, FakeIsland, ('dc' | 'mixed')?]>([
    ['singular', { band: 1, flags: ISLAND_FLAG_SINGULAR }],
    ['non-converged', { band: 1, flags: ISLAND_FLAG_NON_CONVERGED }],
    ['unmodelled (0 iterations)', { band: 1, iterations: 0 }],
    ['mixed', { band: 1 }, 'mixed'],
    ['without a reference', { band: 1, reference: -1 }],
  ])('a %s island shows no reading, never a 0 V or 0 A bin', (_, island, kind) => {
    const { steps } = run(island, { kind, volts: 0, amps: 0 });
    expect(steps.terminalVolts[0]).toBe(STEP_UNKNOWN);
    expect(steps.terminalVolts[1]).toBe(STEP_UNKNOWN);
    expect(steps.leadVoltsA[0]).toBe(STEP_UNKNOWN);
    if (island.reference !== -1) {
      expect(steps.leadAmps[0]).toBe(STEP_UNKNOWN);
      expect(steps.leadDirection[0]).toBe(0);
    }
  });

  it('a solved island at 0 V and 0 A reads bin 0: a real zero, distinct from unknown', () => {
    const { steps } = run({ band: 1 }, { volts: 0, amps: 0 });
    expect(steps.terminalVolts[1]).toBe(0);
    expect(steps.leadAmps[0]).toBe(0);
    expect(steps.leadDirection[0]).toBe(0);
  });

  it('DC current has a direction (from end a to end b, positive); AC shows magnitude only', () => {
    const dc = run({ band: 1 }).steps;
    expect([...dc.leadDirection]).toStrictEqual([1, -1, 0]);
    expect(dc.leadAmps[2]).toBe(STEP_UNKNOWN); // not in this generation
    const ac = run({ band: 2 }, { kind: 'ac', volts: 120 }).steps;
    expect([...ac.leadDirection]).toStrictEqual([0, 0, 0]);
    expect(ac.leadAmps[0]).toBe(ac.leadAmps[1]);
    // 120 V on the 208Y/120 scale (277.3 V full scale): bin 13.
    expect(ac.terminalVolts[1]).toBe(13);
  });

  it('over range reads the over-range bin', () => {
    const { steps } = run({ band: 1 }, { volts: 400, amps: 500 });
    expect(steps.terminalVolts[1]).toBe(OVER_RANGE_BIN);
    expect(steps.leadAmps[0]).toBe(OVER_RANGE_BIN);
  });

  it('reports a change only when a step moved (hysteresis holds near a boundary), and resets to unknown', () => {
    const { steps, readout, reading, join } = run({ band: 1 }, { volts: 12 });
    const inputs = { readout, reading, join, scales };
    expect(updateOverlaySteps(steps, inputs)).toBe(false); // same reading
    const reread = (volts: number) => {
      readout.read(
        fakeSnapshotView({
          descriptor: readout.descriptor,
          nodes: [
            [0, 0],
            [volts, 0],
          ],
          branches: [
            [-0.42, 0],
            [0.42, 0],
            [-0.42, 0],
          ],
          islands: [
            { reference: 0, band: 1 },
            { iterations: 0, reference: -1 },
          ],
        }),
        reading,
      );
      return updateOverlaySteps(steps, inputs);
    };
    expect(reread(11.8)).toBe(false); // 23.6: within half a bin of 24
    expect(steps.terminalVolts[1]).toBe(24);
    expect(reread(11.7)).toBe(true); // 23.4: past it
    expect(steps.terminalVolts[1]).toBe(23);
    expect(updateOverlaySteps(steps, { readout: null, reading: null, join, scales })).toBe(true);
    expect([...steps.terminalVolts]).toStrictEqual(Array(5).fill(STEP_UNKNOWN));
    expect([...steps.leadAmps]).toStrictEqual([STEP_UNKNOWN, STEP_UNKNOWN, STEP_UNKNOWN]);
  });

  it('new steps start unknown, never 0', () => {
    const steps = createOverlaySteps(2, 1);
    expect([...steps.terminalVolts, ...steps.leadVoltsA, ...steps.leadAmps]).toStrictEqual(Array(4).fill(STEP_UNKNOWN));
  });
});
