import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { KEY_PLATFORM, KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { NotificationService } from '@controls/feature-shell';
import type {
  RoutingEvent,
  RoutingEventListener,
  RoutingSession,
  TerminalRef,
  ViewportState,
} from '@controls/renderer';
import type { Difficulty } from '@controls/save-format';
import { routeDefaultLengthMm, snapWaypoint, type TerminationArgs, type Waypoint } from '@controls/world-model';
import { BENCH_STUD_WALL } from '@controls/world-model/testing';
import { createAnnouncer } from './announcer';
import { type CableFlow, connectCableRouting } from './cable-flow';
import { connectRouting, type RoutingFlow, type RoutingRenderer } from './routing-flow';
import { draftOf } from './termination-model';
import { connectWiring, type WiringFlow } from './wiring-flow';

/*
 * F3.2 part 4: the cable gesture, the strip prompt, landing and labels, wired as the viewport wires
 * them (one announcer; the routing flow pushes whichever mode is in force), against a fake renderer
 * that records the sessions and sends picks. The world is `cableRunBus`'s (a 2-gang box at the
 * origin, its top clamp open at (28, 92, 40); a DIN panel above with `ko-bottom-2` open at
 * (100, 500, 40); two feed-through blocks and a ground block on its lower rail), built with commands.
 */

const NMB = { id: 'cable.sorrelby-nmb-14-2', version: 1 };
const ref = (id: string) => ({ id, version: 1 });
const BOX_CLAMP = { x: 28, y: 92, z: 40 };
const PANEL_KO = { x: 100, y: 500, z: 40 };

class FakeRenderer implements RoutingRenderer {
  readonly sessions: (RoutingSession | null)[] = [];
  private readonly listeners = new Set<RoutingEventListener>();
  keyTerminal: TerminalRef | null = null;
  readonly wireSelections: unknown[] = [];
  selectWire(wire: unknown): boolean {
    this.wireSelections.push(wire);
    return true;
  }
  setRouting(session: RoutingSession | null): void {
    if (this.sessions.at(-1) !== session) this.sessions.push(session);
  }
  onRouting(listener: RoutingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cycleTerminal(): TerminalRef | null {
    return this.keyTerminal;
  }
  terminalCycleOrder(entity: number): readonly string[] {
    return entity >= 3 && entity <= 5 ? ['a', 'b'] : [];
  }
  send(event: RoutingEvent): void {
    [...this.listeners].forEach((l) => l(event));
  }
  get current(): RoutingSession | null {
    return this.sessions.at(-1) ?? null;
  }
}

const STATE: ViewportState = {
  mode: 'work',
  pointerLocked: false,
  focusId: 'backplate',
  hovered: null,
  selected: null,
  placement: null,
  terminal: null,
  keyTerminal: null,
  routing: null,
  hoveredWire: null,
  selectedWire: null,
};

interface Setup {
  routing: RoutingFlow;
  cable: CableFlow;
  wiring: WiringFlow;
  renderer: FakeRenderer;
  session: Session;
  state: ReturnType<typeof signal<ViewportState | undefined>>;
  toasts: string[];
}

/** The cable-run world at `difficulty`, the NM-B spool in slot 5, and the flows connected. */
function setup(difficulty: Difficulty = 'trainee', options: { studWall?: boolean } = {}): Setup {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 3, difficulty });
  if (options.studWall) session.start({ ...session.world(), fixtures: [...session.world().fixtures, BENCH_STUD_WALL] });
  const screwdriver = ref('tool.veltmark-sd-2');
  const block = (id: string, x: number) => ({
    ref: ref(id),
    positionMm: { x, y: 651, z: -38 },
    mountedOn: { entity: 2, mount: 'rail-2' },
  });
  const steps: [string, Record<string, unknown>][] = [
    ['entity.place', { ref: ref('box.tinmoor-2g-nm'), positionMm: { x: 0, y: 0, z: 0 } }],
    ['enclosure.openEntry', { id: 1, entry: 'clamp-top-1', tool: screwdriver }],
    ['entity.place', { ref: ref('panel.pellmoor-din-400x500'), positionMm: { x: -100, y: 500, z: -60 } }],
    ['enclosure.openEntry', { id: 2, entry: 'ko-bottom-2', tool: screwdriver }],
    ['entity.place', block('tb.quennick-st4', 97)],
    ['entity.place', block('tb.quennick-st4', 103)],
    ['entity.place', block('tb.quennick-pe4', 109)],
  ];
  for (const [id, args] of steps) expect(session.exec(id, args)).toMatchObject({ ok: true });
  const store = TestBed.inject(SettingsStore);
  const slots = [...store.settings().toolBelt.slots];
  slots[4] = NMB;
  store.update('toolBelt', { slots });
  TestBed.inject(KeybindingService);
  const toasts: string[] = [];
  const notifications = TestBed.inject(NotificationService);
  const notify = notifications.notify.bind(notifications);
  vi.spyOn(notifications, 'notify').mockImplementation((message, opts) => {
    toasts.push(message);
    return notify(message, opts);
  });
  const renderer = new FakeRenderer();
  const state = signal<ViewportState | undefined>(STATE);
  const { routing, cable, wiring } = TestBed.runInInjectionContext(() => {
    const announcer = createAnnouncer();
    const wiring = connectWiring(renderer, state, announcer);
    const cable = connectCableRouting(renderer, state, announcer, (id) => wiring.openStrip(id));
    const routing = connectRouting(renderer, state, announcer, [cable, wiring]);
    return { routing, cable, wiring };
  });
  return { routing, cable, wiring, renderer, session, state, toasts };
}

