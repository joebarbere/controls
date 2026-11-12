import { World } from '@controls/save-format';
import {
  at,
  CABLE,
  CUTTER,
  freeAt,
  LABELLER,
  PUNCH,
  SCREWDRIVER,
  STRIPPER,
  WIRE,
  WIRING_TEST_CATALOG,
  wiringBench,
} from '../../testing';
import { checkWorldReferences } from '../devices';

/*
 * The cable commands and enclosure entries (ADR 0015, "CableV3"), over the TEST-ONLY wiring bench: a
 * 14/2-with-ground test assembly from the 1-gang box's top entry (entity 5, both entries opened) to a
 * free end.
 */

const refused = (code: string) => ({ ok: false, error: { code } });

function expectValid(world: World) {
  expect(World.safeParse(world).success).toBe(true);
  expect(checkWorldReferences(world, WIRING_TEST_CATALOG)).toStrictEqual([]);
}

const ROUTE = [freeAt(25, 500, 2030), freeAt(500, 500, 1000)];

function cableArgs(overrides: Record<string, unknown> = {}) {
  return {
    ref: CABLE,
    a: { entity: 5, entry: 'top' },
    b: null,
    route: ROUTE,
    lengthMm: 2000,
    tailsMm: { a: 200, b: 0 },
    tool: CUTTER,
    ...overrides,
  };
}

describe('cable.add', () => {
  it('creates the cable and one free conductor per assembly conductor; undo restores every id and counter', () => {
    const bus = wiringBench();
    const before = bus.state;
    expect(bus.exec('cable.add', cableArgs()).ok).toBe(true);
    expect(bus.state.cables).toStrictEqual([
      {
        id: 1,
        ref: CABLE,
        a: { entity: 5, entry: 'top' },
        b: null,
        route: ROUTE,
        lengthMm: 2000,
        tailsMm: { a: 200, b: 0 },
        jacketStripMm: { a: 0, b: 0 },
        label: null,
        extensions: {},
      },
    ]);
    expect(
      bus.state.connections.map((c) => [c.id, c.ref.id, c.cable, c.colour?.base, c.a, c.b, c.route, c.lengthMm]),
    ).toStrictEqual([
      [1, 'conductor.test-14', { id: 1, conductor: 0 }, 'black', null, null, null, 2000],
      [2, 'conductor.test-14', { id: 1, conductor: 1 }, 'white', null, null, null, 2000],
      [3, 'conductor.test-14-bare', { id: 1, conductor: 2 }, 'bare', null, null, null, 2000],
    ]);
    expect(bus.state).toMatchObject({ nextCableId: 2, nextConnectionId: 4 });
    expectValid(bus.state);
    // The box now has a cable in it: occupied.
    expect(bus.exec('entity.delete', { id: 5 })).toMatchObject(refused('occupied'));
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });

  it('refuses a non-cable ref, a cutter that cannot reach, conduit, bad entries and a short cut', () => {
    const bus = wiringBench();
    const cases: [string, Record<string, unknown>][] = [
      ['not-a-cable', { ref: WIRE }],
      ['unknown-tool', { tool: CABLE }],
      ['wrong-tool', { tool: LABELLER }],
      ['needs-pull', { route: [{ ...ROUTE[0], kind: 'conduit', entity: 2 }, ROUTE[1]] }],
      ['not-found', { a: { entity: 99, entry: 'top' } }],
      ['not-an-enclosure', { a: { entity: 1, entry: 'top' } }],
      ['unknown-entry', { a: { entity: 5, entry: 'side' } }],
      ['same-entry', { b: { entity: 5, entry: 'top' }, route: [] }],
      ['bad-waypoint', { route: [] }], // end b is free: it needs a rest waypoint
      ['too-short', { lengthMm: 1759 }],
      ['too-short', { tailsMm: { a: 2000, b: 0 } }],
    ];
    for (const [code, overrides] of cases) {
      expect([code, bus.exec('cable.add', cableArgs(overrides))]).toMatchObject([code, refused(code)]);
    }
    expect(bus.exec('cable.add', cableArgs({ lengthMm: 1760 })).ok).toBe(true);
  });

  it('needs an open entry with room (entry-closed, entry-full)', () => {
    const bus = wiringBench();
    // ko1 takes one cable.
    const ko1 = { a: { entity: 5, entry: 'ko1' }, route: [freeAt(25, -500, 2030), freeAt(500, -500, 1000)] };
    expect(bus.exec('cable.add', cableArgs(ko1)).ok).toBe(true);
    expect(bus.exec('cable.add', cableArgs(ko1))).toMatchObject(refused('entry-full'));
    // A fresh box: every entry starts closed; a screwdriver opens a clamp, not twice.
    expect(bus.exec('entity.place', { ref: { id: 'box.test-1gang', version: 1 }, positionMm: at(0, 0, 4000) }).ok).toBe(
      true,
    );
    const top = { a: { entity: 6, entry: 'top' }, route: [freeAt(25, 500, 4030), freeAt(500, 500, 3000)] };
    expect(bus.exec('cable.add', cableArgs(top))).toMatchObject(refused('entry-closed'));
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'top', tool: SCREWDRIVER }).ok).toBe(true);
    expect(bus.state.entities.at(-1)?.state).toStrictEqual({ openEntries: 1 });
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'top', tool: SCREWDRIVER })).toMatchObject(
      refused('already-open'),
    );
    expect(bus.exec('cable.add', cableArgs(top)).ok).toBe(true);
  });
});

