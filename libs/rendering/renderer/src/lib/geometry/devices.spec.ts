import {
  Box3,
  DoubleSide,
  Group,
  Mesh,
  Raycaster,
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
import { TERMINAL_OWN_DEVICE_TOLERANCE_M } from '../viewport-controller';
import {
  BULB_SLOT,
  BULB_TINTS,
  buildDeviceCover,
  buildDeviceEntries,
  buildDeviceGeometry,
  buildDeviceLever,
  buildDeviceMaterials,
  DEVICE_SLOTS,
  deviceDefinitionFor,
  deviceLabel,
  CLOSED_ENTRY_SLOT,
  entryIsOpen,
  leverAngle,
  OPENING_SLOT,
  UTILITY_KINDS,
  UTILITY_LUG_PROUD_MM,
} from './devices';
import { PropRecipes, UNKNOWN_PROP } from './props';

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

// --- F3.5 part 1: the breaker, the fuse and the enclosures -----------------------------------

const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };
const FUSE = { id: 'fuse.emberlyn-5x20-fa-1a', version: 1 };
const ENCLOSURES = [
  { id: 'box.tinmoor-1g-steel', version: 1 },
  { id: 'box.tinmoor-2g-nm', version: 1 },
  { id: 'box.tinmoor-4sq-steel', version: 1 },
  { id: 'box.tinmoor-4rd-nm-ceiling', version: 1 },
  { id: 'panel.pellmoor-din-400x500', version: 1 },
];

