import { createWorld, World } from '@controls/save-format';
import {
  at,
  autoWireArgs,
  BIT,
  CRIMPER,
  CUTTER,
  FERRULE,
  FISH_TAPE,
  freeAt,
  L1_TO_LINE_ROUTE,
  LABELLER,
  LEAD,
  LUG,
  screwTermination,
  SCREWDRIVER,
  STRANDED,
  STRIPPER,
  TORQUE,
  WIRE,
  WIRE_10,
  WIRING_TEST_CATALOG,
  wiringBench,
} from '../../testing';
import { checkWorldReferences } from '../devices';
import { worldHash } from '../hash';
import { createWorldRegistry, replayLog, toReplayLog } from '../session';
import { terminationStepKey } from '../termination';

/*
 * The wire commands (ADR 0015): arguments, ids and counters, terminations, routes and every refusal.
 * Over the TEST-ONLY wiring bench (`testing/wiring-bench.ts`): no real conductor, tool or enclosure
 * exists before F3.1, F3.4 and F3.5.
 */

const refused = (code: string) => ({ ok: false, error: { code } });

/** Every reachable world stays a valid document that agrees with the catalogue. */
function expectValid(world: World) {
  expect(World.safeParse(world).success).toBe(true);
  expect(checkWorldReferences(world, WIRING_TEST_CATALOG)).toStrictEqual([]);
}