describe('enclosure.openEntry', () => {
  it('opens an entry with a tool its entry type lists; undo closes it again', () => {
    const bus = wiringBench();
    bus.exec('entity.place', { ref: { id: 'box.test-1gang', version: 1 }, positionMm: at(0, 0, 4000) });
    const before = bus.state;
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'ko1', tool: LABELLER })).toMatchObject(
      refused('wrong-tool'),
    );
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'ko1', tool: WIRE })).toMatchObject(refused('unknown-tool'));
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'nope', tool: PUNCH })).toMatchObject(
      refused('unknown-entry'),
    );
    expect(bus.exec('enclosure.openEntry', { id: 1, entry: 'ko1', tool: PUNCH })).toMatchObject(
      refused('not-an-enclosure'),
    );
    expect(bus.exec('enclosure.openEntry', { id: 99, entry: 'ko1', tool: PUNCH })).toMatchObject(refused('not-found'));
    expect(bus.exec('enclosure.openEntry', { id: 6, entry: 'ko1', tool: PUNCH }).ok).toBe(true);
    expect(bus.state.entities.at(-1)?.state).toStrictEqual({ openEntries: 2 });
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });
});

describe('cable.strip, landing cable conductors, cable.reroute, cable.label and cable.delete', () => {
  it('strips more, never less, and never past the tail', () => {
    const bus = wiringBench();
    bus.exec('cable.add', cableArgs());
    expect(bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: CUTTER })).toMatchObject(
      refused('wrong-tool'),
    );
    expect(bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: STRIPPER }).ok).toBe(true);
    expect(bus.state.cables[0].jacketStripMm).toStrictEqual({ a: 150, b: 0 });
    expect(bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 100, tool: STRIPPER })).toMatchObject(
      refused('cannot-unstrip'),
    );
    expect(bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 201, tool: STRIPPER })).toMatchObject(
      refused('strip-too-long'),
    );
    expect(bus.exec('cable.strip', { id: 2, end: 'a', jacketMm: 1, tool: STRIPPER })).toMatchObject(
      refused('not-found'),
    );
    expectValid(bus.state);
  });

  it('lands a cable conductor within the stripped tail (tail-too-short otherwise); wire.delete and wire.reroute refuse it', () => {
    const bus = wiringBench();
    bus.exec('cable.add', cableArgs());
    const land = (id: number, entity: number, terminal: string) =>
      bus.exec('wire.land', { id, end: 'a', at: { entity, terminal, termination: 'auto' } });
    expect(land(1, 5, 'ground')).toMatchObject(refused('tail-too-short')); // the jacket is on
    bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: STRIPPER });
    expect(land(1, 1, 'l1')).toMatchObject(refused('tail-too-short')); // out of reach
    expect(land(3, 5, 'ground').ok).toBe(true); // the bare EGC on the box's ground screw
    expect(bus.state.connections[2]).toMatchObject({
      a: { entity: 5, terminal: 'ground', termination: { id: 1 } },
      route: null,
    });
    expectValid(bus.state);
    expect(bus.exec('wire.delete', { id: 3 })).toMatchObject(refused('in-cable'));
    expect(bus.exec('wire.reroute', { id: 3, route: ROUTE })).toMatchObject(refused('in-cable'));
    expect(bus.exec('wire.unland', { id: 3, end: 'a' }).ok).toBe(true);
    expect(bus.state.connections[2]).toMatchObject({ a: null, route: null });
  });

  it('reroutes between the same ends, keeping the cut length', () => {
    const bus = wiringBench();
    bus.exec('cable.add', cableArgs());
    const other = [freeAt(25, 700, 2030), freeAt(500, 700, 1000)];
    expect(bus.exec('cable.reroute', { id: 1, route: other }).ok).toBe(true);
    expect(bus.state.cables[0]).toMatchObject({ route: other, lengthMm: 2000 });
    expect(
      bus.exec('cable.reroute', { id: 1, route: [freeAt(25, 5000, 2030), freeAt(500, 5000, 1000)] }),
    ).toMatchObject(refused('too-short'));
    expect(bus.exec('cable.reroute', { id: 1, route: [] })).toMatchObject(refused('bad-waypoint'));
    expectValid(bus.state);
  });

  it('labels and deletes a cable with all its conductors; undo restores the ids and the landings', () => {
    const bus = wiringBench();
    bus.exec('cable.add', cableArgs());
    bus.exec('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: STRIPPER });
    bus.exec('wire.land', { id: 3, end: 'a', at: { entity: 5, terminal: 'ground', termination: 'auto' } });
    expect(bus.exec('cable.label', { id: 1, text: 'K1', tool: LABELLER }).ok).toBe(true);
    expect(bus.state.cables[0].label).toBe('K1');
    expect(bus.exec('cable.label', { id: 1, text: 'K1', tool: STRIPPER })).toMatchObject(refused('wrong-tool'));
    const before = bus.state;
    expect(bus.exec('cable.delete', { id: 1 }).ok).toBe(true);
    expect(bus.state).toMatchObject({ cables: [], connections: [], nextCableId: 2, nextConnectionId: 4 });
    // The box is free again.
    expect(bus.exec('entity.move', { id: 5, positionMm: at(0, 0, 2100) }).ok).toBe(true);
    bus.exec('edit.undo');
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });
});