const free = (x: number, y: number, z: number): Waypoint => ({
  kind: 'free',
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});
const logged = (session: Session, id: string) => session.entries().filter((e) => e.id === id);
const near = (p: { x: number; y: number; z: number }) => ({ x: p.x + 3, y: p.y - 2, z: p.z });

describe('the cable gesture (F3.2 part 4)', () => {
  it('a cable spool arms entries mode; two entries and the waypoints between log exactly one cable.add', () => {
    const { routing, cable, renderer, session } = setup();
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    expect(renderer.current).toMatchObject({ ref: NMB, ends: 'entries', from: null, startMm: null, waypoints: [] });
    expect(renderer.current?.snap?.kinds).toStrictEqual(['duct', 'conduit', 'staple']); // no drill bit: no bores
    expect(routing.phase()).toBe('armed');
    expect(session.contextKeys()['routing.active']).toBe(true);
    expect(routing.hint()).toMatch(/^NM-B 14\/2 .*: click an open entry on a box or panel/);

    // A click on the box picks its nearest open entry (the top clamp).
    renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
    TestBed.tick();
    expect(cable.gesture().a).toMatchObject({ entity: 1, entry: 'clamp-top-1', positionMm: BOX_CLAMP });
    expect(renderer.current?.startMm).toStrictEqual(BOX_CLAMP);
    expect(routing.announcement()).toBe(
      'From 2-gang nonmetallic new-work device box #1, entry clamp-top-1. Add staples, then pick the far entry.',
    );
    expect(session.contextKeys()['routing.started']).toBe(true);

    const route = [free(28, 250, 40), free(100, 350, 40)];
    for (const waypoint of route) renderer.send({ kind: 'waypoint', waypoint });
    TestBed.tick();
    expect(renderer.current?.waypoints).toStrictEqual(route);
    expect(routing.announcement()).toBe('Waypoint 2 added (free waypoint).');
    expect(logged(session, 'cable.add')).toHaveLength(0);

    renderer.send({ kind: 'entity', entity: 2, atMm: near(PANEL_KO), waypoint: null });
    TestBed.tick();
    const tailsMm = { a: 200, b: 200 };
    const lengthMm = routeDefaultLengthMm([BOX_CLAMP, ...route.map((w) => w.positionMm), PANEL_KO], undefined, tailsMm);
    expect(logged(session, 'cable.add').map((e) => e.args)).toStrictEqual([
      {
        ref: NMB,
        a: { entity: 1, entry: 'clamp-top-1' },
        b: { entity: 2, entry: 'ko-bottom-2' },
        route,
        lengthMm,
        tailsMm,
        tool: ref('tool.veltmark-dc-8'),
      },
    ]);
    expect(session.world().cables).toHaveLength(1);
    expect(routing.announcement()).toMatch(/^Strip cable 1/); // the strip prompt opened after the add
    expect(cable.gesture()).toStrictEqual({ a: null, waypoints: [] }); // the spool stays armed
    expect(routing.phase()).toBe('armed');
  });

  it('refusals are shown and nothing is logged: a closed entry, the first entry again, staple spacing', () => {
    const { routing, cable, renderer, session, toasts } = setup('trainee', { studWall: true });
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    // The box's other clamps are closed: a click near one still picks the open top clamp.
    renderer.send({ kind: 'entity', entity: 1, atMm: { x: 28, y: -10, z: 40 }, waypoint: null });
    TestBed.tick();
    expect(cable.gesture().a?.entry).toBe('clamp-top-1');
    renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
    TestBed.tick();
    expect(toasts.at(-1)).toBe('Add a cable: That is the first entry: pick another');
    expect(routing.announcement()).toBe('Refused: That is the first entry: pick another (same-entry).');

    // A staple on the stud wall far from the box: the support rule shows in the hint, then refuses.
    const wall = BENCH_STUD_WALL.transform.positionMm;
    const staple = snapWaypoint(
      session.world(),
      BUILTIN_CATALOG,
      { x: wall.x + 400, y: 600, z: wall.z - 40 },
      {
        kinds: ['staple'],
      },
    );
    expect(staple.kind).toBe('staple');
    renderer.send({ kind: 'waypoint', waypoint: staple });
    TestBed.tick();
    expect(routing.hint()).toMatch(/The first staple \(waypoint 1\) is \d+ mm from the box at end a; NM cable is/);
    renderer.send({ kind: 'entity', entity: 2, atMm: near(PANEL_KO), waypoint: null });
    TestBed.tick();
    expect(routing.announcement()).toMatch(/^Refused: The first staple .* \(staple-spacing\)\.$/);
    expect(logged(session, 'cable.add')).toHaveLength(0);
    expect(cable.gesture().waypoints).toHaveLength(1); // the picks are kept

    // A closed enclosure entry is refused with its reason.
    session.exec('routing.cancel');
    session.exec('entity.place', { ref: ref('box.tinmoor-2g-nm'), positionMm: { x: 300, y: 0, z: 0 } });
    renderer.send({ kind: 'entity', entity: 6, atMm: { x: 328, y: 92, z: 40 }, waypoint: null });
    TestBed.tick();
    expect(routing.announcement()).toMatch(/\(entry-closed\)\.$/);
    expect(cable.gesture().a).toBeNull();
  });

  it('keyboard: Tab cycles the selected box’s entries, Enter picks one; Backspace and Escape step back', () => {
    const { routing, cable, renderer, session, state } = setup();
    const keys = TestBed.inject(KeybindingService);
    session.exec('toolbelt.select', { slot: 5 });
    session.setContext('viewport.focused', true);
    state.set({
      ...STATE,
      selected: { id: 'entity-1', kind: 'device', label: 'box', entityId: 1 },
    });
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBe(1);
    expect(keys.keymap().resolve('Tab', session.contextKeys())?.id).toBe('routing.terminalNext');
    session.exec('routing.terminalNext');
    TestBed.tick();
    expect(cable.keyEntry()?.entry).toBe(BUILTIN_CATALOG.device(ref('box.tinmoor-2g-nm'))?.enclosure?.entries[0].id);
    // Cycle to the open top clamp, then Enter.
    for (let i = 0; i < 8 && cable.keyEntry()?.entry !== 'clamp-top-1'; i++) session.exec('routing.terminalNext');
    TestBed.tick();
    expect(cable.keyEntry()?.entry).toBe('clamp-top-1');
    expect(renderer.current?.keyPointMm).toStrictEqual(BOX_CLAMP);
    expect(routing.announcement()).toBe(
      'Entry: 2-gang nonmetallic new-work device box #1, entry clamp-top-1. Enter picks it.',
    );
    renderer.send({ kind: 'enter' });
    TestBed.tick();
    expect(cable.gesture().a?.entry).toBe('clamp-top-1');
    expect(renderer.current?.keyPointMm).toBeNull();

    renderer.send({ kind: 'waypoint', waypoint: free(28, 250, 40) });
    session.exec('routing.back');
    TestBed.tick();
    expect(routing.announcement()).toBe('Waypoint removed; 0 left.');
    session.exec('routing.back');
    TestBed.tick();
    expect(cable.gesture().a).toBeNull();
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(TestBed.inject(ToolBelt).activeSlot()).toBeNull();
    expect(routing.announcement()).toBe('Cable spool put away.');
    expect(renderer.current).toBeNull();
  });
});

