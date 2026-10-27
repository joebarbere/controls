import { Mesh, type Material } from 'three/webgpu';
import { buildPanelScene, disposeScene } from './panel-scene';

describe('buildPanelScene', () => {
  it('contains the backplate and two DIN rails', () => {
    const names = buildPanelScene().children.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['backplate', 'din-rail-1', 'din-rail-2']));
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
    expect(materials.size).toBe(2); // rails share one material
  });
});
