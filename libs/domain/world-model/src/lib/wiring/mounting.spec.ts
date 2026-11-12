import { World } from '@controls/save-format';
import fc from 'fast-check';
import {
  at,
  autoWireArgs,
  BLOCK,
  BREAKER,
  LABELLER,
  PANEL,
  STRIPPER,
  WIRING_TEST_CATALOG,
  wiringBench,
} from '../../testing';
import { checkWorldReferences } from '../devices';

/*
 * Mounting (ADR 0015, "Mounting and occupancy"; `mounting.ts`): placing on a mount, sliding along it,
 * the mount frame, room, and what a mounted, occupied or wired entity may do. Over the TEST-ONLY
 * wiring bench: the DIN panel (2) at x = 1000 with its rail `rail-1` from (1050, 300, 100) along +x for
 * 500 mm, the 15 A breaker (3, 40 mm wide) at its start and a terminal block (4, 20 mm) at 100 mm.
 */

const refused = (code: string) => ({ ok: false, error: { code } });
const Z = { yaw: 0, pitch: 0, roll: 0 };
const rail = { entity: 2, mount: 'rail-1' };

function expectValid(world: World) {
  expect(World.safeParse(world).success).toBe(true);
  expect(checkWorldReferences(world, WIRING_TEST_CATALOG)).toStrictEqual([]);
}

