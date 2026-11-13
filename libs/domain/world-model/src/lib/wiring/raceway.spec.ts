import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import { checkWorldReferences } from '../devices';
import { createWorldBus, createWorldRegistry } from '../session';
import { orientationsTurning, racewayTargets, snapConduit } from '../snap/raceway-placement';
import { rotateQuarterTurns } from '../snap/quarter-turn';
import { placeInWorld } from '../snap/world-placement';
import type { CatalogRef, PositionMm } from '../types';
import { obstacleBoxes } from './checks';

/*
 * F3.5 part 2: wire duct on the panel's backplate, cut to length; DIN terminal blocks centred and
 * packed on a rail; ducts hollow for routes but solid for placement; EMT-lite parts snapped into an
 * open entry and end to end. The panel (400 × 500 × 200 mm) at (-200, -200, 0) facing +z puts its
 * backplate square's origin at (-175, -175, 14), rail-1's mount origin at (-165, 105, 22) (centreline
 * y = 150) and knockout ko-bottom-1 (3/4 in) at (-100, -200, 100), pointing in along +y.
 */

const PANEL: CatalogRef = { id: 'panel.pellmoor-din-400x500', version: 1 };
const DUCT: CatalogRef = { id: 'duct.lattisby-40x60', version: 1 };
const ST4: CatalogRef = { id: 'tb.quennick-st4', version: 1 };
const PE4: CatalogRef = { id: 'tb.quennick-pe4', version: 1 };
const SC25: CatalogRef = { id: 'tb.quennick-sc25', version: 1 };
const CONNECTOR: CatalogRef = { id: 'connector.stavenor-emt-075', version: 1 };
const STICK: CatalogRef = { id: 'emt.stavenor-075', version: 1 };
const ELBOW: CatalogRef = { id: 'elbow.stavenor-emt-075', version: 1 };
const BREAKER: CatalogRef = { id: 'breaker.saltmere-1p-15a', version: 1 };
const SCREWDRIVER: CatalogRef = { id: 'tool.veltmark-sd-2', version: 1 };
const at = (x: number, y: number, z: number): PositionMm => ({ x, y, z });

function panelBus() {
  const bus = createWorldBus(createWorld({ seed: 0 }), createWorldRegistry());
  const placed = bus.exec('entity.place', { ref: PANEL, positionMm: at(-200, -200, 0) });
  if (!placed.ok) throw new Error(JSON.stringify(placed));
  return bus;
}
type Bus = ReturnType<typeof panelBus>;