describe('wire.add', () => {
  it('adds a conductor landed at both ends: one connection id, one termination id per end, undo restores the counters', () => {
    const bus = wiringBench();
    const before = bus.state;
    const result = bus.exec('wire.add', autoWireArgs());
    expect(result.ok).toBe(true);
    const wire = bus.state.connections.at(-1);
    expect(wire).toMatchObject({
      id: 1,
      ref: WIRE,
      a: {
        entity: 1,
        terminal: 'l1',
        termination: { id: 1, method: 'screw', auto: true, stripLengthMm: 13, torqueNm: 4 },
      },
      b: { entity: 3, terminal: 'line', termination: { id: 2, method: 'screw', auto: true } },
      cable: null,
      route: L1_TO_LINE_ROUTE,
      lengthMm: 2000,
      colour: { base: 'black', stripe: null },
      label: null,
      state: {},
    });
    expect(wire?.sim).toMatchObject({ conductorTempK: null, endADegradation: 1 });
    expect(bus.state).toMatchObject({ nextConnectionId: 2, nextTerminationId: 3 });
    expectValid(bus.state);
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(bus.state).toStrictEqual(before);
    expect(bus.exec('edit.redo').ok).toBe(true);
    expect(bus.state.connections.at(-1)).toStrictEqual(wire);
  });

  it('logs explicit arguments (the route and the length) and replays to the same hash', () => {
    const bus = wiringBench();
    const result = bus.exec('wire.add', autoWireArgs());
    expect(result).toMatchObject({
      ok: true,
      entry: { id: 'wire.add', args: { lengthMm: 2000, route: L1_TO_LINE_ROUTE } },
    });
    const log = toReplayLog(createWorld({ seed: 7, difficulty: 'trainee' }), bus);
    const replayed = replayLog(log, createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
    expect(replayed.ok && replayed.hash).toBe(worldHash(bus.state));
  });

  it('adds a wire with free ends resting on its first and last waypoints', () => {
    const bus = wiringBench('journeyman');
    const route = [freeAt(0, 600, 0), freeAt(500, 600, 0)];
    expect(bus.exec('wire.add', autoWireArgs({ a: null, b: null, route, lengthMm: 600 })).ok).toBe(true);
    expect(bus.state.connections.at(-1)).toMatchObject({ a: null, b: null, route });
    expect(bus.state.nextTerminationId).toBe(1);
    expectValid(bus.state);
  });

  it('resolves explicit terminations from the termination streams, whichever seq the command gets', () => {
    const args = autoWireArgs({
      a: { entity: 1, terminal: 'l1', termination: screwTermination(4) },
      b: { entity: 3, terminal: 'line', termination: screwTermination(2, 'h16st') },
    });
    const first = wiringBench('journeyman');
    expect(first.exec('wire.add', args).ok).toBe(true);
    // The same circuit after an unrelated logged command (a different seq) lands identically.
    const second = wiringBench('journeyman');
    second.exec('view.mode', { mode: 'work' });
    expect(second.exec('wire.add', args).ok).toBe(true);
    expect(worldHash(second.state)).toBe(worldHash(first.state));
    const wire = first.state.connections.at(-1);
    expect(wire?.a?.termination).toMatchObject({ id: 1, auto: false, nickedStrandFraction: 0 });
    expect(wire?.b?.termination?.nickedStrandFraction).toBeGreaterThan(0); // a 16 AWG stranded hole on 14 AWG solid
    const torque = wire?.a?.termination?.torqueNm as number;
    expect(Math.abs(torque - 4)).toBeLessThanOrEqual(4 * 0.06);
    expect(terminationStepKey(1, 'clamp')).toBe('termination:1:clamp');
  });

  it('refuses what ADR 0015 lists, leaving the world and the log alone', () => {
    const bus = wiringBench();
    const before = bus.state;
    const entries = bus.entries.length;
    const cases: [string, Record<string, unknown>][] = [
      ['not-a-conductor', { ref: LEAD }],
      ['not-a-conductor', { ref: { id: 'conductor.nope', version: 1 } }],
      ['unavailable-colour', { colour: { base: 'red', stripe: null } }],
      ['unavailable-colour', { colour: { base: 'bare', stripe: null } }],
      ['unknown-tool', { tool: WIRE }],
      ['wrong-tool', { tool: LABELLER }],
      ['beyond-tool-capacity', { ref: WIRE_10, tool: STRIPPER }], // its jaws cut up to 12 AWG
      [
        'needs-pull',
        { route: [{ ...freeAt(50, 500, 300), kind: 'conduit', entity: 2 }, ...L1_TO_LINE_ROUTE.slice(1)] },
      ],
      ['bad-waypoint', { route: [{ ...freeAt(50, 500, 300), entity: 2 }] }],
      ['bad-waypoint', { route: [{ ...freeAt(50, 500, 300), kind: 'staple' }] }],
      ['bad-waypoint', { route: [{ ...freeAt(50, 500, 300), kind: 'staple', entity: 99 }] }],
      ['bad-waypoint', { route: [{ ...freeAt(50, 500, 300), kind: 'staple', fixture: 'no-such-stud' }] }],
      ['bad-waypoint', { route: [{ ...freeAt(50, 500, 300), kind: 'bore', fixture: 'stud', tool: null }] }],
      ['bad-waypoint', { route: [freeAt(50, 500, 300), freeAt(50, 500, 300)] }],
      ['bad-waypoint', { route: [freeAt(50, 250, 200)] }], // the same point as L1's entry
      ['same-terminal', { b: { entity: 1, terminal: 'l1', termination: 'auto' } }],
      ['not-found', { b: { entity: 99, terminal: 'line', termination: 'auto' } }],
      ['unknown-terminal', { b: { entity: 3, terminal: 'nope', termination: 'auto' } }],
      ['too-short', { lengthMm: 1500 }],
      ['route-collides', { route: [freeAt(50, 500, 300), freeAt(1160, 500, 120), freeAt(1160, 200, 120)] }],
    ];
    for (const [code, overrides] of cases) {
      expect([code, bus.exec('wire.add', autoWireArgs(overrides))]).toMatchObject([code, refused(code)]);
    }
    expect(bus.state).toBe(before);
    expect(bus.entries).toHaveLength(entries);
  });

  it('needs a free rest waypoint at each free end', () => {
    const bus = wiringBench();
    const staple = { ...freeAt(50, 500, 300), kind: 'staple', fixture: 'nope' };
    expect(bus.exec('wire.add', autoWireArgs({ a: null, route: [] }))).toMatchObject(refused('bad-waypoint'));
    expect(bus.exec('wire.add', autoWireArgs({ b: null, route: [staple] }))).toMatchObject(refused('bad-waypoint'));
  });

  it("refuses 'auto' above Trainee (termination-required), and a method the terminal doesn't list", () => {
    for (const difficulty of ['apprentice', 'journeyman', 'realistic'] as const) {
      expect(wiringBench(difficulty).exec('wire.add', autoWireArgs())).toMatchObject(refused('termination-required'));
    }
    const bus = wiringBench('journeyman');
    const spring = { ...screwTermination(), method: 'springCage', clamp: { tool: null, torqueNm: null } };
    expect(bus.exec('wire.add', autoWireArgs({ a: { entity: 1, terminal: 'l1', termination: spring } }))).toMatchObject(
      refused('wrong-method'),
    );
  });

  it('checks every tool step: capability, capacity, hole, die, torque setting and range', () => {
    const bus = wiringBench('journeyman');
    const land = (termination: object, extra: Record<string, unknown> = {}) =>
      bus.exec('wire.add', autoWireArgs({ a: { entity: 1, terminal: 'l1', termination }, b: null, ...extra }));
    const ok = screwTermination();
    const route = [freeAt(50, 500, 300), freeAt(500, 500, 300)];
    const cases: [string, object][] = [
      ['unknown-tool', { ...ok, strip: { ...ok.strip, tool: WIRE } }],
      ['wrong-tool', { ...ok, strip: { ...ok.strip, tool: CUTTER } }],
      ['unknown-hole', { ...ok, strip: { ...ok.strip, hole: 'h99' } }],
      ['wrong-tool', { ...ok, clamp: { tool: null, torqueNm: null } }],
      ['wrong-tool', { ...ok, clamp: { tool: STRIPPER, torqueNm: null } }],
      ['wrong-tool', { ...ok, clamp: { tool: SCREWDRIVER, torqueNm: 4 } }],
      ['wrong-tool', { ...ok, clamp: { tool: TORQUE, torqueNm: null } }],
      ['beyond-tool-capacity', { ...ok, clamp: { tool: TORQUE, torqueNm: 7 } }],
      ['wrong-accessory', { ...ok, accessory: { ref: WIRE, tool: CRIMPER, die: 'sq-14' } }],
      ['wrong-accessory', { ...ok, accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-14' } }], // solid 14 in a ferrule
    ];
    for (const [code, termination] of cases) {
      expect([code, land(termination, { route })]).toMatchObject([code, refused(code)]);
    }
    expect(land(ok, { route }).ok).toBe(true);
    // A plain screwdriver lands with a seeded spread around the specified torque.
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(land({ ...ok, clamp: { tool: SCREWDRIVER, torqueNm: null } }, { route }).ok).toBe(true);
    const torque = bus.state.connections.at(-1)?.a?.termination?.torqueNm as number;
    expect(torque).toBeGreaterThanOrEqual(4 * 0.6);
    expect(torque).toBeLessThan(4 * 1.4);
  });

  it('crimps an accessory with a die (unknown-die, wrong-accessory) and refuses a stranded conductor bare on a ferrule-only method', () => {
    const bus = wiringBench('journeyman');
    const route = [freeAt(1155, 600, 130), freeAt(1400, 600, 130)];
    const spring = {
      method: 'springCage',
      strip: { tool: STRIPPER, hole: 'h14st', lengthMm: 10 },
      accessory: null,
      clamp: { tool: null, torqueNm: null },
    };
    const add = (termination: object) =>
      bus.exec(
        'wire.add',
        autoWireArgs({ ref: STRANDED, a: { entity: 4, terminal: '1', termination }, b: null, route, lengthMm: 600 }),
      );
    expect(add(spring)).toMatchObject(refused('gauge-out-of-range'));
    expect(add({ ...spring, accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-99' } })).toMatchObject(
      refused('unknown-die'),
    );
    expect(add({ ...spring, accessory: { ref: FERRULE, tool: STRIPPER, die: 'sq-14' } })).toMatchObject(
      refused('wrong-tool'),
    );
    expect(add({ ...spring, accessory: { ref: LUG, tool: CRIMPER, die: 'sq-14' } })).toMatchObject(
      refused('wrong-accessory'),
    );
    const ferruled = { ...spring, accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-14' } };
    expect(add({ ...ferruled, clamp: { tool: SCREWDRIVER, torqueNm: null } })).toMatchObject(refused('wrong-tool'));
    expect(add({ ...spring, accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-14' } }).ok).toBe(true);
    const end = bus.state.connections.at(-1)?.a;
    expect(end?.termination).toMatchObject({
      method: 'springCage',
      torqueNm: null,
      accessory: { ref: FERRULE, crimpQuality: 1 },
    });
    expectValid(bus.state);
    // The wrong die (listed by the crimper, not by the ferrule) lands an under-crimp.
    bus.exec('edit.undo');
    expect(add({ ...spring, accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-10' } }).ok).toBe(true);
    const quality = bus.state.connections.at(-1)?.a?.termination?.accessory?.crimpQuality as number;
    expect(quality).toBeLessThan(0.5);
  });

  it('refuses a conductor outside the method range (gauge-out-of-range) and a full terminal (terminal-full)', () => {
    const bus = wiringBench();
    const route = [freeAt(1160, 600, 130), freeAt(1400, 600, 130)];
    const at2 = { entity: 4, terminal: '2', termination: 'auto' };
    const add = () => bus.exec('wire.add', autoWireArgs({ a: at2, b: null, route, lengthMm: 600 }));
    // Terminal 2 takes two conductors by screw ('auto' takes its first method), then is full.
    expect(add().ok).toBe(true);
    expect(add().ok).toBe(true);
    expect(add()).toMatchObject(refused('terminal-full'));
    // The 15 A breaker's line screw takes 14–10 AWG: a 10 AWG fits.
    const thick = bus.exec(
      'wire.add',
      autoWireArgs({
        ref: WIRE_10,
        a: null,
        b: { entity: 3, terminal: 'line', termination: 'auto' },
        route: [freeAt(1070, 700, 300)],
        lengthMm: 600,
      }),
    );
    expect(thick.ok).toBe(true);
    // A clip-only terminal takes no conductor.
    const lamp = bus.exec('entity.place', {
      ref: { id: 'lamp.lumivane-12v-5w', version: 1 },
      positionMm: at(3000, 0, 0),
    });
    expect(lamp.ok).toBe(true);
    const clip = bus.exec(
      'wire.add',
      autoWireArgs({ a: null, b: { entity: 6, terminal: 'a', termination: 'auto' }, route: [freeAt(3000, 900, 0)] }),
    );
    expect(clip).toMatchObject(refused('wrong-method'));
  });

  it('refuses every twist-on landing until the catalogue has its rated combinations (ADR 0018)', () => {
    const bus = wiringBench('journeyman');
    const twist = {
      method: 'twistOn',
      strip: { tool: STRIPPER, hole: 'h14s', lengthMm: 13 },
      accessory: null,
      clamp: { tool: null, torqueNm: null },
    };
    const add = bus.exec(
      'wire.add',
      autoWireArgs({
        a: { entity: 4, terminal: '2', termination: twist },
        b: null,
        route: [freeAt(1165, 700, 144)],
        lengthMm: 600,
      }),
    );
    expect(add).toMatchObject(refused('combination-out-of-range'));
  });

  it("refuses a gauge outside the terminal's range", () => {
    const bus = wiringBench();
    // The block's spring cage (24–12 AWG) takes no 10 AWG conductor.
    const add = bus.exec(
      'wire.add',
      autoWireArgs({
        ref: WIRE_10,
        a: { entity: 4, terminal: '1', termination: 'auto' },
        b: null,
        route: [freeAt(1155, 700, 130)],
        lengthMm: 600,
      }),
    );
    expect(add).toMatchObject(refused('gauge-out-of-range'));
  });

  it('refuses a terminal on an entity that is not at quarter-turns', () => {
    const bus = wiringBench();
    expect(
      bus.exec('entity.place', {
        ref: { id: 'utility.larkmoor-split-phase-25kva', version: 1 },
        positionMm: at(0, 0, -3000),
        orientationMdeg: { yaw: 45_000, pitch: 0, roll: 0 },
      }).ok,
    ).toBe(true);
    const add = bus.exec(
      'wire.add',
      autoWireArgs({
        b: { entity: 6, terminal: 'l1', termination: 'auto' },
        route: [freeAt(50, 500, 300)],
        lengthMm: 9000,
      }),
    );
    expect(add).toMatchObject(refused('not-axis-aligned'));
  });

  it('a bore waypoint names a tool that can bore, on a host that exists', () => {
    const bus = wiringBench();
    const bore = (tool: object, host: object) => ({ ...freeAt(50, 500, 300), kind: 'bore', tool, ...host });
    expect(bus.exec('wire.add', autoWireArgs({ route: [bore(BIT, { fixture: 'nope' })] }))).toMatchObject(
      refused('bad-waypoint'),
    );
    expect(bus.exec('wire.add', autoWireArgs({ route: [bore(CUTTER, { entity: 2 })] }))).toMatchObject(
      refused('wrong-tool'),
    );
    expect(bus.exec('wire.add', autoWireArgs({ route: [bore(WIRE, { entity: 2 })] }))).toMatchObject(
      refused('unknown-tool'),
    );
    expect(bus.exec('wire.add', autoWireArgs({ route: [bore(BIT, { entity: 2 }), L1_TO_LINE_ROUTE[1]] })).ok).toBe(
      true,
    );
    // The panel now hosts a route: it is occupied.
    expect(bus.exec('entity.move', { id: 2, positionMm: at(0, 0, 0) })).toMatchObject(refused('occupied'));
  });
});

describe('wire.land and wire.unland', () => {
  it('unland puts a rest waypoint where the terminal was; land replaces it; the waypoint count is kept', () => {
    const bus = wiringBench();
    expect(bus.exec('wire.add', autoWireArgs()).ok).toBe(true);
    const added = bus.state.connections[0];
    expect(bus.exec('wire.unland', { id: 1, end: 'b' }).ok).toBe(true);
    expect(bus.state.connections[0]).toMatchObject({ b: null, route: [...L1_TO_LINE_ROUTE, freeAt(1070, 390, 120)] });
    expectValid(bus.state);
    expect(bus.exec('wire.unland', { id: 1, end: 'b' })).toMatchObject(refused('not-landed'));
    expect(
      bus.exec('wire.land', { id: 1, end: 'a', at: { entity: 1, terminal: 'l2', termination: 'auto' } }),
    ).toMatchObject(refused('already-landed'));
    // Re-landing takes a new termination id (3): a new contact.
    expect(
      bus.exec('wire.land', { id: 1, end: 'b', at: { entity: 3, terminal: 'line', termination: 'auto' } }).ok,
    ).toBe(true);
    expect(bus.state.connections[0]).toMatchObject({ route: L1_TO_LINE_ROUTE, b: { termination: { id: 3 } } });
    expect(bus.state.nextTerminationId).toBe(4);
    // Undoing the land and the unland restores the same termination object (id 2).
    bus.exec('edit.undo');
    bus.exec('edit.undo');
    expect(bus.state.connections[0]).toStrictEqual(added);
    expect(bus.state.nextTerminationId).toBe(3);
  });

  it('a re-land must still fit the length (too-short) and join two terminals (same-terminal)', () => {
    const bus = wiringBench();
    expect(bus.exec('wire.add', autoWireArgs()).ok).toBe(true);
    bus.exec('wire.unland', { id: 1, end: 'b' });
    const land = (entity: number, terminal: string) =>
      bus.exec('wire.land', { id: 1, end: 'b', at: { entity, terminal, termination: 'auto' } });
    expect(land(1, 'l1')).toMatchObject(refused('same-terminal'));
    expect(land(5, 'ground')).toMatchObject(refused('too-short'));
  });

  it('refuses a lead (not-a-wire) and a missing id (not-found)', () => {
    const bus = wiringBench();
    bus.exec('lead.connect', { ref: LEAD, a: { entity: 1, terminal: 'l1' }, b: { entity: 1, terminal: 'n' } });
    for (const [id, args] of [
      ['wire.unland', { id: 1, end: 'a' }],
      ['wire.delete', { id: 1 }],
      ['wire.reroute', { id: 1, route: [] }],
      ['wire.label', { id: 1, text: 'W1', tool: LABELLER }],
      ['wire.land', { id: 1, end: 'a', at: { entity: 1, terminal: 'l1', termination: 'auto' } }],
    ] as const) {
      expect(bus.exec(id, args)).toMatchObject(refused('not-a-wire'));
      expect(bus.exec(id, { ...args, id: 9 })).toMatchObject(refused('not-found'));
    }
  });
});

describe('wire.delete, wire.reroute and wire.label', () => {
  it('delete removes a single conductor; undo reinserts the same id and terminations', () => {
    const bus = wiringBench();
    bus.exec('wire.add', autoWireArgs());
    const before = bus.state;
    expect(bus.exec('wire.delete', { id: 1 }).ok).toBe(true);
    expect(bus.state.connections).toHaveLength(0);
    expect(bus.state.nextConnectionId).toBe(2);
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });

  it('reroute keeps the length: a route it reaches is fine, one it does not is too-short', () => {
    const bus = wiringBench();
    bus.exec('wire.add', autoWireArgs());
    const higher = [freeAt(50, 650, 300), freeAt(1070, 650, 300)];
    expect(bus.exec('wire.reroute', { id: 1, route: higher }).ok).toBe(true);
    expect(bus.state.connections[0]).toMatchObject({ route: higher, lengthMm: 2000 });
    const far = [freeAt(50, 5000, 300), freeAt(1070, 5000, 300)];
    expect(bus.exec('wire.reroute', { id: 1, route: far })).toMatchObject(refused('too-short'));
    expect(bus.exec('wire.reroute', { id: 1, route: [{ ...higher[0], kind: 'conduit', entity: 2 }] })).toMatchObject(
      refused('needs-pull'),
    );
    expectValid(bus.state);
  });

  it('label prints and removes a sleeve marker with a tool that can label', () => {
    const bus = wiringBench();
    bus.exec('wire.add', autoWireArgs());
    expect(bus.exec('wire.label', { id: 1, text: 'L1-CB1', tool: LABELLER }).ok).toBe(true);
    expect(bus.state.connections[0].label).toBe('L1-CB1');
    expect(bus.exec('wire.label', { id: 1, text: 'X', tool: CUTTER })).toMatchObject(refused('wrong-tool'));
    expect(bus.exec('wire.label', { id: 1, text: null, tool: LABELLER }).ok).toBe(true);
    expect(bus.state.connections[0].label).toBeNull();
    expect(bus.exec('wire.label', { id: 1, text: ' padded', tool: LABELLER }).ok).toBe(false); // LabelText grammar
  });
});

describe('wire.pull', () => {
  const conduit = (x: number) => ({
    kind: 'conduit',
    positionMm: at(x, 2500, 0),
    entity: 5,
    fixture: null,
    tool: null,
  });
  const pullRoute = [freeAt(0, 2500, 0), conduit(500), conduit(1500), freeAt(2000, 2500, 0)];
  const black = { ref: WIRE, colour: { base: 'black', stripe: null } };
  const white = { ref: WIRE, colour: { base: 'white', stripe: null } };

  it('pulls conductors through conduit with free ends, one id each in order', () => {
    const bus = wiringBench();
    const before = bus.state;
    expect(
      bus.exec('wire.pull', { route: pullRoute, lengthMm: 2100, conductors: [black, white], tool: FISH_TAPE }).ok,
    ).toBe(true);
    expect(bus.state.connections.map((c) => [c.id, c.colour?.base, c.a, c.b])).toStrictEqual([
      [1, 'black', null, null],
      [2, 'white', null, null],
    ]);
    expect(bus.state.nextConnectionId).toBe(3);
    expectValid(bus.state);
    // A pulled conductor stays in its conduit; wire.add takes no conduit.
    expect(bus.exec('wire.reroute', { id: 1, route: [freeAt(0, 9, 0), freeAt(9, 9, 0)] })).toMatchObject(
      refused('needs-pull'),
    );
    expect(bus.exec('wire.add', autoWireArgs({ a: null, b: null, route: pullRoute }))).toMatchObject(
      refused('needs-pull'),
    );
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });

  it('refuses a route without conduit, an unavailable colour, a tool that cannot pull, and a short length', () => {
    const bus = wiringBench();
    const pull = (args: Record<string, unknown>) =>
      bus.exec('wire.pull', { route: pullRoute, lengthMm: 2100, conductors: [black], tool: FISH_TAPE, ...args });
    expect(pull({ route: [freeAt(0, 2500, 0), freeAt(2000, 2500, 0)] })).toMatchObject(refused('bad-waypoint'));
    expect(pull({ route: [conduit(0), freeAt(2000, 2500, 0)] })).toMatchObject(refused('bad-waypoint'));
    expect(pull({ conductors: [{ ref: WIRE, colour: { base: 'red', stripe: null } }] })).toMatchObject(
      refused('unavailable-colour'),
    );
    expect(pull({ conductors: [{ ref: LEAD, colour: { base: 'black', stripe: null } }] })).toMatchObject(
      refused('not-a-conductor'),
    );
    expect(pull({ tool: CUTTER })).toMatchObject(refused('wrong-tool'));
    expect(pull({ lengthMm: 1999 })).toMatchObject(refused('too-short'));
  });
});

describe('entity.delete with wires (ADR 0015)', () => {
  it('unlands every conductor end on the entity and removes its leads, in one change', () => {
    const bus = wiringBench();
    bus.exec('wire.add', autoWireArgs());
    bus.exec('lead.connect', { ref: LEAD, a: { entity: 1, terminal: 'l2' }, b: { entity: 1, terminal: 'n' } });
    const before = bus.state;
    expect(bus.exec('entity.delete', { id: 1 }).ok).toBe(true);
    expect(bus.state.connections).toHaveLength(1);
    expect(bus.state.connections[0]).toMatchObject({ a: null, route: [freeAt(50, 250, 200), ...L1_TO_LINE_ROUTE] });
    expectValid(bus.state);
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });
});
