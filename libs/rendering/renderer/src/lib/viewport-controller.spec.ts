import { Box3Helper, Mesh, Vector3, type BufferGeometry, type Material } from 'three/webgpu';
import { PANEL_ROOM_BOUNDS } from './panel-scene';
import { ViewportController, type ViewportState } from './viewport-controller';

/** EventTarget that tracks live listeners, so tests can prove every one is removed. */
class TrackingTarget extends EventTarget {
  readonly live = new Map<string, number>();
  override addEventListener(
    type: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: AddEventListenerOptions | boolean,
  ): void {
    this.live.set(type, (this.live.get(type) ?? 0) + 1);
    super.addEventListener(type, cb, o);
  }
  override removeEventListener(
    type: string,
    cb: EventListenerOrEventListenerObject | null,
    o?: EventListenerOptions | boolean,
  ): void {
    const n = this.live.get(type) ?? 0;
    if (n <= 1) this.live.delete(type);
    else this.live.set(type, n - 1);
    super.removeEventListener(type, cb, o);
  }
}

class FakeDocument extends TrackingTarget {
  pointerLockElement: unknown = null;
  readonly defaultView = new TrackingTarget();
  exitPointerLock = vi.fn(() => {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  });
}

class FakeCanvas extends TrackingTarget {
  readonly ownerDocument = new FakeDocument();
  readonly style: Record<string, string> = {};
  clientWidth = 1280;
  clientHeight = 720;
  focus = vi.fn();
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  requestPointerLock = vi.fn(() => {
    this.ownerDocument.pointerLockElement = this;
    this.ownerDocument.dispatchEvent(new Event('pointerlockchange'));
  });
  getRootNode(): FakeDocument {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
    };
  }
}

const setup = () => {
  const canvas = new FakeCanvas();
  const controller = new ViewportController(canvas as unknown as HTMLElement);
  controller.resize(canvas.clientWidth, canvas.clientHeight);
  controller.focus('backplate');
  return { canvas, controller };
};

const key = (type: 'keydown' | 'keyup', code: string, repeat = false) =>
  Object.assign(new Event(type, { cancelable: true }), { code, repeat, ctrlKey: false, metaKey: false, altKey: false });
const pointer = (type: string, offsetX: number, offsetY: number) =>
  Object.assign(new Event(type), {
    button: 0,
    offsetX,
    offsetY,
    clientX: offsetX,
    clientY: offsetY,
    pointerId: 1,
    pointerType: 'mouse',
  });

/** NDC of a world point as seen by the controller's camera. */
const ndcOf = (c: ViewportController, x: number, y: number, z: number) => {
  c.camera.updateMatrixWorld();
  const v = new Vector3(x, y, z).project(c.camera);
  return { x: v.x, y: v.y };
};

