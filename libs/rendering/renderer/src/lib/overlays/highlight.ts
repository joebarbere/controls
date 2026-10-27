/**
 * Hover and selection outlines: two reusable box helpers, updated only when hover or selection
 * changes (never per frame). Renderer-local; they are not selectable and not part of the world.
 */
import { Box3, Box3Helper, type Object3D, type Scene } from 'three/webgpu';

const HOVER_COLOUR = 0x7fb8ff;
const SELECT_COLOUR = 0xffb000;

export class SelectionHighlight {
  private readonly hoverBox = new Box3();
  private readonly selectBox = new Box3();
  readonly hoverHelper = new Box3Helper(this.hoverBox, HOVER_COLOUR);
  readonly selectHelper = new Box3Helper(this.selectBox, SELECT_COLOUR);

  constructor(private readonly scene: Scene) {
    for (const h of [this.hoverHelper, this.selectHelper]) {
      h.name = h === this.hoverHelper ? 'overlay:hover' : 'overlay:selection';
      h.visible = false;
      h.raycast = () => undefined; // never pickable, even by a whole-scene raycast
      scene.add(h);
    }
  }

  setHover(target: Object3D | null): void {
    this.fit(this.hoverHelper, this.hoverBox, target);
  }

  setSelection(target: Object3D | null): void {
    this.fit(this.selectHelper, this.selectBox, target);
  }

  dispose(): void {
    for (const h of [this.hoverHelper, this.selectHelper]) {
      this.scene.remove(h);
      h.dispose(); // geometry + material
    }
  }

  private fit(helper: Box3Helper, box: Box3, target: Object3D | null): void {
    if (!target) {
      helper.visible = false;
      return;
    }
    box.setFromObject(target);
    box.expandByScalar(0.002); // 2 mm, so the outline isn't z-fighting the surface
    helper.visible = true;
  }
}
