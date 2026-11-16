import { computed, DestroyRef, effect, inject, linkedSignal, type Signal, untracked } from '@angular/core';
import {
  type ContextValue,
  WIRING_CONDUITS_KEY,
  WIRING_PULL_TARGET_KEY,
  type WiringPullArgs,
} from '@controls/commands';
import { KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import { SettingsStore } from '@controls/feature-settings';
import { racewayOf } from '@controls/catalog';
import type { RoutingSession, ViewportState } from '@controls/renderer';
import type { DefaultTool, WirePullArgs, World } from '@controls/world-model';
import { ActiveTool } from '../tool-belt/active-tool';
import type { Announcer } from './announcer';
import { precheck } from './cable-gesture';
import { type CutOption, cutOptions, describeCutOption, nearestClosedEntry, opensEntries } from './cut-model';
import type { PullPrompt } from './fish-tape-prompt';
import { conduitRun, pullRequest } from './pull-model';
import type { RoutingMode, RoutingRenderer } from './routing-flow';

/** What the viewport reads from the tool flow: the entry flow and the fish tape prompt. */
export interface ToolFlow extends RoutingMode {
  /** The fish tape prompt open now, or `null`. */
  readonly pull: Signal<PullPrompt | null>;
  /** `wire.pull`'s own check of `args` against the world now: its refusal in words, else `null`. */
  checkPull(args: WirePullArgs): string | null;
  /** The minigame succeeded (or a Trainee skip): checks and logs the one `wire.pull`. */
  confirmPull(args: WirePullArgs): void;
  cancelPull(): void;
  /** The entry the keyboard holds (Tab on an enclosure with a cutting tool in hand), or `null`. */
  readonly keyEntry: Signal<CutOption | null>;
  /** Publishes `wiring.pullTarget` for the selection now (the viewport calls it in the selection's task). */
  publishSelection(state: ViewportState | undefined): void;
}

const ENTITY_TARGET = /^entity-(\d+)$/;
const PULL_STEP = 'pull';

/**
 * Tools in hand (F3.4 part 2), in the viewport's injection context. Two modes share the renderer's
 * routing session in `entries` mode (clicks on entities, Enter, Escape; no wire is drawn):
 *
 * - **Entries** (a screwdriver, a knockout punch, a hole saw or a drill bit in hand, `opensEntries`):
 *   a click on an enclosure picks its nearest closed entry; Tab cycles a selected enclosure's entries
 *   and Enter picks one. The pick is checked with `enclosure.openEntry`'s own `run` (`wrong-tool`,
 *   `wrong-size`, `wrong-drive` shown, nothing logged), then logged once through `Session.execFromInput`.
 * - **Fish tape** (a tool that can `pull`): a click on a conduit part, or on a box with a connector in
 *   an entry, or Enter on the selected one, opens the fish tape prompt (`ctl-fish-tape-prompt`); so
 *   does `wiring.pull` (U, the palette, the console) with any tool or none (the default-tool rule's
 *   tape). The prompt's game gates the pull; its success logs exactly one `wire.pull`.
 *
 * Escape drops the keyboard's entry, then puts the tool away. Nothing here mutates the world.
 */
export function connectToolFlow(
  renderer: Pick<RoutingRenderer, 'onRouting'>,
  state: Signal<ViewportState | undefined>,
  announcer: Announcer,
): ToolFlow {
  const destroyRef = inject(DestroyRef);
  const session = inject(Session);
  const activeTool = inject(ActiveTool);
  const toolBelt = inject(ToolBelt);
  const keys = inject(KeybindingService);
  const notifications = inject(NotificationService);
  const settings = inject(SettingsStore);
  const catalog = activeTool.catalog;
  const announce = announcer.announce;
  const key = (id: string) => {
    const chord = keys.chordsOf(id)[0];
    return chord === undefined ? 'unbound' : keys.label(chord);
  };
  const refuse = (what: string, refusal: { code: string; message: string }) => {
    notifications.notify(`${what}: ${refusal.message}`, { level: 'warning', timeoutMs: 6000 });
    announce(`Refused: ${refusal.message} (${refusal.code}).`);
  };
  const check = (id: string, world: World, args: unknown) => precheck(session.registry.get(id), world, args);

  // --- the tool in hand -----------------------------------------------------------------------------
  const tool = activeTool.tool;
  const entryTool = computed(() => {
    const t = tool();
    return t && opensEntries(t) && !t.capabilities.some((c) => c.step === PULL_STEP) ? t : null;
  });
  const tape = computed(() => {
    const t = tool();
    return t && t.capabilities.some((c) => c.step === PULL_STEP) ? t : null;
  });
  const held = computed(() => entryTool() ?? tape());
  const routingSession = computed<RoutingSession | null>(() => {
    const t = held();
    if (t === null) return null;
    return {
      ref: { id: t.id, version: t.version },
      colour: null,
      from: null,
      waypoints: [],
      auto: false,
      ends: 'entries',
      startMm: null,
      keyPointMm: keyEntry()?.positionMm ?? null,
      snap: { kinds: [] },
      claimsClick,
    };
  });

  /**
   * Which clicks are the tool's (the renderer selects on any other, F3.4 part 2): with the fish tape, a
   * click on a conduit run (or a box with a connector in an entry); with an entry tool, a click within
   * the pick radius of a closed entry (`nearestClosedEntry`).
   */
  const claimsClick = (entity: number, atMm: { x: number; y: number; z: number }): boolean =>
    untracked(() => {
      if (tape()) return conduitRun(session.world(), catalog, entity).ok;
      const list = options(entity);
      return list !== null && nearestClosedEntry(list, atMm) !== null;
    });

  // --- entries --------------------------------------------------------------------------------------
  const entryDevice = computed<number | null>(() => {
    if (entryTool() === null) return null;
    const world = session.world();
    const s = state();
    const focused = ENTITY_TARGET.exec(s?.focusId ?? '');
    for (const id of [s?.selected?.entityId ?? null, focused ? Number(focused[1]) : null]) {
      if (id === null) continue;
      const found = world.entities.find((e) => e.id === id);
      if ((found && catalog.device(found.ref)?.enclosure?.entries.length) ?? 0) return id;
    }
    return null;
  });
  const keyEntry = linkedSignal<{ tool: string | null; generation: number; device: number | null }, CutOption | null>({
    source: () => ({ tool: entryTool()?.id ?? null, generation: session.generation(), device: entryDevice() }),
    computation: () => null,
  });
  const options = (entity: number): CutOption[] | null => {
    const t = entryTool();
    if (t === null) return null;
    const ref = { id: t.id, version: t.version };
    const world = session.world();
    return cutOptions(world, catalog, entity, ref, (args) => check('enclosure.openEntry', world, args));
  };
  const resolve = (o: Pick<CutOption, 'entity' | 'entry'>): CutOption | null =>
    options(o.entity)?.find((x) => x.entry === o.entry) ?? null;
  const describe = (o: CutOption) => `${describeCutOption(o)} of ${title(o.entity)}`;
  const title = (entity: number) => {
    const found = session.world().entities.find((e) => e.id === entity);
    return `${(found && catalog.device(found.ref)?.title) ?? 'entity'} #${entity}`;
  };
  const cut = (o: CutOption): void => {
    const t = entryTool();
    if (t === null) return;
    const now = resolve(o);
    if (now === null) {
      announce('That entry left the world.');
      return;
    }
    if (now.open) {
      announce(`${describe(now)} is already open.`);
      return;
    }
    if (now.problem) {
      refuse('Open an entry', now.problem);
      return;
    }
    const result = session.execFromInput('enclosure.openEntry', {
      id: now.entity,
      entry: now.entry,
      tool: { id: t.id, version: t.version },
    });
    if (!result.ok) {
      if (result.error.kind !== 'rejected') console.warn('entry command failed', result);
      return;
    }
    keyEntry.set(null);
    announce(`Opened ${describe(now)} with the ${t.title}.`);
  };
  const cycle = (step: 1 | -1): void => {
    const device = entryDevice();
    if (device === null) {
      announce('Select a box or panel first.');
      return;
    }
    const list = options(device) ?? [];
    if (list.length === 0) return;
    const current = keyEntry();
    const index = current ? list.findIndex((o) => o.entry === current.entry) : step === 1 ? -1 : list.length;
    const next = list[(index + step + list.length) % list.length];
    keyEntry.set(next);
    const why = next.open
      ? ' Already open.'
      : next.problem
        ? ` ${next.problem.message} (${next.problem.code}).`
        : ` ${key('input.commitPlacement')} opens it.`;
    announce(`Entry: ${describe(next)}.${why}`);
  };

  // --- the fish tape --------------------------------------------------------------------------------
  const pull = linkedSignal<number, PullPrompt | null>({ source: session.generation, computation: () => null });
  const tapeFor = (): DefaultTool | null => {
    const t = tape();
    const slot = activeTool.activeSlot();
    if (t) return { tool: t, ref: { id: t.id, version: t.version }, slot };
    return activeTool.toolFor(PULL_STEP);
  };
  const openPull = (entity: number): void => {
    const built = pullRequest(session.world(), catalog, settings.settings().toolBelt.slots, entity, tapeFor());
    if (!built.ok) {
      refuse('Pull through conduit', built);
      return;
    }
    pull.set({ request: built.request, refusal: null });
    announce(`Fish tape: ${built.request.run.title}.`);
  };
  const checkPull = (args: WirePullArgs): string | null => {
    const refusal = check('wire.pull', session.world(), args);
    return refusal && `${refusal.message} (${refusal.code})`;
  };
  const confirmPull = (args: WirePullArgs): void => {
    const p = pull();
    if (p === null) return;
    const refusal = checkPull(args);
    if (refusal) {
      pull.set({ ...p, refusal });
      return;
    }
    const first = session.world().nextConnectionId;
    pull.set(null);
    const result = session.execFromInput('wire.pull', args);
    if (!result.ok) {
      if (result.error.kind !== 'rejected') console.warn('pull command failed', result);
      announce(`Nothing pulled: ${result.error.message}.`);
      return;
    }
    const n = args.conductors.length;
    const ids = n === 1 ? `wire ${first}` : `wires ${first}–${first + n - 1}`;
    announce(`Pulled ${n} conductor${n === 1 ? '' : 's'} through the ${p.request.run.title}: ${ids}, both ends free.`);
  };
  const cancelPull = (): void => {
    if (pull() === null) return;
    pull.set(null);
    announce('Nothing pulled.');
  };

  // --- events and commands --------------------------------------------------------------------------
  const putAway = (): void => {
    if (keyEntry() !== null) {
      keyEntry.set(null);
      announce('Entry dropped.');
      return;
    }
    const t = held();
    toolBelt.clear();
    announce(`${t?.title ?? 'Tool'} put away.`);
  };
  const offEvents = renderer.onRouting((event) => {
    if (routingSession() === null || pull() !== null) return;
    switch (event.kind) {
      case 'entity': {
        if (tape()) {
          openPull(event.entity);
          return;
        }
        const list = options(event.entity);
        if (list === null) {
          announce('Click a box or panel to open one of its entries.');
          return;
        }
        // The renderer only sends claimed clicks; re-checked in case the world moved since.
        const o = nearestClosedEntry(list, event.atMm);
        if (o !== null) cut(o);
        return;
      }
      case 'enter': {
        if (tape()) {
          const id = state()?.selected?.entityId ?? null;
          if (id === null) announce(`Select a conduit part, then ${key('input.commitPlacement')}.`);
          else openPull(id);
          return;
        }
        const k = keyEntry();
        if (k) cut(k);
        else announce(`Select a box or panel, then ${key('routing.terminalNext')} to an entry.`);
        return;
      }
      case 'cancel':
        putAway();
        return;
      default:
        return;
    }
  });
  const whileEntries = (run: () => void) => () => {
    if (entryTool() !== null && pull() === null) run();
  };
  const offCommands = [
    session.onCommand('wiring.pull', (e) => openPull((e.command.args as WiringPullArgs).conduit)),
    session.onCommand(
      'routing.terminalNext',
      whileEntries(() => cycle(1)),
    ),
    session.onCommand(
      'routing.terminalPrevious',
      whileEntries(() => cycle(-1)),
    ),
    session.onCommand('routing.cancel', () => {
      if (routingSession() !== null && pull() === null) putAway();
    }),
  ];
  destroyRef.onDestroy(() => {
    offEvents();
    offCommands.forEach((off) => off());
  });

  // A world change can open the held entry (undo, the console) or take its box away: re-check it.
  effect(() => {
    session.world();
    untracked(() => {
      const k = keyEntry();
      if (k === null) return;
      const now = resolve(k);
      if (now === null) {
        keyEntry.set(null);
        announce('The entry in hand left the world.');
      } else if (now.open !== k.open || now.problem?.code !== k.problem?.code) {
        keyEntry.set(now);
      }
    });
  });

  // --- context keys ---------------------------------------------------------------------------------
  const published = new Map<string, ContextValue>();
  const publish = (k: string, value: ContextValue) => {
    if ((published.get(k) ?? null) === value) return;
    published.set(k, value);
    session.setContext(k, value);
  };
  const publishSelection = (s: ViewportState | undefined): void => {
    const id = s?.selected?.entityId ?? null;
    const world = untracked(session.world);
    publish(WIRING_PULL_TARGET_KEY, id !== null && conduitRun(world, catalog, id).ok ? id : null);
  };
  effect(() => {
    const world = session.world();
    const s = state();
    const any = world.entities.some((e) => {
      const device = catalog.device(e.ref);
      return device !== undefined && racewayOf(device) === 'conduit';
    });
    publish(WIRING_CONDUITS_KEY, any || null);
    untracked(() => publishSelection(s));
  });
  destroyRef.onDestroy(() => [WIRING_CONDUITS_KEY, WIRING_PULL_TARGET_KEY].forEach((k) => session.setContext(k, null)));

  const hint = computed<string | null>(() => {
    const enter = key('input.commitPlacement');
    const t = tape();
    if (t) {
      return (
        `${t.title}: click a conduit run (or a box with a connector in an entry), or select one and ` +
        `${enter}, to pull conductors through it. Escape puts it away.`
      );
    }
    const e = entryTool();
    if (e === null) return null;
    const k = keyEntry();
    if (k) {
      const why = k.open ? 'Already open.' : k.problem ? `${k.problem.message}.` : `${enter} opens it.`;
      return `${e.title}: ${describe(k)}. ${why}`;
    }
    const bit = e.capabilities.every((c) => c.step === 'bore')
      ? ' A bit bores studs while you route a cable: the belt’s bit is used.'
      : '';
    return (
      `${e.title}: click an entry on a box or panel to open it, or select one, ` +
      `${key('routing.terminalNext')} to an entry and ${enter}.${bit} Escape puts it away.`
    );
  });

  return {
    session: routingSession,
    phase: computed(() => (routingSession() === null ? null : 'armed')),
    entryDevice,
    hint,
    pull: pull.asReadonly(),
    checkPull,
    confirmPull,
    cancelPull,
    keyEntry: keyEntry.asReadonly(),
    publishSelection,
  };
}
