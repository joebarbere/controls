import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import {
  createWorldBus,
  createWorldRegistry,
  type RouteProposal,
  suggestTermination,
  type TerminationArgs,
  type Waypoint,
} from '@controls/world-model';
import { WIRING_TEST_CATALOG } from '@controls/world-model/testing';
import {
  addWaypoint,
  cancelGesture,
  IDLE_GESTURE,
  MAX_GESTURE_WAYPOINTS,
  pickTerminal,
  proposeCompletion,
  type RouteGesture,
  spoolOf,
  stepBack,
} from './routing-gesture';

const THHN = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const CUTTER = { id: 'tool.veltmark-dc-8', version: 1 };
const spool = spoolOf(BUILTIN_CATALOG, THHN) ?? (null as never);
const free = (x: number): Waypoint => ({
  kind: 'free',
  positionMm: { x, y: 0, z: 0 },
  entity: null,
  fixture: null,
  tool: null,
});
const proposal = (route: Waypoint[], lengthMm = 120): RouteProposal => ({
  ok: true,
  route,
  lengthMm,
  floorMm: lengthMm - 5,
  points: [],
  auto: route.length === 0,
});

describe('the routing gesture (F3.2 part 3)', () => {
  it('a conductor is a spool, with its first colour and size; a cable, a lead or a tool is not', () => {
    expect(spool).toStrictEqual({
      ref: THHN,
      title: '14 AWG solid copper THHN/THWN-2 building wire',
      colour: { base: 'black', stripe: null },
      awg: 14,
    });
    expect(spoolOf(BUILTIN_CATALOG, { id: 'cable.sorrelby-nmb-14-2', version: 1 })).toBeNull();
    expect(spoolOf(BUILTIN_CATALOG, { id: 'lead.quillfern-test-1m', version: 1 })).toBeNull();
    expect(spoolOf(BUILTIN_CATALOG, CUTTER)).toBeNull();
    expect(spoolOf(BUILTIN_CATALOG, null)).toBeNull();
  });

  it('two terminal picks make exactly one wire.add from the proposal, then start over with the spool kept', () => {
    const first = pickTerminal(IDLE_GESTURE, { entity: 1, terminal: 'a' }, null, spool, CUTTER);
    expect(first).toStrictEqual({
      kind: 'from',
      gesture: { from: { entity: 1, terminal: 'a' }, waypoints: [] },
      end: { entity: 1, terminal: 'a' },
    });
    const route = [free(50)];
    const done = pickTerminal(first.gesture, { entity: 3, terminal: 'b' }, proposal(route, 130), spool, CUTTER);
    expect(done).toStrictEqual({
      kind: 'complete',
      gesture: IDLE_GESTURE,
      lengthMm: 130,
      args: {
        ref: THHN,
        a: { entity: 1, terminal: 'a', termination: 'auto' },
        b: { entity: 3, terminal: 'b', termination: 'auto' },
        route,
        lengthMm: 130,
        colour: { base: 'black', stripe: null },
        tool: CUTTER,
      },
    });
    // The logged args never share objects with the renderer's proposal.
    if (done.kind === 'complete') expect(done.args.route[0]).not.toBe(route[0]);
  });

  it('refuses, keeping the picks, what the command would refuse: the same terminal, a bad proposal, no cutter', () => {
    const started: RouteGesture = { from: { entity: 1, terminal: 'a' }, waypoints: [free(10)] };
    expect(pickTerminal(started, { entity: 1, terminal: 'a' }, null, spool, CUTTER)).toMatchObject({
      kind: 'refused',
      gesture: started,
      code: 'same-terminal',
    });
    const collides: RouteProposal = { ok: false, code: 'route-collides', message: 'The route passes through entity 2' };
    expect(pickTerminal(started, { entity: 3, terminal: 'a' }, collides, spool, CUTTER)).toStrictEqual({
      kind: 'refused',
      gesture: started,
      code: 'route-collides',
      message: 'The route passes through entity 2',
    });
    expect(pickTerminal(started, { entity: 3, terminal: 'a' }, proposal([]), spool, null)).toMatchObject({
      kind: 'refused',
      code: 'wrong-tool',
    });
    expect(pickTerminal(started, { entity: 3, terminal: 'a' }, null, spool, CUTTER)).toStrictEqual({
      kind: 'ignored',
      gesture: started,
    });
  });

  it('waypoints follow the first pick, up to the route limit; before it they are ignored', () => {
    expect(addWaypoint(IDLE_GESTURE, free(1))).toStrictEqual({ kind: 'ignored', gesture: IDLE_GESTURE });
    let g: RouteGesture = { from: { entity: 1, terminal: 'a' }, waypoints: [] };
    for (let i = 0; i < MAX_GESTURE_WAYPOINTS; i++) {
      const step = addWaypoint(g, free(i));
      expect(step.kind).toBe('waypoint');
      g = step.gesture;
    }
    expect(g.waypoints).toHaveLength(MAX_GESTURE_WAYPOINTS);
    expect(addWaypoint(g, free(-1))).toMatchObject({ kind: 'refused', gesture: g, code: 'too-many-waypoints' });
  });

  it('Backspace removes the last waypoint, then the first terminal, then nothing', () => {
    const g: RouteGesture = { from: { entity: 1, terminal: 'a' }, waypoints: [free(1), free(2)] };
    const one = stepBack(g);
    expect(one).toStrictEqual({ kind: 'removedWaypoint', gesture: { ...g, waypoints: [free(1)] }, left: 1 });
    const none = stepBack(one.gesture);
    expect(none).toMatchObject({ kind: 'removedWaypoint', left: 0 });
    expect(stepBack(none.gesture)).toStrictEqual({
      kind: 'clearedFrom',
      gesture: IDLE_GESTURE,
      end: { entity: 1, terminal: 'a' },
    });
    expect(stepBack(IDLE_GESTURE)).toStrictEqual({ kind: 'ignored', gesture: IDLE_GESTURE });
  });

  it('Escape drops a route in progress; with none it puts the spool away', () => {
    expect(cancelGesture({ from: { entity: 1, terminal: 'a' }, waypoints: [] })).toStrictEqual({
      kind: 'cancelled',
      gesture: IDLE_GESTURE,
    });
    expect(cancelGesture(IDLE_GESTURE)).toStrictEqual({ kind: 'putAway', gesture: IDLE_GESTURE });
  });
});

