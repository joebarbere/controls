import { BUILTIN_CATALOG, racewayPorts } from '@controls/catalog';
import fc from 'fast-check';
import { World as WorldSchema } from '@controls/save-format';
import { racewayPanelBus, routingParityWorld } from '../../testing/routing-panel';
import { checkWorldReferences } from '../devices';
import { connectorEntries } from '../routing/connector-entry';
import { UNIT } from '../routing/vec';
import { createWorldBus } from '../session';
import { rotateQuarterTurns } from '../snap/quarter-turn';
import type { InEntry, OrientationMdeg, PositionMm, World } from '../types';
import { checkCableEnd } from './checks';
import { checkInEntry } from './in-entry';

/*
 * A conduit connector's entry, stored (ADR 0015 F3.4 part 2 implementation note 4, the pre-freeze
 * decision): `entity.place`'s `inEntry`, its refusals, the hold it puts on its enclosure and on
 * itself, `entry-full` counting it, and the load check re-verifying it; and the conduit continuity
 * rule in the load check. On the built-in catalogue's raceway panel (`racewayPanelBus`): the DIN panel
 * (1) with `ko-bottom-1` open and connector 7 in it at (-117, -200, 83), roll 270°.
 */

const ref = (id: string) => ({ id, version: 1 });
const at = (x: number, y: number, z: number) => ({ x, y, z });
const refused = (code: string) => ({ ok: false, error: { code } });
const CONNECTOR = ref('connector.stavenor-emt-075');
const CONNECTOR_1IN = ref('connector.stavenor-emt-100');
const STICK = ref('emt.stavenor-075');
const IN_KO1 = { entity: 1, entry: 'ko-bottom-1' };
const SNAPPED = { positionMm: at(-117, -200, 83), orientationMdeg: { yaw: 0, pitch: 0, roll: 270_000 } };

/** The panel and its connector alone (nothing mounted), so only the connector holds the panel. */
function lonePanel() {
  const bus = racewayPanelBus();
  return createWorldBus({ ...bus.state, entities: bus.state.entities.filter((e) => e.id === 1 || e.id === 7) });
}

/** The raceway panel with connector 7 removed (`ko-bottom-1` open and empty), entity ids kept. */
function emptyKnockout() {
  const bus = racewayPanelBus();
  const result = bus.exec('entity.delete', { id: 7 });
  if (!result.ok) throw new Error(result.error.message);
  bus.clearHistory();
  return bus;
}

const placeConnector = (bus: ReturnType<typeof emptyKnockout>, args: Record<string, unknown> = {}) =>
  bus.exec('entity.place', { ref: CONNECTOR, ...SNAPPED, inEntry: IN_KO1, ...args });

