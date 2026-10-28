import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { metresToMm, mm } from '@controls/units';
import { DEMO_PANEL, demoBackplateTarget, demoRailTarget } from '@controls/world-model';
import type { RoomBoundsMm } from './cameras/camera-math';
import { buildBackplateGeometry } from './geometry/backplate';
import { buildDinRailGeometry } from './geometry/din-rail';
import { markSelectable } from './picking/picker';

/**
 * Walkable area around the P0/P1 demo panel (game-design: a small workshop bay, floor 1.2 m below
 * the panel centre). TODO(F1.9): comes from the workshop level document instead.
 */
export const PANEL_ROOM_BOUNDS: RoomBoundsMm = {
  minXMm: -2000,
  maxXMm: 2000,
  minZMm: 0,
  maxZMm: 3500,
  floorYMm: -1200,
};

/**
 * Fixed demo content: the `DEMO_PANEL` sub-panel from `@controls/world-model` (a 600×800 mm white
 * plate with two 500 mm TS35 DIN rails), on a floor. The plate and rails are selectable and
 * focusable, and carry the same snap targets scripts use (`demoPanelSnapTargets()`). World
 * entities (props) are drawn on top by `WorldSync` from world snapshots.
 * TODO(F1.9): the workshop level document replaces the demo panel.
 */
export function buildPanelScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x1d2126);
  scene.add(new HemisphereLight(0xf2f4f7, 0x30343a, 1.4));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(0.6, 0.9, 1.2);
  scene.add(key);

  const room = PANEL_ROOM_BOUNDS;
  const floor = new Mesh(
    new PlaneGeometry(mm(room.maxXMm - room.minXMm), mm(room.maxZMm - room.minZMm)),
    new MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.9 }), // sealed concrete
  );
  floor.name = 'floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(mm((room.minXMm + room.maxXMm) / 2), mm(room.floorYMm), mm((room.minZMm + room.maxZMm) / 2));
  scene.add(floor);

  const { backplate } = DEMO_PANEL;
  const plate = new Mesh(
    buildBackplateGeometry(backplate.widthMm, backplate.heightMm),
    new MeshStandardMaterial({ color: 0xd9dcdf, metalness: 0.2, roughness: 0.6 }), // white-painted sub-panel
  );
  plate.name = backplate.id;
  markSelectable(plate, {
    id: backplate.id,
    kind: 'backplate',
    label: `Backplate ${backplate.widthMm} × ${backplate.heightMm}`,
    focusNormal: '+z',
    snapTarget: demoBackplateTarget(),
  });
  scene.add(plate);

  const railMaterial = new MeshStandardMaterial({ color: 0xc4cad0, metalness: 0.45, roughness: 0.4 }); // zinc-plated steel
  DEMO_PANEL.rails.forEach((r, i) => {
    const rail = new Mesh(buildDinRailGeometry(r.lengthMm), railMaterial);
    rail.name = r.id;
    rail.position.set(0, mm(r.yMm), 0);
    markSelectable(rail, {
      id: r.id,
      kind: 'din-rail',
      label: `DIN rail ${i + 1} (TS35, ${r.lengthMm} mm)`,
      focusNormal: '+z',
      snapTarget: demoRailTarget(r),
    });
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

/**
 * Stable, JSON-plain summary of a scene graph for snapshot tests: positions in integer mm and, when
 * not zero, the Euler rotation (x, y, z components) in integer millidegrees.
 */
export interface SceneGraphNode {
  name: string;
  type: string;
  positionMm: [number, number, number];
  rotationMdeg?: [number, number, number];
  visible: boolean;
  selectable?: string;
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
  if (object.children.length > 0) node.children = object.children.map(describeSceneGraph);
  return node;
}
