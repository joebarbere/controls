import {
  CommandBus,
  CommandRegistry,
  editCommands,
  type ReplayError,
  replayEntries,
  type ReplayTime,
  simCommands,
  viewCommands,
  viewportCommands,
} from '@controls/commands';
import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { createReplayLog, type ReplayLog } from '@controls/save-format';
import { deviceCommands } from './device-commands';
import { entityCommands } from './entity-commands';
import { leadCommands } from './lead-commands';
import { cableCommands } from './wiring/cable-commands';
import { enclosureCommands } from './wiring/enclosure-commands';
import { wireCommands } from './wiring/wire-commands';
import { worldHash } from './hash';
import type { World } from './types';

export interface WorldRegistryOptions {
  /** The device catalogue the world commands resolve refs against (default the built-in one). */
  readonly catalog?: Catalog;
}

/**
 * A registry holding every command a replay log can contain: the world commands (`entity.*`,
 * `lead.*`, `device.operate`, and from world v3 `wire.*`, `cable.*`, `enclosure.openEntry`), `edit.undo` / `edit.redo`, the declared view commands (including the
 * viewport's `view.mode` / `view.focus`) and the sim time commands (`sim.setSpeed`, `sim.resume`,
 * `sim.step`, F2.3a).
 * Headless replay, the sim worker's mirror bus and the UI all start from this, so they agree on every
 * id and argument schema. Hosts may register more commands on top.
 */
export function createWorldRegistry(options: WorldRegistryOptions = {}): CommandRegistry<World> {
  const catalog = options.catalog ?? BUILTIN_CATALOG;
  return new CommandRegistry<World>()
    .registerAll(entityCommands(catalog))
    .registerAll(leadCommands(catalog))
    .registerAll(wireCommands(catalog))
    .registerAll(cableCommands(catalog))
    .registerAll(enclosureCommands(catalog))
    .registerAll(deviceCommands(catalog))
    .registerAll(editCommands<World>())
    .registerAll(viewCommands<World>())
    .registerAll(viewportCommands<World>())
    .registerAll(simCommands<World>());
}

/**
 * A command bus over a world document, starting with an empty history and an empty log whose first
 * entry gets `firstSeq` (default 0; a bus continuing a rebased or restarted log starts at its next seq).
 * It can move time (`advanceTo`, ADR 0011 §3): `{ ...world, tick }`, everything else kept.
 */
export function createWorldBus(
  world: World,
  registry: CommandRegistry<World> = createWorldRegistry(),
  options: { readonly firstSeq?: number } = {},
): CommandBus<World> {
  return new CommandBus<World>({
    registry,
    initialState: world,
    tickOf: (w) => w.tick,
    markAssisted: (w) => (w.assisted ? w : { ...w, assisted: true }),
    withTick: (w, tick) => ({ ...w, tick }),
    firstSeq: options.firstSeq ?? 0,
  });
}

/**
 * The replay log of a session that started from `initialWorld` (for `replay.log` in a save): the
 * bus's entries from its `firstSeq`, ending at the bus's current tick.
 */
export function toReplayLog(initialWorld: World, bus: CommandBus<World>): ReplayLog {
  return createReplayLog(initialWorld, bus.entries, { firstSeq: bus.firstSeq, endTick: bus.currentTick() });
}

export type WorldReplayResult =
  | { readonly ok: true; readonly world: World; readonly hash: string; readonly bus: CommandBus<World> }
  | { readonly ok: false; readonly error: ReplayError };

/**
 * Replays a (validated) replay log from its initial world through a fresh bus, advancing to each
 * entry's tick and then to the log's `endTick` (ADR 0011 §3), and returns the resulting world and its
 * `world.hash`. The bus is returned so a loaded session can continue the same log with the same
 * history. With `time` (the sim engine) the engine follows the replay; without it this is the
 * commanded world only, whose `sim` bags and solution record are the initial world's (inert), so
 * its hash equals the live session's only where no sim state was materialised.
 */
