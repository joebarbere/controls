import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld, type World } from '@controls/save-format';
import fc from 'fast-check';
import { createWorldBus } from '../session';
import type { CatalogRef } from '../types';
import { boxesOverlap, overlappingEntity, refBodyBox } from './overlap';

/*
 * F3.5 part 1, the P1 follow-up: `overlaps`. The commands refuse in the `mounting` scope (a pair with an
 * enclosure or a mounted device), so every log written before world v3 still replays; the placement
 * maths uses the `all` scope (`world-placement.spec.ts`).
 */

const refused = (code: string) => ({ ok: false, error: { code } });
const at = (x: number, y: number, z: number) => ({ x, y, z });
const Z = { yaw: 0, pitch: 0, roll: 0 };
const PANEL: CatalogRef = { id: 'panel.pellmoor-din-400x500', version: 1 };
const BOX_1G: CatalogRef = { id: 'box.tinmoor-1g-steel', version: 1 };
const BOX_4SQ: CatalogRef = { id: 'box.tinmoor-4sq-steel', version: 1 };
const BREAKER: CatalogRef = { id: 'breaker.saltmere-1p-15a', version: 1 };
const LAMP: CatalogRef = { id: 'lamp.lumivane-12v-5w', version: 1 };
const CRATE: CatalogRef = { id: 'prop.crate', version: 1 };
const BOX_PROP: CatalogRef = { id: 'prop.box', version: 1 };

const bus = () => createWorldBus(createWorld({ seed: 0 }));

describe('overlap bodies', () => {
  it('are the quarter-turn body box; touching faces do not overlap', () => {
    const a = refBodyBox(BUILTIN_CATALOG, BOX_1G, { positionMm: at(0, 0, 0), orientationMdeg: Z });
    expect(a).toStrictEqual({ min: at(0, 0, 0), max: at(55, 80, 66) });
    const turned = refBodyBox(BUILTIN_CATALOG, BOX_1G, {
      positionMm: at(0, 0, 0),
      orientationMdeg: { yaw: 90_000, pitch: 0, roll: 0 },
    });
    expect(turned).toStrictEqual({ min: at(0, 0, -55), max: at(66, 80, 0) });
    expect(boxesOverlap(a as never, { min: at(55, 0, 0), max: at(100, 80, 66) })).toBe(false);
    expect(boxesOverlap(a as never, { min: at(54, 79, 65), max: at(100, 100, 100) })).toBe(true);
    expect(
      refBodyBox(
        BUILTIN_CATALOG,
        { id: 'lead.quillfern-test-1m', version: 1 },
        { positionMm: at(0, 0, 0), orientationMdeg: Z },
      ),
    ).toBeNull();
    expect(
      refBodyBox(BUILTIN_CATALOG, { id: 'nope.x', version: 1 }, { positionMm: at(0, 0, 0), orientationMdeg: Z }),
    ).toBeNull();
  });
});

describe('entity.place and entity.move refuse overlaps with enclosures and mounted devices', () => {
  it('nothing free goes inside a box, and a box never goes over something', () => {
    const b = bus();
    expect(b.exec('entity.place', { ref: BOX_1G, positionMm: at(0, 0, 0) }).ok).toBe(true);
    expect(b.exec('entity.place', { ref: LAMP, positionMm: at(5, 5, 5) })).toMatchObject(refused('overlaps'));
    expect(b.exec('entity.place', { ref: BOX_4SQ, positionMm: at(50, 0, 0) })).toMatchObject(refused('overlaps'));
    expect(b.exec('entity.place', { ref: BOX_4SQ, positionMm: at(55, 0, 0) }).ok).toBe(true); // touching
    expect(b.exec('entity.place', { ref: CRATE, positionMm: at(1000, 0, 0) }).ok).toBe(true);
    // Moving the crate into the 4 in box, or the box onto the crate, is refused; the message names the other.
    expect(b.exec('entity.move', { id: 3, positionMm: at(100, 0, 0) })).toMatchObject({
      ok: false,
      error: { code: 'overlaps', message: 'It would overlap entity 2' },
    });
    expect(b.exec('entity.move', { id: 2, positionMm: at(1000, 0, 0) })).toMatchObject(refused('overlaps'));
    expect(b.exec('entity.move', { id: 2, positionMm: at(2000, 0, 0) }).ok).toBe(true);
  });

  it('a device mounted on a panel is inside it; a free one there is refused', () => {
    const b = bus();
    b.exec('entity.place', { ref: PANEL, positionMm: at(-200, -250, 0) });
    const mountedOn = { entity: 1, mount: 'rail-1' };
    expect(b.exec('entity.place', { ref: BREAKER, positionMm: at(-77, 55, 23), mountedOn }).ok).toBe(true);
    expect(b.exec('entity.place', { ref: BREAKER, positionMm: at(-77, -120, 23) })).toMatchObject(refused('overlaps'));
    // A prop pushed into the breaker in front of the panel is refused against the mounted breaker too.
    expect(
      overlappingEntity(
        b.state,
        BUILTIN_CATALOG,
        BOX_PROP,
        { positionMm: at(-100, 60, 80), orientationMdeg: Z },
        null,
        null,
        'mounting',
      ),
    ).toBe(1);
    // Sliding the breaker along its rail is fine, and it never overlaps its own host.
    expect(b.exec('entity.move', { id: 2, positionMm: at(-25, 55, 23) }).ok).toBe(true);
  });

  it('free props and devices may still stack through the commands (pre-v3 logs do); the placement maths refuses them', () => {
    const b = bus();
    expect(b.exec('entity.place', { ref: CRATE, positionMm: at(0, 0, 0) }).ok).toBe(true);
    expect(b.exec('entity.place', { ref: LAMP, positionMm: at(0, 0, 0) }).ok).toBe(true);
    expect(b.exec('entity.move', { id: 2, positionMm: at(10, 0, 0) }).ok).toBe(true);
    const lamp = { positionMm: at(10, 0, 0), orientationMdeg: Z };
    expect(overlappingEntity(b.state, BUILTIN_CATALOG, LAMP, lamp, null, 2, 'mounting')).toBeNull();
    expect(overlappingEntity(b.state, BUILTIN_CATALOG, LAMP, lamp, null, 2, 'all')).toBe(1);
  });
});

