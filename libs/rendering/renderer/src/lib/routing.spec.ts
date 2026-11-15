import { Mesh, Vector3, type BufferGeometry, type Material } from 'three/webgpu';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { bakeWorldRoutes, proposeRoute, type World } from '@controls/world-model';
import { ROUTING_PANEL_REFS, routingPanelBus, rowA, rowB } from '@controls/world-model/testing';
import { ViewportController, type RoutingEvent, type RoutingSession } from './viewport-controller';

/*
 * F3.2 part 3 (ADR 0017 §9): the terminal picker, the wire picker and the routing gesture's view,
 * on the routing panel (free-standing ducts and 6 mm terminal blocks, `routingPanelBus`), seen
 * head-on from 1.2 m as ADR 0010's default framing (a 6 mm pitch is about 4.3 px on a 1280 × 720
 * canvas).
 */

class FakeTarget extends EventTarget {}
class FakeCanvas extends FakeTarget {
  readonly ownerDocument = Object.assign(new FakeTarget(), { pointerLockElement: null, defaultView: new FakeTarget() });
  readonly style: Record<string, string> = {};
  clientWidth = 1280;
  clientHeight = 720;
  focus = vi.fn();
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  hasPointerCapture = vi.fn(() => false);
  getRootNode() {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720, x: 0, y: 0 };
  }
}

const pointer = (type: string, x: number, y: number) =>
  Object.assign(new Event(type), { button: 0, offsetX: x, offsetY: y, clientX: x, clientY: y, pointerId: 1 });
const key = (code: string) =>
  Object.assign(new Event('keydown', { cancelable: true }), {
    code,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });

const WIRE = ROUTING_PANEL_REFS.wire;
const BLACK = { base: 'black', stripe: null } as const;

/** The routing panel (optionally wired), viewed head-on from 1.2 m in front of x = 170, y = 150 mm. */
const setup = (world: World = routingPanelBus().state) => {
  const canvas = new FakeCanvas();
  const controller = new ViewportController(canvas as unknown as HTMLElement);
  controller.resize(canvas.clientWidth, canvas.clientHeight);
  controller.syncWorld(world);
  // No fixture to focus: aim the camera (and OrbitControls, which re-aims it on every update).
  controller.camera.position.set(0.17, 0.15, 1.2);
  const orbit = (controller as unknown as { orbit: { target: Vector3; update(): boolean } }).orbit;
  orbit.target.set(0.17, 0.15, 0);
  orbit.update();
  controller.camera.updateMatrixWorld();
  const events: RoutingEvent[] = [];
  controller.onRouting((e) => events.push(e));
  /** Moves the pointer to canvas px and runs a frame (hover is computed in update). */
  const hover = (x: number, y: number) => {
    canvas.dispatchEvent(pointer('pointermove', x, y));
    controller.update(0);
  };
  const click = (x: number, y: number) => {
    hover(x, y);
    canvas.dispatchEvent(pointer('pointerdown', x, y));
    canvas.dispatchEvent(pointer('pointerup', x, y));
  };
  const at = (entity: number, terminal: string) => {
    const p = controller.projectTerminal({ entity, terminal });
    if (!p) throw new Error(`no terminal ${entity}:${terminal}`);
    return p;
  };
  return { canvas, controller, events, hover, click, at, world };
};

const session = (from: RoutingSession['from'] = null, waypoints: RoutingSession['waypoints'] = []): RoutingSession => ({
  ref: WIRE,
  colour: BLACK,
  from,
  waypoints,
});
const end = (entity: number, terminal: string) => ({ entity, terminal, termination: 'auto' as const });

