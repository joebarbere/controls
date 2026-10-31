import {
  Box3,
  Group,
  Mesh,
  Scene,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
} from 'three/webgpu';
import { BUILTIN_CATALOG, type DeviceDefinition } from '@controls/catalog';
import { initialBags } from '@controls/catalog';
import type { Entity, World } from '@controls/world-model';
import { describeSceneGraph } from '../scene';
import { WorldSync } from '../world/world-sync';
import {
  BULB_SLOT,
  BULB_TINTS,
  buildDeviceGeometry,
  buildDeviceLever,
  buildDeviceMaterials,
  DEVICE_SLOTS,
  deviceDefinitionFor,
  deviceLabel,
  leverAngle,
} from './devices';
import { PropRecipes } from './props';

const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const BENCH_SUPPLY = { id: 'supply.brindlecore-bench-30v-5a', version: 1 };
const DIN_PSU = { id: 'supply.railwick-din-24v-5a', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const SWITCH = { id: 'switch.tessaline-spst-toggle', version: 1 };
const RESISTOR = { id: 'resistor.orrinwood-10r-10w', version: 1 };
const HEATER = { id: 'heater.hearthvale-12v-50w', version: 1 };
const DEVICES = [BATTERY, BENCH_SUPPLY, DIN_PSU];
const F25_DEVICES = [SWITCH, LAMP, RESISTOR, HEATER];

const def = (ref: { id: string; version: number }) => BUILTIN_CATALOG.device(ref) as DeviceDefinition;
const bounds = (g: BufferGeometry): Box3 => {
  g.computeBoundingBox();
  return g.boundingBox as Box3;
};
// Geometry is Float32: compare in mm to a micrometre (`+ 0` turns -0 into 0).
const toMm = (v: Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e3 + 0);

describe('device recipes (F2.4)', () => {
  it('draw the battery, the bench supply, the DIN PSU and the F2.5 devices; props and unknown versions have none', () => {
    for (const ref of [...DEVICES, ...F25_DEVICES]) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect(deviceDefinitionFor({ id: 'prop.box', version: 1 })).toBeUndefined();
    expect(deviceDefinitionFor({ id: 'battery.ferrovane-12v-7ah', version: 9 })).toBeUndefined();
  });

  it('carry their fictional brand and model as the label', () => {
    expect(DEVICES.map((ref) => deviceLabel(def(ref)))).toStrictEqual([
      'Ferrovane FV12-7',
      'Brindlecore BX-217',
      'Railwick RW-24-5',
    ]);
  });

  it.each(DEVICES)('%o fills its catalogue size from the min corner, and reaches every terminal', (ref) => {
    const d = def(ref);
    const g = buildDeviceGeometry(d);
    const b = bounds(g);
    const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
    // The body spans the size; terminals and front details may stand a little proud of it.
    expect(b.min.x).toBeLessThanOrEqual(1e-6);
    expect(b.min.y).toBeLessThanOrEqual(1e-6);
    expect(b.min.z).toBeLessThanOrEqual(1e-6);
    expect(b.max.x).toBeGreaterThanOrEqual(size.widthMm / 1000 - 1e-6);
    expect(b.max.y).toBeGreaterThanOrEqual(size.heightMm / 1000 - 1e-6);
    expect(b.max.z).toBeGreaterThanOrEqual(size.depthMm / 1000 - 1e-6);
    // Nothing more than 20 mm outside the box (binding posts stand out 15 mm).
    expect(toMm(b.min).every((n) => n >= -20)).toBe(true);
    expect(b.max.x * 1000).toBeLessThanOrEqual(size.widthMm + 20);
    // Each terminal's position is on the drawn terminal (inside the terminal part's bounds, 1 mm slack).
    for (const t of d.terminals) {
      const p = new Vector3(t.positionMm.x, t.positionMm.y, t.positionMm.z).multiplyScalar(0.001);
      expect(b.clone().expandByScalar(0.001).containsPoint(p), `${ref.id} ${t.id}`).toBe(true);
    }
    // One group per slot used, each naming its slot's material.
    expect(g.groups.length).toBeGreaterThan(3);
    for (const group of g.groups) expect(group.materialIndex).toBeLessThan(DEVICE_SLOTS.length);
    expect(new Set(g.groups.map((group) => group.materialIndex)).size).toBe(g.groups.length);
    expect(buildDeviceMaterials(d)).toHaveLength(DEVICE_SLOTS.length);
  });

  it('shares and disposes geometry and every material with the last release', () => {
    const recipes = new PropRecipes();
    const a = recipes.acquire(BENCH_SUPPLY);
    expect(recipes.acquire(BENCH_SUPPLY)).toBe(a);
    expect(a.label).toBe('Brindlecore BX-217');
    expect(a.spec).toMatchObject({ title: '0–30 V 0–5 A bench DC power supply', sizeMm: def(BENCH_SUPPLY).sizeMm });
    const materials = a.material as Material[];
    const spies = [a.geometry, ...materials].map((r) => vi.spyOn(r, 'dispose'));
    recipes.release(BENCH_SUPPLY);
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    recipes.release(BENCH_SUPPLY);
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(recipes.size).toBe(0);
    // A teardown disposes device recipes too.
    const b = recipes.acquire(BATTERY);
    const teardown = [b.geometry, ...(b.material as Material[])].map((r) => vi.spyOn(r, 'dispose'));
    recipes.dispose();
    teardown.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
  });
});

/** The three bench devices laid on a bench top (pitched −90°, as `orientationForFrame` sets them). */
function benchWorld(): World {
  const entity = (id: number, ref: { id: string; version: number }, x: number, pitch: number): Entity => {
    const kind = BUILTIN_CATALOG.kindOf(ref);
    const bags = kind ? initialBags(kind) : { state: {}, sim: {} };
    return {
      id,
      ref,
      transform: { positionMm: { x, y: 900, z: 200 }, orientationMdeg: { yaw: 0, pitch, roll: 0 } },
      state: bags.state,
      sim: bags.sim,
      extensions: {},
    } as Entity;
  };
  return {
    schemaVersion: 2,
    seed: 0,
    tick: 0,
    regionId: 'nec',
    nextEntityId: 4,
    nextConnectionId: 1,
    fixtures: [],
    entities: [
      entity(1, BATTERY, 100, 270_000),
      entity(2, BENCH_SUPPLY, 400, 270_000),
      entity(3, DIN_PSU, 700, 270_000),
    ],
    connections: [],
    sim: null,
    extensions: {},
  } as unknown as World;
}

describe('device recipes in the scene (scene-graph snapshot)', () => {
  it('draws each placed device with its recipe, label and device selectable', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(benchWorld());
    const graph = describeSceneGraph(scene.getObjectByName('world') as Group);
    expect(graph).toMatchSnapshot('bench devices');
    expect(graph.children?.map((c) => [c.label, c.selectable])).toStrictEqual([
      ['Ferrovane FV12-7', 'device:entity-1'],
      ['Brindlecore BX-217', 'device:entity-2'],
      ['Railwick RW-24-5', 'device:entity-3'],
    ]);
    expect(sync.recipes.size).toBe(3);
    sync.dispose();
    expect(sync.recipes.size).toBe(0);
  });
});

