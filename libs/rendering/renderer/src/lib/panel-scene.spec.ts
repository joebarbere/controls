import { Mesh, type Material } from 'three/webgpu';
import { buildPanelScene, disposeScene } from './panel-scene';
import { findSelectables } from './picking/picker';

describe('buildPanelScene', () => {
  it('contains the floor, backplate and two DIN rails', () => {
    const names = buildPanelScene().children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['floor', 'backplate', 'din-rail-1', 'din-rail-2']));
  });

  it('marks the plate and rails selectable with integer-mm snap targets; the floor is not', () => {
    const found = findSelectables(buildPanelScene()).map((s) => s.info);
    expect(found.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'backplate:backplate',
      'din-rail:din-rail-1',
      'din-rail:din-rail-2',
    ]);
    for (const info of found) {
      expect(info.focusNormal).toBe('+z');
      const o = info.snapTarget?.frame.origin;
      expect(o && [o.x, o.y, o.z].every(Number.isInteger)).toBe(true);
    }
  });
});

describe('disposeScene', () => {
  it('disposes every geometry and each material exactly once', () => {
    const scene = buildPanelScene();
    const meshes = scene.children.filter((c): c is Mesh => c instanceof Mesh);
    const geometrySpies = meshes.map((m) => vi.spyOn(m.geometry, 'dispose'));
    const materials = new Set(meshes.map((m) => m.material as Material));
    const materialSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));

    disposeScene(scene);

    geometrySpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    materialSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    expect(materials.size).toBe(3); // floor, plate; the rails share one material
  });
});