describe('terminal picking (ADR 0017 §9)', () => {
  it('at the default framing a 6 mm row is about 4.3 px: on the point it picks, 2.5 px off it offers the zoom', () => {
    const { controller, at } = setup();
    const p = at(rowA(3), 'a');
    const pitch = controller.terminalPitchPx(rowA(3));
    expect(pitch).toBeGreaterThan(4);
    expect(pitch).toBeLessThan(4.6);
    expect(controller.terminalAt(p.x, p.y)).toMatchObject({
      hit: { entity: rowA(3), terminal: 'a' },
      near: { entity: rowA(3), terminal: 'a' },
      device: rowA(3),
      zoomSuggested: true,
    });
    const off = controller.terminalAt(p.x, p.y + 2.5);
    expect(off).toMatchObject({ hit: null, near: { entity: rowA(3), terminal: 'a' }, zoomSuggested: true });
    expect(off.pitchPx).toBeCloseTo(pitch as number, 6);
    // Far from every terminal: nothing.
    expect(controller.terminalAt(5, 5)).toMatchObject({ hit: null, near: null, device: null, zoomSuggested: false });
    controller.dispose();
  });

  it('view.focus on the device (a device is a focus target) makes the pitch at least 24 px, and picks 10 px off', () => {
    const { controller, at } = setup();
    expect(controller.focus(`entity-${rowA(3)}`)).toBe(true);
    expect(controller.state.focusId).toBe(`entity-${rowA(3)}`);
    // Framed from the front (+z), and the loop goes idle (a small target once kept OrbitControls
    // re-clamping its distance every frame).
    expect(controller.camera.position.z).toBeGreaterThan(0.047);
    let frames = 0;
    while (controller.update(1 / 60) && frames < 100) frames++;
    expect(frames).toBeLessThan(100);
    // Ample (no other terminal within 48 px: null), or at least 24 px.
    const pitch = controller.terminalPitchPx(rowA(3));
    expect(pitch === null || pitch >= 24).toBe(true);
    const p = at(rowA(3), 'a');
    expect(controller.terminalAt(p.x + 10, p.y)).toMatchObject({
      hit: { entity: rowA(3), terminal: 'a' },
      zoomSuggested: false,
    });
    controller.dispose();
  });

  it('is occlusion-filtered: a block in front hides the terminal behind it', () => {
    const bus = routingPanelBus();
    // A block 60 mm in front of row A's block 0, on the camera's line of sight to its terminal a's
    // entry (23, 108, 30): from (170, 150, 1200) that line crosses x = 26.8 … 31.9 between z = 60 and 101.
    expect(bus.exec('entity.place', { ref: ROUTING_PANEL_REFS.block, positionMm: { x: 26, y: 70, z: 60 } }).ok).toBe(
      true,
    );
    const { controller } = setup(bus.state);
    const behind = { entity: rowA(0), terminal: 'a' };
    const p = controller.projectTerminal(behind) as { x: number; y: number };
    const pick = controller.terminalAt(p.x, p.y);
    expect(pick.hit).not.toStrictEqual(behind);
    expect(pick.near).not.toStrictEqual(behind);
    // Its uncovered neighbour still picks.
    const q = controller.projectTerminal({ entity: rowA(1), terminal: 'a' }) as { x: number; y: number };
    expect(controller.terminalAt(q.x, q.y).hit).toStrictEqual({ entity: rowA(1), terminal: 'a' });
    controller.dispose();
  });
});

describe('keyboard terminal cycling (ADR 0010 decision 4)', () => {
  it('Tab and Shift+Tab walk the selected device’s terminals in reading order, wrapping', () => {
    const { controller } = setup();
    expect(controller.cycleTerminal(1)).toBeNull(); // nothing in hand
    controller.select(`entity-${rowA(2)}`);
    expect(controller.terminalCycleOrder(rowA(2))).toStrictEqual(['a', 'b']);
    expect(controller.cycleTerminal(1)).toStrictEqual({ entity: rowA(2), terminal: 'a' });
    expect(controller.cycleTerminal(1)).toStrictEqual({ entity: rowA(2), terminal: 'b' });
    expect(controller.cycleTerminal(1)).toStrictEqual({ entity: rowA(2), terminal: 'a' });
    expect(controller.cycleTerminal(-1)).toStrictEqual({ entity: rowA(2), terminal: 'b' });
    expect(controller.state.keyTerminal).toStrictEqual({ entity: rowA(2), terminal: 'b' });
    controller.update(0);
    expect(controller.routingMarkers().map((m) => m.kind)).toStrictEqual(['focus']);
    expect(controller.setKeyTerminal({ entity: rowA(2), terminal: 'zz' })).toBe(false);
    expect(controller.setKeyTerminal(null)).toBe(true);
    expect(controller.state.keyTerminal).toBeNull();
    controller.dispose();
  });
});

