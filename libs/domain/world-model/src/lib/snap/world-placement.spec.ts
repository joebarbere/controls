import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld, type World } from '@controls/save-format';
import fc from 'fast-check';
import { WIRING_TEST_CATALOG } from '../../testing';
import { createWorldBus, createWorldRegistry } from '../session';
import type { CatalogRef } from '../types';
import { worldSnapTargets } from '../fixtures';
import type { SnapTarget } from './snap';
import { mountTargetId, placeInWorld, worldMountTargets } from './world-placement';
import { orientationForAxes, rotateQuarterTurns } from './quarter-turn';

/*
 * F3.5 part 1: mouse (and script) placement of catalogue devices, snapping to enclosure mounts, with
 * the commands' own checks. The DIN panel (400 × 500 × 200 mm) at (-200, -250, 0) facing +z puts
 * rail-1's mount origin at (-165, 55, 22) (its centreline at y = 100) and rail-2's at (-165, -120, 22);
 * the backplate square's at (-175, -225, 14).
 */

const PANEL: CatalogRef = { id: 'panel.pellmoor-din-400x500', version: 1 };
const BREAKER: CatalogRef = { id: 'breaker.saltmere-1p-15a', version: 1 };
const PSU: CatalogRef = { id: 'supply.railwick-din-24v-5a', version: 1 };
const LAMP: CatalogRef = { id: 'lamp.lumivane-12v-5w', version: 1 };
const BOX_1G: CatalogRef = { id: 'box.tinmoor-1g-steel', version: 1 };
const BOX_PROP: CatalogRef = { id: 'prop.box', version: 1 };
const CRATE: CatalogRef = { id: 'prop.crate', version: 1 };
const Z = { yaw: 0, pitch: 0, roll: 0 };
const at = (x: number, y: number, z: number) => ({ x, y, z });

/** A command bus over an empty world with the panel at (-200, -250, 0) as entity 1. */
function panelBus(catalog = BUILTIN_CATALOG, orientationMdeg = Z, positionMm = at(-200, -250, 0)) {
  const bus = createWorldBus(createWorld({ seed: 0 }), createWorldRegistry({ catalog }));
  const placed = bus.exec('entity.place', { ref: PANEL, positionMm, orientationMdeg });
  if (!placed.ok) throw new Error(JSON.stringify(placed));
  return bus;
}

/** A vertical backplate grid behind everything (a fixture target), facing +z at z = 0. */
const PLATE: SnapTarget = {
  kind: 'backplate-grid',
  id: 'backplate',
  frame: { origin: at(-1000, -1000, 0), normal: '+z' },
  widthMm: 3000,
  heightMm: 3000,
  marginMm: 0,
};
const RAIL: SnapTarget = {
  kind: 'din-rail',
  id: 'din-rail-1',
  frame: { origin: at(500, 500, 0), normal: '+z' },
  lengthMm: 500,
};

