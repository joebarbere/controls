import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  Scene,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { metresToMm } from '@controls/units';
import type { RoomBoundsMm } from './cameras/camera-math';

/**
 * Walkable area used when the world has no floor fixture (an empty world, a test). game-design: a
 * 4 × 3.5 m bay in front of the origin. Worlds with a floor (the workshop) walk inside that instead.
 */
export const DEFAULT_ROOM_BOUNDS: RoomBoundsMm = {
  minXMm: -2000,
  maxXMm: 2000,
  minZMm: 0,
  maxZMm: 3500,
  floorYMm: -1200,
};

/**
 * The scene every world is drawn into: background and lights only. Since F1.9 the level geometry
 * (floor, stud wall, backboard, backplate, DIN rails, bench) comes from the world's fixtures
 * (`FixtureSync`) and props from its entities (`WorldSync`), so the renderer draws what the world
 * document says and nothing it made up.
 */
export function buildBaseScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x1d2126);
  scene.add(new HemisphereLight(0xf2f4f7, 0x30343a, 1.4));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(0.6, 0.9, 1.2);
  scene.add(key);
  return scene;
}

/** Releases every mesh geometry and material in the scene (each shared one exactly once). */
export function disposeScene(scene: Scene): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  scene.traverse((object) => {
    if (object instanceof Mesh) {
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((m: Material) => materials.add(m));
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}

/**
 * Stable, JSON-plain summary of a scene graph for snapshot tests: positions in integer mm and, when
 * not zero, the Euler rotation (x, y, z components) in integer millidegrees. Meshes also give their
 * geometry's local bounding box (`[min x, y, z, max x, y, z]`, integer mm), so a recipe that changes
 * size shows up, and `drawn: false` when their material is never drawn (snap proxies).
 */
export interface SceneGraphNode {
  name: string;
  type: string;
  positionMm: [number, number, number];
  rotationMdeg?: [number, number, number];
  visible: boolean;
  selectable?: string;
  /** A device's label (`userData.label`: its fictional brand and model). */
  label?: string;
  boundsMm?: [number, number, number, number, number, number];
  drawn?: false;
  children?: SceneGraphNode[];
}

export function describeSceneGraph(object: Object3D): SceneGraphNode {
  const p = object.position;
  const node: SceneGraphNode = {
    name: object.name,
    type: object.type,
    positionMm: [metresToMm(p.x), metresToMm(p.y), metresToMm(p.z)],
    visible: object.visible,
  };
  const r = object.rotation;
  const mdeg = (radians: number): number => {
    const v = Math.round((radians * 180_000) / Math.PI);
    return v === 0 ? 0 : v;
  };
  if (r.x !== 0 || r.y !== 0 || r.z !== 0) node.rotationMdeg = [mdeg(r.x), mdeg(r.y), mdeg(r.z)];
  const sel = object.userData['selectable'] as { id: string; kind: string } | undefined;
  if (sel) node.selectable = `${sel.kind}:${sel.id}`;
  const label = object.userData['label'];
  if (typeof label === 'string') node.label = label;
  if (object instanceof Mesh) {
    const geometry = object.geometry as BufferGeometry;
    if ((geometry.getAttribute('position')?.count ?? 0) > 0) {
      geometry.computeBoundingBox();
      const b = geometry.boundingBox;
      if (b)
        node.boundsMm = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(
          metresToMm,
        ) as SceneGraphNode['boundsMm'];
    }
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.every((m) => !m.visible)) node.drawn = false;
  }
  if (object.children.length > 0) node.children = object.children.map(describeSceneGraph);
  return node;
}
