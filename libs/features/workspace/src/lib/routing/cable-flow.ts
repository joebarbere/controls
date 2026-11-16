import { computed, DestroyRef, effect, inject, linkedSignal, type Signal, untracked } from '@angular/core';
import { VIEW_FOCUS_SELECTION_BINDING } from '@controls/commands';
import { KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import type { RoutingSession, ViewportState } from '@controls/renderer';
import type { CableAddArgs, Waypoint } from '@controls/world-model';
import { ActiveTool } from '../tool-belt/active-tool';
import type { Announcer } from './announcer';
import {
  addCableWaypoint,
  type CableGesture,
  type CableSpool,
  type CableStep,
  cableSpoolOf,
  cableStepBack,
  cancelCable,
  describeEntry,
  dropMissingEntry,
  enclosureEntries,
  type EntryOption,
  IDLE_CABLE,
  nailPlateWarning,
  nearestEntry,
  pickEntry,
  precheck,
  supportProblem,
} from './cable-gesture';
import type { RoutingMode, RoutingRenderer } from './routing-flow';
import { describeWaypoint } from './routing-gesture';

/** What the viewport reads from the cable flow (a {@link RoutingMode} for the routing flow). */
export interface CableFlow extends RoutingMode {
  /** The cable spool armed now, or `null`. */
  readonly spool: Signal<CableSpool | null>;
  readonly gesture: Signal<CableGesture>;
  /** The entry the keyboard holds (Tab on an enclosure; Enter picks it), or `null`. */
  readonly keyEntry: Signal<EntryOption | null>;
}

const ENTITY_TARGET = /^entity-(\d+)$/;
const sameSpool = (a: CableSpool | null, b: CableSpool | null): boolean =>
  a === b || (a !== null && b !== null && a.ref.id === b.ref.id && a.ref.version === b.ref.version);
/** What a cable waypoint may snap to: raceways, staples, and bores with the bit in hand (ADR 0017). */
const CABLE_WAYPOINTS = ['duct', 'conduit', 'staple', 'bore'] as const;

/**
 * The cable gesture (F3.2 part 4), in the viewport's injection context. A cable spool (an NM-B
 * assembly on the active tool-belt slot) arms it; the renderer runs in `entries` mode
 * (`RoutingSession.ends`), reporting clicks on entities and waypoint clicks:
 *
 * - a click on an enclosure picks its nearest open entry with room (`nearestEntry`); the keyboard
 *   selects an enclosure (`]`), Tab cycles its entries and Enter picks one;
 * - clicks off every enclosure after the first entry add waypoints: staples on the studs, bores with
 *   the drill bit the default-tool rule finds (a nail-plate warning when the hole is too near the
 *   stud edge, never a refusal), ducts;
 * - the far entry completes it: exactly one `cable.add` through `Session.execFromInput`, with the
 *   default tails and cut, pre-checked by `cable.add`'s own `run` so `staple-spacing` and the rest are
 *   shown (a toast and the live region) before anything is logged, with the picks kept;
 * - `afterAdd(id)` then opens the strip prompt for the new cable.
 *
 * Nothing here mutates the world: the gesture is UI state, and its one outcome is a Command.
 */
export function connectCableRouting(
  renderer: Pick<RoutingRenderer, 'onRouting'>,
  state: Signal<ViewportState | undefined>,
  announcer: Announcer,
  afterAdd: (cableId: number) => void = () => undefined,
): CableFlow {
  const destroyRef = inject(DestroyRef);
  const session = inject(Session);
  const activeTool = inject(ActiveTool);
  const toolBelt = inject(ToolBelt);
  const keys = inject(KeybindingService);
  const notifications = inject(NotificationService);
  const catalog = activeTool.catalog;
  const announce = announcer.announce;

  const spool = computed(
    () => {
      const active = activeTool.active();
      return active?.kind === 'spool' ? cableSpoolOf(catalog, active.ref) : null;
    },
    { equal: sameSpool },
  );
  const reset = () => ({ spool: spool(), generation: session.generation() });
  const gesture = linkedSignal<{ spool: CableSpool | null; generation: number }, CableGesture>({
    source: reset,
    computation: () => IDLE_CABLE,
  });
  const keyEntry = linkedSignal<{ spool: CableSpool | null; generation: number }, EntryOption | null>({
    source: reset,
    computation: () => null,
  });
  /** The drill bit a bore would use (the default-tool rule), or `null`: then no bore is offered. */
  const boreTool = computed(() => activeTool.toolFor('bore')?.ref ?? null);
  const routingSession = computed<RoutingSession | null>(() => {
    const s = spool();
    if (s === null) return null;
    const g = gesture();
    const bit = boreTool();
    return {
      ref: s.ref,
      colour: null,
      from: null,
      waypoints: g.waypoints,
      auto: false,
      ends: 'entries',
      startMm: g.a?.positionMm ?? null,
      keyPointMm: keyEntry()?.positionMm ?? null,
      snap: { kinds: bit ? [...CABLE_WAYPOINTS] : CABLE_WAYPOINTS.filter((k) => k !== 'bore'), boreTool: bit },
    };
  });
  const phase = computed(() => (spool() === null ? null : gesture().a === null ? 'armed' : 'started'));

  const describe = (entry: { entity: number; entry: string }) => describeEntry(session.world(), catalog, entry);
  const key = (id: string) => {
    const chord = keys.chordsOf(id)[0];
    return chord === undefined ? 'unbound' : keys.label(chord);
  };
  const refuse = (message: string, code: string) => {
    notifications.notify(`Add a cable: ${message}`, { level: 'warning', timeoutMs: 6000 });
    announce(`Refused: ${message} (${code}).`);
  };

  const apply = (step: CableStep): void => {
    switch (step.kind) {
      case 'from':
        gesture.set(step.gesture);
        keyEntry.set(null);
        announce(`From ${describe(step.entry)}. Add staples, then pick the far entry.`);
        return;
      case 'complete': {
        const id = session.world().nextCableId;
        const result = session.execFromInput('cable.add', step.args);
        if (result.ok) {
          gesture.set(step.gesture);
          keyEntry.set(null);
          const { a, b } = step.args;
          if (a && b) announce(`Cable ${id} added from ${describe(a)} to ${describe(b)}, ${step.args.lengthMm} mm.`);
          afterAdd(id);
        } else if (result.error.kind !== 'rejected') {
          console.warn('cable gesture command failed', result);
        }
        return;
      }
      case 'waypoint': {
        gesture.set(step.gesture);
        const warning = nailPlateWarning(catalog, step.waypoint);
        if (warning) notifications.notify(warning, { level: 'warning', timeoutMs: 8000 });
        announce(
          `Waypoint ${step.gesture.waypoints.length} added (${describeWaypoint(step.waypoint)}).` +
            (warning ? ` ${warning}` : ''),
        );
        return;
      }
      case 'removedWaypoint':
        gesture.set(step.gesture);
        announce(`Waypoint removed; ${step.left} left.`);
        return;
      case 'clearedFrom':
        gesture.set(step.gesture);
        announce('First entry cleared. Pick the first entry.');
        return;
      case 'cancelled':
        gesture.set(step.gesture);
        keyEntry.set(null);
        announce('Cable run cancelled.');
        return;
      case 'putAway':
        gesture.set(step.gesture);
        keyEntry.set(null);
        toolBelt.clear();
        announce('Cable spool put away.');
        return;
      case 'refused':
        if (step.gesture !== gesture()) gesture.set(step.gesture);
        refuse(step.message, step.code);
        return;
      case 'ignored':
        return;
    }
  };

  // A world change can close or fill the first entry, or take its enclosure away: start over.
  effect(() => {
    const world = session.world();
    untracked(() => {
      const step = dropMissingEntry(gesture(), world, catalog);
      if (step.kind === 'refused') {
        gesture.set(IDLE_CABLE);
        announce(`The first entry is no longer usable (${step.code}). Pick the first entry.`);
      }
    });
  });

  const cutter = (s: CableSpool) => activeTool.toolFor('cut', s.awg)?.ref ?? null;
  const check = (args: CableAddArgs) => precheck(session.registry.get('cable.add'), session.world(), args);
  const pick = (entry: EntryOption, s: CableSpool) => apply(pickEntry(gesture(), entry, s, cutter(s), check));

  const offEvents = renderer.onRouting((event) => {
    const s = spool();
    if (s === null) return;
    switch (event.kind) {
      case 'entity': {
        const options = enclosureEntries(session.world(), catalog, event.entity);
        if (options === null) {
          // Not an enclosure: a duct (an entity) or anything with a waypoint there.
          if (event.waypoint && gesture().a !== null) apply(addCableWaypoint(gesture(), event.waypoint));
          else if (gesture().a === null) announce('Pick an entry on a box or panel.');
          return;
        }
        // The nearest entry, the first one included: a click on it again is refused (`same-entry`).
        const entry = nearestEntry(options, event.atMm);
        if (entry === null) {
          refuse(`entity ${event.entity} has no cable entry`, 'unknown-entry');
          return;
        }
        pick(entry, s);
        return;
      }
      case 'waypoint':
        apply(addCableWaypoint(gesture(), event.waypoint as Waypoint));
        return;
      case 'enter': {
        const k = keyEntry();
        if (k) pick(k, s);
        else announce(`Select a box or panel, then ${key('routing.terminalNext')} to an entry.`);
        return;
      }
      case 'cancel':
        apply(cancelCable(gesture()));
        return;
      case 'terminal':
        return;
    }
  });

  /** The enclosure Tab cycles: the selected entity, else the focused one, when it has entries. */
  const entryDevice = computed<number | null>(() => {
    if (spool() === null) return null;
    const world = session.world();
    const s = state();
    const focused = ENTITY_TARGET.exec(s?.focusId ?? '');
    for (const id of [s?.selected?.entityId ?? null, focused ? Number(focused[1]) : null]) {
      if (id !== null && (enclosureEntries(world, catalog, id)?.length ?? 0) > 0) return id;
    }
    return null;
  });

  const cycle = (step: 1 | -1): void => {
    const device = entryDevice();
    if (spool() === null) return;
    if (device === null) {
      announce('Select a box or panel first.');
      return;
    }
    const options = enclosureEntries(session.world(), catalog, device) ?? [];
    const current = keyEntry();
    const index = current ? options.findIndex((o) => o.entity === current.entity && o.entry === current.entry) : -1;
    const next = options[(index + step + options.length) % options.length] ?? null;
    if (index < 0 && step === -1 && options.length > 0) keyEntry.set(options[options.length - 1]);
    else keyEntry.set(next);
    const k = keyEntry();
    if (!k) return;
    const why = k.problem ? ` ${k.problem.message}.` : ` ${key('input.commitPlacement')} picks it.`;
    announce(`Entry: ${describe(k)}.${why}`);
  };
  const whileArmed = (run: () => void) => () => {
    if (spool() !== null) run();
  };
  const offCommands = [
    session.onCommand(
      'routing.terminalNext',
      whileArmed(() => cycle(1)),
    ),
    session.onCommand(
      'routing.terminalPrevious',
      whileArmed(() => cycle(-1)),
    ),
    session.onCommand(
      'routing.back',
      whileArmed(() => apply(cableStepBack(gesture()))),
    ),
    session.onCommand(
      'routing.cancel',
      whileArmed(() => apply(cancelCable(gesture()))),
    ),
  ];
  destroyRef.onDestroy(() => {
    offEvents();
    offCommands.forEach((off) => off());
  });

  const hint = computed<string | null>(() => {
    const s = spool();
    if (s === null) return null;
    const g = gesture();
    const enter = key('input.commitPlacement');
    const tab = key('routing.terminalNext');
    if (g.a === null) {
      const k = keyEntry();
      if (k) return `${s.title}: ${describe(k)}. ${k.problem ? k.problem.message : `${enter} picks it.`}`;
      return (
        `${s.title}: click an open entry on a box or panel, or select one, ${tab} to an entry and ${enter}. ` +
        `${key(VIEW_FOCUS_SELECTION_BINDING)} frames the selection.`
      );
    }
    const world = session.world();
    const via =
      g.waypoints.length === 0 ? '' : ` via ${g.waypoints.length} waypoint${g.waypoints.length > 1 ? 's' : ''}`;
    const next = state()?.routing?.next;
    const click = next ? ` A click adds a ${describeWaypoint(next)}.` : '';
    const support = supportProblem(world, catalog, g);
    return (
      `${describeEntry(world, catalog, g.a)}${via} → pick the far entry.${click}` +
      (support ? ` ${support}.` : '') +
      ` ${key('routing.back')} steps back, Escape cancels.`
    );
  });

  return {
    spool,
    gesture: gesture.asReadonly(),
    keyEntry: keyEntry.asReadonly(),
    session: routingSession,
    phase,
    entryDevice,
    hint,
  };
}
