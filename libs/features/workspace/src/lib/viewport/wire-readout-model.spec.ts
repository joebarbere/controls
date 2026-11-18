import type { WireRef } from '@controls/renderer';
import { CONNECTION_OXIDATION_ONSET_K, fakeSnapshotView, NetlistReadout } from '@controls/sim-protocol';
import { benchDescriptor, connectionRecords } from '../netlist/netlist.fakes';
import {
  READOUT_OVERHEAT_K,
  sameWireReadout,
  type ReadoutWorld,
  wireCycleCandidates,
  wireCycleOrder,
  WireReadoutSampler,
  type WireReadoutView,
  wireTitle,
} from './wire-readout-model';

/*
 * The wire readout's model (F3.6 part 3): what one connection record reads as, the never-0 rules for
 * gaps and missing readings, and the display-resolution change detection that keeps a steady wire
 * from re-formatting on every snapshot. The records stand in for the bench descriptor's three leads
 * (c1 to c3) and its wire c9, which here carries the bad-termination golden's loose conductor.
 */

const descriptor = benchDescriptor();
const lead = { currentA: 0.3906, conductorDropV: 0.03, conductorTempK: 293.4, status: 1, readings: 63 };
/** The `wire.info` golden's wire 2 (`apps/sim-cli/src/goldens/wire-info/bad-termination.txt`). */
const LOOSE = {
  currentA: 11.8059,
  conductorDropV: 0.2011,
  endADropV: 0.300478,
  endBDropV: 0.00610151,
  conductorTempK: 303.033,
  endATempK: 393.822,
  endBTempK: 301.709,
  endAState: 1,
  endBState: 1,
  status: 1,
  readings: 63,
};
const view = (wire: Readonly<Record<string, number>>, first: Readonly<Record<string, number>> = lead) =>
  fakeSnapshotView({ descriptor, connections: connectionRecords([first, lead, lead, wire]) });
const world: ReadoutWorld = {
  connections: [
    { id: 1, route: null, cable: null, label: null },
    { id: 9, route: [], cable: null, label: null },
  ],
};
const WIRE = { kind: 'connection', id: 9 } as const;
const LEAD = { kind: 'connection', id: 1 } as const;

function readout(wire: Readonly<Record<string, number>>, target: WireRef = WIRE): WireReadoutView {
  const sampler = new WireReadoutSampler();
  sampler.update(view(wire), target);
  return sampler.format(target, world, 'hover');
}
const rows = (r: WireReadoutView) =>
  r.parts.map((p) => (p.terminated ? [p.name, p.drop, p.temperature] : [p.name, 'no termination']));

