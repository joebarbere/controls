import { Box3, Box3Helper, Mesh, Vector3, type BufferGeometry, type Material } from 'three/webgpu';
import { createWorld, migrateWorld } from '@controls/save-format';
import { createWorldBus, placeOnTargets, worldSnapTargets, type Entity, type World } from '@controls/world-model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ManualFrameClock } from './loop/manual-frame-clock';
import { RenderLoop } from './loop/render-loop';
import { DEFAULT_ROOM_BOUNDS, describeSceneGraph } from './scene';
import { ViewportController, type ViewportIntent, type ViewportState } from './viewport-controller';

/** `content/levels/workshop.json`, loaded the way the game loads it. */
const WORKSHOP: World = (() => {
  const json: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../../../content/levels/workshop.json'), 'utf8'),
  );
  const loaded = migrateWorld(json);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
})();

/**
 * The workshop's panel only (backplate and both DIN rails), as the P1 demo panel was: most picking
 * and placement tests look at it head-on and want empty background around it.
 */
const PANEL: World = {
  ...WORKSHOP,
  fixtures: WORKSHOP.fixtures.filter((f) => ['backplate', 'din-rail-1', 'din-rail-2'].includes(f.id)),
};

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

const setup = (world: World = PANEL) => {
  const canvas = new FakeCanvas();
  const controller = new ViewportController(canvas as unknown as HTMLElement);
  controller.resize(canvas.clientWidth, canvas.clientHeight);
  controller.syncWorld(world);
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

  it('focuses a rail and refuses unknown targets; F and V are Command bindings, not input actions', () => {
    const { canvas, controller } = setup();
    controller.select('din-rail-2');
    const f = key('keydown', 'KeyF');
    canvas.dispatchEvent(f);
    expect(f.defaultPrevented).toBe(false); // left for the keybinding service (view.focus)
    expect(controller.state.focusId).toBe('backplate');
    expect(controller.focus('din-rail-2')).toBe(true);
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
    expect(controller.roomBounds).toEqual(DEFAULT_ROOM_BOUNDS); // the panel-only world has no floor
    expect(controller.camera.position.y).toBeCloseTo((DEFAULT_ROOM_BOUNDS.floorYMm + 1600) / 1000, 9);
    for (let i = 0; i < 200; i++) controller.update(0.1);
    expect(controller.camera.position.z).toBeCloseTo((DEFAULT_ROOM_BOUNDS.minZMm + 250) / 1000, 9);
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
      commitPlacement: [],
      moveSelection: [],
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
    controller.setMode('walk');
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
  it('matches the snapshot of the workshop level (positions in integer mm)', () => {
    const { controller } = setup(WORKSHOP);
    expect(controller.sceneGraph()).toMatchSnapshot('workshop');
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
    expect(controller.bvhCount).toBe(2); // the plate, and one geometry shared by both rails
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
      // Overlays carry their own no-op raycast by design; everything else gets the prototype's back.
      if (!m.name.startsWith('overlay:')) expect(Object.prototype.hasOwnProperty.call(m, 'raycast')).toBe(false);
    });
    expect(controller.scene.getObjectByName('overlay:hover')).toBeUndefined();
    canvas.dispatchEvent(key('keydown', 'BracketRight'));
    expect(listener).not.toHaveBeenCalled();
  });
});

// --- F1.7 part 2: world sync, placement and moves --------------------------------------------

const BOX = { id: 'prop.box', version: 1 };
const CRATE = { id: 'prop.crate', version: 1 };
const entity = (id: number, ref: typeof BOX, x: number, y: number, yaw = 0): Entity => ({
  id,
  ref,
  transform: { positionMm: { x, y, z: 0 }, orientationMdeg: { yaw, pitch: 0, roll: 0 } },
  extensions: {},
});
const worldWith = (...entities: Entity[]): World => ({
  ...PANEL,
  nextEntityId: Math.max(0, ...entities.map((e) => e.id)) + 1,
  entities,
});