describe('ViewportController picking and selection', () => {
  it('starts in work mode focused on the backplate', () => {
    const { controller } = setup();
    expect(controller.state).toMatchObject({
      mode: 'work',
      focusId: 'backplate',
      selected: null,
      pointerLocked: false,
    });
    expect(controller.camera.position.z).toBeGreaterThan(0.5);
    controller.dispose();
  });

  it('picks the backplate and each DIN rail through the BVH', () => {
    const { controller } = setup();
    expect(controller.pickAt(0, 0)?.id).toBe('backplate');
    const r1 = ndcOf(controller, 0, 0.15, 0.005);
    expect(controller.pickAt(r1.x, r1.y)?.id).toBe('din-rail-1');
    const r2 = ndcOf(controller, 0.1, -0.05, 0.005);
    expect(controller.pickAt(r2.x, r2.y)?.id).toBe('din-rail-2');
    expect(controller.pickAt(0.99, 0.99)).toBeNull(); // background
    controller.dispose();
  });

  it('a click selects what is under the pointer; a drag does not', () => {
    const { canvas, controller } = setup();
    canvas.dispatchEvent(pointer('pointerdown', 640, 360));
    canvas.dispatchEvent(pointer('pointerup', 641, 361));
    expect(controller.state.selected?.id).toBe('backplate');
    expect(canvas.focus).toHaveBeenCalled();

    canvas.dispatchEvent(pointer('pointerdown', 10, 10));
    canvas.dispatchEvent(pointer('pointerup', 300, 300));
    expect(controller.state.selected?.id).toBe('backplate');

    canvas.dispatchEvent(pointer('pointerdown', 2, 2)); // empty background clears
    canvas.dispatchEvent(pointer('pointerup', 2, 2));
    expect(controller.state.selected).toBeNull();
    controller.dispose();
  });

  it('hover follows the pointer, at most one raycast per frame', () => {
    const { canvas, controller } = setup();
    canvas.dispatchEvent(pointer('pointermove', 640, 360));
    expect(controller.state.hovered).toBeNull(); // resolved on the next frame
    controller.update(1 / 60);
    expect(controller.state.hovered?.id).toBe('backplate');
    canvas.dispatchEvent(pointer('pointerleave', 0, 0));
    controller.update(1 / 60);
    expect(controller.state.hovered).toBeNull();
    controller.dispose();
  });

  it('keyboard users cycle the selection with input actions; Escape clears it', () => {
    const { canvas, controller } = setup();
    const seen: Array<string | null> = [];
    controller.onChange((s: ViewportState) => seen.push(s.selected?.id ?? null));
    canvas.dispatchEvent(key('keydown', 'BracketRight'));
    canvas.dispatchEvent(key('keydown', 'BracketRight', true)); // auto-repeat is ignored for triggers
    canvas.dispatchEvent(key('keydown', 'BracketRight'));
    canvas.dispatchEvent(key('keydown', 'BracketLeft'));
    canvas.dispatchEvent(key('keydown', 'Escape'));
    expect(seen).toEqual(['backplate', 'din-rail-1', 'backplate', null]);
    controller.dispose();
  });

  it('consumes Escape only when it clears a selection, so the shell can still open the menu', () => {
    const { canvas, controller } = setup();
    const idle = key('keydown', 'Escape');
    canvas.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    controller.select('backplate');
    const clearing = key('keydown', 'Escape');
    canvas.dispatchEvent(clearing);
    expect(clearing.defaultPrevented).toBe(true);
    expect(controller.state.selected).toBeNull();
    controller.dispose();
  });

  it('focuses a rail from the selection and refuses unknown targets', () => {
    const { canvas, controller } = setup();
    controller.select('din-rail-2');
    canvas.dispatchEvent(key('keydown', 'KeyF'));
    expect(controller.state.focusId).toBe('din-rail-2');
    expect(controller.focus('nope')).toBe(false);
    controller.dispose();
  });
});

