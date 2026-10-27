import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Scene,
  type Material,
} from 'three/webgpu';
import { buildBackplateGeometry } from './geometry/backplate';
import { buildDinRailGeometry } from './geometry/din-rail';
import { mm } from './geometry/units';

/** P0 demo content: a 600×800 mm white sub-panel with two 500 mm TS35 DIN rails. */
export function buildPanelScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x1d2126);
  scene.add(new HemisphereLight(0xf2f4f7, 0x30343a, 1.4));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(0.6, 0.9, 1.2);
  scene.add(key);

  const plate = new Mesh(
    buildBackplateGeometry(600, 800),
    new MeshStandardMaterial({ color: 0xd9dcdf, metalness: 0.2, roughness: 0.6 }), // white-painted sub-panel
  );
  plate.name = 'backplate';
  scene.add(plate);

  const railMaterial = new MeshStandardMaterial({ color: 0xc4cad0, metalness: 0.45, roughness: 0.4 }); // zinc-plated steel
  [150, -50].forEach((yMm, i) => {
    const rail = new Mesh(buildDinRailGeometry(500), railMaterial);
    rail.name = `din-rail-${i + 1}`;
    rail.position.set(0, mm(yMm), 0);
    scene.add(rail);
  });
  return scene;
}

/** Releases every mesh geometry and material in the scene (shared materials are disposed once). */
export function disposeScene(scene: Scene): void {
  const materials = new Set<Material>();
  scene.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((m: Material) => materials.add(m));
    }
  });
  materials.forEach((m) => m.dispose());
}