describe('proposeCompletion: the second end follows its chosen method (F3.3 part 2)', () => {
  // The world-model test block's terminal 2 lands by screw (entry z 30) or spring cage (entry z 40).
  const catalog = WIRING_TEST_CATALOG;
  const WIRE = { id: 'conductor.test-14', version: 1 };
  const testSpool = spoolOf(catalog, WIRE) ?? (null as never);
  const TEST_CUTTER = { id: 'tool.test-cutter', version: 1 };
  const methods = catalog.device({ id: 'tb.test-2', version: 1 })?.terminals.find((t) => t.id === '2')?.methods ?? [];
  const landing = (method: string): TerminationArgs => {
    const args = suggestTermination(
      methods.filter((m) => m.method === method),
      { awg: 14, stranding: 'solid' },
      catalog.tools,
      catalog.accessories,
    );
    if (!args) throw new Error(method);
    return args;
  };
  function bench() {
    const bus = createWorldBus(createWorld({ seed: 0, difficulty: 'journeyman' }), createWorldRegistry({ catalog }));
    for (const x of [0, 200]) {
      expect(bus.exec('entity.place', { ref: { id: 'tb.test-2', version: 1 }, positionMm: { x, y: 0, z: 0 } }).ok).toBe(
        true,
      );
    }
    return bus;
  }
  const gesture: RouteGesture = {
    from: { entity: 1, terminal: '2' },
    waypoints: [],
    fromTermination: landing('screw'),
  };
  const end = { entity: 2, terminal: '2' };

  it('the route and lengthMm end at the chosen method’s entry point, and the command lands it there', () => {
    const results: [string, number, number][] = [];
    for (const method of ['screw', 'springCage']) {
      const bus = bench();
      const termination = landing(method);
      const proposed = proposeCompletion(bus.state, catalog, gesture, end, termination);
      if (!proposed.ok) throw new Error(proposed.message);
      const step = pickTerminal(gesture, end, proposed, testSpool, TEST_CUTTER, termination);
      if (step.kind !== 'complete') throw new Error(step.kind);
      expect(step.args.lengthMm).toBe(proposed.lengthMm);
      expect(step.args.b?.termination).toStrictEqual(termination);
      const done = bus.exec('wire.add', step.args);
      expect(done).toMatchObject({ ok: true });
      const wire = bus.state.connections.at(-1);
      expect(wire?.b?.termination?.method).toBe(method);
      results.push([method, proposed.points.at(-1)?.z ?? NaN, proposed.lengthMm]);
    }
    const [screw, cage] = results;
    expect(cage[1] - screw[1]).toBe(10); // the spring cage's entry is 10 mm further along z
    expect(cage[2]).not.toBe(screw[2]);
  });

  it('refuses without a first terminal (not-found)', () => {
    const bus = bench();
    expect(proposeCompletion(bus.state, catalog, IDLE_GESTURE, end, landing('screw'))).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });
});