describe('F3.5 recipes', () => {
  it('draw the breaker, the fuse and every enclosure (no longer unknown objects)', () => {
    for (const ref of [BREAKER, FUSE, ...ENCLOSURES]) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect([BREAKER, FUSE, ...ENCLOSURES].map((ref) => deviceLabel(def(ref)))).toStrictEqual([
      'Saltmere SB-115',
      'Emberlyn EF-520-1A',
      'Tinmoor TM-132C',
      'Tinmoor TM-2GN',
      'Tinmoor TM-4S15',
      'Tinmoor TM-4RC',
      'Pellmoor PM-4520-D',
    ]);
  });

  it.each([BREAKER, FUSE])('%o fills its catalogue size from the min corner and reaches every terminal', (ref) => {
    const d = def(ref);
    const g = buildDeviceGeometry(d);
    const b = bounds(g);
    const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
    expect(toMm(b.min).every((n) => n >= -1)).toBe(true);
    expect(b.max.x * 1000).toBeCloseTo(size.widthMm, 3);
    expect(b.max.y * 1000).toBeLessThanOrEqual(size.heightMm + 1);
    expect(b.max.y * 1000).toBeGreaterThanOrEqual(size.heightMm - 1e-3);
    expect(b.max.z * 1000).toBeLessThanOrEqual(size.depthMm + 1);
    for (const t of d.terminals) {
      const p = new Vector3(t.positionMm.x, t.positionMm.y, t.positionMm.z).multiplyScalar(0.001);
      expect(b.containsPoint(p), `${ref.id} ${t.id}`).toBe(true);
    }
    g.dispose();
  });

  it('the breaker has a handle lever turned by state.on; the fuse has none', () => {
    const lever = buildDeviceLever(def(BREAKER));
    expect(lever).toMatchObject({ stateKey: 'on', userKey: 'breaker', pivotMm: { x: 20, y: 45, z: 70 } });
    expect(DEVICE_SLOTS[lever?.slot ?? -1]).toBe('panel');
    lever?.geometry.dispose();
    expect(buildDeviceLever(def(FUSE))).toBeNull();
    for (const ref of ENCLOSURES) expect(buildDeviceLever(def(ref))).toBeNull();
  });

  it.each(ENCLOSURES)(
    '%o is an open-fronted body exactly its size, with an entry part at each catalogue entry',
    (ref) => {
      const d = def(ref);
      const g = buildDeviceGeometry(d);
      const b = bounds(g);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      expect(toMm(b.min)).toStrictEqual([0, 0, 0]);
      expect(toMm(b.max)).toStrictEqual([size.widthMm, size.heightMm, size.depthMm]);
      const entries = buildDeviceEntries(d);
      expect(entries.map((e) => e.id)).toStrictEqual(d.enclosure?.entries.map((e) => e.id));
      entries.forEach((part, i) => {
        // The entry's catalogue position is on its part (the outside face), inside the body's bounds.
        const p = d.enclosure?.entries[i].positionMm as { x: number; y: number; z: number };
        const point = new Vector3(p.x, p.y, p.z).multiplyScalar(0.001);
        expect(bounds(part.geometry).clone().expandByScalar(1e-6).containsPoint(point), `${ref.id} ${part.id}`).toBe(
          true,
        );
        expect(b.clone().expandByScalar(0.001).containsPoint(point)).toBe(true);
        part.geometry.dispose();
      });
      g.dispose();
    },
  );

  it('match the geometry snapshot (bounds, vertices, slots, entries and levers per entry)', () => {
    const summary = [BREAKER, FUSE, ...ENCLOSURES].map((ref) => {
      const d = def(ref);
      const g = buildDeviceGeometry(d);
      const b = bounds(g);
      const lever = buildDeviceLever(d);
      const entries = buildDeviceEntries(d);
      const out = {
        id: ref.id,
        boundsMm: [...toMm(b.min), ...toMm(b.max)],
        vertices: g.getAttribute('position').count,
        slots: g.groups.map((group) => [DEVICE_SLOTS[group.materialIndex as number], group.count]),
        lever: lever && {
          pivotMm: lever.pivotMm,
          boundsMm: [...toMm(bounds(lever.geometry).min), ...toMm(bounds(lever.geometry).max)],
        },
        entries: entries.map((e) => [
          e.id,
          e.type,
          ...toMm(bounds(e.geometry).min).map(Math.round),
          ...toMm(bounds(e.geometry).max).map(Math.round),
        ]),
      };
      g.dispose();
      lever?.geometry.dispose();
      entries.forEach((e) => e.geometry.dispose());
      return out;
    });
    expect(summary).toMatchSnapshot('F3.5 recipes');
  });

  it('nonmetallic boxes are blue; steel ones galvanised; enclosures draw double-sided bodies', () => {
    const body = (id: string) => buildDeviceMaterials(def({ id, version: 1 }))[DEVICE_SLOTS.indexOf('body')];
    expect(body('box.tinmoor-2g-nm').color.getHex()).toBe(0x2f5fa8);
    expect(body('box.tinmoor-1g-steel').color.getHex()).toBe(0xb8bec4);
    expect(body('box.tinmoor-1g-steel').side).toBe(DoubleSide);
    expect(entryIsOpen(0b101, 0)).toBe(true);
    expect(entryIsOpen(0b101, 1)).toBe(false);
    expect(entryIsOpen(0b101, 2)).toBe(true);
    expect(entryIsOpen(null, 0)).toBe(false);
    expect([OPENING_SLOT, CLOSED_ENTRY_SLOT].map((i) => DEVICE_SLOTS[i])).toStrictEqual(['opening', 'accent']);
  });

  it('an enclosure recipe disposes its entry geometries with the last release', () => {
    const recipes = new PropRecipes();
    const box = recipes.acquire(ENCLOSURES[0]);
    expect(box.enclosure).toBe(true);
    expect(box.entries).toHaveLength(5);
    const owned = [box.geometry, box.entriesAll as BufferGeometry, ...box.entries.map((e) => e.geometry)];
    const spies = [...owned, ...(box.material as Material[])].map((r) => vi.spyOn(r, 'dispose'));
    recipes.release(ENCLOSURES[0]);
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(recipes.size).toBe(0);
    expect(recipes.acquire(BREAKER).enclosure).toBe(false);
    recipes.dispose();
  });
});

// --- F3.5 part 2: wire duct, EMT-lite and DIN terminal blocks ---------------------------------

const DUCTS = ['duct.lattisby-25x40', 'duct.lattisby-40x60', 'duct.lattisby-60x80'].map((id) => ({ id, version: 1 }));
const EMT = ['emt.stavenor-050', 'emt.stavenor-075', 'emt.stavenor-100'].map((id) => ({ id, version: 1 }));
const ELBOWS = ['elbow.stavenor-emt-050', 'elbow.stavenor-emt-075', 'elbow.stavenor-emt-100'].map((id) => ({
  id,
  version: 1,
}));
const CONNECTORS = ['connector.stavenor-emt-050', 'connector.stavenor-emt-075', 'connector.stavenor-emt-100'].map(
  (id) => ({ id, version: 1 }),
);
const BLOCKS = ['tb.quennick-st4', 'tb.quennick-sc25', 'tb.quennick-pe4'].map((id) => ({ id, version: 1 }));
const PART_2 = [...DUCTS, ...EMT, ...ELBOWS, ...CONNECTORS, ...BLOCKS];
const DUCT_40 = DUCTS[1];