/** Places `ref` where `placeInWorld` puts it for `cursor`, and returns the placement. */
function place(bus: Bus, ref: CatalogRef, cursor: PositionMm, turn = 0) {
  const p = placeInWorld(bus.state, ref, cursor, [], { turn });
  if (!p.ok) throw new Error(`no placement at ${JSON.stringify(cursor)}: ${p.reason}`);
  const result = bus.exec('entity.place', {
    ref,
    positionMm: p.positionMm,
    orientationMdeg: p.orientationMdeg,
    mountedOn: p.mountedOn,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return p;
}

describe('wire duct on a backplate', () => {
  it('places at its entry’s default length, cover off, on the 5 mm plate grid', () => {
    const bus = panelBus();
    // Cursor 175 mm along, 265 mm up the plate: a 300 × 40 footprint centred there snaps to (25, 245).
    const p = place(bus, DUCT, at(0, 90, 14));
    expect(p).toMatchObject({ positionMm: at(-150, 70, 14), mountedOn: { entity: 1, mount: 'plate' } });
    expect(bus.state.entities[1].state).toStrictEqual({ coverOn: false, lengthMm: 300 });
  });

  it('raceway.cut changes the body, re-checks the plate and undoes exactly', () => {
    const bus = panelBus();
    place(bus, DUCT, at(0, 90, 14));
    const before = bus.state;
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 200 }).ok).toBe(true);
    expect(bus.state.entities[1].state['lengthMm']).toBe(200);
    // 25 along + 330 > the 350 mm plate: off-mount. Longer than the 2 m stock, or under 20 mm: out-of-range.
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 330 })).toMatchObject({
      ok: false,
      error: { code: 'off-mount' },
    });
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 2001 })).toMatchObject({ error: { code: 'out-of-range' } });
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 19 })).toMatchObject({ error: { code: 'out-of-range' } });
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 200 })).toMatchObject({ error: { code: 'same-length' } });
    expect(bus.exec('raceway.cut', { id: 1, lengthMm: 200 })).toMatchObject({ error: { code: 'not-cut-to-length' } });
    expect(bus.exec('raceway.cut', { id: 9, lengthMm: 200 })).toMatchObject({ error: { code: 'not-found' } });
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(bus.state).toEqual(before);
  });

  it('a second duct can’t be placed or cut into the first (mount-full on the plate)', () => {
    const bus = panelBus();
    place(bus, DUCT, at(-25, 90, 14)); // along 0..300
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 50 }).ok).toBe(true); // along 0..50
    // A new 300 mm piece centred 200 mm along: 50..350, touching the first.
    expect(place(bus, DUCT, at(25, 90, 14)).positionMm).toStrictEqual(at(-125, 70, 14));
    expect(bus.exec('raceway.cut', { id: 2, lengthMm: 60 })).toMatchObject({ error: { code: 'mount-full' } });
    // On the cursor, a third piece would overlap both: no room.
    expect(placeInWorld(bus.state, DUCT, at(25, 90, 14), [])).toMatchObject({ ok: false, reason: 'mount-full' });
  });

  it('the load check refuses a cut length outside the entry', () => {
    const bus = panelBus();
    place(bus, DUCT, at(0, 90, 14));
    const world = {
      ...bus.state,
      entities: bus.state.entities.map((e) => (e.id === 2 ? { ...e, state: { ...e.state, lengthMm: 10 } } : e)),
    };
    expect(checkWorldReferences(world).map((i) => i.path)).toStrictEqual(['entities[1].state.lengthMm']);
    expect(checkWorldReferences(bus.state)).toStrictEqual([]);
  });

  it('the load check re-runs the mount check with each mounted body’s own state (guardian N1)', () => {
    const bus = panelBus();
    place(bus, DUCT, at(-25, 90, 14)); // along 0..300 on the 350 mm plate
    place(bus, ST4, at(-65, 150, 22));
    place(bus, ST4, at(-59, 150, 22));
    expect(checkWorldReferences(bus.state)).toStrictEqual([]);
    const crafted = (update: (e: (typeof bus.state.entities)[number]) => (typeof bus.state.entities)[number]) => ({
      ...bus.state,
      entities: bus.state.entities.map(update),
    });
    // A 2000 mm duct (a length the entry allows) on the 350 mm plate: off the mount.
    const long = crafted((e) => (e.id === 2 ? { ...e, state: { ...e.state, lengthMm: 2000 } } : e));
    expect(checkWorldReferences(long)).toStrictEqual([
      { path: 'entities[1].mountedOn', message: 'Not a place the mount allows (off-mount)' },
    ]);
    // A block at the modular-device line (cross 0) instead of its crossMm 21: off the mount, and (as
    // checkMount has always counted a neighbour that isn't on the mount) its neighbour reports no room.
    const low = crafted((e) =>
      e.id === 3 ? { ...e, transform: { ...e.transform, positionMm: at(-69, 105, 22) } } : e,
    );
    expect(checkWorldReferences(low).map((i) => [i.path, i.message])).toStrictEqual([
      ['entities[2].mountedOn', 'Not a place the mount allows (off-mount)'],
      ['entities[3].mountedOn', 'Not a place the mount allows (mount-full)'],
    ]);
    // Two blocks on one 6 mm slot: both crowd the rail.
    const stacked = crafted((e) =>
      e.id === 4 ? { ...e, transform: { ...e.transform, positionMm: at(-69, 126, 22) } } : e,
    );
    expect(checkWorldReferences(stacked).map((i) => [i.path, i.message])).toStrictEqual([
      ['entities[2].mountedOn', 'Not a place the mount allows (mount-full)'],
      ['entities[3].mountedOn', 'Not a place the mount allows (mount-full)'],
    ]);
  });
});