export function replayLog(
  log: ReplayLog,
  registry: CommandRegistry<World> = createWorldRegistry(),
  options: { readonly time?: ReplayTime<World> } = {},
): WorldReplayResult {
  const bus = createWorldBus(log.initialWorld, registry, { firstSeq: log.firstSeq });
  const result = replayEntries(bus, log.entries, { time: options.time, endTick: log.endTick });
  if (!result.ok) return result;
  return { ok: true, world: bus.state, hash: worldHash(bus.state), bus };
}

export type RebaseResult =
  | { readonly ok: true; readonly log: ReplayLog }
  | { readonly ok: false; readonly error: ReplayError | { readonly kind: 'out-of-range'; readonly message: string } };

/**
 * Rebases a (validated) replay log onto the world it reaches after its first `count` entries: the
 * result starts from that world, at `firstSeq + count`, and keeps the rest of the entries and
 * `endTick`. Replaying the rebased log reaches the same world and `world.hash` as replaying the
 * original (ADR 0013), because every change keeps each `sim` bag and `seq`s are unchanged.
 *
 * - **Without `worldAtCut`** the head is replayed and the cut world is the replayed one, whose `sim`
 *   bags and solution record are the log's own (inert): exact only before the engine has run.
 * - **With `worldAtCut`** (ADR 0013's materialised rebase: the world at the cut with the engine's
 *   state written in, what a save's checkpoint holds, P3 D19) the head isn't replayed. The caller
 *   vouches that it is the world the head reaches, materialised at its tick; that tick must lie
 *   between the head's last entry (or the log's start) and the tail's first entry (or `endTick`), and
 *   its seed must be the log's, or the rebase is `out-of-range`.
 *
 * Exact only where no later `edit.undo` or `edit.redo` reaches a change from before the cut, which
 * is always true at a load (the history is cleared then; ADR 0007). The tail is replayed on a cleared
 * history and the rebase is refused (`failed`) if it no longer succeeds. Undo and redo on an empty
 * stack fail and are never logged (ADR 0006), and the cleared stacks are always the top part of the
 * full ones, so an undo or redo that reached across the cut fails there: a rebase that succeeds is
 * exact. Used by saves (the checkpoint rebase, scripting API) and groundwork for the P1 follow-up
 * "the replay log never shrinks" (the cap-triggered rebase is P4).
 */
export function rebaseReplayLog(
  log: ReplayLog,
  count: number,
  worldAtCut: World | null = null,
  registry: CommandRegistry<World> = createWorldRegistry(),
): RebaseResult {
  if (!Number.isInteger(count) || count < 0 || count > log.entries.length) {
    return { ok: false, error: { kind: 'out-of-range', message: `Can't rebase after ${count} entries` } };
  }
  const tail = log.entries.slice(count);
  let initialWorld: World;
  let bus: CommandBus<World>;
  if (worldAtCut !== null) {
    const earliest = count === 0 ? log.initialWorld.tick : log.entries[count - 1].tick;
    const latest = tail.length === 0 ? log.endTick : tail[0].tick;
    if (worldAtCut.seed !== log.initialWorld.seed || worldAtCut.tick < earliest || worldAtCut.tick > latest) {
      return {
        ok: false,
        error: { kind: 'out-of-range', message: `The world at the cut doesn't fit the log after ${count} entries` },
      };
    }
    initialWorld = worldAtCut;
    bus = createWorldBus(worldAtCut, registry, { firstSeq: log.firstSeq + count });
  } else {
    bus = createWorldBus(log.initialWorld, registry, { firstSeq: log.firstSeq });
    const head = replayEntries(bus, log.entries.slice(0, count));
    if (!head.ok) return head;
    initialWorld = bus.state;
    bus.clearHistory();
  }
  const rest = replayEntries(bus, tail);
  if (!rest.ok) return rest;
  return {
    ok: true,
    log: createReplayLog(initialWorld, tail, { firstSeq: log.firstSeq + count, endTick: log.endTick }),
  };
}