/** Moves the pointer over an integer-mm world point (so the next frame aims the ghost there). */
const pointAt = (canvas: FakeCanvas, c: ViewportController, x: number, y: number, z = 0) => {
  const p = c.projectMm({ x, y, z });
  canvas.dispatchEvent(pointer('pointermove', p.x, p.y));
  return p;
};
const intents = (c: ViewportController) => {
  const seen: ViewportIntent[] = [];
  c.onIntent((i) => seen.push(i));
  return seen;
};
const worldGraph = (c: ViewportController) => {
  const group = c.scene.getObjectByName('world');
  if (!group) throw new Error('no world group');
  return describeSceneGraph(group);
};
const ghostOf = (c: ViewportController) => c.scene.getObjectByName('overlay:ghost') as Mesh;

describe('ViewportController world sync', () => {
  it('adds, updates and removes entity objects by id (scene-graph snapshots)', () => {
    const { controller } = setup();
    controller.syncWorld(worldWith(entity(1, BOX, -210, 260), entity(2, CRATE, -50, -300, 90_000)));
    expect(worldGraph(controller)).toMatchSnapshot('two entities');
    const before = controller.scene.getObjectByName('entity-2');

    controller.syncWorld(worldWith(entity(1, BOX, -70, 110), entity(2, CRATE, -50, -300, 90_000)));
    expect(worldGraph(controller)).toMatchSnapshot('entity 1 moved');
    expect(controller.scene.getObjectByName('entity-2')).toBe(before); // untouched, same object

    controller.syncWorld(worldWith(entity(1, BOX, -70, 110)));
    expect(worldGraph(controller)).toMatchSnapshot('entity 2 removed');
    controller.dispose();
  });

  it('keeps picking and keyboard selection in step with the world', () => {
    const { controller } = setup();
    controller.syncWorld(worldWith(entity(1, BOX, -210, 260)));
    expect(controller.selection.all.map((s) => s.id)).toEqual(['backplate', 'din-rail-1', 'din-rail-2', 'entity-1']);
    const centre = ndcOf(controller, -0.15, 0.3, 0.06);
    expect(controller.pickAt(centre.x, centre.y)).toMatchObject({ id: 'entity-1', kind: 'prop', entityId: 1 });
    controller.select('entity-1');
    expect(controller.state.selected?.label).toBe('Box #1');

    controller.syncWorld(worldWith()); // deleted
    expect(controller.state.selected).toBeNull();
    expect(controller.pickAt(centre.x, centre.y)?.id).toBe('backplate');
    controller.dispose();
  });

  it('shares one geometry per prop and returns to baseline when every entity is gone', () => {
    const { controller } = setup();
    const baselineBvhs = controller.bvhCount;
    controller.syncWorld(worldWith(entity(1, BOX, -210, 260), entity(2, BOX, 0, 0), entity(3, CRATE, -50, -300)));
    expect(controller.recipeCount).toBe(2);
    expect(controller.bvhCount).toBe(baselineBvhs + 2);
    const a = controller.scene.getObjectByName('entity-1') as Mesh;
    const b = controller.scene.getObjectByName('entity-2') as Mesh;
    expect(a.geometry).toBe(b.geometry);
    const dispose = vi.spyOn(a.geometry, 'dispose');
    controller.syncWorld(worldWith());
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(controller.recipeCount).toBe(0);
    expect(controller.bvhCount).toBe(baselineBvhs);
    expect(controller.entityCount).toBe(0);
    controller.dispose();
  });

  it('redraws an entity whose ref changed, and draws unknown refs as a placeholder', () => {
    const { controller } = setup();
    controller.syncWorld(worldWith(entity(1, BOX, 0, 0)));
    controller.syncWorld(worldWith(entity(1, CRATE, 0, 0)));
    expect(controller.selection.get('entity-1')?.label).toBe('Crate #1');
    expect(controller.recipeCount).toBe(1);
    controller.syncWorld(worldWith(entity(1, { id: 'prop.mystery', version: 1 }, 0, 0)));
    expect(controller.selection.get('entity-1')?.label).toBe('Unknown object #1');
    controller.dispose();
  });
});

