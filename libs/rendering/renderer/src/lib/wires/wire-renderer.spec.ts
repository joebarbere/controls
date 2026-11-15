import { InstancedMesh, Mesh, Scene, type BufferGeometry, type Material } from 'three/webgpu';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { bakeWorldRoutes, type World } from '@controls/world-model';
import { routingPanelBus, routingParityWorld } from '@controls/world-model/testing';
import { describeSceneGraph } from '../scene';
import { WireRenderer, type WireTint } from './wire-renderer';

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
    expect(wires.resourceCount).toBe(5); // the segment geometry, one look, the sleeves
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
    wires.setTint({ colour: () => 0x123456 });
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
});