describe('overlaps (property)', () => {
  const refs = [PANEL, BOX_1G, BOX_4SQ, CRATE, BOX_PROP, LAMP];
  const coordinate = fc.integer({ min: -400, max: 400 });
  const quarter = fc.constantFrom(0, 90_000, 180_000, 270_000);
  type Op =
    | { kind: 'place'; ref: CatalogRef; p: { x: number; y: number; z: number }; yaw: number }
    | { kind: 'mount'; x: number }
    | { kind: 'move'; pick: number; p: { x: number; y: number; z: number } }
    | { kind: 'undo' };
  const point = fc.record({ x: coordinate, y: coordinate, z: coordinate });
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('place' as const),
        ref: fc.constantFrom(...refs),
        p: point,
        yaw: quarter,
      }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('mount' as const), x: fc.integer({ min: 0, max: 290 }) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('move' as const), pick: fc.nat({ max: 6 }), p: point }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  );

  /** Every pair the commands keep apart: one is an enclosure or mounted, and neither hosts the other. */
  function clashes(world: World): string[] {
    const found: string[] = [];
    const counts = (e: World['entities'][number]) => e.mountedOn !== null || BUILTIN_CATALOG.device(e.ref)?.enclosure;
    for (const a of world.entities) {
      for (const b of world.entities) {
        if (a.id >= b.id || !(counts(a) || counts(b))) continue;
        if (a.mountedOn?.entity === b.id || b.mountedOn?.entity === a.id) continue;
        const ba = refBodyBox(BUILTIN_CATALOG, a.ref, a.transform);
        const bb = refBodyBox(BUILTIN_CATALOG, b.ref, b.transform);
        if (ba && bb && boxesOverlap(ba, bb)) found.push(`${a.id}/${b.id}`);
      }
    }
    return found;
  }

  it('no sequence of place, mount, move and undo ever leaves an enclosure or a mounted device overlapping a body', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const b = bus();
        for (const op of ops) {
          if (op.kind === 'place') {
            b.exec('entity.place', { ref: op.ref, positionMm: op.p, orientationMdeg: { ...Z, yaw: op.yaw } });
          } else if (op.kind === 'mount') {
            // A breaker onto the first panel's rail 1, at an integer offset along it.
            const panel = b.state.entities.find((e) => e.ref.id === PANEL.id && e.transform.orientationMdeg.yaw === 0);
            if (!panel) continue;
            const o = panel.transform.positionMm;
            b.exec('entity.place', {
              ref: BREAKER,
              positionMm: at(o.x + 35 + op.x, o.y + 305, o.z + 23),
              mountedOn: { entity: panel.id, mount: 'rail-1' },
            });
          } else if (op.kind === 'move') {
            const e = b.state.entities[op.pick];
            if (e) b.exec('entity.move', { id: e.id, positionMm: op.p });
          } else {
            b.exec('edit.undo', {});
          }
          expect(clashes(b.state)).toStrictEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });
});