/** Adds the cable with the gesture and returns the flows. */
function withCable(difficulty: Difficulty): Setup {
  const s = setup(difficulty);
  s.session.exec('toolbelt.select', { slot: 5 });
  TestBed.tick();
  s.renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
  s.renderer.send({ kind: 'waypoint', waypoint: free(28, 250, 40) });
  s.renderer.send({ kind: 'waypoint', waypoint: free(100, 350, 40) });
  s.renderer.send({ kind: 'entity', entity: 2, atMm: near(PANEL_KO), waypoint: null });
  TestBed.tick();
  expect(logged(s.session, 'cable.add')).toHaveLength(1);
  return s;
}

describe('the strip prompt (F3.2 part 4)', () => {
  it('opens after cable.add, prefilled at Trainee with the most a box allows; Strip logs one cable.strip per end', () => {
    const { wiring, session } = withCable('trainee');
    const prompt = wiring.strip();
    expect(prompt?.request).toMatchObject({
      cableId: 1,
      ends: [
        { end: 'a', tailMm: 200, strippedMm: 0, maxMm: 193 },
        { end: 'b', tailMm: 200, strippedMm: 0, maxMm: 193 },
      ],
      draft: { tool: 'tool.veltmark-ws-nm12@1', a: '193', b: '193' },
    });
    // Beyond the tail less the sheath: refused in the prompt, nothing logged.
    wiring.confirmStrip([{ id: 1, end: 'a', jacketMm: 195, tool: ref('tool.veltmark-ws-nm12') }]);
    expect(wiring.strip()?.refusal).toMatch(
      /^end a: At least 6.35 mm of jacket stays inside the box .*\(strip-too-long\)$/,
    );
    expect(logged(session, 'cable.strip')).toHaveLength(0);
    wiring.confirmStrip([
      { id: 1, end: 'a', jacketMm: 150, tool: ref('tool.veltmark-ws-nm12') },
      { id: 1, end: 'b', jacketMm: 180, tool: ref('tool.veltmark-ws-nm12') },
    ]);
    expect(wiring.strip()).toBeNull();
    expect(logged(session, 'cable.strip').map((e) => e.args)).toStrictEqual([
      { id: 1, end: 'a', jacketMm: 150, tool: ref('tool.veltmark-ws-nm12') },
      { id: 1, end: 'b', jacketMm: 180, tool: ref('tool.veltmark-ws-nm12') },
    ]);
    expect(session.world().cables[0].jacketStripMm).toStrictEqual({ a: 150, b: 180 });
  });

  it('starts blank at Journeyman; J (wiring.strip) reopens it for a selected conductor’s cable', () => {
    const { wiring, session, state } = withCable('journeyman');
    expect(wiring.strip()?.request.draft).toStrictEqual({ tool: 'tool.veltmark-ws-nm12@1', a: '', b: '' });
    wiring.cancelStrip();
    expect(wiring.strip()).toBeNull();
    const keys = TestBed.inject(KeybindingService);
    session.setContext('viewport.focused', true);
    state.set({ ...STATE, selectedWire: { kind: 'connection', id: 2 } });
    TestBed.tick();
    expect(session.contextKeys()).toMatchObject({ 'selection.connectionId': 2, 'wiring.stripTarget': 1 });
    const binding = keys.keymap().resolve('J', session.contextKeys());
    expect(binding?.id).toBe('wiring.strip.selection');
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true }));
    expect(wiring.strip()?.request.cableId).toBe(1);
  });
});

