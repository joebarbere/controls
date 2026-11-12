import { World } from '@controls/save-format';
import { engineBus } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { wiredLoopWorld } from '../../testing/wired-loop';
import { formatWireInfo, formatWireNumber, wireInfo } from './wire-info';

/*
 * `wire.info <id>` (F3.6 part 3): the text of one connection's record. The bad-termination scenario's
 * golden (`apps/sim-cli/src/bad-termination.spec.ts`, and Chromium in game-e2e) pins a solved
 * conductor; these pin the other shapes on the wired loop (`testing/wired-loop.ts`).
 */

describe('formatWireNumber', () => {
  it("is six significant figures by ECMA-262's toPrecision, trailing zeros dropped", () => {
    expect(formatWireNumber(0)).toBe('0');
    expect(formatWireNumber(11.80594321)).toBe('11.8059');
    expect(formatWireNumber(293.15)).toBe('293.15');
    expect(formatWireNumber(0.000516818123)).toBe('0.000516818');
    expect(formatWireNumber(1234567)).toBe('1234570');
    expect(formatWireNumber(1.5e-7)).toBe('1.5e-7');
  });
});

describe('wire.info', () => {
  const host = () => new SourceHost(engineBus(5, wiredLoopWorld()));

  it('an un-netlisted conductor reads open: zero current and drops, its free end none', () => {
    const h = host();
    const lines = formatWireInfo(h.engine, h.bus.state, 7).split('\n');
    expect(lines.slice(0, 4)).toStrictEqual([
      'wire.info 7 tick 0',
      'conductor 7 conductor.tallowmere-thhn-14-solid@1 length 1500 mm',
      'status open (not netlisted)',
      'current 0 A',
    ]);
    expect(lines[4]).toMatch(/^conductor R 0\.0124\d* Ω at 293\.15 K, drop 0 V$/);
    expect(lines[5]).toMatch(/^end a ok, contact [0-9.e-]+ Ω at 293\.15 K, drop 0 V, conductor side \d+\.\d+ V$/);
    expect(lines.slice(6)).toStrictEqual(['end b none', 'insulation intact', '']);
  });

  it('a solved conductor gives every drop and the conductor-side voltages; a lead its clips inside R', () => {
    const h = host();
    const lines = formatWireInfo(h.engine, h.bus.state, 2).split('\n');
    expect(lines[2]).toBe('status solved');
    expect(lines[3]).toMatch(/^current \d+\.\d+ A$/);
    expect(lines[5]).toMatch(/^end a ok, contact .* Ω at 293\.15 K, drop .* V, conductor side .* V$/);
    const lead = formatWireInfo(h.engine, h.bus.state, 1).split('\n');
    expect(lead[1]).toBe('lead 1 lead.quillfern-test-1m@1 length 1000 mm');
    expect(lead[4]).toMatch(/^conductor R 0\.0409\d* Ω at 293\.15 K, drop .* V$/);
    expect(lead.slice(5, 7)).toStrictEqual(['end a none', 'end b none']);
  });

  /** The wired loop with sim keys merged into chosen connections' bags. */
  const opened = (sims: Readonly<Record<number, Readonly<Record<string, string | number>>>>) => {
    const base = wiredLoopWorld();
    const world = World.parse({
      ...base,
      connections: base.connections.map((c) => ({ ...c, sim: { ...c.sim, ...(sims[c.id] ?? {}) } })),
    });
    return new SourceHost(engineBus(5, world));
  };

  it('an open end prints `open` and the gap across it, never its closed-contact resistance', () => {
    const h = opened({ 2: { endADegradation: 10_000, endATerminationId: 1 } });
    const lines = formatWireInfo(h.engine, h.bus.state, 2).split('\n');
    expect(lines[2]).toBe('status open (not netlisted)');
    expect(lines[3]).toBe('current 0 A');
    expect(lines[5]).toMatch(/^end a intermittentOpen, open at 293\.15 K, gap 1\d\.\d+ V, conductor side 0 V$/);
    expect(lines[5]).not.toContain('Ω');
    expect(lines[6]).toMatch(/^end b ok, contact .* Ω at 293\.15 K, drop 0 V, conductor side 0 V$/);
  });

  it('a gap with no closed side has no reading; a fused lead prints its body open with the gap', () => {
    const both = opened({
      3: { endADegradation: 10_000, endATerminationId: 3, endBDegradation: 10_000, endBTerminationId: 4 },
    });
    const three = formatWireInfo(both.engine, both.bus.state, 3).split('\n');
    expect(three[5]).toBe('end a intermittentOpen, open at 293.15 K, gap no reading, conductor side no reading');
    expect(three[6]).toBe('end b intermittentOpen, open at 293.15 K, gap no reading, conductor side no reading');
    const fused = opened({ 1: { endAState: 'intermittentOpen', endBState: 'intermittentOpen' } });
    const lead = formatWireInfo(fused.engine, fused.bus.state, 1).split('\n');
    expect(lead[4]).toMatch(/^conductor open \(fused\) at 293\.15 K, gap 1\d\.\d+ V$/);
    expect(lead.slice(5, 7)).toStrictEqual(['end a none', 'end b none']);
  });

  it('a pure function of the materialised world: the same text from an engine started on it', () => {
    const h = host();
    h.advanceTo(3000);
    const world = h.materialised();
    for (const id of [1, 2, 7]) expect(wireInfo(world, id)).toBe(formatWireInfo(h.engine, h.bus.state, id));
  });

  it('a connection the catalogue does not model, and no connection at all', () => {
    const base = wiredLoopWorld();
    const unknown = World.parse({
      ...base,
      connections: base.connections.map((c) => (c.id === 7 ? { ...c, ref: { id: 'conductor.nope', version: 1 } } : c)),
    });
    expect(wireInfo(unknown, 7)).toBe(
      'wire.info 7 tick 0\nconnection 7 conductor.nope@1: not a modelled conductor or lead\n',
    );
    expect(wireInfo(base, 42)).toBe('wire.info 42 tick 0\nno connection 42\n');
  });
});