describe('entity.place on a mount', () => {
  it('records mountedOn and makes the host occupied; undo removes it', () => {
    const bus = wiringBench();
    expect(bus.state.entities[2]).toMatchObject({ id: 3, mountedOn: rail });
    expectValid(bus.state);
    const place = bus.exec('entity.place', { ref: BLOCK, positionMm: at(1300, 300, 100), mountedOn: rail });
    expect(place).toMatchObject({ ok: true, entry: { args: { mountedOn: rail } } });
    expect(bus.exec('entity.move', { id: 2, positionMm: at(0, 0, 0) })).toMatchObject(refused('occupied'));
    expect(bus.exec('entity.delete', { id: 2 })).toMatchObject(refused('occupied'));
    expect(bus.exec('entity.rotate', { id: 2, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject(
      refused('occupied'),
    );
  });

  it('refuses a position off the rail, the wrong frame, a crowded span and the end of the rail', () => {
    const bus = wiringBench();
    const place = (x: number, y = 300, z = 100, orientationMdeg = Z) =>
      bus.exec('entity.place', { ref: BLOCK, positionMm: at(x, y, z), orientationMdeg, mountedOn: rail });
    expect(place(1200, 301)).toMatchObject(refused('off-mount')); // above the rail line
    expect(place(1200, 300, 101)).toMatchObject(refused('off-mount')); // standing off it
    expect(place(1040)).toMatchObject(refused('off-mount')); // before its start
    expect(place(1531)).toMatchObject(refused('off-mount')); // 20 mm wide: past its end
    expect(place(1200, 300, 100, { yaw: 0, pitch: 0, roll: 90_000 })).toMatchObject(refused('off-mount'));
    expect(place(1200, 300, 100, { yaw: 1_000, pitch: 0, roll: 0 })).toMatchObject(refused('not-axis-aligned'));
    expect(place(1089)).toMatchObject(refused('mount-full')); // overlaps the breaker (1050–1090)
    expect(place(1160)).toMatchObject(refused('mount-full')); // overlaps the block (1150–1170)
    expect(place(1090).ok).toBe(true); // touching is fine
    expect(place(1530).ok).toBe(true); // the last 20 mm
    expectValid(bus.state);
  });

  it('composes the host orientation with the mount frame', () => {
    const bus = wiringBench();
    // A panel turned a quarter about +y: its rail runs along world -z, its devices face world +x.
    expect(
      bus.exec('entity.place', {
        ref: PANEL,
        positionMm: at(5000, 0, 0),
        orientationMdeg: { yaw: 90_000, pitch: 0, roll: 0 },
      }).ok,
    ).toBe(true);
    const turned = { yaw: 90_000, pitch: 0, roll: 0 };
    const mountedOn = { entity: 6, mount: 'rail-1' };
    // The rail starts at (50, 300, 100) in the panel's frame, which yaw 90° takes to (5100, 300, -50).
    expect(
      bus.exec('entity.place', { ref: BREAKER, positionMm: at(5100, 300, -50), orientationMdeg: Z, mountedOn }),
    ).toMatchObject(refused('off-mount'));
    expect(
      bus.exec('entity.place', { ref: BREAKER, positionMm: at(5100, 300, -50), orientationMdeg: turned, mountedOn }).ok,
    ).toBe(true);
    expect(
      bus.exec('entity.place', { ref: BREAKER, positionMm: at(5100, 300, -90), orientationMdeg: turned, mountedOn }).ok,
    ).toBe(true);
    expectValid(bus.state);
  });
});

describe('entity.place on an area mount (a backplate)', () => {
  // The panel's `plate` starts at (1050, 20, 50) in the world, 200 mm square; the block is 20 wide, 60 high.
  const plate = { entity: 2, mount: 'plate' };
  const place = (bus: ReturnType<typeof wiringBench>, x: number, y: number, z = 50) =>
    bus.exec('entity.place', { ref: BLOCK, positionMm: at(x, y, z), mountedOn: plate });

  it('takes a device anywhere on the plate, refuses one past extentMm − width or − height, or off its face', () => {
    const bus = wiringBench();
    expect(place(bus, 1050, 20).ok).toBe(true);
    expect(place(bus, 1230, 160).ok).toBe(true); // the far corner: 180 + 20 and 140 + 60 = 200
    expect(place(bus, 1231, 20)).toMatchObject(refused('off-mount'));
    expect(place(bus, 1150, 161)).toMatchObject(refused('off-mount'));
    expect(place(bus, 1049, 100)).toMatchObject(refused('off-mount'));
    expect(place(bus, 1150, 19)).toMatchObject(refused('off-mount'));
    expect(place(bus, 1150, 100, 51)).toMatchObject(refused('off-mount'));
    expectValid(bus.state);
  });

  it('refuses overlapping footprints (mount-full) and allows touching ones', () => {
    const bus = wiringBench();
    expect(place(bus, 1100, 50).ok).toBe(true); // spans 1100–1120 × 50–110
    expect(place(bus, 1110, 80)).toMatchObject(refused('mount-full'));
    expect(place(bus, 1119, 109)).toMatchObject(refused('mount-full'));
    expect(place(bus, 1120, 50).ok).toBe(true); // touching along the axis
    expect(place(bus, 1100, 110).ok).toBe(true); // touching across it
    expect(place(bus, 1081, 0 + 20)).toMatchObject(refused('mount-full')); // 1081–1101 overlaps, 20–80 overlaps 50–110
    expectValid(bus.state);
  });
});

describe('entity.move on a mount', () => {
  it('slides a mounted device along its mount, re-checked; never off it', () => {
    const bus = wiringBench();
    expect(bus.exec('entity.move', { id: 4, positionMm: at(1400, 300, 100) }).ok).toBe(true);
    expect(bus.exec('entity.move', { id: 4, positionMm: at(1060, 300, 100) })).toMatchObject(refused('mount-full'));
    expect(bus.exec('entity.move', { id: 4, positionMm: at(1400, 400, 100) })).toMatchObject(refused('off-mount'));
    expect(bus.exec('entity.move', { id: 3, positionMm: at(1100, 300, 100) }).ok).toBe(true); // it doesn't crowd itself
    expect(bus.exec('entity.rotate', { id: 4, deltaMdeg: { yaw: 0, pitch: 0, roll: 90_000 } })).toMatchObject(
      refused('mounted'),
    );
    expectValid(bus.state);
  });

  it('a wired mounted device does not slide', () => {
    const bus = wiringBench();
    expect(bus.exec('wire.add', autoWireArgs()).ok).toBe(true);
    expect(bus.exec('entity.move', { id: 3, positionMm: at(1100, 300, 100) })).toMatchObject(refused('wired'));
  });

  it('any slide along the rail keeps the world valid (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 900, max: 1700 }), fc.integer({ min: 290, max: 310 }), (x, y) => {
        const bus = wiringBench();
        const result = bus.exec('entity.move', { id: 4, positionMm: at(x, y, 100) });
        const onRail = y === 300 && x >= 1090 && x <= 1530;
        expect(result.ok).toBe(onRail);
        expectValid(bus.state);
      }),
      { numRuns: 60 },
    );
  });
});

describe('entity.label', () => {
  it('prints a label with a tool that can label; null removes it; undo restores it', () => {
    const bus = wiringBench();
    expect(bus.exec('entity.label', { id: 3, text: 'CB1', tool: LABELLER }).ok).toBe(true);
    expect(bus.state.entities[2].label).toBe('CB1');
    expect(bus.exec('entity.label', { id: 3, text: 'CB2', tool: STRIPPER })).toMatchObject(refused('wrong-tool'));
    expect(bus.exec('entity.label', { id: 99, text: 'CB2', tool: LABELLER })).toMatchObject(refused('not-found'));
    expect(bus.exec('entity.label', { id: 3, text: null, tool: LABELLER }).ok).toBe(true);
    expect(bus.state.entities[2].label).toBeNull();
    bus.exec('edit.undo');
    expect(bus.state.entities[2].label).toBe('CB1');
    expectValid(bus.state);
  });
});