describe('the routing gesture (F3.2 part 3)', () => {
  it('two clicks: the first terminal, then the second with the proposal wire.add takes', () => {
    const { controller, events, click, hover, at, world } = setup();
    controller.setRouting(session());
    const a = at(rowA(0), 'a');
    click(a.x, a.y);
    expect(events).toStrictEqual([
      { kind: 'terminal', end: { entity: rowA(0), terminal: 'a' }, source: 'pointer', proposal: null },
    ]);
    // The UI folds the pick into its session.
    controller.setRouting(session(end(rowA(0), 'a')));
    const b = at(rowB(0), 'a');
    hover(b.x, b.y);
    const expected = proposeRoute(world, BUILTIN_CATALOG, end(rowA(0), 'a'), end(rowB(0), 'a'), []);
    expect(expected.ok).toBe(true);
    expect(controller.state.routing).toStrictEqual({
      from: { entity: rowA(0), terminal: 'a' },
      target: { entity: rowB(0), terminal: 'a' },
      proposal: expected,
      next: null,
    });
    // The preview rope runs through the proposal; the markers show the first terminal and the pick.
    expect(controller.wireGraph().preview).toMatchObject({ look: expect.any(String) });
    expect(controller.routingMarkers().map((m) => m.kind)).toStrictEqual(['from', 'pick']);
    click(b.x, b.y);
    expect(events[1]).toStrictEqual({
      kind: 'terminal',
      end: { entity: rowB(0), terminal: 'a' },
      source: 'pointer',
      proposal: expected,
    });
    // Routing never selects, and never changes the world.
    expect(controller.state.selected).toBeNull();
    controller.dispose();
  });

  it('a click off every terminal after the first adds the waypoint snapWaypoint gives (a duct)', () => {
    const { controller, events, click } = setup();
    controller.setRouting(session(end(rowA(0), 'a')));
    // D2's trough: axis y = 320, z = 30, its body x 0 … 600, y 300 … 340, z 0 … 60.
    const p = controller.projectMm({ x: 200, y: 320, z: 60 });
    click(p.x, p.y);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({ kind: 'waypoint', waypoint: { kind: 'duct', entity: 2 } });
    expect(controller.state.routing?.next).toMatchObject({ kind: 'duct', entity: 2 });
    // With the waypoint in the session, the marker shows it and the proposal goes through it.
    const waypoint = (event as Extract<RoutingEvent, { kind: 'waypoint' }>).waypoint;
    controller.setRouting(session(end(rowA(0), 'a'), [waypoint]));
    const b = controller.projectTerminal({ entity: rowB(0), terminal: 'a' }) as { x: number; y: number };
    click(b.x, b.y);
    expect(events[1]).toMatchObject({ kind: 'terminal', proposal: { ok: true, auto: false, route: [waypoint] } });
    expect(controller.routingMarkers().map((m) => m.kind)).toStrictEqual(['from', 'waypoint', 'pick']);
    controller.dispose();
  });

  it('keyboard only: Tab to a terminal, Enter picks it; Escape cancels', () => {
    const { canvas, controller, events, world } = setup();
    controller.setRouting(session(end(rowA(0), 'a')));
    controller.select(`entity-${rowB(1)}`);
    controller.cycleTerminal(1);
    controller.update(0);
    expect(controller.state.routing?.target).toStrictEqual({ entity: rowB(1), terminal: 'a' });
    canvas.dispatchEvent(key('Enter'));
    expect(events).toStrictEqual([
      {
        kind: 'terminal',
        end: { entity: rowB(1), terminal: 'a' },
        source: 'keyboard',
        proposal: proposeRoute(world, BUILTIN_CATALOG, end(rowA(0), 'a'), end(rowB(1), 'a'), []),
      },
    ]);
    canvas.dispatchEvent(key('Escape'));
    expect(events[1]).toStrictEqual({ kind: 'cancel' });
    expect(controller.state.keyTerminal).toBeNull();
    controller.dispose();
  });

  it('ending the gesture removes the preview and the markers; disposal frees everything exactly once', () => {
    const { controller, hover, at } = setup();
    controller.setRouting(session(end(rowA(0), 'a')));
    const b = at(rowB(0), 'a');
    hover(b.x, b.y);
    expect(controller.routingResourceCount).toBe(3);
    expect(controller.wireResourceCount).toBe(3); // the preview's mesh, geometry and material
    expect(controller.scene.getObjectByName('routing')).toBeDefined();
    controller.setRouting(null);
    controller.update(0);
    expect(controller.routingResourceCount).toBe(0);
    expect(controller.wireResourceCount).toBe(0);
    expect(controller.scene.getObjectByName('routing')).toBeUndefined();
    expect(controller.state.routing).toBeNull();

    controller.setRouting(session(end(rowA(0), 'a')));
    hover(b.x, b.y);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    controller.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      geometries.add(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => materials.add(m));
    });
    const gSpies = [...geometries].map((g) => vi.spyOn(g, 'dispose'));
    const mSpies = [...materials].map((m) => vi.spyOn(m, 'dispose'));
    controller.dispose();
    gSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    mSpies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    expect(controller.routingResourceCount).toBe(0);
    expect(controller.wireResourceCount).toBe(0);
  });
});

