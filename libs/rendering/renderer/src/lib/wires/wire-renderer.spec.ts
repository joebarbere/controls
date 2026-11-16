import {
  BufferAttribute,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  Scene,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { bakeWorldRoutes, type World } from '@controls/world-model';
import { cableRunBus, routingPanelBus, routingParityWorld } from '@controls/world-model/testing';
import { mm } from '@controls/units';
import { describeSceneGraph } from '../scene';
import { WireRenderer, type WireTint } from './wire-renderer';
import { halfAt } from './wire-segments';

/** The routing-parity world (ADR 0017 §10): eight duct-routed THHN wires, a coiled one, one through EMT. */
const PARITY = routingParityWorld();

/** `world` with connection `id` labelled `text` (a crafted world: `wire.label` is the command that does this). */
const labelled = (world: World, id: number, text: string): World => ({
  ...world,
  connections: world.connections.map((c) => (c.id === id ? { ...c, label: text } : c)),
});

/** `world` without its routed conductors (a lead or nothing left). */
const unwired = (world: World): World => ({ ...world, connections: world.connections.filter((c) => c.route === null) });

const setup = (world: World | null = PARITY) => {
  const scene = new Scene();
  const invalidate = vi.fn();
  const wires = new WireRenderer(scene, BUILTIN_CATALOG, invalidate);
  if (world) wires.sync(world);
  return { scene, wires, invalidate };
};

const lookMesh = (scene: Scene, look: string) => scene.getObjectByName(`wires:${look}`) as InstancedMesh;

/** Every geometry and material under `root`, with dispose spies. */
const spyAll = (root: Scene) => {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const meshes: InstancedMesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) {
      geometries.add(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
    }
    if (o instanceof InstancedMesh) meshes.push(o);
  });
  return {
    geometries: [...geometries].map((g) => vi.spyOn(g, 'dispose')),
    materials: [...materials].map((m) => vi.spyOn(m, 'dispose')),
    meshes: meshes.map((m) => vi.spyOn(m, 'dispose')),
  };
};

/** A cable on two free waypoints, ends free (a crafted world: its conductors and entries don't matter to drawing). */
const withCable = (world: World): World => {
  const free = (x: number) => ({
    kind: 'free' as const,
    positionMm: { x, y: 600, z: 40 },
    entity: null,
    fixture: null,
    tool: null,
  });
  return {
    ...world,
    cables: [
      {
        id: 1,
        ref: { id: 'cable.sorrelby-nmb-12-2', version: 1 },
        a: null,
        b: null,
        route: [free(0), free(400)],
        lengthMm: 404,
        tailsMm: { a: 0, b: 0 },
        jacketStripMm: { a: 0, b: 0 },
        label: null,
        extensions: {},
      },
    ],
    nextCableId: 2,
  };
};

/** Conductor `c`'s end `a` is 0x0000c0 + 2c, end `b` 0x0000c1 + 2c: every half its own colour. */
const perConnection: WireTint = { colour: (c, end) => 0xc0 + 2 * c + (end === 'a' ? 0 : 1), unknownColour: 0x777777 };
const hex = (v: number) => `#${v.toString(16).padStart(6, '0')}`;
/** Instance `i`'s colour as a hex value (instanceColor holds linear sRGB). */
const instanceHex = (mesh: InstancedMesh, i: number) => {
  const c = new Color();
  mesh.getColorAt(i, c);
  return c.getHex();
};

// ADR 0010's r186 gotcha: no partial upload of an instanced attribute, ever (also an ESLint rule).
let updateRange: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  updateRange = vi.spyOn(BufferAttribute.prototype, 'addUpdateRange');
});
afterEach(() => {
  expect(updateRange).not.toHaveBeenCalled();
  updateRange.mockRestore();
});