describe('ViewportController placement', () => {
  const targets = worldSnapTargets(PANEL);

  it('the ghost previews the snapped spot; a click commits exactly one place intent', () => {
    const { canvas, controller } = setup();
    const seen = intents(controller);
    controller.setPlacement(BOX);
    const p = pointAt(canvas, controller, -150, 300);
    controller.update(1 / 60);
    expect(ghostOf(controller).visible).toBe(true);
    expect(controller.state.placement).toMatchObject({
      kind: 'place',
      valid: true,
      targetId: 'backplate',
      source: 'pointer',
    });
    expect(describeSceneGraph(ghostOf(controller)).positionMm).toEqual([-210, 260, 0]);

    for (let i = 0; i < 5; i++) {
      pointAt(canvas, controller, -150 + i * 7, 300);
      controller.update(1 / 60); // following the pointer emits nothing
    }
    expect(seen).toEqual([]);

    canvas.dispatchEvent(pointer('pointerdown', p.x, p.y));
    canvas.dispatchEvent(pointer('pointerup', p.x, p.y));
    const expected = placeOnTargets(BOX, { x: -150, y: 300, z: 0 }, targets);
    if (!expected.ok) throw new Error('expected a placement');
    expect(seen).toEqual([
      { kind: 'place', ref: BOX, positionMm: expected.positionMm, orientationMdeg: expected.orientationMdeg },
    ]);
    expect(controller.state.selected).toBeNull(); // placing doesn't select
    controller.dispose();
  });

  it('snaps to a DIN rail over the plate behind it', () => {
    const { canvas, controller } = setup();
    controller.setPlacement(BOX);
    pointAt(canvas, controller, -10, 150, 7);
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ valid: true, targetId: 'din-rail-1' });
    expect(describeSceneGraph(ghostOf(controller)).positionMm).toEqual([-75, 110, 0]);
    controller.dispose();
  });

  it('an orbit drag while placing commits nothing, and off-target clicks commit nothing', () => {
    const { canvas, controller } = setup();
    const seen = intents(controller);
    controller.setPlacement(CRATE);
    canvas.dispatchEvent(pointer('pointerdown', 600, 300));
    canvas.dispatchEvent(pointer('pointermove', 700, 320));
    canvas.dispatchEvent(pointer('pointerup', 700, 320));
    canvas.dispatchEvent(pointer('pointermove', 2, 2)); // the background
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ valid: false, targetId: null });
    expect(ghostOf(controller).visible).toBe(false);
    canvas.dispatchEvent(pointer('pointerdown', 2, 2));
    canvas.dispatchEvent(pointer('pointerup', 2, 2));
    expect(seen).toEqual([]);
    controller.dispose();
  });

  it('Escape cancels placement without a command, then clears the selection, then falls through', () => {
    const { canvas, controller } = setup();
    const seen = intents(controller);
    controller.select('backplate');
    controller.setPlacement(BOX);
    pointAt(canvas, controller, -150, 300);
    controller.update(1 / 60);
    const first = key('keydown', 'Escape');
    canvas.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ kind: 'cancelPlacement' }]);
    expect(controller.state.placement).toBeNull();
    expect(ghostOf(controller).visible).toBe(false);
    expect(controller.recipeCount).toBe(0); // the ghost gave its geometry back
    expect(controller.state.selected?.id).toBe('backplate');
    canvas.dispatchEvent(key('keydown', 'Escape'));
    expect(controller.state.selected).toBeNull();
    const third = key('keydown', 'Escape');
    canvas.dispatchEvent(third);
    expect(third.defaultPrevented).toBe(false); // the shell opens the menu
    expect(seen).toEqual([{ kind: 'cancelPlacement' }]);
    controller.dispose();
  });

  it('keyboard: Enter places at the reticle when the pointer is not over the canvas', () => {
    const { canvas, controller } = setup();
    const seen = intents(controller);
    controller.setPlacement(BOX);
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ source: 'reticle', valid: true });
    const enter = key('keydown', 'Enter');
    canvas.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    // The reticle is the view centre, the focused backplate's centre: (0, 0) snaps to (-60, -40).
    expect(seen).toEqual([
      {
        kind: 'place',
        ref: BOX,
        positionMm: { x: -60, y: -40, z: 0 },
        orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
      },
    ]);
    controller.setPlacement(null);
    const idle = key('keydown', 'Enter');
    canvas.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false); // nothing to commit
    controller.dispose();
  });
});

