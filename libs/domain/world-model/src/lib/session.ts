import {
  CommandBus,
  CommandRegistry,
  editCommands,
  type ReplayError,
  replayEntries,
  viewCommands,
} from '@controls/commands';
import { createReplayLog, type ReplayLog } from '@controls/save-format';
import { entityCommands } from './entity-commands';
import { worldHash } from './hash';
import type { World } from './types';

/**
 * A registry holding every command a replay log can contain: the world commands, `edit.undo` /
 * `edit.redo` and the declared view commands. Headless replay and the UI both start from this,
 * so they agree on every id and argument schema. Hosts may register more commands on top.
 */
export function createWorldRegistry(): CommandRegistry<World> {
  return new CommandRegistry<World>()
    .registerAll(entityCommands())
    .registerAll(editCommands<World>())
    .registerAll(viewCommands<World>());
}

/** A command bus over a world document, starting with an empty history and an empty log. */
export function createWorldBus(
  world: World,
  registry: CommandRegistry<World> = createWorldRegistry(),
): CommandBus<World> {
  return new CommandBus<World>({
    registry,
    initialState: world,
    tickOf: (w) => w.tick,
    markAssisted: (w) => (w.assisted ? w : { ...w, assisted: true }),
  });
}

/** The replay log of a session that started from `initialWorld` (for `replay.log` in a save). */
export function toReplayLog(initialWorld: World, bus: CommandBus<World>): ReplayLog {
  return createReplayLog(initialWorld, bus.entries);
}

export type WorldReplayResult =
  | { readonly ok: true; readonly world: World; readonly hash: string; readonly bus: CommandBus<World> }
  | { readonly ok: false; readonly error: ReplayError };

/**
 * Replays a (validated) replay log from its initial world through a fresh bus and returns the
 * resulting world and its `world.hash`, which equals the live session's (ADR 0006). The bus is
 * returned so a loaded session can continue the same log with the same history.
 */
export function replayLog(log: ReplayLog, registry: CommandRegistry<World> = createWorldRegistry()): WorldReplayResult {
  const bus = createWorldBus(log.initialWorld, registry);
  const result = replayEntries(bus, log.entries);
  if (!result.ok) return result;
  return { ok: true, world: bus.state, hash: worldHash(bus.state), bus };
}
