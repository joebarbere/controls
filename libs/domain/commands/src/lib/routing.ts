import type { AnyCommandDef, CommandDef } from './command';
import { defineViewCommand, NoArgs } from './builtin';
import { VIEWPORT_FOCUSED_KEY } from './keybindings/input-actions';

/*
 * The routing gesture's keys (F3.2 part 3, ADR 0017 §9, ADR 0010's measured design). The gesture
 * itself is UI state in `feature-workspace` (the spool on the belt, the first terminal, the waypoints
 * so far); only its outcome, one `wire.add`, is a world command. These commands step the gesture from
 * the keyboard, the palette or the console. They are UI chrome, so `logged: false`: they never enter
 * the replay log and their ids are not save format (their binding ids are settings keys, so keep them
 * stable). The workspace applies them through `Session.onCommand`.
 *
 * Tab and Shift+Tab are reserved for focus (a player can't bind them), but these defaults may use them
 * because their `when` holds only while the viewport has focus, a spool is armed and a device with
 * terminals is in hand: anywhere else Tab still moves focus. Escape cancels through the renderer's
 * `clearSelection` input action (the fixed "back" key), which reports a `cancel` routing event.
 */

/** Context key: `true` while a routable spool (a conductor) is the active tool-belt slot. */
export const ROUTING_ACTIVE_KEY = 'routing.active';
/** Context key: `true` once the route's first terminal is picked. */
export const ROUTING_STARTED_KEY = 'routing.started';
/** Context key: the entity id whose terminals Tab cycles while routing (selected, focused, keyboard or hovered). */
export const ROUTING_TERMINAL_DEVICE_KEY = 'routing.terminalDevice';
/**
 * Context key: the view target (`entity-<id>`) the zoom key frames while routing, set only while the
 * device under the pointer has a terminal pitch under 24 CSS px (WCAG 2.2 SC 2.5.8).
 */
export const ROUTING_ZOOM_TARGET_KEY = 'routing.zoomTarget';

/** Binding id of the zoom key (on `view.focus`; a settings key, stable). */
export const VIEW_FOCUS_TERMINALS_BINDING = 'view.focus.terminals';

const viewportAnd = (when: string): string => `${VIEWPORT_FOCUSED_KEY} && ${when}`;

/** `routing.terminalNext` (Tab): the keyboard's terminal moves to the next terminal of the device in hand. */
export function routingTerminalNextCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'routing.terminalNext',
    title: 'Next terminal',
    category: 'Wiring',
    args: NoArgs,
    when: ROUTING_TERMINAL_DEVICE_KEY,
    bindings: [
      {
        id: 'routing.terminalNext',
        title: 'Next terminal (while routing)',
        category: 'Wiring',
        target: { kind: 'command', command: 'routing.terminalNext', args: {} },
        defaults: ['Tab'],
        when: viewportAnd(ROUTING_TERMINAL_DEVICE_KEY),
      },
    ],
    logged: false,
  });
}

/** `routing.terminalPrevious` (Shift+Tab): the keyboard's terminal moves back. */
export function routingTerminalPreviousCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'routing.terminalPrevious',
    title: 'Previous terminal',
    category: 'Wiring',
    args: NoArgs,
    when: ROUTING_TERMINAL_DEVICE_KEY,
    bindings: [
      {
        id: 'routing.terminalPrevious',
        title: 'Previous terminal (while routing)',
        category: 'Wiring',
        target: { kind: 'command', command: 'routing.terminalPrevious', args: {} },
        defaults: ['Shift+Tab'],
        when: viewportAnd(ROUTING_TERMINAL_DEVICE_KEY),
      },
    ],
    logged: false,
  });
}

/**
 * `routing.back` (Backspace): removes the route's last waypoint, or with none un-picks the first
 * terminal. Its `when` needs `routing.started`, so it is provably disjoint from Backspace's
 * `entity.delete.selection` (which needs `!routing.started`): Backspace never deletes the device you are
 * wiring, while a player with a spool merely armed can still delete a selected device.
 */
export function routingBackCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'routing.back',
    title: 'Step back in the route',
    category: 'Wiring',
    args: NoArgs,
    when: `${ROUTING_ACTIVE_KEY} && ${ROUTING_STARTED_KEY}`,
    bindings: [
      {
        id: 'routing.back',
        title: 'Step back in the route (the last waypoint, then the first terminal)',
        category: 'Wiring',
        target: { kind: 'command', command: 'routing.back', args: {} },
        defaults: ['Backspace'],
        when: viewportAnd(`${ROUTING_ACTIVE_KEY} && ${ROUTING_STARTED_KEY}`),
      },
    ],
    logged: false,
  });
}

/**
 * `routing.cancel`: drops the route in progress (the spool stays armed), or with none puts the spool
 * away, as Escape does on the canvas. No default key: Escape is reserved, and on the canvas it reaches
 * the gesture through the renderer. Here for the palette and the console.
 */
export function routingCancelCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'routing.cancel',
    title: 'Cancel the route',
    category: 'Wiring',
    args: NoArgs,
    when: ROUTING_ACTIVE_KEY,
    logged: false,
  });
}

/** The routing gesture's commands, for registering with any state type (world registries add them). */
export function routingCommands<S>(): AnyCommandDef<S>[] {
  return [
    routingTerminalNextCommand<S>(),
    routingTerminalPreviousCommand<S>(),
    routingBackCommand<S>(),
    routingCancelCommand<S>(),
  ];
}
