import { computed, DestroyRef, effect, inject, linkedSignal, signal, type Signal } from '@angular/core';
import {
  type ContextValue,
  ROUTING_ACTIVE_KEY,
  ROUTING_STARTED_KEY,
  ROUTING_TERMINAL_DEVICE_KEY,
  ROUTING_ZOOM_TARGET_KEY,
  VIEW_FOCUS_TERMINALS_BINDING,
} from '@controls/commands';
import { KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import {
  entitySelectableId,
  type RoutingEventListener,
  type RoutingSession,
  type TerminalRef,
  type ViewportState,
} from '@controls/renderer';
import { ActiveTool } from '../tool-belt/active-tool';
import {
  addWaypoint,
  cancelGesture,
  describeTerminal,
  describeWaypoint,
  type GestureStep,
  IDLE_GESTURE,
  pickTerminal,
  type RouteGesture,
  type Spool,
  spoolOf,
  stepBack,
} from './routing-gesture';

/** What the routing flow needs from the renderer (`ViewportRenderer`; a fake in specs). */
export interface RoutingRenderer {
  setRouting(session: RoutingSession | null): void;
  onRouting(listener: RoutingEventListener): () => void;
  cycleTerminal(step: 1 | -1): TerminalRef | null;
  terminalCycleOrder(entity: number): readonly string[];
}

/** What the viewport reads from the routing flow. */
export interface RoutingFlow {
  /** The routable spool armed now, or `null`. */
  readonly spool: Signal<Spool | null>;
  /** The route in progress. */
  readonly gesture: Signal<RouteGesture>;
  /** `armed` (a spool, no first terminal yet), `started` (a first terminal picked), else `null`. */
  readonly phase: Signal<'armed' | 'started' | null>;
  /** The viewport's routing hint: what the next pick does, the route under the pointer, the zoom offer. */
  readonly hint: Signal<string | null>;
  /** The latest announcement for the polite live region (picks, waypoints, completion, cancel). */
  readonly announcement: Signal<string>;
}

const ENTITY_TARGET = /^entity-(\d+)$/;
const NO_BREAK_SPACE = '\u00a0';
const sameSpool = (a: Spool | null, b: Spool | null): boolean =>
  a === b || (a !== null && b !== null && a.ref.id === b.ref.id && a.ref.version === b.ref.version);

/**
 * The routing gesture (F3.2 part 3), in the viewport's injection context. The UI owns the gesture; the
 * renderer draws it and reports picks ({@link RoutingRenderer}):
 *
 * - a **spool** (a conductor on the active tool-belt slot, `toolbelt.kind == 'spool'`) arms it, and
 *   the gesture is pushed to the renderer with `setRouting` whenever it changes;
 * - the renderer's `terminal`, `waypoint` and `cancel` events, and the `routing.*` commands (Tab,
 *   Shift+Tab, Backspace; the palette and console), step the pure state machine in `routing-gesture`;
 * - a completed route runs **exactly one** `wire.add` through `Session.execFromInput`, with the
 *   proposal the renderer previewed; a refusal reaches the shell's toasts and the picks are kept;
 * - the `routing.*` context keys (`active`, `started`, `terminalDevice`, `zoomTarget`) gate the keys.
 *
 * Nothing here mutates the world: the gesture is UI state, and its one outcome is a Command.
 */
export function connectRouting(renderer: RoutingRenderer, state: Signal<ViewportState | undefined>): RoutingFlow {
  const destroyRef = inject(DestroyRef);
  const session = inject(Session);
  const activeTool = inject(ActiveTool);
  const toolBelt = inject(ToolBelt);
  const keys = inject(KeybindingService);
  const notifications = inject(NotificationService);
  const catalog = activeTool.catalog;

  /** The active slot when it holds a spool (routable or not). */
  const spoolSlot = computed(() => {
    const active = activeTool.active();
    return active?.kind === 'spool' ? active : null;
  });
  const spool = computed(() => spoolOf(catalog, spoolSlot()?.ref ?? null), { equal: sameSpool });
  // A new spool or a new session starts the gesture over.
  const gesture = linkedSignal<{ spool: Spool | null; generation: number }, RouteGesture>({
    source: () => ({ spool: spool(), generation: session.generation() }),
    computation: () => IDLE_GESTURE,
  });
  const routingSession = computed<RoutingSession | null>(() => {
    const s = spool();
    if (s === null) return null;
    const g = gesture();
    return {
      ref: s.ref,
      colour: s.colour,
      from: g.from && { entity: g.from.entity, terminal: g.from.terminal, termination: 'auto' },
      waypoints: g.waypoints,
      termination: 'auto',
    };
  });
  const phase = computed(() => (routingSession() === null ? null : gesture().from === null ? 'armed' : 'started'));

  const announcement = signal('');
  // The same words twice still change the region (a trailing no-break space), so they are read again.
  const announce = (message: string) =>
    announcement.set(announcement() === message ? `${message}${NO_BREAK_SPACE}` : message);
  const describe = (end: { entity: number; terminal: string }) => describeTerminal(session.world(), catalog, end);
  const key = (id: string) => {
    const chord = keys.chordsOf(id)[0];
    return chord === undefined ? 'unbound' : keys.label(chord);
  };

  // Pushing the gesture into the framework-free renderer is an imperative side effect.
  effect(() => renderer.setRouting(routingSession()));
  destroyRef.onDestroy(() => renderer.setRouting(null));

  const apply = (step: GestureStep): void => {
    switch (step.kind) {
      case 'from':
        gesture.set(step.gesture);
        announce(`From ${describe(step.end)}. Pick the second terminal.`);
        return;
      case 'complete': {
        const result = session.execFromInput('wire.add', step.args);
        if (result.ok) {
          gesture.set(step.gesture);
          const { a, b } = step.args;
          if (a && b) announce(`Wire added from ${describe(a)} to ${describe(b)}, ${step.lengthMm} mm.`);
        } else if (result.error.kind !== 'rejected') {
          // Bad arguments are a bug (the proposal is the command's own maths); a refusal is the world's
          // answer and reaches the toasts through `execFromInput`. Either way the picks are kept.
          console.warn('routing gesture command failed', result);
        }
        return;
      }
      case 'waypoint':
        gesture.set(step.gesture);
        announce(`Waypoint ${step.gesture.waypoints.length} added (${describeWaypoint(step.waypoint)}).`);
        return;
      case 'removedWaypoint':
        gesture.set(step.gesture);
        announce(`Waypoint removed; ${step.left} left.`);
        return;
      case 'clearedFrom':
        gesture.set(step.gesture);
        announce(`First terminal cleared. Pick the first terminal.`);
        return;
      case 'cancelled':
        gesture.set(step.gesture);
        announce('Route cancelled.');
        return;
      case 'putAway':
        gesture.set(step.gesture);
        toolBelt.clear();
        announce('Spool put away.');
        return;
      case 'refused':
        notifications.notify(`Add a wire: ${step.message}`, { level: 'warning', timeoutMs: 6000 });
        return;
      case 'ignored':
        return;
    }
  };

  const offEvents = renderer.onRouting((event) => {
    const s = spool();
    if (s === null) return;
    switch (event.kind) {
      case 'terminal': {
        const cutter = activeTool.toolFor('cut', s.awg)?.ref ?? null;
        apply(pickTerminal(gesture(), event.end, event.proposal, s, cutter));
        return;
      }
      case 'waypoint':
        apply(addWaypoint(gesture(), event.waypoint));
        return;
      case 'cancel':
        apply(cancelGesture(gesture()));
        return;
    }
  });

  const cycle = (step: 1 | -1): void => {
    if (spool() === null) return;
    const ref = renderer.cycleTerminal(step);
    announce(ref ? `Terminal: ${describe(ref)}. Enter picks it.` : 'Select a device with terminals first.');
  };
  const whileRouting = (run: () => void) => () => {
    if (spool() !== null) run();
  };
  const offCommands = [
    session.onCommand('routing.terminalNext', () => cycle(1)),
    session.onCommand('routing.terminalPrevious', () => cycle(-1)),
    session.onCommand(
      'routing.back',
      whileRouting(() => apply(stepBack(gesture()))),
    ),
    session.onCommand(
      'routing.cancel',
      whileRouting(() => apply(cancelGesture(gesture()))),
    ),
  ];
  destroyRef.onDestroy(() => {
    offEvents();
    offCommands.forEach((off) => off());
  });

  /** The device Tab cycles, as the renderer picks it: selected, focused, the keyboard's, the hovered terminal's. */
  const terminalDevice = computed<number | null>(() => {
    if (routingSession() === null) return null;
    session.world(); // re-check when the world changes (a deleted device)
    const s = state();
    const focused = ENTITY_TARGET.exec(s?.focusId ?? '');
    const candidates = [
      s?.selected?.entityId ?? null,
      focused ? Number(focused[1]) : null,
      s?.keyTerminal?.entity ?? null,
      s?.terminal?.near?.entity ?? null,
    ];
    for (const id of candidates) if (id !== null && renderer.terminalCycleOrder(id).length > 0) return id;
    return null;
  });
  const zoomTarget = computed<string | null>(() => {
    if (routingSession() === null) return null;
    const terminal = state()?.terminal;
    return terminal?.zoomSuggested && terminal.device !== null ? entitySelectableId(terminal.device) : null;
  });

  // Context keys are the session's plain state, not signals: an effect is the one place they're written.
  const published = new Map<string, ContextValue>();
  const publish = (k: string, value: ContextValue) => {
    if ((published.get(k) ?? null) === value) return;
    published.set(k, value);
    session.setContext(k, value);
  };
  effect(() => {
    publish(ROUTING_ACTIVE_KEY, phase() === null ? null : true);
    publish(ROUTING_STARTED_KEY, phase() === 'started' ? true : null);
    publish(ROUTING_TERMINAL_DEVICE_KEY, terminalDevice());
    publish(ROUTING_ZOOM_TARGET_KEY, zoomTarget());
  });
  destroyRef.onDestroy(() => {
    for (const k of [ROUTING_ACTIVE_KEY, ROUTING_STARTED_KEY, ROUTING_TERMINAL_DEVICE_KEY, ROUTING_ZOOM_TARGET_KEY]) {
      session.setContext(k, null);
    }
  });

  const hint = computed<string | null>(() => {
    const slot = spoolSlot();
    if (slot === null) return null;
    const s = spool();
    if (s === null) return `${slot.title}: only single conductors can be routed yet.`;
    const g = gesture();
    const view = state();
    const zoom = view?.terminal?.zoomSuggested
      ? ` Terminals are crowded here: ${key(VIEW_FOCUS_TERMINALS_BINDING)} zooms in.`
      : '';
    const enter = key('input.commitPlacement');
    if (g.from === null) {
      return `Pick the first terminal: click it, or ${key('routing.terminalNext')} to a terminal and ${enter}.${zoom}`;
    }
    const via =
      g.waypoints.length === 0 ? '' : ` via ${g.waypoints.length} waypoint${g.waypoints.length > 1 ? 's' : ''}`;
    const from = describe(g.from);
    const routing = view?.routing;
    if (routing?.target && routing.proposal) {
      const to = describe(routing.target);
      return routing.proposal.ok
        ? `${from} → ${to}${via}, ${routing.proposal.lengthMm} mm: click or ${enter} adds the wire.`
        : `${from} → ${to}: ${routing.proposal.message}.`;
    }
    const next = routing?.next ? ` A click adds a ${describeWaypoint(routing.next)}.` : '';
    return (
      `${from}${via} → pick the second terminal.${next} ` + `${key('routing.back')} steps back, Escape cancels.${zoom}`
    );
  });

  return { spool, gesture: gesture.asReadonly(), phase, hint, announcement: announcement.asReadonly() };
}