describe('wire picking (ADR 0017 §9)', () => {
  /** A point (mm) on connection `id`'s baked centreline, in the open between its block and its duct. */
  const onWire = (world: World, id: number) => {
    const route = bakeWorldRoutes(world, BUILTIN_CATALOG).routes.find((r) => r.owner === `c${id}`);
    if (!route) throw new Error(`no route c${id}`);
    for (let i = 0; i < route.points.length; i += 3) {
      const [x, y, z] = [route.points[i] / 10, route.points[i + 1] / 10, route.points[i + 2] / 10];
      if (y > 44 && y < 56) return { x, y, z };
    }
    throw new Error('no open-air point');
  };

  it('hovers and selects a wire through its BVH, exclusive with the entity selection; Escape clears it', () => {
    const wired = routingPanelBus(true).state;
    const { canvas, controller, hover, click } = setup(wired);
    // Connection 1 runs from row A's block 0, terminal b (y = 60), down into D1.
    const p = onWire(wired, 1);
    const px = controller.projectMm({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
    const v = new Vector3(p.x / 1000, p.y / 1000, p.z / 1000).project(controller.camera);
    expect(controller.pickWireAt(v.x, v.y)).toStrictEqual({ kind: 'connection', id: 1 });
    hover(px.x, px.y);
    expect(controller.state.hoveredWire).toStrictEqual({ kind: 'connection', id: 1 });
    expect(controller.state.hovered).toBeNull();
    expect(controller.wireGraph().highlight).toStrictEqual({ hover: 'c1', selected: null });
    click(px.x, px.y);
    expect(controller.state.selectedWire).toStrictEqual({ kind: 'connection', id: 1 });
    expect(controller.state.selected).toBeNull();
    // Selecting an entity deselects the wire.
    controller.select(`entity-${rowA(5)}`);
    expect(controller.state.selectedWire).toBeNull();
    expect(controller.selectWire({ kind: 'connection', id: 1 })).toBe(true);
    expect(controller.state.selected).toBeNull();
    canvas.dispatchEvent(key('Escape'));
    expect(controller.state.selectedWire).toBeNull();
    expect(controller.selectWire({ kind: 'connection', id: 99 })).toBe(false);
    // Off every wire, nothing.
    expect(controller.pickWireAt(0.95, 0.95)).toBeNull();
    controller.dispose();
    expect(controller.wireResourceCount).toBe(0);
  });

  it('a deleted wire is no longer hovered or selected', () => {
    const bus = routingPanelBus(true);
    const { controller } = setup(bus.state);
    expect(controller.selectWire({ kind: 'connection', id: 1 })).toBe(true);
    expect(bus.exec('wire.delete', { id: 1 }).ok).toBe(true);
    controller.syncWorld(bus.state);
    expect(controller.state.selectedWire).toBeNull();
    expect(controller.wireGraph().highlight.selected).toBeNull();
    controller.dispose();
  });
});