// --- F2.5: the switch, the lamp, the resistor and the heater ---------------------------------

describe('F2.5 device recipes', () => {
  it('carry their fictional brand and model as the label', () => {
    expect(F25_DEVICES.map((ref) => deviceLabel(def(ref)))).toStrictEqual([
      'Tessaline TS-101',
      'Lumivane LV-12-5',
      'Orrinwood OW-10R-10',
      'Hearthvale HV-1250',
    ]);
  });

  it.each(F25_DEVICES)('%o stands on a base filling its footprint, inside its size, reaching every terminal', (ref) => {
    const d = def(ref);
    const g = buildDeviceGeometry(d);
    const b = bounds(g);
    const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
    // The base spans the footprint from the min corner; only the label strip stands 0.5 mm proud of the front.
    expect(toMm(b.min)).toStrictEqual([0, -0.5, 0]);
    expect(b.max.x * 1000).toBeCloseTo(size.widthMm, 3);
    expect(b.max.y * 1000).toBeCloseTo(size.heightMm, 3);
    expect(b.max.z * 1000).toBeLessThanOrEqual(size.depthMm + 1e-3);
    for (const t of d.terminals) {
      const p = new Vector3(t.positionMm.x, t.positionMm.y, t.positionMm.z).multiplyScalar(0.001);
      expect(b.containsPoint(p), `${ref.id} ${t.id}`).toBe(true);
    }
    for (const group of g.groups) expect(group.materialIndex).toBeLessThan(DEVICE_SLOTS.length);
    // Only the lamp has a bulb group.
    expect(g.groups.some((group) => group.materialIndex === BULB_SLOT)).toBe(ref === LAMP);
    expect(buildDeviceMaterials(d)).toHaveLength(DEVICE_SLOTS.length);
  });

  it('match the geometry snapshot (bounds, vertices and slots per kind)', () => {
    const summary = F25_DEVICES.map((ref) => {
      const g = buildDeviceGeometry(def(ref));
      const b = bounds(g);
      const lever = buildDeviceLever(def(ref));
      const out = {
        id: ref.id,
        boundsMm: [...toMm(b.min), ...toMm(b.max)],
        vertices: g.getAttribute('position').count,
        slots: g.groups.map((group) => [DEVICE_SLOTS[group.materialIndex as number], group.count]),
        lever: lever && {
          pivotMm: lever.pivotMm,
          boundsMm: [...toMm(bounds(lever.geometry).min), ...toMm(bounds(lever.geometry).max)],
        },
      };
      g.dispose();
      lever?.geometry.dispose();
      return out;
    });
    expect(summary).toMatchSnapshot('F2.5 recipes');
  });

  it('only the switch has a lever; upright it reaches the top of the switch, thrown it leans ±25°', () => {
    for (const ref of [...DEVICES, LAMP, RESISTOR, HEATER]) expect(buildDeviceLever(def(ref))).toBeNull();
    const lever = buildDeviceLever(def(SWITCH));
    if (!lever) throw new Error('expected a lever');
    const top = lever.pivotMm.z + bounds(lever.geometry).max.z * 1000;
    expect(top).toBeGreaterThan(40);
    expect(top).toBeLessThanOrEqual(45 + 1e-3); // Float32
    expect(DEVICE_SLOTS[lever.slot]).toBe('accent');
    expect(leverAngle(true)).toBeCloseTo((-25 * Math.PI) / 180, 12);
    expect(leverAngle(false)).toBeCloseTo((25 * Math.PI) / 180, 12);
    lever.geometry.dispose();
  });
});

