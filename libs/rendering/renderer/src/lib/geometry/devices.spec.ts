import { Box3, Group, Scene, Vector3, type BufferGeometry, type Material } from 'three/webgpu';
import { BUILTIN_CATALOG, type DeviceDefinition } from '@controls/catalog';
import { initialBags } from '@controls/catalog';
import type { Entity, World } from '@controls/world-model';
import { describeSceneGraph } from '../scene';
import { WorldSync } from '../world/world-sync';
import { buildDeviceGeometry, buildDeviceMaterials, DEVICE_SLOTS, deviceDefinitionFor, deviceLabel } from './devices';
import { PropRecipes } from './props';

const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const BENCH_SUPPLY = { id: 'supply.brindlecore-bench-30v-5a', version: 1 };
const DIN_PSU = { id: 'supply.railwick-din-24v-5a', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const DEVICES = [BATTERY, BENCH_SUPPLY, DIN_PSU];

const def = (ref: { id: string; version: number }) => BUILTIN_CATALOG.device(ref) as DeviceDefinition;
const bounds = (g: BufferGeometry): Box3 => {
  g.computeBoundingBox();
  return g.boundingBox as Box3;
};
// Geometry is Float32: compare in mm to a micrometre.
const toMm = (v: Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e3);

describe('device recipes (F2.4)', () => {
  it('draw the battery, the bench supply and the DIN PSU; other catalogue kinds and props have none yet', () => {
    for (const ref of DEVICES) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect(deviceDefinitionFor(LAMP)).toBeUndefined(); // F2.5's recipe
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
