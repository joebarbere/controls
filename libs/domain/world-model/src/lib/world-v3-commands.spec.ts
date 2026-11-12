import { World } from '@controls/save-format';
import { WIRING_TEST_CATALOG } from '../testing/wiring-catalog';
import { at, BATTERY, BREAKER, LEAD, WIRE, wiredWorldDoc } from '../testing/wired-world';
import { checkWorldReferences } from './devices';
import { worldHash } from './hash';
import { createWorldBus, createWorldRegistry } from './session';

/*
 * The existing commands on world v3 (ADR 0015, P3 PR 7). No new command lands here (the wire, cable
 * and enclosure commands are P3 PR 8); `entity.place` gains `mountedOn` (default `null`), and the
 * commands refuse what would leave a v3 world invalid until PR 8 refines it (mount checks, sliding
 * along a mount, unlanding on delete). Test leads behave exactly as in v2.
 */

/** Entities: 1 split-phase, 2 box (`ko1` open, a cable in it), 3 DIN panel, 4 breaker on its rail, 5 battery. */
function wiredBus() {
  const world = World.parse(wiredWorldDoc());
  expect(checkWorldReferences(world, WIRING_TEST_CATALOG)).toStrictEqual([]);
  return createWorldBus(world, createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
}

const refused = (code: string) => ({ ok: false, error: { code } });

describe('entity.place with mountedOn (ADR 0015)', () => {
  it('logs mountedOn: null when it is left out, and places an unmounted, unlabelled entity', () => {
    const bus = wiredBus();
    const result = bus.exec('entity.place', { ref: BATTERY, positionMm: at(0, 0, 500) });
    expect(result).toMatchObject({ ok: true, entry: { args: { mountedOn: null } } });
    expect(bus.state.entities.at(-1)).toMatchObject({ id: 6, mountedOn: null, label: null });
    expect(checkWorldReferences(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([]);
  });

  it('refuses a mount until the world v3 commands land, after checking the host and the mount', () => {
    const bus = wiredBus();
    const before = bus.state;
    const place = (ref: object, mountedOn: object) =>
      bus.exec('entity.place', { ref, positionMm: at(0, 0, 0), mountedOn });
    expect(place(BREAKER, { entity: 99, mount: 'rail-1' })).toMatchObject(refused('not-found'));
    expect(place(BREAKER, { entity: 3, mount: 'rail-9' })).toMatchObject(refused('unknown-mount'));
    expect(place(BREAKER, { entity: 1, mount: 'rail-1' })).toMatchObject(refused('unknown-mount'));
    expect(place(BATTERY, { entity: 3, mount: 'rail-1' })).toMatchObject(refused('mount-mismatch'));
    expect(place(BREAKER, { entity: 3, mount: 'rail-1' })).toMatchObject(refused('mounting-unavailable'));
    expect(bus.state).toBe(before);
    expect(bus.entries).toHaveLength(0);
  });
});

describe('the entity commands keep a v3 world valid (until P3 PR 8 refines them)', () => {
  it('an entity something is mounted on, a cable enters or a route is hosted by is occupied', () => {
    const bus = wiredBus();
    for (const id of [3, 2]) {
      expect(bus.exec('entity.move', { id, positionMm: at(0, 0, 0) })).toMatchObject(refused('occupied'));
      expect(bus.exec('entity.rotate', { id, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject(
        refused('occupied'),
      );
      expect(bus.exec('entity.delete', { id })).toMatchObject(refused('occupied'));
    }
  });

  it('a mounted device can be neither moved nor rotated; deleting it is fine once unwired', () => {
    const doc = wiredWorldDoc();
    doc.connections.splice(0, 1); // the conductor landed on the breaker
    const bus = createWorldBus(World.parse(doc), createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
    expect(bus.exec('entity.move', { id: 4, positionMm: at(0, 0, 0) })).toMatchObject(refused('mounted'));
    expect(bus.exec('entity.rotate', { id: 4, deltaMdeg: { yaw: 0, pitch: 0, roll: 90_000 } })).toMatchObject(
      refused('mounted'),
    );
    const before = worldHash(bus.state);
    expect(bus.exec('entity.delete', { id: 4 }).ok).toBe(true);
    expect(checkWorldReferences(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([]);
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(worldHash(bus.state)).toBe(before);
    // With nothing mounted on it, the panel can go too.
    expect(bus.exec('entity.delete', { id: 4 }).ok).toBe(true);
    expect(bus.exec('entity.delete', { id: 3 }).ok).toBe(true);
  });

  it('an entity with a landed conductor end is wired: no move, rotate or delete', () => {
    const bus = wiredBus();
    expect(bus.exec('entity.move', { id: 1, positionMm: at(0, 0, 0) })).toMatchObject(refused('wired'));
    expect(bus.exec('entity.rotate', { id: 1, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject(
      refused('wired'),
    );
    expect(bus.exec('entity.delete', { id: 1 })).toMatchObject(refused('wired'));
  });

  it('test leads behave as in v2: deleting an entity removes its leads, and undo restores them', () => {
    const bus = wiredBus();
    const before = bus.state;
    expect(bus.exec('entity.move', { id: 5, positionMm: at(0, 0, 0) }).ok).toBe(true);
    expect(bus.exec('entity.delete', { id: 5 }).ok).toBe(true);
    expect(bus.state.connections.map((c) => c.id)).toStrictEqual([1, 2, 3, 4]);
    bus.exec('edit.undo');
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });
});

describe('lead commands on world v3', () => {
  it('lead.disconnect refuses a conductor (not-a-lead); lead.connect refuses a conductor kind', () => {
    const bus = wiredBus();
    expect(bus.exec('lead.disconnect', { id: 1 })).toMatchObject(refused('not-a-lead'));
    expect(bus.exec('lead.disconnect', { id: 3 })).toMatchObject(refused('not-a-lead'));
    expect(
      bus.exec('lead.connect', { ref: WIRE, a: { entity: 5, terminal: 'pos' }, b: { entity: 1, terminal: 'n' } }),
    ).toMatchObject(refused('not-a-lead'));
    expect(bus.exec('lead.disconnect', { id: 5 }).ok).toBe(true);
  });

  it('a lead may share terminals with a conductor; a conductor never counts as a duplicate lead', () => {
    const bus = wiredBus();
    const result = bus.exec('lead.connect', {
      ref: LEAD,
      a: { entity: 1, terminal: 'l1' },
      b: { entity: 4, terminal: 'line' },
    });
    expect(result.ok).toBe(true);
    expect(bus.state.connections.at(-1)).toMatchObject({ id: 6, a: { termination: null }, lengthMm: null });
    expect(checkWorldReferences(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([]);
  });

  it("a lead clips onto an enclosure's terminal like any other", () => {
    const bus = wiredBus();
    const a = { entity: 2, terminal: 'ground' };
    expect(bus.exec('lead.connect', { ref: LEAD, a, b: { entity: 5, terminal: 'neg' } }).ok).toBe(true);
    expect(checkWorldReferences(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([]);
  });
});