describe('WireRenderer', () => {
  it('draws the bake: one instanced mesh per look, one instance per segment (scene-graph snapshot)', () => {
    const { scene, wires } = setup(labelled(PARITY, 3, 'X1-3'));
    const graph = wires.describe();
    expect(graph).toMatchSnapshot('wire graph');
    expect(describeSceneGraph(scene.getObjectByName('wires') as Scene)).toMatchSnapshot('scene graph');
    // Every route the bake draws is drawn, in bake order, with as many segments as the bake has links
    // (plus its coil's).
    const baked = bakeWorldRoutes(PARITY, BUILTIN_CATALOG).routes;
    expect(graph.routes.map((r) => r.owner)).toStrictEqual(baked.map((r) => r.owner));
    graph.routes.forEach((r, i) => {
      if (baked[i].coil === null) expect(r.segments).toBe(baked[i].points.length / 3 - 1);
      else expect(r.segments).toBeGreaterThan(baked[i].points.length / 3 - 1);
    });
    // THHN only: one look, so one draw for every wire.
    expect(graph.looks.map((l) => l.look)).toStrictEqual(['thhnThwn2']);
    expect(graph.looks[0].instances).toBe(graph.routes.reduce((n, r) => n + r.segments, 0));
    expect(graph.routes.find((r) => r.coil !== null)?.colour).toBe('#c62828'); // the red 5 m wire coils
    expect(graph.routes.find((r) => r.label !== null)).toMatchObject({ owner: 'c3', label: 'X1-3' });
    expect(graph.sleeves).toBe(2);
  });

  it('places each segment on the baked centreline: an instance matrix ends on the bake points (mm)', () => {
    const { scene } = setup();
    const mesh = lookMesh(scene, 'thhnThwn2');
    const first = bakeWorldRoutes(PARITY, BUILTIN_CATALOG).routes[0].points;
    const m = new (mesh.instanceMatrix.array.constructor as Float32ArrayConstructor)(16);
    m.set(mesh.instanceMatrix.array.subarray(0, 16));
    // The translation is the first segment's midpoint, in scene metres.
    const mid = [0, 1, 2].map((c) => (first[c] + first[3 + c]) / 2 / 10 / 1000);
    expect(m[12]).toBeCloseTo(mid[0], 6);
    expect(m[13]).toBeCloseTo(mid[1], 6);
    expect(m[14]).toBeCloseTo(mid[2], 6);
  });

  it('a second insulation adds one mesh (one draw), in look order; its last wire gone, the mesh goes', () => {
    const MTW = { id: 'conductor.tallowmere-mtw-14', version: 1 };
    const mixed: World = {
      ...PARITY,
      connections: PARITY.connections.map((c) => (c.id === 2 ? { ...c, ref: MTW } : c)),
    };
    const { scene, wires } = setup(mixed);
    expect(wires.describe().looks.map((l) => l.look)).toStrictEqual(['mtw', 'thhnThwn2']);
    expect(scene.getObjectByName('wires')?.children.map((c) => c.name)).toStrictEqual(['wires:mtw', 'wires:thhnThwn2']);
    expect(wires.describe().routes[1]).toMatchObject({ owner: 'c2', look: 'mtw' });
    const mtw = lookMesh(scene, 'mtw');
    const disposed = vi.spyOn(mtw, 'dispose');
    const material = vi.spyOn(mtw.material as Material, 'dispose');
    wires.sync(PARITY);
    expect(wires.describe().looks.map((l) => l.look)).toStrictEqual(['thhnThwn2']);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
  });

  it('a world without wires leaves the scene untouched and holds no GPU resource', () => {
    const { scene, wires } = setup(unwired(PARITY));
    expect(scene.getObjectByName('wires')).toBeUndefined();
    expect(wires.resourceCount).toBe(0);
    expect(wires.describe().inScene).toBe(false);
  });

  it('re-bakes on a world change only when the drawing changes, and uploads in full', () => {
    const { scene, wires } = setup();
    const mesh = lookMesh(scene, 'thhnThwn2');
    const range = vi.spyOn(mesh.instanceMatrix, 'addUpdateRange');
    const version = mesh.instanceMatrix.version;
    // The same arrays: nothing at all.
    expect(wires.sync(PARITY)).toBe(false);
    // A new world whose wires draw the same (an unrelated state change): no rewrite.
    expect(wires.sync({ ...PARITY, connections: [...PARITY.connections] })).toBe(false);
    expect(mesh.instanceMatrix.version).toBe(version);
    // A wire relabelled: the sleeves change, so it redraws, with a full upload (never a range).
    expect(wires.sync(labelled(PARITY, 1, 'A'))).toBe(true);
    expect(lookMesh(scene, 'thhnThwn2').instanceMatrix.version).toBeGreaterThan(version);
    expect(range).not.toHaveBeenCalled();
    expect(lookMesh(scene, 'thhnThwn2').instanceMatrix.updateRanges).toStrictEqual([]);
  });

  it('pools capacity: doubles when full, shrinks at a quarter, and disposes every mesh it replaces', () => {
    const bus = routingPanelBus(true);
    const one = { ...bus.state, connections: bus.state.connections.slice(0, 1) };
    const { scene, wires } = setup(one);
    const capacity = () => wires.describe().looks[0].capacity;
    expect(capacity()).toBe(64);
    const small = lookMesh(scene, 'thhnThwn2');
    const smallDispose = vi.spyOn(small, 'dispose');
    wires.sync(PARITY);
    const used = wires.describe().looks[0].instances;
    expect(used).toBeGreaterThan(64);
    expect(capacity()).toBeGreaterThanOrEqual(used);
    expect(capacity()).toBeLessThan(2 * used);
    expect(Math.log2(capacity() / 64) % 1).toBe(0); // 64 doubled
    expect(smallDispose).toHaveBeenCalledTimes(1);
    expect(small.parent).toBeNull();
    const big = lookMesh(scene, 'thhnThwn2');
    const bigDispose = vi.spyOn(big, 'dispose');
    wires.sync(one);
    expect(capacity()).toBe(64);
    expect(bigDispose).toHaveBeenCalledTimes(1);
    expect(scene.getObjectsByProperty('name', 'wires:thhnThwn2')).toHaveLength(1);
  });

  it('wire removal and world unload release every mesh, material, instance buffer and the geometry', () => {
    const { scene, wires } = setup(labelled(PARITY, 3, 'X1-3'));
    expect(wires.resourceCount).toBe(6); // one look and the sleeves: a mesh, its own geometry and a material each
    const spies = spyAll(scene);
    expect(spies.meshes).toHaveLength(2);
    // Remove one wire: the rest stay drawn, nothing is disposed but replaced pools.
    wires.sync({ ...PARITY, connections: PARITY.connections.filter((c) => c.id !== 3) });
    expect(wires.describe().sleeves).toBe(0);
    expect(wires.resourceCount).toBe(3);
    // Unload (a world with no wires): back to baseline.
    wires.sync(unwired(PARITY));
    expect(wires.resourceCount).toBe(0);
    expect(scene.getObjectByName('wires')).toBeUndefined();
    spies.geometries.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.materials.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.meshes.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    // And back again: rebuilt from nothing.
    wires.sync(PARITY);
    expect(wires.resourceCount).toBe(3);
    wires.dispose();
    wires.dispose(); // idempotent
    expect(wires.resourceCount).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it('dispose releases everything exactly once, including the preview rope', () => {
    const { scene, wires } = setup(labelled(PARITY, 3, 'X1-3'));
    wires.setPreview({
      pointsMm: [
        { x: 0, y: 500, z: 50 },
        { x: 300, y: 500, z: 50 },
      ],
      ref: { id: 'conductor.tallowmere-mtw-14', version: 1 },
      colour: { base: 'blue', stripe: null },
    });
    const spies = spyAll(scene);
    expect(spies.meshes).toHaveLength(3);
    wires.dispose();
    spies.geometries.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.materials.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.meshes.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(wires.resourceCount).toBe(0);
    expect(scene.getObjectByName('wires')).toBeUndefined();
  });

  it('colours each conductor half by its tint (D15) and back to its insulation colour', () => {
    const { scene, wires, invalidate } = setup();
    const mesh = lookMesh(scene, 'thhnThwn2');
    const colours = () => Array.from(mesh.instanceColor?.array ?? []);
    const own = colours();
    const calls: [number, string][] = [];
    const tint: WireTint = {
      colour: (connection, end) => {
        calls.push([connection, end]);
        return connection === 1 ? (end === 'a' ? 0x00ff00 : 0x0000ff) : -1;
      },
      unknownColour: 0x777777,
    };
    invalidate.mockClear();
    wires.setTint(tint);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const graph = wires.describe();
    expect(graph.routes[0].tint).toStrictEqual(['#00ff00', '#0000ff']);
    expect(graph.routes.slice(1).every((r) => r.tint === null)).toBe(true);
    // Only route c1's instances changed: the first half green, the second blue (linear sRGB).
    const tinted = colours();
    const segments = graph.routes[0].segments;
    expect(tinted.slice(3 * segments)).toStrictEqual(own.slice(3 * segments));
    expect(tinted.slice(0, 3)).toStrictEqual([0, 1, 0]);
    expect(tinted.slice(3 * (segments - 1), 3 * segments)).toStrictEqual([0, 0, 1]);
    // One call per conductor and end per refresh; an unchanged refresh rewrites and invalidates nothing.
    expect(calls).toHaveLength(2 * graph.routes.length);
    invalidate.mockClear();
    const version = mesh.instanceColor?.version;
    wires.refreshTint();
    expect(invalidate).not.toHaveBeenCalled();
    expect(mesh.instanceColor?.version).toBe(version);
    wires.setTint(null);
    expect(colours()).toStrictEqual(own);
    expect(wires.describe().routes.every((r) => r.tint === null)).toBe(true);
  });

  it('keeps a tint across a re-bake', () => {
    const { wires } = setup();
    wires.setTint({ colour: () => 0x123456, unknownColour: 0x777777 });
    wires.sync(labelled(PARITY, 2, 'B'));
    expect(wires.describe().routes.every((r) => r.tint !== null && r.tint[0] === '#123456')).toBe(true);
  });

  it('the preview rope animates until it settles, then idles; null hides it', () => {
    const { scene, wires, invalidate } = setup(null);
    const preview = {
      pointsMm: [
        { x: 0, y: 0, z: 0 },
        { x: 300, y: 0, z: 0 },
      ],
      ref: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
      colour: { base: 'red', stripe: null },
    };
    wires.setPreview(preview);
    expect(invalidate).toHaveBeenCalled();
    expect(scene.getObjectByName('wires:preview')).toBeInstanceOf(InstancedMesh);
    let frames = 0;
    while (wires.update()) frames++;
    const graph = wires.describe().preview;
    expect(graph).toMatchObject({ settled: true, look: 'thhnThwn2', particles: 21 });
    expect(frames).toBeGreaterThan(10);
    expect(wires.update()).toBe(false);
    // The same pins: nothing to do.
    wires.setPreview(preview);
    expect(wires.update()).toBe(false);
    wires.setPreview(null);
    expect(wires.describe().preview).toBeNull();
    expect(wires.resourceCount).toBe(0);
    expect(scene.getObjectByName('wires')).toBeUndefined();
  });

  it('a pool rebuild disposes the old mesh and its own geometry, never the shared material', () => {
    const one = { ...PARITY, connections: PARITY.connections.slice(0, 1) };
    const { scene, wires } = setup(one);
    const small = lookMesh(scene, 'thhnThwn2');
    const geometry = vi.spyOn(small.geometry, 'dispose');
    const material = vi.spyOn(small.material as Material, 'dispose');
    wires.sync(PARITY);
    const big = lookMesh(scene, 'thhnThwn2');
    expect(big).not.toBe(small);
    expect(big.geometry).not.toBe(small.geometry); // each pool mesh owns its geometry
    expect(big.material).toBe(small.material);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).not.toHaveBeenCalled();
  });

  it('keeps its children in a fixed order whatever the history (A → B → A equals a fresh A)', () => {
    const MTW = { id: 'conductor.tallowmere-mtw-14', version: 1 };
    const a = labelled(
      { ...PARITY, connections: PARITY.connections.map((c) => (c.id === 2 ? { ...c, ref: MTW } : c)) },
      3,
      'X',
    );
    // B: one THHN wire only, so the THHN pool shrinks (crosses a capacity) and the sleeves and MTW go.
    const b: World = { ...PARITY, connections: PARITY.connections.slice(0, 1) };
    const fresh = setup(a);
    const { scene, wires } = setup(a);
    wires.setPreview({
      pointsMm: [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 },
      ],
      ref: MTW,
      colour: null,
    });
    wires.sync(b);
    wires.setPreview(null);
    wires.sync(a);
    const graph = (sc: Scene) => describeSceneGraph(sc.getObjectByName('wires') as Scene);
    expect(graph(scene)).toStrictEqual(graph(fresh.scene));
    expect(graph(scene).children?.map((c) => c.name)).toStrictEqual(['wires:mtw', 'wires:thhnThwn2', 'wires:sleeves']);
  });

  it('tints by connection id: each route keeps its own colours after a middle wire is deleted', () => {
    const { scene, wires } = setup();
    wires.setTint(perConnection);
    wires.sync({ ...PARITY, connections: PARITY.connections.filter((c) => c.id !== 4) });
    const graph = wires.describe();
    for (const r of graph.routes) {
      const c = Number(r.owner.slice(1));
      expect(r.tint).toStrictEqual([hex(0xc0 + 2 * c), hex(0xc1 + 2 * c)]);
    }
    // The route after the deleted one shifted down in the buffer: read its first and last instance.
    const mesh = lookMesh(scene, 'thhnThwn2');
    const before = graph.routes.slice(0, 3).reduce((n, r) => n + r.segments, 0); // c1, c2, c3
    const c5 = graph.routes[3];
    expect(c5.owner).toBe('c5');
    expect(instanceHex(mesh, before)).toBe(0xc0 + 10);
    expect(instanceHex(mesh, before + c5.segments - 1)).toBe(0xc1 + 10);
  });

  it('keeps a tint through a pool reallocation and through a look freed and re-created', () => {
    const MTW = { id: 'conductor.tallowmere-mtw-14', version: 1 };
    const mixed: World = {
      ...PARITY,
      connections: PARITY.connections.map((c) => (c.id === 2 ? { ...c, ref: MTW } : c)),
    };
    const one = { ...PARITY, connections: PARITY.connections.slice(0, 1) };
    const { scene, wires } = setup(one);
    wires.setTint(perConnection);
    wires.sync(PARITY); // the pool reallocates
    const mesh = lookMesh(scene, 'thhnThwn2');
    expect(instanceHex(mesh, 0)).toBe(0xc0 + 2);
    expect(instanceHex(mesh, mesh.count - 1)).toBe(0xc1 + 2 * PARITY.connections.at(-1)!.id);
    wires.sync(mixed);
    const first = lookMesh(scene, 'mtw');
    const firstMaterial = vi.spyOn(first.material as Material, 'dispose');
    wires.sync(PARITY);
    expect(scene.getObjectByName('wires:mtw')).toBeUndefined();
    expect(firstMaterial).toHaveBeenCalledTimes(1);
    expect(wires.resourceCount).toBe(3);
    wires.sync(mixed);
    const again = lookMesh(scene, 'mtw');
    expect(again).not.toBe(first);
    expect(again.material).not.toBe(first.material);
    expect(again.geometry).not.toBe(first.geometry);
    expect(wires.resourceCount).toBe(6);
    expect(instanceHex(again, 0)).toBe(0xc0 + 4);
    expect(instanceHex(again, again.count - 1)).toBe(0xc1 + 4);
  });

  it('draws a cable in the unknown colour while a tint is on (no reading for a jacket), its own colour after', () => {
    const { wires } = setup(withCable(PARITY));
    const cable = () => wires.describe().routes.find((r) => r.owner === 'k1');
    expect(cable()).toMatchObject({ look: 'nmbJacket', colour: '#f2c200', tint: null });
    wires.setTint(perConnection);
    expect(cable()?.tint).toStrictEqual(['#777777', '#777777']);
    wires.setTint(null);
    expect(cable()?.tint).toBeNull();
  });

  it('draws a coil in the half of the route its point is in', () => {
    const { scene, wires } = setup();
    wires.setTint(perConnection);
    const graph = wires.describe();
    const i = graph.routes.findIndex((r) => r.coil !== null);
    const route = graph.routes[i];
    const baked = bakeWorldRoutes(PARITY, BUILTIN_CATALOG).routes[i];
    const links = baked.points.length / 3 - 1;
    const start = graph.routes.slice(0, i).reduce((n, r) => n + r.segments, 0);
    const mesh = lookMesh(scene, 'thhnThwn2');
    const c = Number(route.owner.slice(1));
    // The coil hangs mid-way along the longest free span; every coil instance takes that point's half.
    const halves = Array.from({ length: route.segments - links }, (_, k) => instanceHex(mesh, start + links + k));
    expect(new Set(halves).size).toBe(1);
    const half = halfAt(baked.points, baked.coil!.at);
    expect(halves[0]).toBe(half === 0 ? 0xc0 + 2 * c : 0xc1 + 2 * c);
  });
});