describe('the wire readout (F3.6 part 3)', () => {
  it("shows the bad termination's current, drops and each end's temperature separately from the conductor's", () => {
    const r = readout(LOOSE);
    expect(r.title).toBe('Wire 9');
    expect(r.source).toBe('hover');
    expect(r.current).toBe('11.8 A');
    expect(rows(r)).toStrictEqual([
      ['Conductor', '201 mV', '303 K (30 °C)'],
      ['End a', '300 mV', '394 K (121 °C)'],
      ['End b', '6.10 mV', '302 K (29 °C)'],
    ]);
    // 393.8 K is past ambient + 100 K (the engine's terminationOverheat point) and below the oxidation onset.
    expect(READOUT_OVERHEAT_K).toBeCloseTo(393.15, 9);
    expect(r.state).toBe('overheating at end a');
  });

  it("shows a lead's clips as no termination, never 0 K", () => {
    const r = readout(LOOSE, LEAD);
    expect(r.title).toBe('Test lead 1');
    expect(r.current).toBe('391 mA');
    expect(rows(r)).toStrictEqual([
      ['Conductor', '30.0 mV', '293 K (20 °C)'],
      ['End a', 'no termination'],
      ['End b', 'no termination'],
    ]);
    expect(r.state).toBe('normal');
  });

  it('shows no reading at all without a snapshot, or for a connection with no record', () => {
    const sampler = new WireReadoutSampler();
    expect(sampler.update(null, WIRE)).toBe(true);
    const none = sampler.format(WIRE, world, 'selection');
    expect(none.current).toBe('no reading');
    expect(none.parts.map((p) => [p.drop, p.temperature])).toStrictEqual([
      ['no reading', 'no reading'],
      ['no reading', 'no reading'],
      ['no reading', 'no reading'],
    ]);
    expect(none.state).toBe('no reading: the simulation has no snapshot');
    sampler.update(view(LOOSE), { kind: 'connection', id: 42 });
    expect(sampler.format({ kind: 'connection', id: 42 }, world, 'hover').state).toBe('no reading: not simulated');
  });

  it('shows no reading for an electrical field whose bit is clear (never 0 A or 0 V); temperatures stay', () => {
    const r = readout({ ...LOOSE, currentA: 0, conductorDropV: 0, endADropV: 0, endBDropV: 0, status: 2, readings: 0 });
    expect(r.current).toBe('no reading');
    expect(rows(r)).toStrictEqual([
      ['Conductor', 'no reading', '303 K (30 °C)'],
      ['End a', 'no reading', '394 K (121 °C)'],
      ['End b', 'no reading', '302 K (29 °C)'],
    ]);
    expect(r.state).toBe('overheating at end a');
    expect(readout({ ...LOOSE, endATempK: 300, status: 3, readings: 0 }).state).toBe('not solved (singular)');
  });

  it('an open record: 0 A and 0 V where they are readings, a free end with no termination', () => {
    // As the netlist fakes' open wire: bits 1 to 8 (current, drops) and end a's terminal voltage.
    const r = readout({ conductorTempK: 293.15, endATempK: 293.15, endAState: 1, status: 4, readings: 31 });
    expect(r.current).toBe('0 A');
    expect(rows(r)).toStrictEqual([
      ['Conductor', '0 V', '293 K (20 °C)'],
      ['End a', '0 V', '293 K (20 °C)'],
      ['End b', 'no termination'],
    ]);
    expect(r.state).toBe('open: not in a circuit');
  });

  it('never claims 0 V across a gap: an intermittent open end and a fused conductor read "gap"', () => {
    const open = { ...LOOSE, currentA: 0, endAState: 3, status: 4 };
    const unknown = readout({ ...open, endADropV: 0, readings: 1 | 2 | 8 });
    expect(rows(unknown)[1]).toStrictEqual(['End a', 'gap, no reading', '394 K (121 °C)']);
    expect(unknown.current).toBe('0 A');
    expect(unknown.state).toBe('intermittent at end a, open now');
    const known = readout({ ...open, endADropV: 119.28, readings: 63 });
    expect(rows(known)[1]).toStrictEqual(['End a', 'gap 119 V', '394 K (121 °C)']);

    const fusedLead = { ...lead, currentA: 0, conductorDropV: 0, conductorTempK: 1358, conductorState: 1, status: 4 };
    const fused = new WireReadoutSampler();
    fused.update(view(LOOSE, { ...fusedLead, readings: 1 }), LEAD);
    const f = fused.format(LEAD, world, 'hover');
    expect(rows(f)[0]).toStrictEqual(['Conductor', 'gap, no reading', '1358 K (1085 °C)']);
    expect(f.state).toBe('fused');
    fused.update(view(LOOSE, { ...fusedLead, conductorDropV: 12, readings: 3 }), LEAD);
    expect(fused.format(LEAD, world, 'hover').parts[0].drop).toBe('gap 12.0 V');
  });

  it('names intermittent, arcing, degrading and insulation damage, worst first', () => {
    expect(readout({ ...LOOSE, endBState: 2 }).state).toBe('intermittent at end b, closed now, overheating at end a');
    expect(readout({ ...LOOSE, endAState: 4, endATempK: 900 }).state).toBe(
      'arcing at end a, degrading at end a (above the oxidation onset)',
    );
    expect(readout({ ...LOOSE, endATempK: 450, endBTempK: 430, insulationDamaged: 1 }).state).toBe(
      'degrading at ends a and b (above the oxidation onset), insulation damaged',
    );
    expect(readout({ ...LOOSE, endATempK: 393 }).state).toBe('normal');
  });

  it('says a cable jacket has no reading of its own', () => {
    const cable = { kind: 'cable', id: 1 } as const;
    const r = readout(LOOSE, cable);
    expect(r.title).toBe('Cable 1');
    expect(r.parts).toStrictEqual([]);
    expect(r.state).toBe('no reading: a cable jacket (its conductors have readings)');
  });

  it('titles wires by kind, label and cable from the world', () => {
    const w: ReadoutWorld = {
      connections: [
        { id: 3, route: null, cable: null, label: null },
        { id: 5, route: [], cable: null, label: 'L1' },
        { id: 7, route: null, cable: { id: 2 }, label: null },
      ],
    };
    expect(wireTitle({ kind: 'connection', id: 3 }, w)).toBe('Test lead 3');
    expect(wireTitle({ kind: 'connection', id: 5 }, w)).toBe('Wire 5 "L1"');
    expect(wireTitle({ kind: 'connection', id: 7 }, w)).toBe('Wire 7 (cable 2)');
    expect(wireTitle({ kind: 'connection', id: 8 }, w)).toBe('Wire 8');
    expect(wireTitle({ kind: 'cable', id: 2 }, null)).toBe('Cable 2');
  });

  it('reports a change only at display resolution, or when the target changes', () => {
    const sampler = new WireReadoutSampler();
    expect(sampler.update(view(LOOSE), null)).toBe(false); // nothing hovered: nothing read
    expect(sampler.update(view(LOOSE), WIRE)).toBe(true); // a new target
    expect(sampler.update(view(LOOSE), WIRE)).toBe(false); // the same values
    expect(sampler.update(view({ ...LOOSE, currentA: 11.8061, endATempK: 393.9 }), WIRE)).toBe(false); // below 3 s.f. and 1 K
    expect(sampler.update(view({ ...LOOSE, currentA: 11.86 }), WIRE)).toBe(true); // 11.9 A now
    expect(sampler.update(view({ ...LOOSE, currentA: 11.86, endATempK: 394.6 }), WIRE)).toBe(true); // 395 K
    expect(sampler.update(view({ ...LOOSE, currentA: 11.86, endATempK: 394.6 }), LEAD)).toBe(true); // another wire
    expect(sampler.update(null, LEAD)).toBe(true); // a reset: no reading now
    expect(sampler.update(null, LEAD)).toBe(false);
  });

  it('format marks what it shows, so the next identical snapshot is no change', () => {
    const sampler = new WireReadoutSampler();
    const v = view(LOOSE);
    sampler.update(v, null); // the snapshot arrived before the hover
    const shown = sampler.format(WIRE, world, 'hover');
    expect(sampler.update(v, WIRE)).toBe(false);
    sampler.summary(LEAD, world); // announcing a selection leaves the hovered readout as shown
    expect(sampler.update(v, WIRE)).toBe(false);
    expect(sameWireReadout(shown, sampler.format(WIRE, world, 'hover'))).toBe(true);
    expect(sameWireReadout(shown, sampler.format(WIRE, world, 'selection'))).toBe(false);
  });

  it('summarises a selection in one sentence for the live region', () => {
    const sampler = new WireReadoutSampler();
    sampler.update(view(LOOSE), WIRE);
    expect(sampler.summary(WIRE, world)).toBe(
      'Wire 9 selected. Current 11.8 A. Conductor 303 K (30 °C), drop 201 mV. End a 394 K (121 °C), drop 300 mV. ' +
        'End b 302 K (29 °C), drop 6.10 mV. State: overheating at end a.',
    );
    expect(sampler.summary(LEAD, world)).toContain('End a no termination. End b no termination. State: normal.');
    expect(sampler.summary({ kind: 'cable', id: 1 }, world)).toBe(
      'Cable 1 selected: no reading: a cable jacket (its conductors have readings).',
    );
  });
});