describe('ViewportController moves', () => {
  const setupWithBox = () => {
    const ctx = setup();
    ctx.controller.syncWorld(worldWith(entity(1, BOX, -210, 260)));
    return ctx;
  };

  it('dragging an entity previews the move and releasing commits exactly one move intent', () => {
    const { canvas, controller } = setupWithBox();
    const seen = intents(controller);
    const box = controller.scene.getObjectByName('entity-1') as Mesh;
    const eye = controller.camera.position.clone();
    const start = controller.projectMm({ x: -150, y: 300, z: 60 });
    canvas.dispatchEvent(pointer('pointermove', start.x, start.y));
    canvas.dispatchEvent(pointer('pointerdown', start.x, start.y));
    for (let i = 1; i <= 8; i++) {
      const p = controller.projectMm({ x: -150 + i * 17.5, y: 300 - i * 18.75, z: 0 });
      canvas.dispatchEvent(pointer('pointermove', p.x, p.y));
      controller.update(1 / 60);
    }
    expect(controller.state.placement).toMatchObject({
      kind: 'move',
      entityId: 1,
      valid: true,
      targetId: 'din-rail-1',
    });
    expect(box.visible).toBe(false); // the ghost stands in for it
    expect(seen).toEqual([]); // dragging produces nothing

    const end = controller.projectMm({ x: -10, y: 150, z: 7 });
    canvas.dispatchEvent(pointer('pointerup', end.x, end.y));
    expect(seen).toEqual([{ kind: 'move', id: 1, positionMm: { x: -75, y: 110, z: 0 } }]);
    expect(box.visible).toBe(true);
    expect(controller.state.placement).toBeNull();
    expect(controller.camera.position.equals(eye)).toBe(true); // the drag didn't orbit
    controller.dispose();
  });

  it('a click on an entity selects it; Escape mid-drag cancels the move with no intent', () => {
    const { canvas, controller } = setupWithBox();
    const seen = intents(controller);
    const start = controller.projectMm({ x: -150, y: 300, z: 60 });
    canvas.dispatchEvent(pointer('pointerdown', start.x, start.y));
    canvas.dispatchEvent(pointer('pointerup', start.x + 1, start.y));
    expect(controller.state.selected).toMatchObject({ id: 'entity-1', entityId: 1 });

    canvas.dispatchEvent(pointer('pointerdown', start.x, start.y));
    canvas.dispatchEvent(pointer('pointermove', start.x + 60, start.y + 40));
    expect(controller.state.placement?.kind).toBe('move');
    canvas.dispatchEvent(key('keydown', 'Escape'));
    expect(controller.state.placement).toBeNull();
    canvas.dispatchEvent(pointer('pointerup', start.x + 60, start.y + 40));
    expect(seen).toEqual([]);
    expect((controller.scene.getObjectByName('entity-1') as Mesh).visible).toBe(true);
    controller.dispose();
  });

  it('dropping where it already is commits nothing', () => {
    const { canvas, controller } = setupWithBox();
    const seen = intents(controller);
    const start = controller.projectMm({ x: -150, y: 300, z: 60 });
    canvas.dispatchEvent(pointer('pointerdown', start.x, start.y));
    const away = controller.projectMm({ x: -100, y: 300, z: 0 });
    canvas.dispatchEvent(pointer('pointermove', away.x, away.y));
    const back = controller.projectMm({ x: -150, y: 300, z: 0 });
    canvas.dispatchEvent(pointer('pointermove', back.x, back.y));
    canvas.dispatchEvent(pointer('pointerup', back.x, back.y));
    expect(seen).toEqual([]);
    controller.dispose();
  });

  it('keyboard: M picks up the selection and Enter drops it at the reticle', () => {
    const { canvas, controller } = setupWithBox();
    const seen = intents(controller);
    canvas.dispatchEvent(key('keydown', 'KeyM')); // nothing selected
    expect(controller.state.placement).toBeNull();
    controller.select('entity-1');
    canvas.dispatchEvent(key('keydown', 'KeyM'));
    expect(controller.state.placement).toMatchObject({ kind: 'move', entityId: 1, source: 'reticle' });
    controller.update(1 / 60);
    canvas.dispatchEvent(key('keydown', 'Enter'));
    expect(seen).toEqual([{ kind: 'move', id: 1, positionMm: { x: -60, y: -40, z: 0 } }]);
    controller.dispose();
  });

  it('a world change to the entity being moved (undo, delete) cancels the move', () => {
    const { canvas, controller } = setupWithBox();
    controller.select('entity-1');
    canvas.dispatchEvent(key('keydown', 'KeyM'));
    controller.syncWorld(worldWith());
    expect(controller.state.placement).toBeNull();
    controller.dispose();
  });

  it('mode changes and tool changes end a move', () => {
    const { canvas, controller } = setupWithBox();
    controller.select('entity-1');
    canvas.dispatchEvent(key('keydown', 'KeyM'));
    controller.setMode('walk');
    expect(controller.state.placement).toBeNull();
    controller.setMode('work');
    controller.select('entity-1');
    canvas.dispatchEvent(key('keydown', 'KeyM'));
    controller.setPlacement(CRATE);
    expect(controller.state.placement).toMatchObject({ kind: 'place', ref: CRATE });
    controller.dispose();
  });
});