describe('WireRenderer cables (F3.2 part 4)', () => {
  /** The box-to-panel NM-B run: stripped 150 mm at the box and 250 mm at the panel, landed at the panel. */
  const RUN = cableRunBus({ strip: { a: 150, b: 250 }, land: true }).state;

  it('draws NM-B flat from jacket end to jacket end, and each conductor tail by itself (scene-graph snapshot)', () => {
    const { scene, wires } = setup(RUN);
    const graph = wires.describe();
    expect(graph).toMatchSnapshot('cable graph');
    expect(describeSceneGraph(scene.getObjectByName('wires') as Scene)).toMatchSnapshot('cable scene graph');
    const jacket = graph.routes.find((r) => r.owner === 'k1');
    // 14/2 NM-B's 9.4 × 4.7 mm jacket: from 50 mm inside the box's top clamp (28, 92, 40), inward −y,
    // to 50 mm inside the panel's knockout (100, 500, 40), inward +y.
    expect(jacket).toMatchObject({ look: 'nmbJacket', flatMm: [9.4, 4.7], fromMm: [28, 42, 40], toMm: [100, 550, 40] });
    expect(jacket?.tail).toBeUndefined();
    // Three stubs at the box (end a), then three landed tails at the panel (end b), after the jacket.
    expect(graph.routes.map((r) => [r.owner, r.tail ?? null, r.look, r.colour])).toStrictEqual([
      ['k1', null, 'nmbJacket', '#ededed'],
      ['c1', 'a', 'thhnThwn2', '#1c1c1c'],
      ['c2', 'a', 'thhnThwn2', '#ededed'],
      ['c3', 'a', 'bare', '#b87333'],
      ['c1', 'b', 'thhnThwn2', '#1c1c1c'],
      ['c2', 'b', 'thhnThwn2', '#ededed'],
      ['c3', 'b', 'bare', '#b87333'],
    ]);
    // The box stubs end 150 mm further in; the panel tails end on their blocks' bottom clamps (y 651, z −8).
    expect(graph.routes.filter((r) => r.tail === 'b').map((r) => r.toMm)).toStrictEqual([
      [100, 651, -8],
      [106, 651, -8],
      [112, 651, -8],
    ]);
    expect(graph.routes.filter((r) => r.tail === 'a').map((r) => r.toMm[1])).toStrictEqual([-108, -108, -108]);
  });

  it('stands each jacket segment flat: a basis as wide and as thick as the jacket, the wide side across the run', () => {
    const { scene, wires } = setup(RUN);
    const mesh = lookMesh(scene, 'nmbJacket');
    expect(mesh.count).toBe(wires.describe().routes.find((r) => r.owner === 'k1')?.segments);
    const m = new Matrix4();
    const [x, y, z] = [new Vector3(), new Vector3(), new Vector3()];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.extractBasis(x, y, z);
      expect(x.length()).toBeCloseTo(mm(9.4 / 2), 9);
      expect(z.length()).toBeCloseTo(mm(4.7 / 2), 9);
      expect(x.dot(y)).toBeCloseTo(0, 9);
      expect(z.dot(y)).toBeCloseTo(0, 9);
      expect(x.dot(z)).toBeCloseTo(0, 9);
      expect(new Vector3().crossVectors(x, y).dot(z)).toBeGreaterThan(0); // right-handed: faces keep their winding
    }
  });

  it('tints each tail by its own conductor end while the jacket stays unknown', () => {
    const { scene, wires } = setup(RUN);
    wires.setTint(perConnection);
    const routes = wires.describe().routes;
    expect(routes.find((r) => r.owner === 'k1')?.tint).toStrictEqual(['#777777', '#777777']);
    for (const c of [1, 2, 3]) {
      const a = hex(0xc0 + 2 * c);
      const b = hex(0xc1 + 2 * c);
      expect(routes.find((r) => r.owner === `c${c}` && r.tail === 'a')?.tint).toStrictEqual([a, a]);
      expect(routes.find((r) => r.owner === `c${c}` && r.tail === 'b')?.tint).toStrictEqual([b, b]);
    }
    // The instance colours follow: every bare (EGC) instance is in end a's or end b's colour.
    const bare = lookMesh(scene, 'bare');
    const seen = new Set(Array.from({ length: bare.count }, (_, i) => instanceHex(bare, i)));
    expect(seen).toStrictEqual(new Set([0xc0 + 6, 0xc1 + 6]));
    wires.setTint(null);
    expect(wires.describe().routes.every((r) => r.tint === null)).toBe(true);
  });

  it('picks a tail as its conductor and the jacket as the cable', () => {
    const { wires } = setup(RUN);
    // Straight down −z onto the black tail just above block 3's clamp, then onto the jacket's first free span.
    const down = { x: 0, y: 0, z: -1 };
    expect(wires.pick({ x: 100, y: 645, z: 200 }, down, 0.001)?.wire).toStrictEqual({ kind: 'connection', id: 1 });
    expect(wires.pick({ x: 28, y: 150, z: 200 }, down, 0.001)?.wire).toStrictEqual({ kind: 'cable', id: 1 });
  });

  it('labels a cable conductor with one sleeve on each tail, near its far end', () => {
    const { wires, scene } = setup(cableRunBus({ strip: { a: 150, b: 250 }, land: true, label: 'L1' }).state);
    expect(wires.describe().sleeves).toBe(2);
    expect(scene.getObjectByName('wires:sleeves')?.userData['wires']).toStrictEqual({
      labels: ['c1:a L1', 'c1:b L1'],
      instances: 2,
    });
  });

  it('a cable that goes releases its jacket, tail and sleeve meshes exactly once (disposal baseline)', () => {
    const { scene, wires } = setup(cableRunBus({ strip: { a: 150, b: 250 }, land: true, label: 'L1' }).state);
    expect(wires.resourceCount).toBe(12); // nmbJacket, thhnThwn2, bare and the sleeves: 3 each
    const spies = spyAll(scene);
    wires.sync({ ...RUN, cables: [], connections: [] });
    expect(wires.resourceCount).toBe(0);
    expect(scene.getObjectByName('wires')).toBeUndefined();
    spies.geometries.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.materials.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    spies.meshes.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
  });

  it('an unstripped cable draws its jacket to the end of each tail and no conductors', () => {
    const { wires } = setup(cableRunBus().state);
    const routes = wires.describe().routes;
    expect(routes.map((r) => r.owner)).toStrictEqual(['k1']);
    expect(routes[0]).toMatchObject({ fromMm: [28, -108, 40], toMm: [100, 800, 40] });
  });
});