describe('DIN terminal blocks', () => {
  it('centre on the rail (crossMm) and pack at their own width', () => {
    const bus = panelBus();
    // 100 mm along rail-1: k = round(97 / 6) = 16, so 96 mm; 21 mm above the mount origin.
    expect(place(bus, ST4, at(-65, 150, 22))).toMatchObject({ positionMm: at(-69, 126, 22), kind: 'mount' });
    expect(place(bus, ST4, at(-59, 150, 22)).positionMm).toStrictEqual(at(-63, 126, 22)); // k = 17: 102 mm
    expect(place(bus, PE4, at(-53, 150, 22)).positionMm).toStrictEqual(at(-57, 126, 22)); // k = 18: 108 mm
    // The 5 mm spring block 120 mm along: k = round(117.5 / 5) = 24, so 120 mm, centred 45 − 28 = 17 mm above.
    expect(place(bus, SC25, at(-45, 150, 22)).positionMm).toStrictEqual(at(-45, 122, 22));
    // Over the ground block's span (108..114): k = 22, 110 mm, crowds it.
    expect(placeInWorld(bus.state, SC25, at(-53, 150, 22), [])).toMatchObject({ ok: false, reason: 'mount-full' });
    // Its body centre is the rail centreline: 122 + 56 / 2 = 150; the 48 mm blocks' 126 + 24 = 150.
    expect(bus.state.entities.map((e) => e.mountedOn?.mount ?? null)).toStrictEqual([
      null,
      'rail-1',
      'rail-1',
      'rail-1',
      'rail-1',
    ]);
  });

  it('a block next to a breaker packs from the breaker’s module-slot edge', () => {
    const bus = panelBus();
    place(bus, BREAKER, at(-145, 150, 22)); // slot 0: along 0..40
    // The cursor over 40..46: k = round(40 / 6) = 7 → 42 mm (blocks keep their own 6 mm grid from the rail start).
    expect(place(bus, ST4, at(-122, 150, 22)).positionMm).toStrictEqual(at(-123, 126, 22));
  });

  it('can’t go inside a duct: the duct is solid for placement', () => {
    const bus = panelBus();
    // A duct across rail-1's place: plate cross 300, so panel y 325..365, z 14..74.
    place(bus, DUCT, at(0, 145, 14));
    expect(bus.state.entities[1].transform.positionMm).toStrictEqual(at(-150, 125, 14));
    expect(placeInWorld(bus.state, ST4, at(-65, 150, 22), [])).toMatchObject({ ok: false, reason: 'overlaps' });
    expect(
      bus.exec('entity.place', {
        ref: ST4,
        positionMm: at(-69, 126, 22),
        mountedOn: { entity: 1, mount: 'rail-1' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'overlaps' } });
  });

  it('ducts and conduit are hollow for route-collides; terminal blocks are bodies', () => {
    const bus = panelBus();
    place(bus, DUCT, at(0, 90, 14));
    place(bus, ST4, at(-65, 150, 22));
    expect(obstacleBoxes(bus.state, BUILTIN_CATALOG).map((b) => b.entity)).toStrictEqual([3]);
  });
});

describe('EMT-lite snapping', () => {
  function withOpenKnockout(): Bus {
    const bus = panelBus();
    const opened = bus.exec('enclosure.openEntry', { id: 1, entry: 'ko-bottom-1', tool: SCREWDRIVER });
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    return bus;
  }

  it('turns a local direction onto a world one four ways, ranked, all exact', () => {
    const minusX = at(-1, 0, 0);
    const up = at(0, 1, 0);
    const turns = orientationsTurning(minusX, up);
    expect(turns).toHaveLength(4);
    for (const o of turns) expect(rotateQuarterTurns(o, minusX)).toStrictEqual(up);
    // First: local +z stays world +z (a roll of 270°).
    expect(turns[0]).toStrictEqual({ yaw: 0, pitch: 0, roll: 270_000 });
    expect(rotateQuarterTurns(turns[0], at(0, 0, 1))).toStrictEqual(at(0, 0, 1));
  });

  it('offers only open entries of the part’s trade size, and free ends', () => {
    expect(racewayTargets(panelBus().state, BUILTIN_CATALOG, '3/4', true)).toStrictEqual([]);
    const bus = withOpenKnockout();
    expect(racewayTargets(bus.state, BUILTIN_CATALOG, '3/4', true).map((t) => t.id)).toStrictEqual([
      'entity-1:ko-bottom-1',
    ]);
    expect(racewayTargets(bus.state, BUILTIN_CATALOG, '1', true)).toStrictEqual([]);
    expect(racewayTargets(bus.state, BUILTIN_CATALOG, '3/4', false)).toStrictEqual([]); // a stick doesn't go in an entry
  });

  it('a connector into the knockout, a stick on it, cut, and an elbow on the stick’s end', () => {
    const bus = withOpenKnockout();
    // Connector: its entry end (0, 17, 17), facing −x, turned onto +y (in); +z stays +z, so +y → +x:
    // the offset turns to (17, 0, 17), so it sits at (-100 − 17, -200, 100 − 17).
    const connector = place(bus, CONNECTOR, at(-95, -205, 100));
    expect(connector).toMatchObject({
      kind: 'raceway',
      targetId: 'entity-1:ko-bottom-1',
      positionMm: at(-117, -200, 83),
      orientationMdeg: { yaw: 0, pitch: 0, roll: 270_000 },
      mountedOn: null,
    });
    // Its outer end: (-117, -200, 83) + 25 × (−y) + 17 × (+x) + 17 × (+z) = (-100, -225, 100), facing −y.
    const stick = place(bus, STICK, at(-100, -250, 100));
    expect(stick).toMatchObject({ targetId: 'entity-2:end-b', positionMm: at(-112, -225, 88) });
    expect(bus.state.entities[2].state).toStrictEqual({ lengthMm: 1000 });
    expect(bus.exec('raceway.cut', { id: 3, lengthMm: 300 }).ok).toBe(true);
    // The stick's free end is now 300 mm below the connector: (-100, -525, 100), facing −y.
    expect(racewayTargets(bus.state, BUILTIN_CATALOG, '3/4', false).map((t) => [t.id, t.pointMm])).toStrictEqual([
      ['entity-3:end-b', at(-100, -525, 100)],
    ]);
    // Each of the four turns gives a different exact placement on that end.
    const turned = [0, 1, 2, 3].map((t) => snapConduit(bus.state, BUILTIN_CATALOG, ELBOW, at(-100, -540, 100), t));
    expect(new Set(turned.map((t) => JSON.stringify(t?.orientationMdeg))).size).toBe(4);
    expect(snapConduit(bus.state, BUILTIN_CATALOG, ELBOW, at(-100, -540, 100), 4)).toStrictEqual(turned[0]);
    // Elbow: its end a (12, 0, 12) facing −y must point +y; the first ranked turn keeps its +z on +z.
    const elbow = place(bus, ELBOW, at(-100, -540, 100));
    expect(elbow.targetId).toBe('entity-3:end-b');
    const placedElbow = bus.state.entities[3];
    const end = rotateQuarterTurns(placedElbow.transform.orientationMdeg, at(12, 0, 12)) as PositionMm;
    const p = placedElbow.transform.positionMm;
    expect(at(p.x + end.x, p.y + end.y, p.z + end.z)).toStrictEqual(at(-100, -525, 100));
    expect(rotateQuarterTurns(placedElbow.transform.orientationMdeg, at(0, 0, 1))).toStrictEqual(at(0, 0, 1));
  });

  it('a filled end is no longer offered, and nothing out of reach snaps', () => {
    const bus = withOpenKnockout();
    place(bus, CONNECTOR, at(-95, -205, 100));
    place(bus, STICK, at(-100, -250, 100));
    expect(racewayTargets(bus.state, BUILTIN_CATALOG, '3/4', true).map((t) => t.id)).toStrictEqual([
      'entity-1:ko-bottom-1', // still open: a second connector overlaps the first (refused as overlaps)
      'entity-3:end-b',
    ]);
    expect(placeInWorld(bus.state, CONNECTOR, at(-95, -205, 100), [])).toMatchObject({ ok: false, reason: 'overlaps' });
    expect(snapConduit(bus.state, BUILTIN_CATALOG, ELBOW, at(500, 500, 500))).toBeNull();
    expect(snapConduit(bus.state, BUILTIN_CATALOG, DUCT, at(-100, -1225, 100))).toBeNull();
  });
});
