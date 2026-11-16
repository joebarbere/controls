import { computed, DestroyRef, effect, inject, linkedSignal, type Signal, untracked } from '@angular/core';
import {
  type ContextValue,
  SELECTION_CABLE_ID_KEY,
  SELECTION_CONNECTION_ID_KEY,
  VIEW_FOCUS_TERMINALS_BINDING,
  WIRING_CABLES_KEY,
  WIRING_FREE_ENDS_KEY,
  WIRING_STRIP_TARGET_KEY,
  WIRING_WIRES_KEY,
  type WiringLabelArgs,
  type WiringLandArgs,
  type WiringStripArgs,
} from '@controls/commands';
import { KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import { SettingsStore } from '@controls/feature-settings';
import type { RoutingSession, TerminalRef, ViewportState } from '@controls/renderer';
import {
  type CableStripArgs,
  type TerminationArg,
  type TerminationArgs,
  terminalPlace,
  type World,
} from '@controls/world-model';
import { ActiveTool } from '../tool-belt/active-tool';
import type { Announcer } from './announcer';
import { precheck } from './cable-gesture';
import type { StripPrompt } from './cable-strip-prompt';
import type { LabelConfirm, LabelPrompt } from './label-prompt';
import type { RoutingMode, RoutingRenderer, TerminationPrompt } from './routing-flow';
import { describeTerminal } from './routing-gesture';
import { promptMode, terminationRequest } from './termination-model';
import { type LabelTarget, labelRequest, landingEnd, landingTarget, nextToLand, stripRequest } from './wiring-model';

/** What the viewport reads from the wiring flow: the strip, landing and label prompts. */
export interface WiringFlow extends RoutingMode {
  /** The strip prompt open now, or `null`. */
  readonly strip: Signal<StripPrompt | null>;
  confirmStrip(args: readonly CableStripArgs[]): void;
  cancelStrip(): void;
  /** Opens the strip prompt for cable `id` (after `cable.add`, or `wiring.strip`). */
  openStrip(id: number): void;
  /** The conductor being landed (its connection id), or `null`. */
  readonly landing: Signal<number | null>;
  /** The landing termination prompt open now (above Trainee, after a terminal pick), or `null`. */
  readonly prompt: Signal<TerminationPrompt | null>;
  confirmTermination(args: TerminationArgs): void;
  cancelTermination(): void;
  /** The label prompt open now, or `null`. */
  readonly label: Signal<LabelPrompt | null>;
  confirmLabel(confirm: LabelConfirm): void;
  cancelLabel(): void;
}

interface PendingLanding {
  readonly conductor: number;
  readonly end: 'a' | 'b';
  readonly terminal: TerminalRef;
  readonly prompt: TerminationPrompt;
}

const LABEL_MAKER_KIND = 'labelMaker';

/**
 * The cable prompts (F3.2 part 4), in the viewport's injection context. None of them changes the
 * world itself: each collects arguments, checks them with the command's own `run` (`precheck`) so a
 * refusal shows in the prompt, then logs the command through `Session.execFromInput`.
 *
 * - **Strip** (`cable.strip`, one per filled-in end): opened after a `cable.add` and by `wiring.strip`
 *   (J on a selected cable or its conductor).
 * - **Landing** a cable conductor's free end (`wire.land`): `wiring.land` (L on a selected conductor)
 *   puts the belt away and arms a terminal pick (the renderer's routing session with no first
 *   terminal: click, or Tab and Enter). The pick's end is the free end whose stripped tail reaches it;
 *   above Trainee it opens that end's termination prompt (F3.3 part 2's model and dialog, D9). After a
 *   landing the next conductor of the same cable with a free end follows, until none is left; Escape
 *   stops.
 * - **Labels** (`wire.label` / `cable.label`): `wiring.label` (Shift+L), or a click on a wire with the
 *   label maker in hand, opens the label prompt.
 *
 * It publishes `selection.connectionId` / `selection.cableId` from the selected wire and the `wiring.*`
 * context keys the commands' `when`s read.
 */
export function connectWiring(
  renderer: Pick<RoutingRenderer, 'onRouting' | 'cycleTerminal'>,
  state: Signal<ViewportState | undefined>,
  announcer: Announcer,
): WiringFlow {
  const destroyRef = inject(DestroyRef);
  const session = inject(Session);
  const activeTool = inject(ActiveTool);
  const toolBelt = inject(ToolBelt);
  const keys = inject(KeybindingService);
  const notifications = inject(NotificationService);
  const settings = inject(SettingsStore);
  const catalog = activeTool.catalog;
  const announce = announcer.announce;
  const belt = () => settings.settings().toolBelt.slots;
  const key = (id: string) => {
    const chord = keys.chordsOf(id)[0];
    return chord === undefined ? 'unbound' : keys.label(chord);
  };
  const refuse = (what: string, refusal: { code: string; message: string }) => {
    notifications.notify(`${what}: ${refusal.message}`, { level: 'warning', timeoutMs: 6000 });
    announce(`Refused: ${refusal.message} (${refusal.code}).`);
  };
  const check = (id: string, world: World, args: unknown) => precheck(session.registry.get(id), world, args);
  const words = (r: { code: string; message: string }) => `${r.message} (${r.code})`;

  // --- strip --------------------------------------------------------------------------------------
  const strip = linkedSignal<number, StripPrompt | null>({ source: session.generation, computation: () => null });
  const openStrip = (id: number): void => {
    const built = stripRequest(session.world(), catalog, belt(), id);
    if (!built.ok) {
      refuse('Strip a cable', built);
      return;
    }
    strip.set({ request: built.request, refusal: null });
    announce(`Strip cable ${id}: how much jacket at each end.`);
  };
  const confirmStrip = (list: readonly CableStripArgs[]): void => {
    const p = strip();
    if (p === null) return;
    const world = session.world();
    for (const args of list) {
      const refusal = check('cable.strip', world, args);
      if (refusal) {
        strip.set({ ...p, refusal: `end ${args.end}: ${words(refusal)}` });
        return;
      }
    }
    strip.set(null);
    const done: string[] = [];
    for (const args of list) {
      const result = session.execFromInput('cable.strip', args);
      if (!result.ok) {
        if (result.error.kind !== 'rejected') console.warn('strip prompt command failed', result);
        return;
      }
      done.push(`end ${args.end} ${args.jacketMm} mm`);
    }
    announce(
      `Cable ${p.request.cableId} stripped: ${done.join(', ')}. Select a conductor and press ` +
        `${key('wiring.land.selection')} to land it.`,
    );
  };
  const cancelStrip = (): void => {
    if (strip() === null) return;
    strip.set(null);
    announce('Nothing stripped.');
  };

  // --- landing ------------------------------------------------------------------------------------
  // The conductor being landed; another belt slot or a new session stops it.
  const landing = linkedSignal<{ slot: number | null; generation: number }, number | null>({
    source: () => ({ slot: toolBelt.activeSlot(), generation: session.generation() }),
    computation: () => null,
  });
  const pending = linkedSignal<{ landing: number | null; generation: number }, PendingLanding | null>({
    source: () => ({ landing: landing(), generation: session.generation() }),
    computation: () => null,
  });
  const target = computed(() => {
    const id = landing();
    if (id === null) return null;
    const built = landingTarget(session.world(), id);
    return built.ok ? built.target : null;
  });
  const landingSession = computed<RoutingSession | null>(() => {
    const t = target();
    if (t === null) return null;
    return { ref: t.conductor.ref, colour: t.conductor.colour, from: null, waypoints: [], termination: 'auto' };
  });
  const prompt = computed(() => pending()?.prompt ?? null);

  const startLanding = (id: number): void => {
    const built = landingTarget(session.world(), id);
    if (!built.ok) {
      refuse('Land a conductor', built);
      return;
    }
    if (toolBelt.activeSlot() !== null) toolBelt.clear();
    untracked(landing); // the source changed: settle it before setting
    landing.set(id);
    announce(
      `Landing the ${built.target.title}: click a terminal, or select a device, ` +
        `${key('routing.terminalNext')} to a terminal and ${key('input.commitPlacement')}. Escape stops.`,
    );
  };
  const stopLanding = (message: string): void => {
    landing.set(null);
    announce(message);
  };

  const land = (id: number, end: 'a' | 'b', terminal: TerminalRef, termination: TerminationArg): boolean => {
    const args = { id, end, at: { entity: terminal.entity, terminal: terminal.terminal, termination } };
    const result = session.execFromInput('wire.land', args);
    if (!result.ok) {
      if (result.error.kind !== 'rejected') console.warn('landing command failed', result);
      return false;
    }
    const world = session.world();
    const what = `Wire ${id} end ${end} landed on ${describeTerminal(world, catalog, terminal)}.`;
    const cable = world.connections.find((c) => c.id === id)?.cable?.id;
    const next = cable === undefined ? null : nextToLand(world, cable, id, end);
    if (next === null) {
      stopLanding(`${what} Every conductor of cable ${cable ?? ''} is landed at end ${end}.`);
      return true;
    }
    landing.set(next);
    const n = landingTarget(world, next);
    announce(`${what} Next: the ${n.ok ? n.target.title : `wire ${next}`}. Pick its terminal, or Escape to stop.`);
    return true;
  };

  const pickTerminal = (terminal: TerminalRef): void => {
    const t = target();
    if (t === null) return;
    const world = session.world();
    const place = terminalPlace(world, catalog, { ...terminal, termination: 'auto' });
    if (!place.ok) {
      refuse('Land a conductor', place);
      return;
    }
    const end = landingEnd(world, catalog, t, place.point);
    const title = describeTerminal(world, catalog, terminal);
    if (promptMode(world.difficulty) === 'automatic') {
      const refusal = check('wire.land', world, {
        id: t.conductor.id,
        end,
        at: { entity: terminal.entity, terminal: terminal.terminal, termination: 'auto' },
      });
      if (refusal) refuse('Land a conductor', refusal);
      else land(t.conductor.id, end, terminal, 'auto');
      return;
    }
    const built = terminationRequest(world, catalog, belt(), t.conductor.ref, end, terminal, title);
    if (!built.ok) {
      refuse('Land a conductor', built);
      return;
    }
    if (built.request === null) return;
    pending.set({ conductor: t.conductor.id, end, terminal, prompt: { request: built.request, refusal: null } });
    announce(`Terminate end ${end} of wire ${t.conductor.id} at ${title}.`);
  };

  const confirmTermination = (args: TerminationArgs): void => {
    const p = pending();
    if (p === null) return;
    const refusal = check('wire.land', session.world(), {
      id: p.conductor,
      end: p.end,
      at: { entity: p.terminal.entity, terminal: p.terminal.terminal, termination: args },
    });
    if (refusal) {
      pending.set({ ...p, prompt: { ...p.prompt, refusal: words(refusal) } });
      return;
    }
    pending.set(null);
    land(p.conductor, p.end, p.terminal, args);
  };
  const cancelTermination = (): void => {
    if (pending() === null) return;
    pending.set(null);
    announce('Termination cancelled. Pick a terminal, or Escape to stop.');
  };

  // --- labels -------------------------------------------------------------------------------------
  const label = linkedSignal<number, LabelPrompt | null>({ source: session.generation, computation: () => null });
  const openLabel = (t: LabelTarget): void => {
    const built = labelRequest(session.world(), catalog, belt(), t);
    if (!built.ok) {
      refuse('Label', built);
      return;
    }
    label.set({ request: built.request, refusal: null });
    announce(`Label ${built.request.title}.`);
  };
  const confirmLabel = (confirm: LabelConfirm): void => {
    const p = label();
    if (p === null) return;
    const refusal = check(confirm.id, session.world(), confirm.args);
    if (refusal) {
      label.set({ ...p, refusal: words(refusal) });
      return;
    }
    label.set(null);
    const result = session.execFromInput(confirm.id, confirm.args);
    if (!result.ok) {
      if (result.error.kind !== 'rejected') console.warn('label prompt command failed', result);
      return;
    }
    const text = confirm.args.text;
    announce(text === null ? `${p.request.title}: label removed.` : `${p.request.title} labelled “${text}”.`);
  };
  const cancelLabel = (): void => {
    if (label() === null) return;
    label.set(null);
    announce('Nothing labelled.');
  };
  // The label maker in hand: a click on a wire (it becomes the selected wire) opens its prompt.
  const labelMaker = computed(() => activeTool.tool()?.kind === LABEL_MAKER_KIND);
  let lastSelected: string | null = null;
  effect(() => {
    const wire = state()?.selectedWire ?? null;
    const now = wire ? `${wire.kind}:${wire.id}` : null;
    const armed = labelMaker();
    untracked(() => {
      if (armed && now !== null && now !== lastSelected && wire) openLabel({ kind: wire.kind, id: wire.id });
      lastSelected = now;
    });
  });

  // --- events and commands ------------------------------------------------------------------------
  const offEvents = renderer.onRouting((event) => {
    if (landing() === null || pending() !== null) return;
    if (event.kind === 'terminal') pickTerminal(event.end);
    else if (event.kind === 'cancel') stopLanding('Landing stopped.');
  });
  const whileLanding = (run: () => void) => () => {
    if (landing() !== null && pending() === null) run();
  };
  const cycle = (step: 1 | -1) => {
    const ref = renderer.cycleTerminal(step);
    announce(
      ref
        ? `Terminal: ${describeTerminal(session.world(), catalog, ref)}. ${key('input.commitPlacement')} picks it.`
        : 'Select a device with terminals first.',
    );
  };
  const selectedWire = () => state()?.selectedWire ?? null;
  const offCommands = [
    session.onCommand('wiring.strip', (e) => openStrip((e.command.args as WiringStripArgs).id)),
    session.onCommand('wiring.land', (e) => startLanding((e.command.args as WiringLandArgs).id)),
    session.onCommand('wiring.label', (e) => {
      const args = e.command.args as WiringLabelArgs;
      const wire = selectedWire();
      const t: LabelTarget | null =
        args.wire !== null
          ? { kind: 'connection', id: args.wire }
          : args.cable !== null
            ? { kind: 'cable', id: args.cable }
            : wire && { kind: wire.kind, id: wire.id };
      if (t) openLabel(t);
      else announce('Select a wire or cable to label first.');
    }),
    session.onCommand(
      'routing.terminalNext',
      whileLanding(() => cycle(1)),
    ),
    session.onCommand(
      'routing.terminalPrevious',
      whileLanding(() => cycle(-1)),
    ),
    session.onCommand(
      'routing.cancel',
      whileLanding(() => stopLanding('Landing stopped.')),
    ),
  ];
  destroyRef.onDestroy(() => {
    offEvents();
    offCommands.forEach((off) => off());
  });

  // --- context keys -------------------------------------------------------------------------------
  const published = new Map<string, ContextValue>();
  const publish = (k: string, value: ContextValue) => {
    if ((published.get(k) ?? null) === value) return;
    published.set(k, value);
    session.setContext(k, value);
  };
  const KEYS = [
    WIRING_CABLES_KEY,
    WIRING_FREE_ENDS_KEY,
    WIRING_WIRES_KEY,
    WIRING_STRIP_TARGET_KEY,
    SELECTION_CONNECTION_ID_KEY,
    SELECTION_CABLE_ID_KEY,
  ];
  effect(() => {
    const world = session.world();
    const wire = selectedWire();
    const connection = wire?.kind === 'connection' ? wire.id : null;
    const cable = wire?.kind === 'cable' ? wire.id : null;
    const stripTarget =
      cable ?? (connection === null ? null : (world.connections.find((c) => c.id === connection)?.cable?.id ?? null));
    publish(WIRING_CABLES_KEY, world.cables.length > 0 ? true : null);
    publish(WIRING_FREE_ENDS_KEY, world.connections.some((c) => c.cable && (c.a === null || c.b === null)) || null);
    publish(WIRING_WIRES_KEY, world.connections.length + world.cables.length > 0 ? true : null);
    publish(WIRING_STRIP_TARGET_KEY, stripTarget);
    publish(SELECTION_CONNECTION_ID_KEY, connection);
    publish(SELECTION_CABLE_ID_KEY, cable);
  });
  destroyRef.onDestroy(() => KEYS.forEach((k) => session.setContext(k, null)));

  const hint = computed<string | null>(() => {
    const t = target();
    if (t === null) return null;
    const ends = t.freeEnds.join(' or ');
    const zoom = state()?.terminal?.zoomSuggested
      ? ` Terminals are crowded here: ${key(VIEW_FOCUS_TERMINALS_BINDING)} zooms in.`
      : '';
    return (
      `Landing the ${t.title}, end ${ends}: click a terminal, or select a device, ` +
      `${key('routing.terminalNext')} to a terminal and ${key('input.commitPlacement')}. Escape stops.${zoom}`
    );
  });

  return {
    session: landingSession,
    phase: computed(() => (landingSession() === null ? null : 'armed')),
    hint,
    strip: strip.asReadonly(),
    confirmStrip,
    cancelStrip,
    openStrip,
    landing: computed(() => (target() === null ? null : landing())),
    prompt,
    confirmTermination,
    cancelTermination,
    label: label.asReadonly(),
    confirmLabel,
    cancelLabel,
  };
}
