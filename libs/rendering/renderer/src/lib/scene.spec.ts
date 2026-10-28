import { Mesh, type BufferGeometry, type Material } from 'three/webgpu';
import { migrateWorld } from '@controls/save-format';
import { worldSnapTargets, type World } from '@controls/world-model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findSelectables } from './picking/picker';
import { buildBaseScene, disposeScene } from './scene';
import { FixtureSync } from './world/fixture-sync';

/** `content/levels/workshop.json`, loaded the way the game loads it. */
function workshop(): World {
  const json: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../../../content/levels/workshop.json'), 'utf8'),
  );
  const loaded = migrateWorld(json);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

describe('buildBaseScene', () => {
  it('holds lights only: the level comes from the world', () => {
    const scene = buildBaseScene();
    expect(scene.children.map((c) => c.type)).toEqual(['HemisphereLight', 'DirectionalLight']);
    expect(findSelectables(scene)).toEqual([]);
  });
});

describe('FixtureSync on the workshop', () => {
  it('draws every fixture and makes walls, benches, plates and rails selectable with world snap targets', () => {
    const scene = buildBaseScene();
    const sync = new FixtureSync(scene);
    const world = workshop();
    expect(sync.sync(world)).toBe(true);
    expect(sync.group.children.map((c) => c.name)).toEqual(world.fixtures.map((f) => f.id));
    const found = findSelectables(scene).map((s) => s.info);
    expect(found.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'board:backboard',
      'backplate:backplate',
      'bench:bench',
      'din-rail:din-rail-1',
      'din-rail:din-rail-2',
      'wall:stud-wall',
    ]);
    for (const info of found) expect(info.focusNormal).toBe('+z');
    expect(found.map((i) => i.label)).toEqual([
      'Plywood backboard',
      'Backplate 600 × 800',
      'Workbench',
      'DIN rail 1 (TS35, 500 mm)',
      'DIN rail 2 (TS35, 500 mm)',
      'Stud wall (2×4 at 16 in o.c.)',
    ]);
    // The ghost snaps to exactly the targets scripts get from the world document.
    expect(found.flatMap((i) => (i.snapTarget ? [i.snapTarget] : []))).toEqual(worldSnapTargets(world));
    expect(found.find((i) => i.id === 'backboard')?.snapTarget).toBeUndefined();
    // The placement picker sees the backboard too, so it hides the studs behind it.
    expect(sync.surfaceRoots().map((r) => r.name)).toEqual([
      'backboard',
      'backplate',
      'bench',
      'din-rail-1',
      'din-rail-2',
      'stud-wall',
    ]);
    expect(sync.room()).toEqual({ minXMm: -2500, maxXMm: 2500, minZMm: -110, maxZMm: 3590, floorYMm: -1200 });
    sync.dispose();
  });

  it('a resync of the same world changes nothing; DIN rails share one recipe', () => {
    const sync = new FixtureSync(buildBaseScene());
    const world = workshop();
    sync.sync(world);
    expect(sync.sync(world)).toBe(false);
    expect(sync.sync({ ...world, fixtures: world.fixtures.map((f) => ({ ...f })) })).toBe(false); // equal by value
    expect(sync.recipes.size).toBe(6); // seven fixtures, two of them rails
    const rails = ['din-rail-1', 'din-rail-2'].map((id) => sync.objectOf(id)?.children[0] as Mesh);
    expect(rails[0].geometry).toBe(rails[1].geometry);
    sync.dispose();
  });

  it('removing fixtures releases their recipes; disposal disposes every geometry and material once', () => {
    const scene = buildBaseScene();
    const sync = new FixtureSync(scene);
    const world = workshop();
    sync.sync(world);
    const meshes: Mesh[] = [];
    scene.traverse((o) => o instanceof Mesh && meshes.push(o));
    const geometries = new Set<BufferGeometry>(meshes.map((m) => m.geometry));
    const materials = new Set<Material>(meshes.map((m) => m.material as Material));
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));

    expect(sync.sync({ ...world, fixtures: world.fixtures.filter((f) => f.id !== 'din-rail-2') })).toBe(true);
    expect(sync.recipes.size).toBe(6); // din-rail-1 still holds the rail recipe
    expect(sync.sync({ ...world, fixtures: [] })).toBe(true);
    expect(sync.recipes.size).toBe(0);
    expect(sync.room()).toBeNull();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    sync.dispose();
    expect(scene.getObjectByName('fixtures')).toBeUndefined();
  });

  it('moves a fixture that changed, and draws unknown refs as nothing', () => {
    const sync = new FixtureSync(buildBaseScene());
    const world = workshop();
    sync.sync(world);
    const bench = world.fixtures.find((f) => f.id === 'bench');
    if (!bench) throw new Error('no bench');
    const moved = { ...bench, transform: { ...bench.transform, positionMm: { x: 0, y: -1200, z: 1000 } } };
    const odd = { ...bench, id: 'mystery', ref: { id: 'prop.mystery', version: 1 } };
    sync.sync({ ...world, fixtures: [...world.fixtures.map((f) => (f.id === 'bench' ? moved : f)), odd] });
    expect(sync.objectOf('bench')?.position.z).toBeCloseTo(1, 9);
    expect(sync.objectOf('mystery')?.children).toEqual([]);
    expect(sync.selectables().map((s) => s.info.id)).not.toContain('mystery');
    sync.dispose();
  });

  it('turned floors give the same walkable area', () => {
    const sync = new FixtureSync(buildBaseScene());
    const floor = (yaw: number, x: number, z: number) => ({
      ...workshop(),
      fixtures: [
        {
          id: 'floor',
          ref: { id: 'prop.workshop-floor', version: 1 },
          transform: { positionMm: { x, y: 0, z }, orientationMdeg: { yaw, pitch: 0, roll: 0 } },
          extensions: {},
        },
      ],
    });
    // 5000 × 3700 laid along x, then turned a quarter at a time about its origin corner.
    expect((sync.sync(floor(0, 0, 0)), sync.room())).toMatchObject({
      minXMm: 0,
      maxXMm: 5000,
      minZMm: 0,
      maxZMm: 3700,
    });
    expect((sync.sync(floor(90_000, 0, 0)), sync.room())).toMatchObject({
      minXMm: 0,
      maxXMm: 3700,
      minZMm: -5000,
      maxZMm: 0,
    });
    expect((sync.sync(floor(180_000, 0, 0)), sync.room())).toMatchObject({
      minXMm: -5000,
      maxXMm: 0,
      minZMm: -3700,
      maxZMm: 0,
    });
    expect((sync.sync(floor(270_000, 0, 0)), sync.room())).toMatchObject({
      minXMm: -3700,
      maxXMm: 0,
      minZMm: 0,
      maxZMm: 5000,
    });
    expect((sync.sync(floor(1, 0, 0)), sync.room())).toBeNull();
    sync.dispose();
  });
});

describe('disposeScene', () => {
  it('disposes every geometry and each material exactly once', () => {
    const scene = buildBaseScene();
    const sync = new FixtureSync(scene);
    sync.sync(workshop());
    const meshes: Mesh[] = [];
    scene.traverse((o) => o instanceof Mesh && meshes.push(o));
    const geometrySpies = [...new Set(meshes.map((m) => m.geometry))].map((g) => vi.spyOn(g, 'dispose'));
    const materials = new Set(meshes.map((m) => m.material as Material));
    const materialSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));

    disposeScene(scene);

    geometrySpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    materialSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });
});