describe('F3.5 part 2 recipes', () => {
  it('draw every duct, EMT part and terminal block, with its fictional label', () => {
    for (const ref of PART_2) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect(BLOCKS.map((ref) => deviceLabel(def(ref)))).toStrictEqual([
      'Quennick QST 4',
      'Quennick QSC 2.5',
      'Quennick QPE 4',
    ]);
  });

  it('a duct and a stick are drawn at their cut length (default when not placed), within their body box', () => {
    const duct = def(DUCT_40);
    const atDefault = bounds(buildDeviceGeometry(duct));
    expect(toMm(atDefault.min)).toStrictEqual([0, 0, 0]);
    expect(toMm(atDefault.max)).toStrictEqual([300, 40, 58]); // 60 deep, less the 2 mm cover
    const cut = buildDeviceGeometry(duct, { lengthMm: 125, coverOn: true });
    expect(toMm(bounds(cut).max)[0]).toBe(125);
    const cover = buildDeviceCover(duct, { lengthMm: 125 }) as BufferGeometry;
    expect([...toMm(bounds(cover).min), ...toMm(bounds(cover).max)]).toStrictEqual([0, 0, 58, 125, 40, 60]);
    expect(buildDeviceCover(def(EMT[0]))).toBeNull();
    const stick = bounds(buildDeviceGeometry(def(EMT[1]), { lengthMm: 750 }));
    // A 23.42 mm tube centred in its 24 mm body, its bore discs 0.3 mm proud of each cut end.
    expect(toMm(stick.min)).toStrictEqual([-0.3, 0.29, 0.29]);
    expect(toMm(stick.max)).toStrictEqual([750.3, 23.71, 23.71]);
  });

  it('an elbow’s tube runs from its end a to its end b inside its box', () => {
    const elbow = def(ELBOWS[1]); // L 64, R 114, D 24: box 190 × 190 × 24
    const b = bounds(buildDeviceGeometry(elbow));
    expect(toMm(b.min).map((n) => Math.round(n) + 0)).toStrictEqual([0, 0, 0]);
    expect(toMm(b.max).map((n) => Math.round(n) + 0)).toStrictEqual([190, 190, 24]);
  });

  it('a terminal block reaches its height, and its entries are at entryMm', () => {
    for (const ref of BLOCKS) {
      const d = def(ref);
      const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
      const b = bounds(buildDeviceGeometry(d));
      expect(toMm(b.max)[1], ref.id).toBeCloseTo(size.heightMm, 0);
      for (const t of d.terminals) {
        const e = t.methods[0].entryMm;
        const point = new Vector3(e.x, e.y, e.z).multiplyScalar(0.001);
        expect(b.clone().expandByScalar(0.001).containsPoint(point), `${ref.id} ${t.id}`).toBe(true);
      }
    }
    const green = buildDeviceMaterials(def(BLOCKS[2]))[DEVICE_SLOTS.indexOf('body')];
    expect(green.color.getHex()).toBe(0x2e8b3a);
  });

  it('match the geometry snapshot (bounds, vertices and slots per entry, at the default length)', () => {
    const summary = PART_2.map((ref) => {
      const d = def(ref);
      const g = buildDeviceGeometry(d);
      const b = bounds(g);
      const out = {
        id: ref.id,
        boundsMm: [...toMm(b.min), ...toMm(b.max)],
        vertices: g.getAttribute('position').count,
        slots: g.groups.map((group) => [DEVICE_SLOTS[group.materialIndex as number], group.count]),
      };
      g.dispose();
      return out;
    });
    expect(summary).toMatchSnapshot('F3.5 part 2 recipes');
  });

  it('caches one recipe per cut length, and disposes each (cover included) with its last release', () => {
    const recipes = new PropRecipes();
    const a = recipes.acquire(DUCT_40, { lengthMm: 200, coverOn: false });
    const b = recipes.acquire(DUCT_40, { lengthMm: 200, coverOn: true }); // the cover is a child, not the recipe
    const c = recipes.acquire(DUCT_40, null);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(recipes.keyOf(DUCT_40, { lengthMm: 200 })).toBe('duct.lattisby-40x60@1#200');
    expect(recipes.keyOf(DUCT_40, null)).toBe('duct.lattisby-40x60@1#300');
    expect(recipes.keyOf(BLOCKS[0], { lengthMm: 5 })).toBe('tb.quennick-st4@1');
    expect(recipes.size).toBe(2);
    const owned = [a.geometry, a.cover as BufferGeometry, ...(a.material as Material[])];
    const spies = owned.map((r) => vi.spyOn(r, 'dispose'));
    recipes.release(DUCT_40, { lengthMm: 200 });
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    recipes.release(DUCT_40, { lengthMm: 200 });
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    recipes.release(DUCT_40, null);
    expect(recipes.size).toBe(0);
  });
});