/** A catalogue device entity on a bench top, with its initial bags (`state` overrides them). */
const deviceEntity = (
  id: number,
  ref: { id: string; version: number },
  x: number,
  state: Record<string, unknown> = {},
): Entity => {
  const kind = BUILTIN_CATALOG.kindOf(ref);
  const bags = kind ? initialBags(kind) : { state: {}, sim: {} };
  return {
    id,
    ref,
    transform: { positionMm: { x, y: 900, z: 200 }, orientationMdeg: { yaw: 0, pitch: 270_000, roll: 0 } },
    state: { ...bags.state, ...state },
    sim: bags.sim,
    extensions: {},
  } as Entity;
};
const worldOf = (...entities: Entity[]): World =>
  ({ ...benchWorld(), nextEntityId: entities.length + 1, entities }) as World;

const node = (sync: WorldSync, scene: Scene, id: number) =>
  describeSceneGraph(scene.getObjectByName('world') as Group).children?.find((c) => c.name === `entity-${id}`);

describe('F2.5 devices in the scene', () => {
  it('draw the four devices; lamps start unknown, the switch open (scene-graph snapshot)', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(
      worldOf(
        deviceEntity(1, SWITCH, 100),
        deviceEntity(2, LAMP, 200),
        deviceEntity(3, RESISTOR, 300),
        deviceEntity(4, HEATER, 400),
      ),
    );
    const graph = describeSceneGraph(scene.getObjectByName('world') as Group);
    expect(graph).toMatchSnapshot('F2.5 devices');
    expect(graph.children?.map((c) => [c.label, c.lamp, c.switch])).toStrictEqual([
      ['Tessaline TS-101', undefined, { closed: false }],
      ['Lumivane LV-12-5', { level: 0, status: 'unknown' }, undefined],
      ['Orrinwood OW-10R-10', undefined, undefined],
      ['Hearthvale HV-1250', undefined, undefined],
    ]);
    sync.dispose();
  });

  it("the switch's lever follows the entity's commanded state on each world sync", () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(worldOf(deviceEntity(1, SWITCH, 100)));
    const lever = () => (sync.objectOf(1) as Mesh).getObjectByName('lever') as Mesh;
    expect(lever().rotation.x).toBeCloseTo(leverAngle(false), 12);
    sync.sync(worldOf(deviceEntity(1, SWITCH, 100, { closed: true })));
    expect(lever().rotation.x).toBeCloseTo(leverAngle(true), 12);
    expect(node(sync, scene, 1)?.switch).toStrictEqual({ closed: true });
    expect(node(sync, scene, 1)?.children?.[0]).toMatchObject({ name: 'lever', rotationMdeg: [-25_000, 0, 0] });
    sync.sync(worldOf(deviceEntity(1, SWITCH, 100, { closed: false })));
    expect(node(sync, scene, 1)?.switch).toStrictEqual({ closed: false });
    expect(node(sync, scene, 1)?.children?.[0]?.rotationMdeg).toStrictEqual([25_000, 0, 0]);
    sync.dispose();
  });

  it('each lamp glows by its own output; setLampOutputs reports a change only when a level or status moves', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(worldOf(deviceEntity(1, LAMP, 100), deviceEntity(2, LAMP, 200), deviceEntity(3, SWITCH, 300)));
    const bulb = (id: number) => ((sync.objectOf(id) as Mesh).material as MeshStandardMaterial[])[BULB_SLOT];
    expect(bulb(1)).not.toBe(bulb(2));
    // Only the bulb is per lamp; the other slots stay the recipe's.
    expect(((sync.objectOf(1) as Mesh).material as Material[])[0]).toBe(
      ((sync.objectOf(2) as Mesh).material as Material[])[0],
    );

    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 1, status: 'solved' as const }]]))).toBe(true);
    expect(sync.lampOf(1)).toStrictEqual({ level: 204, status: 'solved' });
    expect(sync.lampOf(2)).toStrictEqual({ level: 0, status: 'unknown' }); // no entry: unknown, not off
    expect(bulb(1).emissiveIntensity).toBeGreaterThan(0);
    expect(bulb(1).color.getHex()).toBe(BULB_TINTS.solved);
    expect(bulb(2).emissiveIntensity).toBe(0);
    expect(bulb(2).color.getHex()).toBe(BULB_TINTS.unknown);

    // A move smaller than a display step changes nothing drawn.
    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 1.0001, status: 'solved' as const }]]))).toBe(false);
    // Solved and dark is a real "off", drawn in clear glass.
    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 0, status: 'solved' as const }]]))).toBe(true);
    expect([sync.lampOf(1), bulb(1).color.getHex(), bulb(1).emissiveIntensity]).toStrictEqual([
      { level: 0, status: 'solved' },
      BULB_TINTS.solved,
      0,
    ]);
    // An unsolved island's zeroes are no reading: unknown, a status change.
    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 0, status: 'unsolved' as const }]]))).toBe(true);
    expect(sync.lampOf(1)).toStrictEqual({ level: 0, status: 'unknown' });
    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 0.7, status: 'singular' as const }]]))).toBe(false);
    // Unsettled: lit by its level, with the unsettled tint.
    expect(sync.setLampOutputs(new Map([[1, { lightOutputRel: 1, status: 'unsettled' as const }]]))).toBe(true);
    expect([sync.lampOf(1), bulb(1).color.getHex()]).toStrictEqual([
      { level: 204, status: 'unsettled' },
      BULB_TINTS.unsettled,
    ]);
    expect(node(sync, scene, 1)?.lamp).toStrictEqual({ level: 204, status: 'unsettled' });

    // A lamp added after the outputs arrived draws them at once.
    const outputs = new Map([[4, { lightOutputRel: 2, status: 'solved' as const }]]);
    sync.setLampOutputs(outputs);
    sync.sync(
      worldOf(
        deviceEntity(1, LAMP, 100),
        deviceEntity(2, LAMP, 200),
        deviceEntity(3, SWITCH, 300),
        deviceEntity(4, LAMP, 400),
      ),
    );
    expect(sync.lampOf(4)?.level).toBeGreaterThan(204);
    expect(sync.lampOf(3)).toBeUndefined(); // not a lamp
    sync.dispose();
  });

  it("disposes each lamp's own bulb on removal and everything exactly once at teardown", () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(worldOf(deviceEntity(1, LAMP, 100), deviceEntity(2, LAMP, 200), deviceEntity(3, SWITCH, 300)));
    const bulb1 = ((sync.objectOf(1) as Mesh).material as Material[])[BULB_SLOT];
    const recipeBulb = (sync.recipes.acquire(LAMP).material as Material[])[BULB_SLOT];
    sync.recipes.release(LAMP);
    const bulb1Spy = vi.spyOn(bulb1, 'dispose');
    const recipeBulbSpy = vi.spyOn(recipeBulb, 'dispose');
    sync.sync(worldOf(deviceEntity(2, LAMP, 200), deviceEntity(3, SWITCH, 300)));
    expect(bulb1Spy).toHaveBeenCalledTimes(1);
    expect(recipeBulbSpy).not.toHaveBeenCalled(); // lamp 2 still uses the recipe

    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    materials.add(recipeBulb);
    expect(geometries.size).toBe(3); // the lamp, the switch and its lever
    const spies = [...geometries, ...materials].map((r) => vi.spyOn(r, 'dispose'));
    sync.dispose();
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(sync.recipes.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});