describe('the wire readout: review cases (F3.6 part 3)', () => {
  it('a conductorState it does not know reads "conductor open" (a gap), not fused; open is fused', () => {
    const odd = new WireReadoutSampler();
    odd.update(view(LOOSE, { ...lead, currentA: 0, conductorState: 7, status: 4, readings: 1 }), LEAD);
    const r = odd.format(LEAD, world, 'hover');
    expect(r.parts[0].drop).toBe('gap, no reading');
    expect(r.state).toBe('conductor open');
    const fused = new WireReadoutSampler();
    fused.update(view(LOOSE, { ...lead, currentA: 0, conductorState: 1, status: 4, readings: 1 }), LEAD);
    expect(fused.format(LEAD, world, 'hover').state).toBe('fused');
  });

  it('an intermittently open end b without its drop bit reads "gap, no reading", never 0 V', () => {
    const r = readout({ ...LOOSE, endBState: 3, endBDropV: 0, currentA: 0, status: 4, readings: 1 | 2 | 4 | 16 | 32 });
    expect(rows(r)[2]).toStrictEqual(['End b', 'gap, no reading', '302 K (29 °C)']);
    expect(r.state).toBe('intermittent at end b, open now, overheating at end a');
  });

  it('update() reports state-only changes: an end opening, a readings bit flipping at value 0', () => {
    const sampler = new WireReadoutSampler();
    expect(sampler.update(view(LOOSE), WIRE)).toBe(true);
    expect(sampler.update(view({ ...LOOSE, endAState: 3 }), WIRE)).toBe(true);
    const zero = { ...LOOSE, endAState: 3, endADropV: 0 };
    expect(sampler.update(view({ ...zero, readings: 63 }), WIRE)).toBe(true); // 0 V was 300 mV
    expect(sampler.update(view({ ...zero, readings: 63 & ~4 }), WIRE)).toBe(true); // gap 0 V → gap, no reading
    expect(sampler.update(view({ ...zero, readings: 63 & ~4 }), WIRE)).toBe(false);
  });

  it('overheating starts at ambient + 100 K inclusive; degrading only strictly above the oxidation onset', () => {
    expect(readout({ ...LOOSE, endATempK: READOUT_OVERHEAT_K }).state).toBe('overheating at end a');
    expect(readout({ ...LOOSE, endATempK: READOUT_OVERHEAT_K - 1e-9 }).state).toBe('normal');
    expect(readout({ ...LOOSE, endATempK: CONNECTION_OXIDATION_ONSET_K }).state).toBe('overheating at end a');
    expect(readout({ ...LOOSE, endATempK: CONNECTION_OXIDATION_ONSET_K + 1e-9 }).state).toBe(
      'degrading at end a (above the oxidation onset)',
    );
  });

  it('protocol 8: a cooled end that degraded still reads degraded, with its factor; hot, it reads degrading', () => {
    // The carried P3 item: before protocol 8 a degraded end read `normal` once it cooled below the onset.
    expect(readout({ ...LOOSE, endATempK: 300, endADegradation: 3.217 }).state).toBe(
      'degraded at end a (contact 3.22 times as made)',
    );
    expect(readout({ ...LOOSE, endATempK: 300, endADegradation: 1 }).state).toBe('normal');
    expect(readout({ ...LOOSE, endATempK: 300, endADegradation: 1.004 }).state).toBe('normal'); // 1.00 at 3 s.f.
    expect(readout({ ...LOOSE, endATempK: CONNECTION_OXIDATION_ONSET_K + 5, endADegradation: 3.217 }).state).toBe(
      'degrading at end a (above the oxidation onset)',
    );
    expect(readout({ ...LOOSE, endATempK: READOUT_OVERHEAT_K + 1, endADegradation: 2 }).state).toBe(
      'degraded at end a (contact 2 times as made), overheating at end a',
    );
  });

  it('allocates its reading once per descriptor, and reads nothing with no target', () => {
    const create = vi.spyOn(NetlistReadout.prototype, 'createReading');
    const first = benchDescriptor(1);
    const records = connectionRecords([lead, lead, lead, LOOSE]);
    const sampler = new WireReadoutSampler();
    for (let i = 0; i < 50; i++) sampler.update(fakeSnapshotView({ descriptor: first, connections: records }), WIRE);
    expect(create).toHaveBeenCalledTimes(1);
    sampler.update(fakeSnapshotView({ descriptor: benchDescriptor(2), connections: records }), WIRE);
    expect(create).toHaveBeenCalledTimes(2);
    create.mockClear();
    const idle = new WireReadoutSampler();
    for (let i = 0; i < 50; i++)
      idle.update(fakeSnapshotView({ descriptor: benchDescriptor(3), connections: records }), null);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('wire cycling order (N, Shift+N)', () => {
  const order = wireCycleOrder({
    connections: [
      { id: 4, route: [] },
      { id: 1, route: null }, // a lead: not drawn as a wire
      { id: 2, route: [] },
    ],
    cables: [{ id: 1 }],
  });
  const ids = (wires: readonly { kind: string; id: number }[]) =>
    wires.map((w) => `${w.kind === 'cable' ? 'k' : 'c'}${w.id}`);

  it('is routed conductors by id, then cables', () => {
    expect(ids(order)).toStrictEqual(['c2', 'c4', 'k1']);
  });

  it('tries every wire once from the next one, wrapping, the current last', () => {
    expect(ids(wireCycleCandidates(order, null, 1))).toStrictEqual(['c2', 'c4', 'k1']);
    expect(ids(wireCycleCandidates(order, null, -1))).toStrictEqual(['k1', 'c4', 'c2']);
    expect(ids(wireCycleCandidates(order, { kind: 'connection', id: 4 }, 1))).toStrictEqual(['k1', 'c2', 'c4']);
    expect(ids(wireCycleCandidates(order, { kind: 'connection', id: 2 }, -1))).toStrictEqual(['k1', 'c4', 'c2']);
    expect(wireCycleCandidates([], null, 1)).toStrictEqual([]);
  });
});
