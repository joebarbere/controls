import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KEY_PLATFORM, KeybindingService, Session } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { NotificationService } from '@controls/feature-shell';
import type {
  RoutingEvent,
  RoutingEventListener,
  RoutingSession,
  TerminalRef,
  ViewportState,
} from '@controls/renderer';
import type { CatalogRef, Difficulty } from '@controls/save-format';
import { createAnnouncer } from './announcer';
import { connectCableRouting } from './cable-flow';
import { pullArgs } from './pull-model';
import { FISH_TAPE, PULL_RUN_STEPS, THHN_12 } from './pull-world.fakes';
import { connectRouting, type RoutingFlow, type RoutingRenderer } from './routing-flow';
import { connectToolFlow, type ToolFlow } from './tool-flow';
import { connectWiring } from './wiring-flow';

/*
 * F3.4 part 2: tools in hand, wired as the viewport wires them (one announcer; the routing flow pushes
 * whichever mode is in force) against a fake renderer. The world is `pull-world.fakes`' conduit run:
 * the panel (entity 1) with `drill-top-1` cut, connector 2, stick 3, elbow 4, stick 5.
 */

const ref = (id: string): CatalogRef => ({ id, version: 1 });
const THHN = `${THHN_12.id}@1`;

class FakeRenderer implements RoutingRenderer {
  readonly sessions: (RoutingSession | null)[] = [];
  private readonly listeners = new Set<RoutingEventListener>();
  setRouting(session: RoutingSession | null): void {
    if (this.sessions.at(-1) !== session) this.sessions.push(session);
  }
  onRouting(listener: RoutingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cycleTerminal(): TerminalRef | null {
    return null;
  }
  terminalCycleOrder(): readonly string[] {
    return [];
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
const selecting = (entityId: number): ViewportState => ({
  ...STATE,
  selected: { id: `entity-${entityId}`, kind: 'device', label: `#${entityId}`, entityId },
});

interface Setup {
  tools: ToolFlow;
  routing: RoutingFlow;
  renderer: FakeRenderer;
  session: Session;
  state: ReturnType<typeof signal<ViewportState | undefined>>;
  toasts: string[];
}

/** The conduit run at `difficulty`, `belt` in slots 1…, and the flows connected. */
function setup(difficulty: Difficulty = 'journeyman', belt: readonly CatalogRef[] = []): Setup {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 3, difficulty });
  for (const [id, args] of PULL_RUN_STEPS) expect(session.exec(id, args)).toMatchObject({ ok: true });
  const store = TestBed.inject(SettingsStore);
  const slots = [...store.settings().toolBelt.slots];
  belt.forEach((r, i) => (slots[i] = r));
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
  const { tools, routing } = TestBed.runInInjectionContext(() => {
    const announcer = createAnnouncer();
    const wiring = connectWiring(renderer, state, announcer);
    const cable = connectCableRouting(renderer, state, announcer);
    const tools = connectToolFlow(renderer, state, announcer);
    const routing = connectRouting(renderer, state, announcer, [cable, wiring, tools]);
    return { tools, routing };
  });
  TestBed.tick();
  return { tools, routing, renderer, session, state, toasts };
}

const logged = (session: Session, id: string) => session.entries().filter((e) => e.id === id);
const blackAndWhite = (tools: ToolFlow) => {
  const p = tools.pull();
  if (!p) throw new Error('no pull prompt');
  const built = pullArgs(p.request, [
    { conductor: THHN, colour: 'black' },
    { conductor: THHN, colour: 'white' },
  ]);
  if (!built.ok) throw new Error(built.message);
  return built.args;
};

describe('the fish tape flow (F3.4 part 2)', () => {
  it('wiring.pull opens the prompt with the default tape; a success logs exactly one wire.pull', () => {
    const { tools, routing, session } = setup();
    expect(session.contextKeys()['wiring.conduits']).toBe(true);
    session.exec('wiring.pull', { conduit: 3 });
    const p = tools.pull();
    expect(p?.request.run.parts).toStrictEqual([2, 3, 4, 5]);
    expect(p?.request.toolRef).toStrictEqual(FISH_TAPE);
    expect(p?.request.toolSource).toBe('Steel fish tape, 1/8 in x 50 ft (not on the belt)');
    expect(routing.announcement()).toBe('Fish tape: 3/4 in conduit run of 4 parts (connector #2 to stick #5).');
    const args = blackAndWhite(tools);
    expect(tools.checkPull(args)).toBeNull();
    tools.confirmPull(args);
    expect(tools.pull()).toBeNull();
    expect(logged(session, 'wire.pull').map((e) => e.args)).toStrictEqual([args]);
    expect(session.world().connections.map((c) => [c.id, c.a, c.b])).toStrictEqual([
      [1, null, null],
      [2, null, null],
    ]);
    expect(routing.announcement()).toBe(
      'Pulled 2 conductors through the 3/4 in conduit run of 4 parts (connector #2 to stick #5): wires 1–2, both ends free.',
    );
  });

  it('cancel logs nothing; a command refusal at the end stays in the prompt and logs nothing', () => {
    const { tools, routing, session } = setup();
    const before = session.entries().length;
    session.exec('wiring.pull', { conduit: 2 });
    tools.cancelPull();
    expect(tools.pull()).toBeNull();
    expect(routing.announcement()).toBe('Nothing pulled.');
    session.exec('wiring.pull', { conduit: 2 });
    const args = blackAndWhite(tools);
    // The run changes under the prompt (the console deletes the far stick): the route's host is gone.
    session.exec('entity.delete', { id: 5 });
    tools.confirmPull(args);
    expect(tools.pull()?.refusal).toMatch(/\((not-found|bad-waypoint)\)$/);
    expect(logged(session, 'wire.pull')).toHaveLength(0);
    expect(session.entries().length).toBe(before + 1); // the delete only (view commands aren't logged)
  });

  it('a run the tape cannot reach, or a part that isn’t conduit, is refused before any prompt opens', () => {
    const { tools, session, toasts } = setup();
    session.exec('wiring.pull', { conduit: 1 }); // the panel: connector 2 is in its drill site
    expect(tools.pull()?.request.run.parts).toStrictEqual([2, 3, 4, 5]);
    tools.cancelPull();
    session.exec('entity.place', { ref: ref('box.tinmoor-2g-nm'), positionMm: { x: 0, y: 0, z: 0 } });
    session.exec('wiring.pull', { conduit: 6 });
    expect(tools.pull()).toBeNull();
    expect(toasts.at(-1)).toMatch(/^Pull through conduit: Entity 6 isn't conduit/);
  });

  it('the fish tape in hand arms entries mode: a click on conduit, or Enter on the selection, opens the prompt', () => {
    const { tools, routing, renderer, session, state } = setup('journeyman', [FISH_TAPE]);
    session.exec('toolbelt.select', { slot: 1 });
    TestBed.tick();
    expect(renderer.current).toMatchObject({ ref: FISH_TAPE, ends: 'entries', startMm: null });
    expect(routing.phase()).toBe('armed');
    expect(routing.hint()).toMatch(/^Steel fish tape, 1\/8 in x 50 ft: click a conduit run/);
    renderer.send({ kind: 'entity', entity: 4, atMm: { x: -800, y: 2000, z: 79 }, waypoint: null });
    expect(tools.pull()?.request.toolSource).toBe('Steel fish tape, 1/8 in x 50 ft (belt slot 1)');
    tools.cancelPull();
    state.set(selecting(3));
    tools.publishSelection(state());
    expect(session.contextKeys()['wiring.pullTarget']).toBe(3);
    renderer.send({ kind: 'enter' });
    expect(tools.pull()?.request.picked).toBe(3);
    tools.cancelPull();
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(session.contextKeys()['toolbelt.kind']).toBeUndefined();
    expect(routing.announcement()).toBe('Steel fish tape, 1/8 in x 50 ft put away.');
    expect(logged(session, 'wire.pull')).toHaveLength(0);
  });

  it('U resolves to wiring.pull on a selected conduit part, and not on anything else', () => {
    const { tools, session, state } = setup();
    const keys = TestBed.inject(KeybindingService);
    const resolve = () => keys.keymap().resolve('U', { ...session.contextKeys(), 'viewport.focused': true });
    state.set(selecting(5));
    tools.publishSelection(state());
    expect(resolve()?.id).toBe('wiring.pull.selection');
    state.set(STATE);
    tools.publishSelection(state());
    expect(resolve()).toBeNull();
  });
});

describe('opening entries with the tool in hand (F3.4 part 2)', () => {
  const PANEL_TOP_2 = { x: -740, y: 1300, z: 79 }; // the panel's second drill site (3/4 in)

  it('a click picks the nearest closed entry; wrong-size and wrong-tool are shown, nothing logged', () => {
    const tools = [ref('tool.corriden-hs-14'), ref('tool.corriden-sa-12'), ref('tool.veltmark-kp-3')];
    const { routing, renderer, session, toasts } = setup('journeyman', tools);
    const before = logged(session, 'enclosure.openEntry').length;
    session.exec('toolbelt.select', { slot: 1 }); // the 7/8 in hole saw: a 1/2 in hole
    TestBed.tick();
    expect(renderer.current).toMatchObject({ ref: tools[0], ends: 'entries' });
    renderer.send({ kind: 'entity', entity: 1, atMm: { ...PANEL_TOP_2, x: PANEL_TOP_2.x + 5 }, waypoint: null });
    expect(routing.announcement()).toMatch(/^Refused: Bi-metal hole saw, 7\/8 in .* doesn't fit .*\(wrong-size\)\.$/);
    expect(toasts.at(-1)).toMatch(/^Open an entry: /);
    session.exec('toolbelt.select', { slot: 2 }); // the 3/4 in ship auger: bores studs, cuts no box
    TestBed.tick();
    expect(routing.hint()).toMatch(/A bit bores studs while you route a cable/);
    renderer.send({ kind: 'entity', entity: 1, atMm: PANEL_TOP_2, waypoint: null });
    expect(routing.announcement()).toMatch(/\(wrong-tool\)\.$/);
    expect(logged(session, 'enclosure.openEntry')).toHaveLength(before);
    session.exec('toolbelt.select', { slot: 3 }); // the knockout punch with a 3/4 in die
    TestBed.tick();
    renderer.send({ kind: 'entity', entity: 1, atMm: PANEL_TOP_2, waypoint: null });
    expect(
      logged(session, 'enclosure.openEntry')
        .slice(before)
        .map((e) => e.args),
    ).toStrictEqual([{ id: 1, entry: 'drill-top-2', tool: tools[2] }]);
    expect(routing.announcement()).toBe(
      'Opened drill site drill-top-2 (3/4 in) of Steel panel enclosure, 400 × 500 × 200 mm, backplate and two DIN rails #1 with the Knockout punch set, 1/2, 3/4 and 1 in conduit.',
    );
  });

  it('keyboard: Tab cycles a selected box’s entries with what the tool would do; Enter opens; Escape steps out', () => {
    const { tools, routing, session, state, renderer } = setup('journeyman', [ref('tool.veltmark-sd-2')]);
    session.exec('toolbelt.select', { slot: 1 }); // the slotted screwdriver opens knockouts, not drill sites
    state.set(selecting(1));
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBe(1);
    session.exec('routing.terminalNext');
    expect(tools.keyEntry()?.entry).toBe('ko-bottom-1');
    expect(routing.announcement()).toMatch(/^Entry: knockout ko-bottom-1 \(3\/4 in\) of .* #1\. Enter opens it\.$/);
    session.exec('routing.terminalPrevious');
    expect(tools.keyEntry()?.entry).toBe('drill-top-2');
    expect(routing.announcement()).toMatch(/\(wrong-tool\)\.$/);
    session.exec('routing.terminalPrevious');
    expect(routing.announcement()).toMatch(/drill-top-1 \(3\/4 in\) of .* Already open\.$/);
    session.exec('routing.terminalNext');
    session.exec('routing.terminalNext'); // wraps to ko-bottom-1
    renderer.send({ kind: 'enter' });
    expect(logged(session, 'enclosure.openEntry').at(-1)?.args).toStrictEqual({
      id: 1,
      entry: 'ko-bottom-1',
      tool: ref('tool.veltmark-sd-2'),
    });
    expect(tools.keyEntry()).toBeNull();
    session.exec('routing.terminalNext');
    renderer.send({ kind: 'cancel' }); // drops the held entry first…
    expect(routing.announcement()).toBe('Entry dropped.');
    renderer.send({ kind: 'cancel' }); // …then puts the tool away
    TestBed.tick();
    expect(routing.phase()).toBeNull();
  });
});