describe('ViewportController with a live command bus', () => {
  it('intents executed as Commands give the same world as the equivalent script', () => {
    const { canvas, controller } = setup();
    const bus = createWorldBus(PANEL);
    controller.onIntent((i) => {
      if (i.kind === 'place')
        bus.exec('entity.place', { ref: i.ref, positionMm: i.positionMm, orientationMdeg: i.orientationMdeg });
      if (i.kind === 'move') bus.exec('entity.move', { id: i.id, positionMm: i.positionMm });
      controller.syncWorld(bus.state);
    });
    controller.setPlacement(BOX);
    const p = pointAt(canvas, controller, -150, 300);
    canvas.dispatchEvent(pointer('pointerdown', p.x, p.y));
    canvas.dispatchEvent(pointer('pointerup', p.x, p.y));
    expect(bus.entries.map((e) => e.id)).toEqual(['entity.place']);
    expect(controller.entityCount).toBe(1);

    const script = createWorldBus(PANEL);
    const placed = placeOnTargets(BOX, { x: -150, y: 300, z: 0 }, worldSnapTargets(script.state));
    if (!placed.ok) throw new Error('expected a placement');
    script.exec('entity.place', { ref: BOX, positionMm: placed.positionMm, orientationMdeg: placed.orientationMdeg });
    expect(bus.state).toEqual(script.state);
    controller.dispose();
  });
});

describe('ViewportController disposal with world entities and a ghost', () => {
  it('releases every entity, recipe, ghost and BVH', () => {
    const { canvas, controller } = setup();
    controller.syncWorld(worldWith(entity(1, BOX, -210, 260), entity(2, CRATE, -50, -300)));
    controller.setPlacement(BOX);
    pointAt(canvas, controller, -150, 300);
    controller.update(1 / 60);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    controller.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Box3Helper) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    controller.dispose();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(controller.recipeCount).toBe(0);
    expect(controller.bvhCount).toBe(0);
    expect(controller.scene.getObjectByName('world')).toBeUndefined();
    expect(controller.scene.getObjectByName('overlay:ghost')).toBeUndefined();
    expect(canvas.live.size).toBe(0);
  });
});

// --- F1.9: the workshop level ----------------------------------------------------------------