describe('entity.place with inEntry (ADR 0015 F3.4 part 2 note 4)', () => {
  it('logs inEntry (null by default) and stores it on the entity', () => {
    const bus = emptyKnockout();
    const free = bus.exec('entity.place', { ref: CONNECTOR, positionMm: at(2000, 0, 0) });
    expect(free).toMatchObject({ ok: true, entry: { args: { mountedOn: null, inEntry: null } } });
    expect(bus.state.entities.at(-1)?.inEntry).toBeNull();
    const placed = placeConnector(bus);
    expect(placed).toMatchObject({ ok: true, entry: { args: { inEntry: IN_KO1 } } });
    expect(bus.state.entities.at(-1)).toMatchObject({ ref: CONNECTOR, inEntry: IN_KO1, mountedOn: null });
    expect(connectorEntries(bus.state)).toStrictEqual([
      { connector: bus.state.entities.at(-1)?.id, enclosure: 1, entry: 'ko-bottom-1' },
    ]);
  });

  it('refuses each broken rule with its code', () => {
    const bus = emptyKnockout();
    expect(placeConnector(bus, { ref: STICK })).toMatchObject(refused('not-a-connector'));
    expect(placeConnector(bus, { ref: ref('prop.crate') })).toMatchObject(refused('not-a-connector'));
    expect(placeConnector(bus, { mountedOn: { entity: 1, mount: 'rail-1' } })).toMatchObject(refused('mount-mismatch'));
    expect(placeConnector(bus, { inEntry: { entity: 99, entry: 'ko-bottom-1' } })).toMatchObject(refused('not-found'));
    expect(placeConnector(bus, { inEntry: { entity: 2, entry: 'ko-bottom-1' } })).toMatchObject(
      refused('not-an-enclosure'), // the duct
    );
    expect(placeConnector(bus, { inEntry: { entity: 1, entry: 'ko-9' } })).toMatchObject(refused('unknown-entry'));
    // ko-bottom-2 (3/4 in) is still closed; the connector placed at it 100 mm along +x.
    const atKo2 = { positionMm: at(-17, -200, 83), inEntry: { entity: 1, entry: 'ko-bottom-2' } };
    expect(placeConnector(bus, atKo2)).toMatchObject(refused('entry-closed'));
    expect(placeConnector(bus, { orientationMdeg: { yaw: 45_000, pitch: 0, roll: 0 } })).toMatchObject(
      refused('not-axis-aligned'),
    );
    expect(placeConnector(bus, { positionMm: at(-116, -200, 83) })).toMatchObject(refused('off-entry'));
    // Turned so its entry end points out of the box instead of in.
    expect(
      placeConnector(bus, { positionMm: at(-83, -200, 83), orientationMdeg: { yaw: 0, pitch: 0, roll: 90_000 } }),
    ).toMatchObject(refused('off-entry'));
    // ko-bottom-3 is a 1 in knockout: a 3/4 in connector is the wrong size, a 1 in one fits.
    expect(bus.exec('enclosure.openEntry', { id: 1, entry: 'ko-bottom-3', tool: ref('tool.veltmark-sd-2') }).ok).toBe(
      true,
    );
    const ko3 = { entity: 1, entry: 'ko-bottom-3' };
    expect(placeConnector(bus, { positionMm: at(83, -200, 83), inEntry: ko3 })).toMatchObject(refused('wrong-size'));
    expect(nothingPlacedSince(bus)).toBe(true);
  });

  it('one connector per entry, and a connector fills its entry for cables (maxCables)', () => {
    const bus = racewayPanelBus(); // connector 7 already in ko-bottom-1
    expect(placeConnector(bus)).toMatchObject(refused('entry-full'));
    // A cable end into the same entry: the connector counts against its one cable.
    const end = checkCableEnd(bus.state, BUILTIN_CATALOG, IN_KO1);
    expect(end).toMatchObject({ ok: false, code: 'entry-full' });
    expect(end.ok ? '' : end.message).toContain('holds connector 7');
    // Removed, the entry takes a cable again.
    expect(bus.exec('entity.delete', { id: 7 }).ok).toBe(true);
    expect(checkCableEnd(bus.state, BUILTIN_CATALOG, IN_KO1).ok).toBe(true);
  });

  it('places exactly when the entry end meets the entry pointing in (property over the 64 quarter-turn triples)', () => {
    const bus = emptyKnockout();
    const device = BUILTIN_CATALOG.device(CONNECTOR);
    const port = device && racewayPorts(device, null).find((p) => p.kind === 'entry');
    if (!port) throw new Error('no entry port');
    const quarter = fc.constantFrom(0, 90_000, 180_000, 270_000);
    const entryPoint = at(-100, -200, 100);
    fc.assert(
      fc.property(
        fc.record({ yaw: quarter, pitch: quarter, roll: quarter }),
        fc.integer({ min: -2, max: 2 }),
        (orientationMdeg: OrientationMdeg, nudge) => {
          // Put the entry end exactly on the entry point (nudged along x when `nudge` ≠ 0).
          const offset = rotateQuarterTurns(orientationMdeg, port.positionMm) as PositionMm;
          const positionMm = at(entryPoint.x - offset.x + nudge, entryPoint.y - offset.y, entryPoint.z - offset.z);
          const out = rotateQuarterTurns(orientationMdeg, UNIT[port.axis]) as PositionMm;
          const pointsIn = out.x === 0 && out.y === 1 && out.z === 0;
          const refusal = checkInEntry(
            bus.state,
            BUILTIN_CATALOG,
            CONNECTOR,
            { positionMm, orientationMdeg },
            null,
            IN_KO1,
            null,
          );
          expect(refusal?.code ?? 'ok').toBe(pointsIn && nudge === 0 ? 'ok' : 'off-entry');
        },
      ),
    );
  });
});

/** Whether the bus's last entity is still the elbow (9): every refused place above changed nothing. */
function nothingPlacedSince(bus: ReturnType<typeof emptyKnockout>): boolean {
  return bus.state.entities.at(-1)?.id === 9 && bus.state.nextEntityId === 10;
}