/** Places with the command the placement names, refusing loudly. */
function commit(bus: ReturnType<typeof panelBus>, ref: CatalogRef, p: ReturnType<typeof placeInWorld>) {
  if (!p.ok) throw new Error(`no placement: ${p.reason}`);
  const result = bus.exec('entity.place', {
    ref,
    positionMm: p.positionMm,
    orientationMdeg: p.orientationMdeg,
    mountedOn: p.mountedOn,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

describe('worldMountTargets', () => {
  it('lists each enclosure mount in world space, in entity then catalogue order', () => {
    const world = panelBus().state;
    expect(worldMountTargets(world).map((t) => [t.id, t.mount.type, t.occupancy, t.origin, t.axes])).toStrictEqual([
      ['entity-1:rail-1', 'din35', 'linear', at(-165, 55, 22), { x: at(1, 0, 0), y: at(0, 1, 0), z: at(0, 0, 1) }],
      ['entity-1:rail-2', 'din35', 'linear', at(-165, -120, 22), { x: at(1, 0, 0), y: at(0, 1, 0), z: at(0, 0, 1) }],
      ['entity-1:plate', 'backplate', 'area', at(-175, -225, 14), { x: at(1, 0, 0), y: at(0, 1, 0), z: at(0, 0, 1) }],
    ]);
    expect(mountTargetId(3, 'yoke')).toBe('entity-3:yoke');
  });

  it('turns mounts with their host, and skips a host that is not at quarter-turns', () => {
    const turned = worldMountTargets(panelBus(BUILTIN_CATALOG, { yaw: 90_000, pitch: 0, roll: 0 }).state);
    // Yaw 90°: the panel's +x runs to world -z and its front (+z) faces world +x.
    expect(turned[0]).toMatchObject({ axes: { x: at(0, 0, -1), y: at(0, 1, 0), z: at(1, 0, 0) } });
    const world = panelBus().state;
    const tilted: World = {
      ...world,
      entities: world.entities.map((e) => ({ ...e, transform: { ...e.transform, orientationMdeg: { ...Z, yaw: 1 } } })),
    };
    expect(worldMountTargets(tilted)).toStrictEqual([]);
  });
});

describe('placeInWorld onto enclosure mounts', () => {
  it('snaps the breaker onto rail 1 at a DIN module slot, with the mount frame and mountedOn, and the command takes it', () => {
    const bus = panelBus();
    // Cursor on the rail top, 100 mm along: the breaker's left edge goes to slot round(5 × 17.5) = 88.
    const p = placeInWorld(bus.state, BREAKER, at(-65, 100, 22), []);
    expect(p).toStrictEqual({
      ok: true,
      targetId: 'entity-1:rail-1',
      kind: 'mount',
      positionMm: at(-77, 55, 22),
      orientationMdeg: Z,
      mountedOn: { entity: 1, mount: 'rail-1' },
    });
    commit(bus, BREAKER, p);
    expect(bus.state.entities[1]).toMatchObject({ mountedOn: { entity: 1, mount: 'rail-1' } });
  });

  it('captures a hit on the backplate beside the rail, chooses rail 2 below, and ignores a hit too far off the plane', () => {
    const world = panelBus().state;
    expect(placeInWorld(world, BREAKER, at(-65, 70, 14), [])).toMatchObject({ ok: true, targetId: 'entity-1:rail-1' });
    expect(placeInWorld(world, BREAKER, at(-65, -75, 22), [])).toMatchObject({
      ok: true,
      targetId: 'entity-1:rail-2',
      positionMm: at(-77, -120, 22),
    });
    // 21 mm in front of the rail top: no mount, and no fixture given.
    expect(placeInWorld(world, BREAKER, at(-65, 100, 44), [])).toStrictEqual({
      ok: false,
      reason: 'no-target',
      targetId: null,
    });
    // Between the rails: the breaker doesn't fit the backplate mount.
    expect(placeInWorld(world, BREAKER, at(-65, 0, 14), [])).toMatchObject({ ok: false, reason: 'no-target' });
  });

  it('clamps to the ends of the rail, so the device always fits on it', () => {
    const world = panelBus().state;
    // Rail 1 runs x = -165 … 165; a 40 mm breaker's last slot is k = floor(290 / 17.5) = 16 → 280.
    expect(placeInWorld(world, BREAKER, at(-165, 100, 22), [])).toMatchObject({ positionMm: at(-165, 55, 22) });
    expect(placeInWorld(world, BREAKER, at(165, 100, 22), [])).toMatchObject({ positionMm: at(115, 55, 22) });
  });

  it('refuses a full slot (mount-full); the next free module slot is offered', () => {
    const bus = panelBus();
    commit(bus, BREAKER, placeInWorld(bus.state, BREAKER, at(-65, 100, 22), []));
    expect(placeInWorld(bus.state, BREAKER, at(-65, 100, 22), [])).toStrictEqual({
      ok: false,
      reason: 'mount-full',
      targetId: 'entity-1:rail-1',
    });
    // Slot 7 (123 mm) still overlaps the first breaker (88–128 mm): 40 mm isn't a whole number of 17.5 mm
    // modules. Slot 8 (140 mm) is free.
    expect(placeInWorld(bus.state, BREAKER, at(-25, 100, 22), [])).toMatchObject({ ok: false, reason: 'mount-full' });
    expect(placeInWorld(bus.state, BREAKER, at(-5, 100, 22), [])).toMatchObject({
      ok: true,
      positionMm: at(-25, 55, 22),
    });
    // A device on rail 2 that would reach up into rail 1's breaker: the 125 mm supply fits rail 2 and
    // stays clear (its top at y = 5), so nothing in this panel can overlap across rails.
    expect(placeInWorld(bus.state, PSU, at(-65, -75, 22), [])).toMatchObject({ ok: true });
  });

  it('places a device in a box yoke and a block on a backplate grid (test catalogue)', () => {
    const bus = createWorldBus(createWorld({ seed: 0 }), createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
    bus.exec('entity.place', { ref: { id: 'box.test-1gang', version: 1 }, positionMm: at(0, 0, 0) });
    bus.exec('entity.place', { ref: { id: 'panel.test-din', version: 1 }, positionMm: at(1000, 0, 0) });
    const options = { catalog: WIRING_TEST_CATALOG };
    const yoke = { id: 'tb.test-yoke', version: 1 };
    const inBox = placeInWorld(bus.state, yoke, at(35, 60, 60), [], options);
    expect(inBox).toMatchObject({ ok: true, targetId: 'entity-1:yoke', positionMm: at(25, 37, 60) });
    expect(placeInWorld(bus.state, yoke, at(80, 60, 60), [], options)).toMatchObject({ reason: 'no-target' });
    // The block fits the panel's rail and its backplate patch; on the patch it snaps to the 5 mm grid.
    const block = { id: 'tb.test-2', version: 1 };
    expect(placeInWorld(bus.state, block, at(1100, 100, 50), [], options)).toMatchObject({
      ok: true,
      targetId: 'entity-2:plate',
      positionMm: at(1090, 70, 50),
    });
    const onRail = placeInWorld(bus.state, block, at(1100, 330, 100), [], options);
    expect(onRail).toMatchObject({ ok: true, targetId: 'entity-2:rail-1' });
    // The yoke takes one device.
    if (!inBox.ok) throw new Error('unreachable');
    expect(bus.exec('entity.place', { ref: yoke, positionMm: inBox.positionMm, mountedOn: inBox.mountedOn }).ok).toBe(
      true,
    );
    expect(placeInWorld(bus.state, yoke, at(35, 60, 60), [], options)).toMatchObject({ reason: 'mount-full' });
  });

  it('follows a host turned a quarter-turn, or laid on its back, and the command accepts the orientation', () => {
    for (const orientationMdeg of [
      { yaw: 90_000, pitch: 0, roll: 0 },
      { yaw: 0, pitch: 270_000, roll: 0 },
    ]) {
      const bus = panelBus(BUILTIN_CATALOG, orientationMdeg, at(0, 0, 0));
      const rail = worldMountTargets(bus.state)[0];
      // Aim 100 mm along the rail, on its centreline (45 mm across), on the rail top.
      const { x, y } = rail.axes;
      const cursor = at(
        rail.origin.x + 100 * x.x + 45 * y.x,
        rail.origin.y + 100 * x.y + 45 * y.y,
        rail.origin.z + 100 * x.z + 45 * y.z,
      );
      const p = placeInWorld(bus.state, BREAKER, cursor, []);
      expect(p, JSON.stringify(orientationMdeg)).toMatchObject({ ok: true, targetId: 'entity-1:rail-1' });
      if (!p.ok) continue;
      expect(rotateQuarterTurns(p.orientationMdeg, at(1, 0, 0))).toStrictEqual(rail.axes.x);
      expect(rotateQuarterTurns(p.orientationMdeg, at(0, 0, 1))).toStrictEqual(rail.axes.z);
      commit(bus, BREAKER, p);
    }
  });
});

describe('placeInWorld onto fixtures', () => {
  it('places a catalogue device by its body footprint, a DIN device on a fixture rail, and not a lamp on one', () => {
    const world = createWorld({ seed: 0 });
    expect(placeInWorld(world, BOX_1G, at(0, 0, 0), [PLATE])).toMatchObject({
      ok: true,
      targetId: 'backplate',
      positionMm: at(-25, -40, 0), // centred on the cursor, 5 mm grid: 55 × 80 → u 972.5 → slot 194.5 rounds up → -25
      mountedOn: null,
    });
    expect(placeInWorld(world, BREAKER, at(600, 500, 7), [RAIL, PLATE])).toMatchObject({
      ok: true,
      targetId: 'din-rail-1',
    });
    // The lamp doesn't fit din35: the rail is skipped, so it snaps to the plate behind.
    expect(placeInWorld(world, LAMP, at(600, 500, 7), [RAIL, PLATE])).toMatchObject({
      ok: true,
      targetId: 'backplate',
    });
    // Props snap to rails as in P1.
    expect(placeInWorld(world, BOX_PROP, at(600, 500, 7), [RAIL, PLATE])).toMatchObject({ targetId: 'din-rail-1' });
  });

  it('refuses an overlap with any body (stricter than the commands), and an enclosure hides nothing behind it', () => {
    const bus = createWorldBus(createWorld({ seed: 0 }));
    const first = placeInWorld(bus.state, CRATE, at(0, 0, 0), [PLATE]);
    commit(bus, CRATE, first);
    expect(placeInWorld(bus.state, BOX_PROP, at(0, 0, 0), [PLATE])).toStrictEqual({
      ok: false,
      reason: 'overlaps',
      targetId: 'backplate',
    });
    // Beside it is fine.
    expect(placeInWorld(bus.state, BOX_PROP, at(300, 0, 0), [PLATE])).toMatchObject({ ok: true });
  });

  it('reports unknown refs, connections and missing entities', () => {
    const world = createWorld({ seed: 0 });
    expect(placeInWorld(world, { id: 'nope.thing', version: 1 }, at(0, 0, 0), [PLATE])).toMatchObject({
      reason: 'unknown-prop',
    });
    expect(placeInWorld(world, { id: 'lead.quillfern-test-1m', version: 1 }, at(0, 0, 0), [PLATE])).toMatchObject({
      reason: 'unknown-prop',
    });
    expect(placeInWorld(world, BOX_PROP, at(0, 0, 0), [PLATE], { moving: 9 })).toMatchObject({ reason: 'not-found' });
    expect(() => placeInWorld(world, BOX_PROP, at(0.5, 0, 0), [PLATE])).toThrow(RangeError);
  });
});

describe('placeInWorld for a move', () => {
  it('slides a mounted device along its own mount only, keeping orientation and mount', () => {
    const bus = panelBus();
    commit(bus, BREAKER, placeInWorld(bus.state, BREAKER, at(-65, 100, 22), []));
    const slide = placeInWorld(bus.state, BREAKER, at(35, 100, 22), [PLATE], { moving: 2 });
    expect(slide).toMatchObject({ ok: true, targetId: 'entity-1:rail-1', mountedOn: { entity: 1, mount: 'rail-1' } });
    if (!slide.ok) throw new Error('unreachable');
    expect(bus.exec('entity.move', { id: 2, positionMm: slide.positionMm }).ok).toBe(true);
    // Not onto rail 2, nor off the panel onto the plate fixture.
    expect(placeInWorld(bus.state, BREAKER, at(-65, -75, 22), [PLATE], { moving: 2 })).toMatchObject({
      ok: false,
      reason: 'off-mount',
    });
    expect(placeInWorld(bus.state, BREAKER, at(600, 600, 0), [PLATE], { moving: 2 })).toMatchObject({
      reason: 'off-mount',
    });
  });

  it('refuses to move an occupied enclosure, and moves a free one between same-facing fixtures', () => {
    const bus = panelBus();
    expect(placeInWorld(bus.state, PANEL, at(800, 0, 0), [PLATE], { moving: 1 })).toMatchObject({ ok: true });
    commit(bus, BREAKER, placeInWorld(bus.state, BREAKER, at(-65, 100, 22), []));
    expect(placeInWorld(bus.state, PANEL, at(800, 0, 0), [PLATE], { moving: 1 })).toStrictEqual({
      ok: false,
      reason: 'occupied',
      targetId: null,
    });
    // A free device never moves onto a mount (entity.move can't change mountedOn).
    commit(bus, PSU, placeInWorld(bus.state, PSU, at(800, 800, 0), [PLATE]));
    expect(placeInWorld(bus.state, PSU, at(-65, 100, 22), [PLATE], { moving: 3 })).toMatchObject({
      reason: 'no-target',
    });
  });

  it('a move keeps orientation: only same-facing fixtures count, and an odd orientation has none', () => {
    const bus = createWorldBus(createWorld({ seed: 0 }));
    bus.exec('entity.place', {
      ref: CRATE,
      positionMm: at(0, 0, 0),
      orientationMdeg: { yaw: 1_000, pitch: 0, roll: 0 },
    });
    expect(placeInWorld(bus.state, CRATE, at(0, 0, 0), [PLATE], { moving: 1 })).toMatchObject({
      reason: 'orientation-mismatch',
    });
  });
});

describe('placeInWorld properties', () => {
  it('a placement it offers is always accepted by entity.place, and is the same for the same inputs', () => {
    const bus = panelBus();
    commit(bus, BREAKER, placeInWorld(bus.state, BREAKER, at(-65, 100, 22), []));
    const world = bus.state;
    const coordinate = fc.integer({ min: -400, max: 400 });
    const depth = fc.integer({ min: -10, max: 60 });
    fc.assert(
      fc.property(
        fc.constantFrom(BREAKER, PSU, LAMP, BOX_PROP, CRATE, BOX_1G),
        coordinate,
        coordinate,
        depth,
        (ref, x, y, z) => {
          const p = placeInWorld(world, ref, at(x, y, z), [PLATE, RAIL]);
          expect(placeInWorld(world, ref, at(x, y, z), [PLATE, RAIL])).toStrictEqual(p);
          if (!p.ok) return;
          const replay = createWorldBus(world);
          const result = replay.exec('entity.place', {
            ref,
            positionMm: p.positionMm,
            orientationMdeg: p.orientationMdeg,
            mountedOn: p.mountedOn,
          });
          expect(result.ok, JSON.stringify(p)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('orientationForAxes finds the canonical triple for every quarter-turn frame, and refuses a non-frame', () => {
    const axes = [at(1, 0, 0), at(-1, 0, 0), at(0, 1, 0), at(0, -1, 0), at(0, 0, 1), at(0, 0, -1)];
    let frames = 0;
    for (const x of axes) {
      for (const z of axes) {
        const o = orientationForAxes(x, z);
        const perpendicular = x.x * z.x + x.y * z.y + x.z * z.z === 0;
        expect(o === null, `${JSON.stringify(x)} ${JSON.stringify(z)}`).toBe(!perpendicular);
        if (o === null) continue;
        frames++;
        expect(rotateQuarterTurns(o, at(1, 0, 0))).toStrictEqual(x);
        expect(rotateQuarterTurns(o, at(0, 0, 1))).toStrictEqual(z);
      }
    }
    expect(frames).toBe(24); // the 24 rotations of the cube
  });

  it('worldSnapTargets and worldMountTargets together are what the mouse snaps to', () => {
    const world = panelBus().state;
    expect(worldSnapTargets(world)).toStrictEqual([]); // no fixtures in this world
    expect(worldMountTargets(world)).toHaveLength(3);
  });
});