describe('F3.5 part 2 in the scene', () => {
  const panelWorld = (duct: Record<string, unknown>): World =>
    worldOf(deviceEntity(1, DUCT_40, 100, duct), deviceEntity(2, EMT[1], 500), deviceEntity(3, BLOCKS[0], 900));

  it('draws a duct, a stick and a block (scene-graph snapshot); the cover follows coverOn', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(panelWorld({ lengthMm: 300, coverOn: false }));
    const graph = describeSceneGraph(scene.getObjectByName('world') as Group);
    expect(graph).toMatchSnapshot('F3.5 part 2 devices');
    expect(node(sync, scene, 1)?.duct).toStrictEqual({ coverOn: false, lengthMm: 300 });
    expect(node(sync, scene, 2)?.raceway).toStrictEqual({ lengthMm: 1000 });
    const cover = () => (sync.objectOf(1) as Mesh).getObjectByName('cover') as Mesh;
    expect(cover().visible).toBe(false);
    const result = sync.sync(panelWorld({ lengthMm: 300, coverOn: true }));
    expect(cover().visible).toBe(true);
    expect(result.membershipChanged).toBe(false); // the same recipe: no picker rebuild
    expect(sync.surfaceRoots().map((o) => o.name)).toStrictEqual(['entity-1', 'entity-2']);
    expect(sync.enclosureRoots()).toStrictEqual([]);
    sync.dispose();
  });

  it('a cut swaps the recipe (a picker rebuild) and frees the old length; teardown returns to baseline', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(panelWorld({ lengthMm: 300, coverOn: false }));
    const old = (sync.objectOf(1) as Mesh).geometry;
    const oldSpy = vi.spyOn(old, 'dispose');
    const result = sync.sync(panelWorld({ lengthMm: 120, coverOn: false }));
    expect(result.membershipChanged).toBe(true);
    expect(oldSpy).toHaveBeenCalledTimes(1);
    expect(bounds((sync.objectOf(1) as Mesh).geometry).max.x * 1000).toBeCloseTo(120, 3);
    expect(sync.recipes.size).toBe(3);

    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    expect(geometries.size).toBe(4); // the duct, its cover, the stick and the block
    const spies = [...geometries, ...materials].map((r) => vi.spyOn(r, 'dispose'));
    sync.dispose();
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(sync.recipes.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});

// --- Twist-on wire nuts (splice.twistOn) ------------------------------------------------------

const NUTS = ['splice.corvelle-tw-s', 'splice.corvelle-tw-m', 'splice.corvelle-tw-l'].map((id) => ({ id, version: 1 }));

describe('wire nut recipes', () => {
  it('draw every twist-on size (no longer the unknown cube), with its fictional label', () => {
    for (const ref of NUTS) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect(NUTS.map((ref) => deviceLabel(def(ref)))).toStrictEqual(['Corvelle TW-S', 'Corvelle TW-M', 'Corvelle TW-L']);
  });

  it.each(NUTS)('%o fills its body box, its mouth at the splice entry', (ref) => {
    const d = def(ref);
    const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
    const g = buildDeviceGeometry(d);
    const b = bounds(g);
    // The skirt is the body's width and depth, the dome its height; the mouth disc 0.3 mm proud of y = 0.
    expect(toMm(b.min)).toStrictEqual([0, -0.3, 0]);
    expect(toMm(b.max)).toStrictEqual([size.widthMm, size.heightMm, size.depthMm]);
    const e = d.terminals[0].methods[0].entryMm;
    const mouth = g.groups.find((group) => DEVICE_SLOTS[group.materialIndex as number] === 'opening');
    expect(mouth).toBeDefined();
    expect(b.containsPoint(new Vector3(e.x, e.y, e.z).multiplyScalar(0.001))).toBe(true);
    g.dispose();
  });

  it('match the geometry snapshot (bounds, vertices and slots per size)', () => {
    const summary = NUTS.map((ref) => {
      const g = buildDeviceGeometry(def(ref));
      const b = bounds(g);
      const out = {
        id: ref.id,
        boundsMm: [...toMm(b.min), ...toMm(b.max)],
        vertices: g.getAttribute('position').count,
        slots: g.groups.map((group) => [DEVICE_SLOTS[group.materialIndex as number], group.count]),
      };
      g.dispose();
      return out;
    });
    expect(summary).toMatchSnapshot('wire nut recipes');
  });

  it('draw a neutral shell (the entry has no colour) with a dark mouth, and have no lever, entries or cover', () => {
    const d = def(NUTS[0]);
    const materials = buildDeviceMaterials(d);
    expect(materials[DEVICE_SLOTS.indexOf('body')].color.getHex()).toBe(0xb9ad97);
    expect(materials[OPENING_SLOT].color.getHex()).toBe(0x101214);
    materials.forEach((m) => m.dispose());
    expect(buildDeviceLever(d)).toBeNull();
    expect(buildDeviceEntries(d)).toStrictEqual([]);
    expect(buildDeviceCover(d)).toBeNull();
  });
});

describe('wire nuts in the scene', () => {
  it('draws three nuts (scene-graph snapshot) and disposes every recipe exactly once at teardown', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(worldOf(deviceEntity(1, NUTS[0], 100), deviceEntity(2, NUTS[1], 140), deviceEntity(3, NUTS[2], 180)));
    const graph = describeSceneGraph(scene.getObjectByName('world') as Group);
    expect(graph).toMatchSnapshot('wire nuts');
    expect(sync.recipes.size).toBe(3);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    expect(geometries.size).toBe(3);
    const spies = [...geometries, ...materials].map((r) => vi.spyOn(r, 'dispose'));
    sync.dispose();
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(sync.recipes.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});

// --- Utility services: the P3 stand-in supply (D12) and the three-phase services --------------

const UTILITIES = BUILTIN_CATALOG.devices
  .filter((d) => d.model.kind.startsWith('utility.'))
  .map((d) => ({ id: d.id, version: d.version }));

describe('every drawn catalogue device has a recipe', () => {
  it('no device with a body size falls back to the unknown-object cube', () => {
    const missing = BUILTIN_CATALOG.devices
      .filter((d) => d.sizeMm !== null && deviceDefinitionFor(d) === undefined)
      .map((d) => `${d.id} (${d.model.kind})`);
    expect(missing).toStrictEqual([]);
  });
});

describe('utility service recipes', () => {
  it('draw the split-phase stand-in and both three-phase services, with their fictional label', () => {
    expect(UTILITIES.map((r) => r.id)).toStrictEqual([
      'utility.larkmoor-208y120-150kva',
      'utility.larkmoor-480y277-1000kva',
      'utility.larkmoor-split-phase-25kva',
    ]);
    expect(new Set(UTILITIES.map((r) => def(r).model.kind))).toStrictEqual(new Set(UTILITY_KINDS));
    for (const ref of UTILITIES) expect(deviceDefinitionFor(ref)?.id).toBe(ref.id);
    expect(UTILITIES.map((ref) => deviceLabel(def(ref)))).toStrictEqual([
      'Larkmoor Power LP-3W150',
      'Larkmoor Power LP-3W1000',
      'Larkmoor Power LP-SP25',
    ]);
  });

  it.each(UTILITIES)('%o fills its catalogue size, with a lug at every terminal standing out of the front', (ref) => {
    const d = def(ref);
    const size = d.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
    const g = buildDeviceGeometry(d);
    const b = bounds(g);
    // The cabinet spans the body box from the min corner; only the lugs (bore mouths) stand proud of the front.
    expect(toMm(b.min)).toStrictEqual([0, 0, 0]);
    expect(toMm(b.max)).toStrictEqual([size.widthMm, size.heightMm, size.depthMm + UTILITY_LUG_PROUD_MM + 0.3]);
    // Looking straight at each terminal along −z, the first thing hit is its lug's dark bore, just in
    // front of it (within the picker's 15 mm own-device tolerance); just beside the bore, the tinned lug.
    expect(UTILITY_LUG_PROUD_MM + 0.3).toBeLessThan(TERMINAL_OWN_DEVICE_TOLERANCE_M * 1000);
    const mesh = new Mesh(g, buildDeviceMaterials(d));
    const ray = new Raycaster();
    const firstHit = (x: number, y: number) => {
      ray.set(new Vector3(x / 1000, y / 1000, 1), new Vector3(0, 0, -1));
      const hit = ray.intersectObject(mesh)[0];
      return hit && { slot: DEVICE_SLOTS[hit.face?.materialIndex as number], zMm: Math.round(hit.point.z * 1e4) / 10 };
    };
    for (const t of d.terminals) {
      const p = t.positionMm;
      expect(firstHit(p.x, p.y), `${ref.id} ${t.id}`).toStrictEqual({
        slot: 'opening',
        zMm: p.z + UTILITY_LUG_PROUD_MM + 0.3,
      });
      expect(firstHit(p.x + 6, p.y), `${ref.id} ${t.id} lug`).toStrictEqual({
        slot: 'accent',
        zMm: p.z + UTILITY_LUG_PROUD_MM,
      });
      // Its entry point (where a landed wire ends) is the terminal's position, on the cabinet front.
      expect(p.z).toBe(size.depthMm);
      for (const m of t.methods) expect(m.entryMm).toStrictEqual(p);
    }
    (mesh.material as Material[]).forEach((m) => m.dispose());
    expect(new Set(g.groups.map((group) => DEVICE_SLOTS[group.materialIndex as number]))).toStrictEqual(
      new Set(['body', 'panel', 'label', 'accent', 'opening']),
    );
    g.dispose();
  });

  it('match the geometry snapshot (bounds, vertices and slots per entry)', () => {
    const summary = UTILITIES.map((ref) => {
      const g = buildDeviceGeometry(def(ref));
      const b = bounds(g);
      const out = {
        id: ref.id,
        boundsMm: [...toMm(b.min), ...toMm(b.max)],
        vertices: g.getAttribute('position').count,
        slots: g.groups.map((group) => [DEVICE_SLOTS[group.materialIndex as number], group.count]),
      };
      g.dispose();
      return out;
    });
    expect(summary).toMatchSnapshot('utility recipes');
  });

  it('draw a grey painted cabinet with tinned lugs and dark bores, and have no lever, entries or cover', () => {
    const d = def(UTILITIES[2]);
    const materials = buildDeviceMaterials(d);
    expect(materials[DEVICE_SLOTS.indexOf('body')].color.getHex()).toBe(0x8a9095);
    expect(materials[DEVICE_SLOTS.indexOf('accent')].color.getHex()).toBe(0xb8bcc0);
    expect(materials[OPENING_SLOT].color.getHex()).toBe(0x101214);
    materials.forEach((m) => m.dispose());
    expect(buildDeviceLever(d)).toBeNull();
    expect(buildDeviceEntries(d)).toStrictEqual([]);
    expect(buildDeviceCover(d)).toBeNull();
  });
});

describe('utility services in the scene', () => {
  it('draws the stand-in supply as its recipe, not the unknown cube, and disposes it exactly once', () => {
    const scene = new Scene();
    const sync = new WorldSync(scene);
    sync.sync(worldOf(deviceEntity(1, UTILITIES[2], -1500), deviceEntity(2, UTILITIES[0], -1000)));
    const graph = describeSceneGraph(scene.getObjectByName('world') as Group);
    expect(graph).toMatchSnapshot('utility services');
    expect(graph.children?.map((c) => [c.name, c.label, c.selectable])).toStrictEqual([
      ['entity-1', 'Larkmoor Power LP-SP25', 'device:entity-1'],
      ['entity-2', 'Larkmoor Power LP-3W150', 'device:entity-2'],
    ]);
    const supply = sync.recipes.acquire(UTILITIES[2]);
    expect(supply.spec).not.toBe(UNKNOWN_PROP);
    expect(supply.spec.sizeMm).toStrictEqual(def(UTILITIES[2]).sizeMm);
    sync.recipes.release(UTILITIES[2]);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    expect(geometries.size).toBe(2);
    const spies = [...geometries, ...materials].map((r) => vi.spyOn(r, 'dispose'));
    sync.dispose();
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(sync.recipes.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});