describe('a connector in an entry holds its enclosure and itself', () => {
  it('the enclosure is occupied: it can neither move, turn nor go while the connector is in it', () => {
    const bus = lonePanel();
    expect(bus.exec('entity.move', { id: 1, positionMm: at(-200, -200, 500) })).toMatchObject(refused('occupied'));
    expect(bus.exec('entity.rotate', { id: 1, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject(
      refused('occupied'),
    );
    expect(bus.exec('entity.delete', { id: 1 })).toMatchObject(refused('occupied'));
    // Take the connector out, and the panel moves; undo puts both back.
    const before = bus.state;
    expect(bus.exec('entity.delete', { id: 7 }).ok).toBe(true);
    expect(bus.exec('entity.move', { id: 1, positionMm: at(-200, -200, 500) }).ok).toBe(true);
    bus.exec('edit.undo');
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });

  it('the connector can neither move nor turn (in-entry), but can be removed', () => {
    const bus = lonePanel();
    expect(bus.exec('entity.move', { id: 7, positionMm: at(-117, -201, 83) })).toMatchObject(refused('in-entry'));
    expect(bus.exec('entity.rotate', { id: 7, deltaMdeg: { yaw: 0, pitch: 0, roll: 90_000 } })).toMatchObject(
      refused('in-entry'),
    );
    expect(bus.exec('entity.delete', { id: 7 }).ok).toBe(true);
    expect(connectorEntries(bus.state)).toStrictEqual([]);
  });
});

describe('the load check re-verifies inEntry and conduit continuity (checkWorldReferences)', () => {
  const issues = (world: World) => checkWorldReferences(WorldSchema.parse(world), BUILTIN_CATALOG);
  const messages = (world: World) => issues(world).map((i) => `${i.path}: ${i.message}`);
  const withConnector = (change: (inEntry: InEntry, e: World['entities'][number]) => object): World => {
    const world = racewayPanelBus().state;
    return {
      ...world,
      entities: world.entities.map((e) => (e.id === 7 && e.inEntry ? { ...e, ...change(e.inEntry, e) } : e)),
    };
  };

  it('accepts the raceway panel (a connector in its entry) and the routing parity world (a pull round an elbow)', () => {
    expect(issues(racewayPanelBus().state)).toStrictEqual([]);
    expect(issues(routingParityWorld())).toStrictEqual([]);
  });

  it('refuses a stored inEntry the command would refuse', () => {
    const closed = withConnector(() => ({ inEntry: { entity: 1, entry: 'ko-bottom-2' } }));
    expect(messages(closed)).toContain(
      'entities[6].inEntry: Not a place a connector can be in that entry (entry-closed)',
    );
    const moved = withConnector((_, e) => ({ transform: { ...e.transform, positionMm: at(-117, -201, 83) } }));
    expect(messages(moved)).toContain('entities[6].inEntry: Not a place a connector can be in that entry (off-entry)');
    const big = withConnector(() => ({ ref: CONNECTOR_1IN }));
    expect(messages(big).some((m) => m.startsWith('entities[6].inEntry:'))).toBe(true);
    // A terminal block (entity 3) claiming the entry instead.
    const world = racewayPanelBus().state;
    const block = {
      ...world,
      entities: world.entities.map((e) =>
        e.id === 7 ? { ...e, inEntry: null } : e.id === 3 ? { ...e, mountedOn: null, inEntry: IN_KO1 } : e,
      ),
    };
    expect(messages(block)).toContain(
      'entities[2].inEntry: Not a place a connector can be in that entry (not-a-connector)',
    );
    // A host the catalogue doesn't know is left alone.
    const unknownHost = {
      ...world,
      entities: world.entities.map((e) => (e.id === 1 ? { ...e, ref: ref('panel.mod-x'), state: {} } : e)),
    };
    expect(messages(unknownHost).some((m) => m.includes('inEntry'))).toBe(false);
  });

  it('refuses a pulled conductor whose conduit route skips an elbow or leaves its part', () => {
    const world = routingParityWorld();
    const pulled = world.connections.at(-1);
    if (!pulled?.route) throw new Error('no pulled conductor');
    const at = `connections[${world.connections.length - 1}].route`;
    const withRoute = (route: NonNullable<typeof pulled.route>): World => ({
      ...world,
      connections: [...world.connections.slice(0, -1), { ...pulled, route }],
    });
    // free, stick 24's top end, elbow 25's port a (the stick's bottom end), elbow 25's port b, free.
    const [before, top, , elbowB, after] = pulled.route;
    expect(messages(withRoute([before, top, elbowB, after]))).toContain(
      `${at}[2]: Not a continuous conduit run (conduit-discontinuous)`,
    );
    const off = { ...top, positionMm: { ...top.positionMm, x: top.positionMm.x + 1 } };
    expect(messages(withRoute([before, off, ...pulled.route.slice(2)]))).toContain(
      `${at}[1]: Not a continuous conduit run (off-raceway)`,
    );
  });
});
