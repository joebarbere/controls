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
import { proposeRoute, type Waypoint } from '@controls/world-model';
import { connectRouting, type RoutingFlow, type RoutingRenderer } from './routing-flow';

const THHN = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const BLOCK = { id: 'tb.quennick-st4', version: 1 };

/** The renderer's routing surface, recorded: what the flow pushed and a way to send it picks. */
class FakeRenderer implements RoutingRenderer {
  readonly sessions: (RoutingSession | null)[] = [];
  private readonly listeners = new Set<RoutingEventListener>();
  keyTerminal: TerminalRef | null = null;
  cycled: (1 | -1)[] = [];
  setRouting(session: RoutingSession | null): void {
    if (this.sessions.at(-1) !== session) this.sessions.push(session);
  }
  onRouting(listener: RoutingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cycleTerminal(step: 1 | -1): TerminalRef | null {
    this.cycled.push(step);
    return this.keyTerminal;
  }
  terminalCycleOrder(entity: number): readonly string[] {
    return entity >= 1 && entity <= 3 ? ['a', 'b'] : [];
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
  flow: RoutingFlow;
  renderer: FakeRenderer;
  session: Session;
  state: ReturnType<typeof signal<ViewportState | undefined>>;
}

/** A Trainee sandbox with three blocks 6 mm apart, the THHN spool in slot 4, and the flow connected. */
function setup(difficulty: 'trainee' | 'apprentice' = 'trainee'): Setup {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const session = TestBed.inject(Session);
  session.newSandbox({ seed: 0, difficulty });
  for (const x of [-100, -94, -88]) {
    const placed = session.exec('entity.place', {
      ref: BLOCK,
      positionMm: { x, y: 0, z: 40 },
      orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
      mountedOn: null,
    });
    expect(placed.ok).toBe(true);
  }
  const store = TestBed.inject(SettingsStore);
  const slots = [...store.settings().toolBelt.slots];
  slots[3] = THHN;
  slots[4] = { id: 'lead.quillfern-test-1m', version: 1 };
  store.update('toolBelt', { slots });
  TestBed.inject(KeybindingService);
  const renderer = new FakeRenderer();
  const state = signal<ViewportState | undefined>(STATE);
  const flow = TestBed.runInInjectionContext(() => connectRouting(renderer, state));
  return { flow, renderer, session, state };
}

/** What the renderer would hand over for a pick of `end` with the flow's session now. */
function terminalEvent(session: Session, renderer: FakeRenderer, end: TerminalRef): RoutingEvent {
  const s = renderer.current;
  const proposal =
    s?.from && !(s.from.entity === end.entity && s.from.terminal === end.terminal)
      ? proposeRoute(session.world(), BUILTIN_CATALOG, s.from, { ...end, termination: 'auto' }, s.waypoints)
      : null;
  return { kind: 'terminal', end, source: 'pointer', proposal };
}

const wireAdds = (session: Session) => session.entries().filter((e) => e.id === 'wire.add');

describe('the routing flow (F3.2 part 3)', () => {
  it('a conductor spool arms the gesture; two picks log exactly one wire.add with the previewed route', () => {
    const { flow, renderer, session } = setup();
    TestBed.tick();
    expect(renderer.current).toBeNull();
    expect(flow.hint()).toBeNull();

    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    expect(renderer.current).toStrictEqual({
      ref: THHN,
      colour: { base: 'black', stripe: null },
      from: null,
      waypoints: [],
      termination: 'auto',
    });
    expect(flow.phase()).toBe('armed');
    expect(session.contextKeys()).toMatchObject({ 'routing.active': true });
    expect(session.contextKeys()['routing.started']).toBeUndefined();
    expect(flow.hint()).toMatch(/^Pick the first terminal: click it, or Tab to a terminal and Enter\./);

    renderer.send(terminalEvent(session, renderer, { entity: 1, terminal: 'a' }));
    TestBed.tick();
    expect(renderer.current?.from).toStrictEqual({ entity: 1, terminal: 'a', termination: 'auto' });
    expect(flow.announcement()).toBe(
      'From Screw-clamp feed-through terminal block, 4 mm² class, grey #1, terminal 1. Pick the second terminal.',
    );
    expect(session.contextKeys()['routing.started']).toBe(true);
    expect(wireAdds(session)).toHaveLength(0);

    const pick = terminalEvent(session, renderer, { entity: 3, terminal: 'a' });
    renderer.send(pick);
    TestBed.tick();
    const adds = wireAdds(session);
    expect(adds).toHaveLength(1);
    const proposal = pick.kind === 'terminal' && pick.proposal?.ok ? pick.proposal : null;
    expect(adds[0].args).toStrictEqual({
      ref: THHN,
      a: { entity: 1, terminal: 'a', termination: 'auto' },
      b: { entity: 3, terminal: 'a', termination: 'auto' },
      route: proposal?.route,
      lengthMm: proposal?.lengthMm,
      colour: { base: 'black', stripe: null },
      tool: { id: 'tool.veltmark-dc-8', version: 1 },
    });
    expect(session.world().connections.filter((c) => c.ref.id === THHN.id)).toHaveLength(1);
    expect(flow.announcement()).toMatch(/^Wire added from .*#1, terminal 1 to .*#3, terminal 1, \d+ mm\.$/);
    // The spool stays armed for the next wire.
    expect(renderer.current?.from).toBeNull();
    expect(flow.phase()).toBe('armed');
  });

  it('waypoints, Backspace and Escape step the gesture back; a second Escape puts the spool away', () => {
    const { flow, renderer, session } = setup();
    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    renderer.send(terminalEvent(session, renderer, { entity: 1, terminal: 'a' }));
    const waypoint: Waypoint = {
      kind: 'free',
      positionMm: { x: -94, y: 80, z: 60 },
      entity: null,
      fixture: null,
      tool: null,
    };
    renderer.send({ kind: 'waypoint', waypoint });
    renderer.send({ kind: 'waypoint', waypoint: { ...waypoint, positionMm: { x: -90, y: 80, z: 60 } } });
    TestBed.tick();
    expect(renderer.current?.waypoints).toHaveLength(2);
    expect(flow.announcement()).toBe('Waypoint 2 added (free waypoint).');

    session.exec('routing.back');
    TestBed.tick();
    expect(renderer.current?.waypoints).toStrictEqual([waypoint]);
    expect(flow.announcement()).toBe('Waypoint removed; 1 left.');
    session.exec('routing.back');
    session.exec('routing.back');
    TestBed.tick();
    expect(renderer.current).toMatchObject({ from: null, waypoints: [] });
    expect(flow.announcement()).toBe('First terminal cleared. Pick the first terminal.');

    renderer.send(terminalEvent(session, renderer, { entity: 2, terminal: 'b' }));
    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(renderer.current).toMatchObject({ from: null, waypoints: [] });
    expect(flow.announcement()).toBe('Route cancelled.');
    expect(TestBed.inject(ToolBelt).activeSlot()).toBe(4);

    renderer.send({ kind: 'cancel' });
    TestBed.tick();
    expect(TestBed.inject(ToolBelt).activeSlot()).toBeNull();
    expect(renderer.current).toBeNull();
    expect(flow.announcement()).toBe('Spool put away.');
    expect(session.contextKeys()['routing.active']).toBeUndefined();
    // None of it was logged: only the slot pick is in the replay log.
    expect(session.entries().map((e) => e.id)).toStrictEqual([
      'entity.place',
      'entity.place',
      'entity.place',
      'toolbelt.select',
    ]);
  });

  it('a refused wire.add keeps the picks and reaches the toasts; a refused proposal is a warning', () => {
    const { flow, renderer, session } = setup('apprentice');
    const refusals: string[] = [];
    session.onRefusal((r) => refusals.push(`${r.commandId} ${r.code}`));
    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    renderer.send(terminalEvent(session, renderer, { entity: 1, terminal: 'a' }));
    TestBed.tick();
    renderer.send(terminalEvent(session, renderer, { entity: 3, terminal: 'a' }));
    TestBed.tick();
    // 'auto' terminations are Trainee's (D9); the termination prompts (F3.3 part 2) supply them above it.
    expect(refusals).toStrictEqual(['wire.add termination-required']);
    expect(wireAdds(session)).toHaveLength(0);
    expect(renderer.current?.from).toStrictEqual({ entity: 1, terminal: 'a', termination: 'auto' });

    renderer.send({
      kind: 'terminal',
      end: { entity: 2, terminal: 'a' },
      source: 'keyboard',
      proposal: { ok: false, code: 'route-collides', message: 'The route passes through entity 2' },
    });
    expect(
      TestBed.inject(NotificationService)
        .toasts()
        .map((t) => [t.level, t.message]),
    ).toStrictEqual([['warning', 'Add a wire: The route passes through entity 2']]);
    expect(flow.phase()).toBe('started');
  });

  it('Tab cycles the device in hand while routing; the zoom key targets a crowded device', () => {
    const { flow, renderer, session, state } = setup();
    const keys = TestBed.inject(KeybindingService);
    session.setContext('viewport.focused', true);
    // Not routing: Tab is not bound, so it still moves focus.
    state.set({ ...STATE, selected: { id: 'entity-2', kind: 'device', label: 'Block #2', entityId: 2 } as never });
    TestBed.tick();
    expect(keys.keymap().resolve('Tab', session.contextKeys())).toBeNull();

    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBe(2);
    expect(keys.keymap().resolve('Tab', session.contextKeys())?.id).toBe('routing.terminalNext');
    expect(keys.keymap().resolve('Shift+Tab', session.contextKeys())?.id).toBe('routing.terminalPrevious');
    renderer.keyTerminal = { entity: 2, terminal: 'b' };
    session.exec('routing.terminalPrevious');
    expect(renderer.cycled).toStrictEqual([-1]);
    expect(flow.announcement()).toBe(
      'Terminal: Screw-clamp feed-through terminal block, 4 mm² class, grey #2, terminal 2. Enter picks it.',
    );
    // With the spool only armed, Backspace still deletes the selection; routing.back needs a started route.
    session.setContext('selection.entityId', 2); // the viewport publishes it from the selection
    expect(keys.keymap().resolve('Backspace', session.contextKeys())?.id).toBe('entity.delete.selection');

    // A device whose terminals are under 24 px apart: Z frames it with view.focus.
    state.set({
      ...STATE,
      terminal: {
        hit: null,
        near: { entity: 3, terminal: 'a' },
        pitchPx: 5,
        device: 3,
        groupPitchPx: 5,
        zoomSuggested: true,
      },
    });
    TestBed.tick();
    expect(session.contextKeys()['routing.zoomTarget']).toBe('entity-3');
    expect(flow.hint()).toContain('Terminals are crowded here: Z zooms in.');
    const zoom = keys.keymap().resolve('Z', session.contextKeys());
    expect(zoom?.id).toBe('view.focus.terminals');
  });

  it('a lead or cable spool is held but not routed (yet)', () => {
    const { flow, renderer, session } = setup();
    session.exec('toolbelt.select', { slot: 5 });
    TestBed.tick();
    expect(renderer.current).toBeNull();
    expect(flow.hint()).toBe('1 m 18 AWG test lead with crocodile clips: only single conductors can be routed yet.');
  });
  it('a hovered device never takes Tab: only the selection, the focus target or the keyboard terminal do', () => {
    const { renderer, session, state } = setup();
    const keys = TestBed.inject(KeybindingService);
    session.setContext('viewport.focused', true);
    session.exec('toolbelt.select', { slot: 4 });
    const hover = {
      hit: { entity: 3, terminal: 'a' },
      near: { entity: 3, terminal: 'a' },
      pitchPx: 30,
      device: 3,
      groupPitchPx: 30,
      zoomSuggested: false,
    };
    state.set({ ...STATE, terminal: hover });
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBeUndefined();
    expect(keys.keymap().resolve('Tab', session.contextKeys())).toBeNull();
    state.set({ ...STATE, terminal: hover, focusId: 'entity-1' });
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBe(1);
    state.set({ ...STATE, terminal: hover, keyTerminal: { entity: 2, terminal: 'b' } });
    TestBed.tick();
    expect(session.contextKeys()['routing.terminalDevice']).toBe(2);
    expect(renderer.cycled).toStrictEqual([]);
  });

  it('a first terminal that leaves the world starts the route over, announced, with no wire.add', () => {
    const { flow, renderer, session } = setup();
    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    renderer.send(terminalEvent(session, renderer, { entity: 2, terminal: 'a' }));
    TestBed.tick();
    expect(flow.phase()).toBe('started');
    expect(session.exec('entity.delete', { id: 2 }).ok).toBe(true);
    TestBed.tick();
    expect(flow.phase()).toBe('armed');
    expect(renderer.current).toMatchObject({ from: null, waypoints: [] });
    expect(flow.announcement()).toBe('First terminal removed from the world. Pick the first terminal.');
    expect(wireAdds(session)).toHaveLength(0);
  });

  it('another spool starts over; the same conductor in another slot keeps the route; a second route is a second wire.add', () => {
    const { flow, renderer, session } = setup();
    const store = TestBed.inject(SettingsStore);
    const slots = [...store.settings().toolBelt.slots];
    slots[5] = { id: 'conductor.tallowmere-thhn-12-solid', version: 1 };
    slots[6] = THHN;
    store.update('toolBelt', { slots });
    const pickFirst = () => {
      renderer.send(terminalEvent(session, renderer, { entity: 1, terminal: 'a' }));
      TestBed.tick();
      expect(flow.phase()).toBe('started');
    };
    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    pickFirst();
    session.exec('toolbelt.select', { slot: 6 }); // 12 AWG: another spool
    TestBed.tick();
    expect(flow.phase()).toBe('armed');
    expect(renderer.current?.ref).toStrictEqual({ id: 'conductor.tallowmere-thhn-12-solid', version: 1 });

    session.exec('toolbelt.select', { slot: 4 });
    TestBed.tick();
    pickFirst();
    session.exec('toolbelt.select', { slot: 7 }); // the same conductor in another slot
    TestBed.tick();
    expect(flow.phase()).toBe('started');
    expect(renderer.current?.from).toStrictEqual({ entity: 1, terminal: 'a', termination: 'auto' });

    session.exec('toolbelt.select', { slot: 1 }); // a prop
    TestBed.tick();
    expect(flow.phase()).toBeNull();
    session.exec('toolbelt.select', { slot: 4 }); // and back: a fresh route
    TestBed.tick();
    expect(flow.phase()).toBe('armed');

    pickFirst();
    renderer.send(terminalEvent(session, renderer, { entity: 3, terminal: 'a' }));
    TestBed.tick();
    expect(wireAdds(session)).toHaveLength(1);
    expect(flow.phase()).toBe('armed'); // the spool stays armed
    renderer.send(terminalEvent(session, renderer, { entity: 2, terminal: 'b' }));
    TestBed.tick();
    renderer.send(terminalEvent(session, renderer, { entity: 3, terminal: 'b' }));
    TestBed.tick();
    expect(wireAdds(session)).toHaveLength(2);
  });
});