describe('ViewportController on the workshop', () => {
  const SPOOL = { id: 'prop.spool', version: 1 };
  const targets = worldSnapTargets(WORKSHOP);

  it('draws nothing until a world arrives, then frames the backplate and walks the floor', () => {
    const canvas = new FakeCanvas();
    const controller = new ViewportController(canvas as unknown as HTMLElement);
    controller.resize(canvas.clientWidth, canvas.clientHeight);
    expect(controller.state.focusId).toBeNull();
    expect(controller.selection.all).toEqual([]);
    controller.syncWorld(WORKSHOP);
    expect(controller.state).toMatchObject({ mode: 'work', focusId: 'backplate' });
    expect(controller.fixtureCount).toBe(7);
    expect(controller.roomBounds).toEqual({ minXMm: -2500, maxXMm: 2500, minZMm: -110, maxZMm: 3590, floorYMm: -1200 });
    controller.syncWorld(createWorld({ seed: 0 })); // an empty world: the level goes, and so does the focus
    expect(controller.fixtureCount).toBe(0);
    expect(controller.fixtureRecipeCount).toBe(0);
    expect(controller.state.focusId).toBeNull();
    expect(controller.roomBounds).toEqual(DEFAULT_ROOM_BOUNDS);
    controller.dispose();
  });

  it('walls, benches and the backboard are selectable focus targets (view.focus); the floor is not', () => {
    const { controller } = setup(WORKSHOP);
    expect(controller.selection.all.map((s) => `${s.kind}:${s.id}`)).toEqual([
      'board:backboard',
      'backplate:backplate',
      'bench:bench',
      'din-rail:din-rail-1',
      'din-rail:din-rail-2',
      'wall:stud-wall',
    ]);
    for (const id of ['stud-wall', 'bench', 'backboard', 'din-rail-1']) {
      expect(controller.focus(id), id).toBe(true);
      expect(controller.state.focusId).toBe(id);
    }
    expect(controller.focus('floor')).toBe(false);
    // The bench is framed from above (its top is 900 mm up, at y = -300), so its top is in view.
    controller.focus('bench');
    expect(controller.camera.position.y).toBeGreaterThan(-0.3);
    controller.dispose();
  });

  it('the ghost snaps to the stud wall and the bench top with the arguments a script gets', () => {
    const { canvas, controller } = setup(WORKSHOP);
    const seen = intents(controller);
    controller.focus('stud-wall');
    controller.setPlacement(BOX);
    const wallPoint = { x: -2000, y: 0, z: -21 };
    const p = pointAt(canvas, controller, wallPoint.x, wallPoint.y, wallPoint.z);
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ valid: true, targetId: 'stud-wall' });
    canvas.dispatchEvent(pointer('pointerdown', p.x, p.y));
    canvas.dispatchEvent(pointer('pointerup', p.x, p.y));

    controller.focus('bench');
    controller.setPlacement(SPOOL);
    const benchPoint = { x: 1600, y: -300, z: 455 };
    const q = pointAt(canvas, controller, benchPoint.x, benchPoint.y, benchPoint.z);
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ valid: true, targetId: 'bench' });
    canvas.dispatchEvent(pointer('pointerdown', q.x, q.y));
    canvas.dispatchEvent(pointer('pointerup', q.x, q.y));

    const expected = (
      [
        [BOX, wallPoint],
        [SPOOL, benchPoint],
      ] as const
    ).map(([ref, cursor]) => {
      const r = placeOnTargets(ref, cursor, targets);
      if (!r.ok) throw new Error(`expected a placement, got ${r.reason}`);
      return { kind: 'place', ref, positionMm: r.positionMm, orientationMdeg: r.orientationMdeg };
    });
    expect(seen).toEqual(expected);
    expect(expected[1].orientationMdeg).toEqual({ yaw: 0, pitch: 270_000, roll: 0 }); // stood up on the bench
    controller.dispose();
  });

  it('the backboard hides the studs behind it: no snap there, so nothing is placed', () => {
    const { canvas, controller } = setup(WORKSHOP);
    const seen = intents(controller);
    controller.focus('backboard');
    controller.setPlacement(BOX);
    const p = pointAt(canvas, controller, -500, 500, -3); // on the board, above and left of the backplate
    controller.update(1 / 60);
    expect(controller.state.placement).toMatchObject({ valid: false, targetId: null });
    canvas.dispatchEvent(pointer('pointerdown', p.x, p.y));
    canvas.dispatchEvent(pointer('pointerup', p.x, p.y));
    expect(seen).toEqual([]);
    controller.dispose();
  });

  it('a prop placed on the bench is drawn standing on the top', () => {
    const { controller } = setup(WORKSHOP);
    const placed = placeOnTargets(SPOOL, { x: 1600, y: -300, z: 455 }, targets);
    if (!placed.ok) throw new Error('expected a placement');
    const transform = { positionMm: placed.positionMm, orientationMdeg: placed.orientationMdeg };
    controller.syncWorld({
      ...WORKSHOP,
      nextEntityId: 2,
      entities: [{ id: 1, ref: SPOOL, transform, extensions: {} }],
    });
    const spool = controller.scene.getObjectByName('entity-1') as Mesh;
    const bounds = new Box3().setFromObject(spool);
    expect(bounds.min.y).toBeCloseTo(-0.3, 6); // its bottom on the bench top
    expect(bounds.max.y).toBeCloseTo(-0.2, 6); // 100 mm tall: the spool's depth stands up
    controller.dispose();
  });

  it('resetView returns to work mode on the backplate with nothing selected', () => {
    const { controller } = setup(WORKSHOP);
    controller.focus('bench');
    controller.select('stud-wall');
    controller.setMode('walk');
    controller.resetView();
    expect(controller.state).toMatchObject({ mode: 'work', focusId: 'backplate', selected: null });
    controller.dispose();
  });

  it('disposal releases every fixture recipe, BVH and listener', () => {
    const { canvas, controller } = setup(WORKSHOP);
    canvas.dispatchEvent(pointer('pointermove', 640, 360));
    controller.update(1 / 60);
    controller.setPlacement(BOX);
    controller.update(1 / 60);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    controller.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof Box3Helper) {
        geometries.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
      }
    });
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    expect(controller.fixtureRecipeCount).toBe(6);
    controller.dispose();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(controller.fixtureRecipeCount).toBe(0);
    expect(controller.recipeCount).toBe(0);
    expect(controller.bvhCount).toBe(0);
    expect(controller.scene.getObjectByName('fixtures')).toBeUndefined();
    expect(canvas.live.size).toBe(0);
  });
});

