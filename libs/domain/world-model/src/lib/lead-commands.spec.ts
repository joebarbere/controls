import { createWorld, World } from '@controls/save-format';
import { checkWorldDevices } from './devices';
import { worldHash } from './hash';
import { findConnection, findConnectionIndex, joins } from './lead-commands';
import { createWorldBus } from './session';

const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const SPST = { id: 'switch.tessaline-spst-toggle', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const origin = { x: 0, y: 0, z: 0 };
const end = (entity: number, terminal: string) => ({ entity, terminal });

/** A world with a battery (1), a switch (2), a lamp (3) and a crate (4). */
function bench() {
  const bus = createWorldBus(createWorld({ seed: 5 }));
  for (const ref of [BATTERY, SPST, LAMP, { id: 'prop.crate', version: 1 }]) {
    expect(bus.exec('entity.place', { ref, positionMm: origin }).ok).toBe(true);
  }
  return bus;
}

describe('lead.connect', () => {
  it('joins two terminals with an id from nextConnectionId, which it increments', () => {
    const bus = bench();
    const result = bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    expect(result).toMatchObject({ ok: true, entry: { id: 'lead.connect' } });
    expect(bus.state.connections).toStrictEqual([
      { id: 1, ref: LEAD, a: end(1, 'pos'), b: end(2, 'a'), extensions: {} },
    ]);
    expect(bus.state.nextConnectionId).toBe(2);
    expect(World.safeParse(bus.state).success).toBe(true);
    expect(checkWorldDevices(bus.state)).toStrictEqual([]);
  });

  it('undo removes the lead and restores the counter; redo brings it back with the same id', () => {
    const bus = bench();
    const before = bus.state;
    bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
    expect(worldHash(bus.state)).toBe(worldHash(before));
    bus.exec('edit.redo');
    expect(bus.state.connections.map((c) => c.id)).toStrictEqual([1]);
  });

  it.each([
    ['a ref that is not a lead', { ref: SPST, a: end(1, 'pos'), b: end(2, 'a') }, 'not-a-lead'],
    ['an unknown ref', { ref: { id: 'lead.nope', version: 1 }, a: end(1, 'pos'), b: end(2, 'a') }, 'not-a-lead'],
    ['an entity that doesn’t exist', { ref: LEAD, a: end(1, 'pos'), b: end(9, 'a') }, 'not-found'],
    ['a prop', { ref: LEAD, a: end(4, 'a'), b: end(2, 'a') }, 'no-terminals'],
    ['a terminal the device doesn’t have', { ref: LEAD, a: end(1, 'plus'), b: end(2, 'a') }, 'unknown-terminal'],
    ['the same terminal twice', { ref: LEAD, a: end(2, 'a'), b: end(2, 'a') }, 'same-terminal'],
  ])('refuses %s', (_name, args, code) => {
    const bus = bench();
    const before = bus.state;
    expect(bus.exec('lead.connect', args)).toMatchObject({ ok: false, error: { kind: 'rejected', code } });
    expect(bus.state).toBe(before);
  });

  it('refuses a device the catalogue doesn’t know (its terminals are unknown)', () => {
    const bus = bench();
    bus.exec('entity.place', { ref: { id: 'mod.example-relay', version: 1 }, positionMm: origin });
    expect(bus.exec('lead.connect', { ref: LEAD, a: end(5, 'a'), b: end(2, 'a') })).toMatchObject({
      ok: false,
      error: { code: 'unknown-terminal' },
    });
  });

  it('refuses a duplicate lead in either direction, but allows a second lead on one terminal', () => {
    const bus = bench();
    bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    for (const [a, b] of [
      [end(1, 'pos'), end(2, 'a')],
      [end(2, 'a'), end(1, 'pos')],
    ]) {
      expect(bus.exec('lead.connect', { ref: LEAD, a, b })).toMatchObject({
        ok: false,
        error: { code: 'duplicate-lead', message: 'Lead 1 already joins those terminals' },
      });
    }
    expect(bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(3, 'a') }).ok).toBe(true);
    // Two terminals of one device are fine (a jumper across the switch).
    expect(bus.exec('lead.connect', { ref: LEAD, a: end(2, 'a'), b: end(2, 'b') }).ok).toBe(true);
  });

  it('refuses once connection ids run out', () => {
    const bus = bench();
    const world = World.parse({ ...bus.state, nextConnectionId: Number.MAX_SAFE_INTEGER });
    const full = createWorldBus(world);
    expect(full.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') })).toMatchObject({
      ok: false,
      error: { code: 'ids-exhausted' },
    });
  });

  it('refuses malformed args before running (strict, terminal grammar)', () => {
    const bus = bench();
    expect(bus.exec('lead.connect', { ref: LEAD, a: end(1, 'p:s'), b: end(2, 'a') })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-args' },
    });
    expect(bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a'), gauge: 14 })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-args' },
    });
  });
});

describe('lead.disconnect', () => {
  it('removes a lead; undo reinserts it with the same id, in order; the counter never moves', () => {
    const bus = bench();
    bus.exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    bus.exec('lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(3, 'a') });
    bus.exec('lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') });
    const before = bus.state;
    expect(bus.exec('lead.disconnect', { id: 2 }).ok).toBe(true);
    expect(bus.state.connections.map((c) => c.id)).toStrictEqual([1, 3]);
    expect(bus.state.nextConnectionId).toBe(4);
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
    expect(findConnection(bus.state, 2)).toStrictEqual(findConnection(before, 2));
  });

  it('refuses a lead that doesn’t exist', () => {
    const bus = bench();
    expect(bus.exec('lead.disconnect', { id: 1 })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});

describe('lead helpers', () => {
  it('findConnectionIndex is a binary search over sorted ids', () => {
    const connections = [1, 3, 4, 9].map((id) => ({ id, ref: LEAD, a: end(1, 'a'), b: end(2, 'a'), extensions: {} }));
    expect([1, 3, 4, 9, 2, 10, 0].map((id) => findConnectionIndex(connections, id))).toStrictEqual([
      0, 1, 2, 3, -1, -1, -1,
    ]);
  });

  it('joins matches either direction only', () => {
    const c = { id: 1, ref: LEAD, a: end(1, 'a'), b: end(2, 'b'), extensions: {} };
    expect(joins(c, end(1, 'a'), end(2, 'b'))).toBe(true);
    expect(joins(c, end(2, 'b'), end(1, 'a'))).toBe(true);
    expect(joins(c, end(1, 'a'), end(2, 'a'))).toBe(false);
  });
});
