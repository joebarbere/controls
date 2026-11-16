import * as z from 'zod';
import type { AnyCommandDef, CommandDef } from './command';
import {
  cableRefMeta,
  connectionRefMeta,
  entityRefMeta,
  SELECTION_CABLE_ID_KEY,
  SELECTION_CONNECTION_ID_KEY,
} from './arg-hints';
import { defineViewCommand } from './builtin';
import { VIEWPORT_FOCUSED_KEY } from './keybindings/input-actions';

/*
 * The cable prompts' keys (F3.2 part 4): open the strip prompt for a cable, start landing a cable
 * conductor's free end, or open the label prompt for a wire or cable. Like `routing.*` they are UI
 * chrome (`logged: false`): each opens a prompt or a picking mode in `feature-workspace`, whose
 * outcome is the world command (`cable.strip`, `wire.land`, `wire.label` / `cable.label`), logged once.
 * Their ids are settings keys (bindings), so keep them stable. The workspace applies them through
 * `Session.onCommand`.
 */

/** Context key: `true` while the world holds at least one cable (the strip prompt has something to strip). */
export const WIRING_CABLES_KEY = 'wiring.cables';
/** Context key: `true` while some cable conductor has a free end (landing has something to land). */
export const WIRING_FREE_ENDS_KEY = 'wiring.freeEnds';
/** Context key: `true` while the world holds a conductor or a cable (something to label). */
export const WIRING_WIRES_KEY = 'wiring.wires';
/** Context key: the cable the strip key strips: the selected cable, or the selected conductor's cable. */
export const WIRING_STRIP_TARGET_KEY = 'wiring.stripTarget';
/** Context key: `true` while the world holds a conduit part (stick, elbow or connector): something to pull through. */
export const WIRING_CONDUITS_KEY = 'wiring.conduits';
/**
 * Context key: the conduit part the pull key pulls through (F3.4 part 2): the selected entity when it is
 * a conduit part, or an enclosure with a conduit connector in one of its entries.
 */
export const WIRING_PULL_TARGET_KEY = 'wiring.pullTarget';

const Id = z.int().min(1);

export const WiringStripArgs = z.strictObject({ id: Id.meta({ ...cableRefMeta, title: 'Cable' }) });
export type WiringStripArgs = z.infer<typeof WiringStripArgs>;

export const WiringLandArgs = z.strictObject({ id: Id.meta({ ...connectionRefMeta, title: 'Conductor' }) });
export type WiringLandArgs = z.infer<typeof WiringLandArgs>;

export const WiringLabelArgs = z.strictObject({
  wire: Id.nullable()
    .default(null)
    .meta({ ...connectionRefMeta, title: 'Wire', description: 'A conductor to label (or leave empty)' }),
  cable: Id.nullable()
    .default(null)
    .meta({ ...cableRefMeta, title: 'Cable', description: 'A cable to label (or leave empty)' }),
});
export type WiringLabelArgs = z.infer<typeof WiringLabelArgs>;

export const WiringPullArgs = z.strictObject({
  conduit: Id.meta({
    ...entityRefMeta,
    title: 'Conduit',
    description: 'A conduit part of the run (a stick, elbow or connector), or a box with a connector in an entry',
  }),
});
export type WiringPullArgs = z.infer<typeof WiringPullArgs>;

const viewportAnd = (when: string): string => `${VIEWPORT_FOCUSED_KEY} && ${when}`;

/** `wiring.strip {id}` (J on a selected cable or its conductor): opens the strip prompt for cable `id`. */
export function wiringStripCommand<S>(): CommandDef<WiringStripArgs, S> {
  return defineViewCommand<WiringStripArgs, S>({
    id: 'wiring.strip',
    title: 'Strip a cable jacket…',
    category: 'Wiring',
    args: WiringStripArgs,
    when: WIRING_CABLES_KEY,
    bindings: [
      {
        id: 'wiring.strip.selection',
        title: 'Strip the selected cable',
        category: 'Wiring',
        target: { kind: 'command', command: 'wiring.strip', args: {}, contextArgs: { id: WIRING_STRIP_TARGET_KEY } },
        defaults: ['J'],
        when: viewportAnd(WIRING_STRIP_TARGET_KEY),
      },
    ],
    logged: false,
  });
}

/**
 * `wiring.land {id}` (L on a selected conductor): starts landing conductor `id`'s free end: the next
 * terminal picked (click, or Tab and Enter) opens its termination prompt, and the prompt logs one
 * `wire.land`.
 */
export function wiringLandCommand<S>(): CommandDef<WiringLandArgs, S> {
  return defineViewCommand<WiringLandArgs, S>({
    id: 'wiring.land',
    title: 'Land a cable conductor…',
    category: 'Wiring',
    args: WiringLandArgs,
    when: WIRING_FREE_ENDS_KEY,
    bindings: [
      {
        id: 'wiring.land.selection',
        title: 'Land the selected conductor',
        category: 'Wiring',
        target: {
          kind: 'command',
          command: 'wiring.land',
          args: {},
          contextArgs: { id: SELECTION_CONNECTION_ID_KEY },
        },
        defaults: ['L'],
        when: viewportAnd(SELECTION_CONNECTION_ID_KEY),
      },
    ],
    logged: false,
  });
}

/**
 * `wiring.label {wire, cable}` (Shift+L on a selected wire or cable): opens the label-maker prompt for
 * conductor `wire` or cable `cable` (one of them; with neither, the selection), which logs one
 * `wire.label` or `cable.label`.
 */
export function wiringLabelCommand<S>(): CommandDef<WiringLabelArgs, S> {
  return defineViewCommand<WiringLabelArgs, S>({
    id: 'wiring.label',
    title: 'Label a wire or cable…',
    category: 'Wiring',
    args: WiringLabelArgs,
    when: WIRING_WIRES_KEY,
    bindings: [
      {
        id: 'wiring.label.selection',
        title: 'Label the selected wire or cable',
        category: 'Wiring',
        target: { kind: 'command', command: 'wiring.label', args: {} },
        defaults: ['Shift+L'],
        when: viewportAnd(`(${SELECTION_CONNECTION_ID_KEY} || ${SELECTION_CABLE_ID_KEY})`),
      },
    ],
    logged: false,
  });
}

/**
 * `wiring.pull {conduit}` (U on a selected conduit part, F3.4 part 2): opens the fish tape prompt for the
 * conduit run through `conduit`: choose the conductors, then feed the tape (the minigame, D10). Only a
 * successful pull logs its one `wire.pull`; skipping (Trainee) logs the same arguments.
 */
export function wiringPullCommand<S>(): CommandDef<WiringPullArgs, S> {
  return defineViewCommand<WiringPullArgs, S>({
    id: 'wiring.pull',
    title: 'Fish tape: pull wires through conduit…',
    category: 'Wiring',
    args: WiringPullArgs,
    when: WIRING_CONDUITS_KEY,
    bindings: [
      {
        id: 'wiring.pull.selection',
        title: 'Pull wires through the selected conduit run',
        category: 'Wiring',
        target: {
          kind: 'command',
          command: 'wiring.pull',
          args: {},
          contextArgs: { conduit: WIRING_PULL_TARGET_KEY },
        },
        defaults: ['U'],
        when: viewportAnd(WIRING_PULL_TARGET_KEY),
      },
    ],
    logged: false,
  });
}

/** The cable prompts' commands, for registering with any state type (world registries add them). */
export function wiringCommands<S>(): AnyCommandDef<S>[] {
  return [wiringStripCommand<S>(), wiringLandCommand<S>(), wiringLabelCommand<S>(), wiringPullCommand<S>()];
}