describe('landing tails (F3.2 part 4)', () => {
  const stripBoth = (session: Session) => {
    for (const end of ['a', 'b'] as const) {
      session.exec('cable.strip', { id: 1, end, jacketMm: 180, tool: ref('tool.veltmark-ws-nm12') });
    }
  };

  it('at Trainee, L then a terminal lands each conductor with one wire.add-free wire.land, then the next', () => {
    const { routing, wiring, renderer, session } = withCable('trainee');
    wiring.cancelStrip();
    stripBoth(session);
    session.exec('wiring.land', { id: 1 });
    TestBed.tick();
    expect(TestBed.inject(ToolBelt).activeSlot()).toBeNull(); // the spool is put away
    expect(renderer.current).toMatchObject({ ref: ref('conductor.sorrelby-nm-14-solid'), from: null });
    expect(renderer.current?.ends).toBeUndefined();
    expect(routing.hint()).toMatch(
      /^Landing the black conductor 1 of cable 1 \(wire 1\), end a or b: click a terminal/,
    );
    for (const [wire, block] of [
      [1, 3],
      [2, 4],
      [3, 5],
    ]) {
      expect(wiring.landing()).toBe(wire);
      renderer.send({ kind: 'terminal', end: { entity: block, terminal: 'b' }, source: 'pointer', proposal: null });
      TestBed.tick();
    }
    expect(logged(session, 'wire.land').map((e) => e.args)).toStrictEqual(
      [1, 2, 3].map((id) => ({
        id,
        end: 'b',
        at: { entity: id + 2, terminal: 'b', termination: 'auto' },
      })),
    );
    expect(wiring.landing()).toBeNull();
    expect(routing.announcement()).toMatch(/Every conductor of cable 1 is landed at end b\.$/);
    expect(renderer.current).toBeNull();
  });

  it('an unstripped tail is refused (tail-too-short); Escape stops landing', () => {
    const { routing, wiring, renderer, session, toasts } = withCable('trainee');
    wiring.cancelStrip();
    session.exec('wiring.land', { id: 1 });
    renderer.send({ kind: 'terminal', end: { entity: 3, terminal: 'b' }, source: 'pointer', proposal: null });
    TestBed.tick();
    expect(toasts.at(-1)).toMatch(/^Land a conductor: The jacket at end a of cable 1 isn't stripped/);
    expect(routing.announcement()).toMatch(/\(tail-too-short\)\.$/);
    expect(logged(session, 'wire.land')).toHaveLength(0);
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(wiring.landing()).toBeNull();
    expect(routing.announcement()).toBe('Landing stopped.');
  });

  it('at Journeyman each pick opens the termination prompt; its refusal shows there; Land logs one wire.land', () => {
    const { wiring, renderer, session } = withCable('journeyman');
    wiring.cancelStrip();
    stripBoth(session);
    session.exec('wiring.land', { id: 1 });
    renderer.send({ kind: 'terminal', end: { entity: 3, terminal: 'b' }, source: 'pointer', proposal: null });
    TestBed.tick();
    const request = wiring.prompt()?.request;
    expect(request).toMatchObject({ end: 'b', mode: 'blank', conductorSize: '14 AWG solid' });
    const termination: TerminationArgs = {
      method: 'screw',
      strip: { tool: ref('tool.veltmark-ws-nm12'), hole: 'sol14', lengthMm: 9 },
      accessory: null,
      clamp: { tool: ref('tool.calderyn-ts-03'), torqueNm: 3 },
    };
    expect(draftOf(termination).torqueNm).toBe('3');
    wiring.confirmTermination(termination);
    expect(wiring.prompt()?.refusal).toMatch(/\(beyond-tool-capacity\)$/);
    expect(logged(session, 'wire.land')).toHaveLength(0);
    const ok = { ...termination, clamp: { ...termination.clamp, torqueNm: 0.6 } };
    wiring.confirmTermination(ok);
    expect(wiring.prompt()).toBeNull();
    expect(logged(session, 'wire.land').map((e) => e.args)).toStrictEqual([
      { id: 1, end: 'b', at: { entity: 3, terminal: 'b', termination: ok } },
    ]);
    expect(wiring.landing()).toBe(2);
  });
});

describe('labels (F3.2 part 4)', () => {
  it('wiring.label opens the prompt for a wire; Print logs one wire.label with the label maker', () => {
    const { routing, wiring, session } = withCable('trainee');
    wiring.cancelStrip();
    session.exec('wiring.label', { wire: 1 });
    const request = wiring.label()?.request;
    expect(request).toMatchObject({
      target: { kind: 'connection', id: 1 },
      title: 'Wire 1, the black conductor of cable 1',
      current: null,
      draft: { tool: 'tool.penmarrow-lp-12@1', text: '' },
    });
    wiring.confirmLabel({
      ok: true,
      id: 'wire.label',
      args: { id: 1, text: ' bad', tool: ref('tool.penmarrow-lp-12') },
    });
    expect(wiring.label()?.refusal).toMatch(/\(bad-args\)$/);
    wiring.confirmLabel({ ok: true, id: 'wire.label', args: { id: 1, text: 'L1', tool: ref('tool.penmarrow-lp-12') } });
    expect(wiring.label()).toBeNull();
    expect(logged(session, 'wire.label').map((e) => e.args)).toStrictEqual([
      { id: 1, text: 'L1', tool: ref('tool.penmarrow-lp-12') },
    ]);
    expect(routing.announcement()).toBe('Wire 1, the black conductor of cable 1 labelled “L1”.');
  });

  it('with the label maker in hand, selecting a cable opens its prompt (cable.label)', () => {
    const { wiring, session, state } = withCable('trainee');
    wiring.cancelStrip();
    const store = TestBed.inject(SettingsStore);
    const slots = [...store.settings().toolBelt.slots];
    slots[6] = ref('tool.penmarrow-lp-12');
    store.update('toolBelt', { slots });
    session.exec('toolbelt.select', { slot: 7 });
    TestBed.tick();
    state.set({ ...STATE, selectedWire: { kind: 'cable', id: 1 } });
    TestBed.tick();
    expect(wiring.label()?.request).toMatchObject({ target: { kind: 'cable', id: 1 } });
    expect(wiring.label()?.request.makers[0].label).toBe('Label printer, 12 mm tape (belt slot 7)');
  });
});

const SCREWDRIVER = ref('tool.veltmark-sd-2');
const BOX_SELECTED = (): ViewportState => ({
  ...STATE,
  selected: { id: 'entity-1', kind: 'device', label: 'box', entityId: 1 },
});

describe('review fixes (F3.2 part 4, test-engineer)', () => {
  it('Enter re-checks the keyboard’s entry: one closed by an undo since Tab is refused (entry-closed)', () => {
    const { routing, cable, renderer, session, state } = setup();
    expect(session.exec('enclosure.openEntry', { id: 1, entry: 'clamp-top-2', tool: SCREWDRIVER }).ok).toBe(true);
    session.exec('toolbelt.select', { slot: 5 });
    state.set(BOX_SELECTED());
    TestBed.tick();
    for (let i = 0; i < 8 && cable.keyEntry()?.entry !== 'clamp-top-2'; i++) session.exec('routing.terminalNext');
    expect(cable.keyEntry()).toMatchObject({ entry: 'clamp-top-2', problem: null });
    session.exec('edit.undo');
    TestBed.tick();
    expect(cable.keyEntry()).toMatchObject({ entry: 'clamp-top-2', problem: { code: 'entry-closed' } });
    renderer.send({ kind: 'enter' });
    TestBed.tick();
    expect(routing.announcement()).toMatch(/\(entry-closed\)\.$/);
    expect(cable.gesture().a).toBeNull();
    // Another enclosure in hand (here none) drops the keyboard's entry.
    state.set(STATE);
    TestBed.tick();
    expect(cable.keyEntry()).toBeNull();
  });

  it('a first entry closed by undo, or whose box is deleted, starts the run over, announced', () => {
    const { routing, cable, renderer, session } = setup();
    expect(session.exec('enclosure.openEntry', { id: 1, entry: 'clamp-top-2', tool: SCREWDRIVER }).ok).toBe(true);
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    renderer.send({ kind: 'entity', entity: 1, atMm: { x: 74, y: 92, z: 40 }, waypoint: null });
    TestBed.tick();
    expect(cable.gesture().a?.entry).toBe('clamp-top-2');
    session.exec('edit.undo');
    TestBed.tick();
    expect(cable.gesture()).toStrictEqual({ a: null, waypoints: [] });
    expect(routing.announcement()).toBe('The first entry is no longer usable (entry-closed). Pick the first entry.');
    renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
    TestBed.tick();
    expect(cable.gesture().a?.entry).toBe('clamp-top-1');
    expect(session.exec('entity.delete', { id: 1 }).ok).toBe(true);
    TestBed.tick();
    expect(cable.gesture()).toStrictEqual({ a: null, waypoints: [] });
    expect(routing.announcement()).toBe('The first entry is no longer usable (not-found). Pick the first entry.');
  });

  it('Escape after the first entry cancels the run with the spool kept; another slot drops the gesture', () => {
    const { routing, cable, renderer, session } = setup();
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(routing.announcement()).toBe('Cable run cancelled.');
    expect(TestBed.inject(ToolBelt).activeSlot()).toBe(5);
    expect(renderer.current).toMatchObject({ ends: 'entries', startMm: null });
    renderer.send({ kind: 'entity', entity: 1, atMm: near(BOX_CLAMP), waypoint: null });
    session.exec('toolbelt.select', { slot: 9 }); // an empty slot
    TestBed.tick();
    expect(renderer.current).toBeNull();
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    expect(cable.gesture()).toStrictEqual({ a: null, waypoints: [] });
  });

  it('with the spool still armed, a second run logs a second cable.add', () => {
    const { wiring, renderer, session } = withCable('trainee');
    wiring.cancelStrip();
    expect(session.exec('enclosure.openEntry', { id: 1, entry: 'clamp-top-2', tool: SCREWDRIVER }).ok).toBe(true);
    expect(session.exec('enclosure.openEntry', { id: 2, entry: 'ko-bottom-1', tool: SCREWDRIVER }).ok).toBe(true);
    renderer.send({ kind: 'entity', entity: 1, atMm: { x: 74, y: 92, z: 40 }, waypoint: null });
    renderer.send({ kind: 'waypoint', waypoint: free(74, 250, 40) });
    renderer.send({ kind: 'entity', entity: 2, atMm: { x: 0, y: 500, z: 40 }, waypoint: null });
    TestBed.tick();
    expect(logged(session, 'cable.add').map((e) => [e.args['a'], e.args['b']])).toStrictEqual([
      [
        { entity: 1, entry: 'clamp-top-1' },
        { entity: 2, entry: 'ko-bottom-2' },
      ],
      [
        { entity: 1, entry: 'clamp-top-2' },
        { entity: 2, entry: 'ko-bottom-1' },
      ],
    ]);
    expect(wiring.strip()?.request.cableId).toBe(2);
  });

  it('Escape mid-landing logs exactly the landings made; undo or redo during landing stops it', () => {
    const { wiring, renderer, session } = withCable('trainee');
    wiring.cancelStrip();
    session.exec('cable.strip', { id: 1, end: 'b', jacketMm: 180, tool: ref('tool.veltmark-ws-nm12') });
    session.exec('wiring.land', { id: 1 });
    renderer.send({ kind: 'terminal', end: { entity: 3, terminal: 'b' }, source: 'pointer', proposal: null });
    TestBed.tick();
    expect(wiring.landing()).toBe(2);
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(logged(session, 'wire.land')).toHaveLength(1);
    expect(wiring.landing()).toBeNull();
    // Landing again, then an undo (the first landing comes off): landing stops rather than resuming later.
    session.exec('wiring.land', { id: 2 });
    TestBed.tick();
    expect(wiring.landing()).toBe(2);
    session.exec('edit.undo');
    TestBed.tick();
    expect(wiring.landing()).toBeNull();
    session.exec('wiring.land', { id: 2 });
    session.exec('edit.redo');
    TestBed.tick();
    expect(wiring.landing()).toBeNull();
  });

  it('labels: clearing logs wire.label {text: null}; wire and cable together are refused; the label maker reopens on the same wire after Cancel', () => {
    const { routing, wiring, renderer, session, state, toasts } = withCable('trainee');
    wiring.cancelStrip();
    const printer = ref('tool.penmarrow-lp-12');
    expect(session.exec('wire.label', { id: 1, text: 'L1', tool: printer }).ok).toBe(true);
    session.exec('wiring.label', { wire: 1 });
    expect(wiring.label()?.request.current).toBe('L1');
    wiring.confirmLabel({ ok: true, id: 'wire.label', args: { id: 1, text: null, tool: printer } });
    expect(logged(session, 'wire.label').filter((e) => e.args['text'] === null)).toHaveLength(1);
    expect(routing.announcement()).toBe('Wire 1, the black conductor of cable 1: label removed.');

    session.exec('wiring.label', { wire: 1, cable: 1 });
    expect(wiring.label()).toBeNull();
    expect(toasts.at(-1)).toBe('Label: Label a wire or a cable, not both at once');

    const store = TestBed.inject(SettingsStore);
    const slots = [...store.settings().toolBelt.slots];
    slots[6] = printer;
    store.update('toolBelt', { slots });
    session.exec('toolbelt.select', { slot: 7 });
    state.set({ ...STATE, selectedWire: { kind: 'connection', id: 2 } });
    TestBed.tick();
    expect(wiring.label()?.request.target).toStrictEqual({ kind: 'connection', id: 2 });
    wiring.cancelLabel();
    expect(renderer.wireSelections.at(-1)).toBeNull(); // the selection is cleared…
    state.set(STATE);
    TestBed.tick();
    state.set({ ...STATE, selectedWire: { kind: 'connection', id: 2 } });
    TestBed.tick();
    expect(wiring.label()?.request.target).toStrictEqual({ kind: 'connection', id: 2 }); // …so a click reopens it
  });

  it('the selected wire’s keys are published as soon as the viewport hands over its state (no tick needed)', () => {
    const { wiring, session } = withCable('trainee');
    wiring.publishSelection({ ...STATE, selectedWire: { kind: 'connection', id: 3 } });
    expect(session.contextKeys()).toMatchObject({ 'selection.connectionId': 3, 'wiring.stripTarget': 1 });
    const keys = TestBed.inject(KeybindingService);
    expect(keys.keymap().resolve('L', { ...session.contextKeys(), 'viewport.focused': true })?.id).toBe(
      'wiring.land.selection',
    );
  });
});