describe('ViewportController modes', () => {
  it('walk mode: WASD actions move the eye, clamped to the room, at eye height', () => {
    const { canvas, controller } = setup();
    controller.setMode('walk');
    expect(controller.mode).toBe('walk');
    const startZ = controller.camera.position.z;
    canvas.dispatchEvent(key('keydown', 'KeyW'));
    controller.update(0.1);
    expect(controller.camera.position.z).toBeLessThan(startZ);
    expect(controller.camera.position.y).toBeCloseTo((PANEL_ROOM_BOUNDS.floorYMm + 1600) / 1000, 9);
    for (let i = 0; i < 200; i++) controller.update(0.1);
    expect(controller.camera.position.z).toBeCloseTo((PANEL_ROOM_BOUNDS.minZMm + 250) / 1000, 9);
    canvas.dispatchEvent(key('keyup', 'KeyW'));
    const z = controller.camera.position.z;
    controller.update(0.1);
    expect(controller.camera.position.z).toBe(z);
    controller.dispose();
  });

  it('rebinding an action takes effect and blur releases held keys', () => {
    const { canvas, controller } = setup();
    controller.setMode('walk');
    controller.setBindings({
      moveForward: ['KeyI'],
      moveBack: ['KeyK'],
      moveLeft: ['KeyJ'],
      moveRight: ['KeyL'],
      sprint: [],
      selectNext: [],
      selectPrevious: [],
      clearSelection: [],
      focusSelection: [],
      toggleMode: [],
    });
    const x0 = controller.camera.position.x;
    canvas.dispatchEvent(key('keydown', 'KeyD')); // no longer bound
    controller.update(0.1);
    expect(controller.camera.position.x).toBe(x0);
    canvas.dispatchEvent(key('keydown', 'KeyL'));
    controller.update(0.1);
    expect(controller.camera.position.x).toBeGreaterThan(x0);
    canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
    const x1 = controller.camera.position.x;
    controller.update(0.1);
    expect(controller.camera.position.x).toBe(x1);
    controller.dispose();
  });

  it('click in walk mode takes pointer lock; mouse look turns; leaving walk releases the lock', () => {
    const { canvas, controller } = setup();
    canvas.dispatchEvent(key('keydown', 'KeyV'));
    expect(controller.mode).toBe('walk');
    canvas.dispatchEvent(pointer('pointerdown', 640, 360));
    canvas.dispatchEvent(pointer('pointerup', 640, 360));
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(controller.state.pointerLocked).toBe(true);
    expect(controller.state.selected).toBeNull(); // the locking click doesn't select

    const yaw0 = controller.camera.rotation.y;
    canvas.ownerDocument.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: -100, movementY: 0 }));
    controller.update(1 / 60);
    expect(controller.camera.rotation.y).toBeGreaterThan(yaw0);

    canvas.dispatchEvent(pointer('pointerdown', 10, 10)); // locked: picks at the crosshair
    canvas.dispatchEvent(pointer('pointerup', 10, 10));
    controller.update(1 / 60);

    controller.setMode('work');
    expect(canvas.ownerDocument.exitPointerLock).toHaveBeenCalled();
    expect(controller.state).toMatchObject({ mode: 'work', pointerLocked: false, focusId: 'backplate' });
    controller.dispose();
  });

  it('focus from walk mode switches to work mode', () => {
    const { controller } = setup();
    controller.setMode('walk');
    controller.setMode('walk');
    expect(controller.focus('din-rail-1')).toBe(true);
    expect(controller.state).toMatchObject({ mode: 'work', focusId: 'din-rail-1' });
    controller.dispose();
  });
});

describe('ViewportController scene graph', () => {
  it('matches the snapshot (positions in integer mm)', () => {
    const { controller } = setup();
    expect(controller.sceneGraph()).toMatchSnapshot();
    controller.dispose();
  });
});

describe('ViewportController disposal', () => {
  it('removes every listener, BVH, geometry and material it created', () => {
    const { canvas, controller } = setup();
    // Exercise hover, selection, walk and pointer lock first so their resources exist.
    canvas.dispatchEvent(pointer('pointermove', 640, 360));
    controller.update(1 / 60);
    controller.select('din-rail-1');
    controller.setMode('walk');
    canvas.dispatchEvent(pointer('pointerdown', 640, 360));
    canvas.dispatchEvent(pointer('pointerup', 640, 360));
    expect(controller.state.pointerLocked).toBe(true);

    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const meshes: Mesh[] = [];
    controller.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Box3Helper) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
      if (o instanceof Mesh) meshes.push(o);
    });
    expect(controller.bvhCount).toBe(3);
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    const listener = vi.fn();
    controller.onChange(listener);

    controller.dispose();
    controller.dispose(); // idempotent

    expect(canvas.live.size).toBe(0);
    expect(canvas.ownerDocument.live.size).toBe(0);
    expect(canvas.ownerDocument.defaultView.live.size).toBe(0);
    expect(canvas.ownerDocument.exitPointerLock).toHaveBeenCalled();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(controller.bvhCount).toBe(0);
    meshes.forEach((m) => {
      expect((m.geometry as { boundsTree?: unknown }).boundsTree).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(m, 'raycast')).toBe(false);
    });
    expect(controller.scene.getObjectByName('overlay:hover')).toBeUndefined();
    canvas.dispatchEvent(key('keydown', 'BracketRight'));
    expect(listener).not.toHaveBeenCalled();
  });
});