describe('ViewportController on-demand rendering (with RenderLoop)', () => {
  /** The controller driven by a RenderLoop on a hand-ticked clock, counting draws; settled and idle. */
  const onDemand = (world: World = PANEL) => {
    const ctx = setup(world);
    const clock = new ManualFrameClock();
    const draw = vi.fn();
    const loop = new RenderLoop({ clock, update: (dt) => ctx.controller.update(dt), draw });
    ctx.controller.onInvalidate(() => loop.requestRender());
    loop.requestRender();
    clock.ticks(5);
    /** Draws caused by `act`, after any animation it starts has settled (the loop is idle again). */
    const drawsAfter = (act: () => void, ticks = 5): number => {
      draw.mockClear();
      act();
      clock.ticks(ticks);
      expect(clock.pendingFrames).toBe(0);
      return draw.mock.calls.length;
    };
    return { ...ctx, clock, draw, loop, drawsAfter };
  };

  it('an idle viewport draws nothing and requests no frame', () => {
    const { clock, draw, controller } = onDemand(WORKSHOP);
    expect(draw).toHaveBeenCalled(); // the first frame
    draw.mockClear();
    clock.ticks(600); // ten seconds
    expect(draw).not.toHaveBeenCalled();
    expect(clock.pendingFrames).toBe(0);
    controller.dispose();
  });

  it('pointer moves draw (hover is resolved in that frame); unbound keys do not', () => {
    const { canvas, controller, drawsAfter } = onDemand();
    expect(drawsAfter(() => canvas.dispatchEvent(pointer('pointermove', 640, 360)))).toBeGreaterThan(0);
    expect(controller.state.hovered?.id).toBe('backplate');
    expect(drawsAfter(() => canvas.dispatchEvent(pointer('pointerleave', 0, 0)))).toBeGreaterThan(0);
    expect(controller.state.hovered).toBeNull();
    expect(drawsAfter(() => canvas.dispatchEvent(key('keydown', 'KeyQ')))).toBe(0);
    controller.dispose();
  });

  it('world, selection, placement, mode, focus, reset and resize changes each draw', () => {
    const { canvas, controller, drawsAfter } = onDemand();
    expect(drawsAfter(() => controller.syncWorld(worldWith(entity(1, BOX, -210, 260))))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.select('din-rail-1'))).toBeGreaterThan(0);
    expect(drawsAfter(() => canvas.dispatchEvent(key('keydown', 'BracketRight')))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.setPlacement(CRATE))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.setPlacement(null))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.focus('din-rail-2'))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.setMode('walk'))).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.resetView())).toBeGreaterThan(0);
    expect(drawsAfter(() => controller.resize(800, 600))).toBeGreaterThan(0);
    // Requests made before a frame coalesce into it.
    expect(
      drawsAfter(() => {
        controller.select('backplate');
        controller.select(null);
        controller.resize(1280, 720);
      }),
    ).toBe(1);
    controller.dispose();
  });

  it('walk mode keeps drawing while a key is held and stops when it is released', () => {
    const { canvas, clock, draw, controller, drawsAfter } = onDemand();
    controller.setMode('walk');
    clock.ticks(5);
    const z0 = controller.camera.position.z;
    draw.mockClear();
    canvas.dispatchEvent(key('keydown', 'KeyW'));
    canvas.dispatchEvent(key('keydown', 'KeyW', true)); // auto-repeat changes nothing
    clock.ticks(30);
    expect(draw).toHaveBeenCalledTimes(30); // every frame while held
    expect(controller.camera.position.z).toBeLessThan(z0);
    expect(drawsAfter(() => canvas.dispatchEvent(key('keyup', 'KeyW')))).toBe(1);
    const z1 = controller.camera.position.z;
    clock.ticks(30);
    expect(controller.camera.position.z).toBe(z1);
    // Blur releases held keys, and so ends the animation.
    canvas.dispatchEvent(key('keydown', 'KeyD'));
    clock.ticks(3);
    expect(drawsAfter(() => canvas.dispatchEvent(new Event('blur')))).toBe(1);
    controller.dispose();
  });

  it('mouse look in walk mode draws', () => {
    const { canvas, controller, drawsAfter } = onDemand();
    controller.setMode('walk');
    canvas.dispatchEvent(pointer('pointerdown', 640, 360));
    canvas.dispatchEvent(pointer('pointerup', 640, 360)); // takes pointer lock
    const yaw0 = controller.camera.rotation.y;
    const look = () =>
      canvas.ownerDocument.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: -50, movementY: 0 }));
    expect(drawsAfter(look)).toBe(1);
    expect(controller.camera.rotation.y).toBeGreaterThan(yaw0);
    controller.dispose();
  });

  it('an orbit drag draws, damping keeps drawing until it settles, then the viewport idles', () => {
    const { canvas, clock, draw, controller } = onDemand();
    const eye = controller.camera.position.clone();
    draw.mockClear();
    // OrbitControls follows a drag on the document (where a real pointer event bubbles to).
    canvas.dispatchEvent(pointer('pointerdown', 600, 300));
    canvas.ownerDocument.dispatchEvent(pointer('pointermove', 700, 320));
    canvas.ownerDocument.dispatchEvent(pointer('pointerup', 700, 320));
    clock.ticks(10);
    expect(draw).toHaveBeenCalledTimes(10); // still damping
    clock.ticks(2000);
    expect(clock.pendingFrames).toBe(0); // settled
    const settled = draw.mock.calls.length;
    expect(controller.camera.position.equals(eye)).toBe(false);
    clock.ticks(100);
    expect(draw).toHaveBeenCalledTimes(settled);
    controller.dispose();
  });

  it('after dispose nothing requests a frame', () => {
    const { canvas, clock, controller, loop } = onDemand();
    controller.dispose();
    loop.dispose();
    canvas.dispatchEvent(pointer('pointermove', 640, 360));
    expect(clock.pendingFrames).toBe(0);
  });
});
