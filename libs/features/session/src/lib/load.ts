import type { CommandRegistry } from '@controls/commands';
import { type Manifest, readCtrl, type World } from '@controls/save-format';
import {
  ENGINE_CHANGED_MESSAGE,
  type Game,
  createGame,
  type LoadGameError,
  planLoad,
  resumeLogGame,
  type SaveReplayStatus,
  verifyFailure,
} from '@controls/scripting-api';
import type { SimStartFailure } from '@controls/sim-core';
import { materialiseWorld, type SimStart } from '@controls/sim-protocol';
import { checkWorldDevices, worldHash } from '@controls/world-model';
import type { SimCandidate, SimFailure, SimHost } from './sim-host';

/*
 * Loading a save in the game (ADR 0011 §10 "Load", plan F2.3b): a synchronous parse and check, then
 * the sim check in a worker, never on the main thread. The decision to verify is the scripting
 * API's `planLoad` (D8 and `MAX_VERIFY_TICKS`), exactly as the headless `gameFromSave` makes it:
 *
 * 1. `readCtrl` and the device check (`invalid-device-state`);
 * 2. `restart` plans (no log, another engine, too long to verify) start a worker from `world.json`;
 * 3. `verify` plans replay the log on the main thread for the commanded state only (cheap), start a
 *    worker with a replay start, and compare the materialised hash at `endTick` with `world.json`'s;
 * 4. on a match that worker carries on; otherwise it is terminated and one starts from `world.json`
 *    with the log restarted. A same-engine save whose solution record doesn't fit is refused
 *    (`start-failed`); another engine's misfit record is dropped (D8).
 *
 * Nothing replaces the session until {@link Session.adopt} takes the result.
 */

/** The game has no sim worker to check the save with (no factory: a spec without one). */
export interface SimUnavailableError {
  readonly kind: 'sim-unavailable';
  readonly message: string;
}

/** Why a save didn't load in the game. */
export type GameLoadError = LoadGameError | SimUnavailableError;

/** A save checked and ready to adopt: its game, the worker that carries on, and the baseline hash. */
export interface PreparedLoad {
  readonly game: Game;
  readonly manifest: Manifest;
  readonly thumbnail: Uint8Array | null;
  readonly fromVersion: number;
  readonly replay: SaveReplayStatus;
  /** `world.hash` of the game as adopted, from its own worker: the dirty model's baseline. */
  readonly hash: string;
  /** @internal the worker that becomes the game's on adopt. */
  readonly candidate: SimCandidate;
  /** Terminates the worker (a checked save that isn't adopted after all). */
  dispose(): void;
}

export type PrepareLoadResult =
  { readonly ok: true; readonly prepared: PreparedLoad } | { readonly ok: false; readonly error: GameLoadError };

const START_FAILURES: readonly SimStartFailure[] = [
  'solution-on-empty-netlist',
  'topology-mismatch',
  'length-mismatch',
];

/** The start failure a worker reported (its message names the reason, never a value). */
function startFailure(failure: SimFailure): SimStartFailure {
  return START_FAILURES.find((reason) => failure.message.includes(reason)) ?? 'topology-mismatch';
}

const isFailure = (error: unknown): error is SimFailure =>
  typeof error === 'object' && error !== null && 'code' in error && 'beforeReady' in error;

/** Starts a candidate and waits for `ready` and its state at `tick`; `null` with the failure otherwise. */
async function started(
  host: SimHost,
  start: SimStart,
  busWorld: World,
): Promise<
  | { readonly ok: true; readonly candidate: SimCandidate; readonly hash: string }
  | { readonly ok: false; readonly failure: SimFailure | null }
> {
  const candidate = host.prepare(start);
  if (candidate === null) return { ok: false, failure: null };
  try {
    await candidate.ready;
    const reply = await candidate.state(busWorld.tick);
    return { ok: true, candidate, hash: worldHash(materialiseWorld(busWorld, reply.export)) };
  } catch (error) {
    candidate.dispose();
    return { ok: false, failure: isFailure(error) ? error : null };
  }
}

const UNAVAILABLE: SimUnavailableError = {
  kind: 'sim-unavailable',
  message: 'The simulator isn’t available, so the save can’t be checked.',
};

/** Checks `bytes` as a save and starts its sim worker, without touching the session. Never throws. */
export async function prepareLoad(
  bytes: Uint8Array,
  options: { readonly registry: CommandRegistry<World>; readonly host: SimHost },
): Promise<PrepareLoadResult> {
  const { registry, host } = options;
  const read = readCtrl(bytes);
  if (!read.ok) return { ok: false, error: read.error };
  const contents = read.value;
  const { world, replayLog: log, manifest } = contents;
  const devices = checkWorldDevices(world);
  if (devices.length > 0) {
    return {
      ok: false,
      error: {
        kind: 'invalid-device-state',
        issues: devices,
        message: "The save's device state doesn't match the device catalogue.",
      },
    };
  }
  const done = (game: Game, replay: SaveReplayStatus, candidate: SimCandidate, hash: string): PrepareLoadResult => ({
    ok: true,
    prepared: {
      game,
      manifest,
      thumbnail: contents.thumbnail,
      fromVersion: contents.fromVersion,
      replay,
      hash,
      candidate,
      dispose: () => candidate.dispose(),
    },
  });

  const plan = planLoad(contents);
  let replay: SaveReplayStatus;
  if (plan.kind === 'restart') {
    replay = plan.replay;
  } else {
    // The commanded state on the main thread (no engine), then the sim check in a worker.
    const resumed = resumeLogGame(plan.log, { registry, time: host.time });
    if (!resumed.ok) {
      replay = verifyFailure(plan.compatibility, { kind: 'replay-failed', message: resumed.error.message });
    } else {
      const verified = await started(host, { kind: 'replay', log: plan.log }, resumed.game.world() as World);
      if (verified.ok && verified.hash === worldHash(world)) {
        return done(resumed.game, { status: 'continued' }, verified.candidate, verified.hash);
      }
      if (verified.ok) verified.candidate.dispose();
      if (!verified.ok && verified.failure === null) return { ok: false, error: UNAVAILABLE };
      replay = verifyFailure(
        plan.compatibility,
        verified.ok
          ? { kind: 'hash-mismatch' }
          : { kind: 'replay-failed', message: 'The simulator couldn’t replay the save’s log.' },
      );
    }
  }

  // A new log from world.json, numbered on from the saved log.
  const firstSeq = log === null ? 0 : log.firstSeq + log.entries.length;
  let start = world;
  let fresh = await started(host, { kind: 'world', world: start, firstSeq }, start);
  if (!fresh.ok) {
    if (fresh.failure === null) return { ok: false, error: UNAVAILABLE };
    if (fresh.failure.code !== 'start-failed' || plan.compatibility === 'verify') {
      return {
        ok: false,
        error: {
          kind: 'start-failed',
          reason: startFailure(fresh.failure),
          message: "The save's simulation state doesn't fit its circuit.",
        },
      };
    }
    // D8: another engine's solution record may not fit this build's netlist: drop it and solve anew.
    start = { ...world, sim: null };
    fresh = await started(host, { kind: 'world', world: start, firstSeq }, start);
    if (!fresh.ok) return { ok: false, error: UNAVAILABLE };
    if (replay.status === 'restarted' && replay.reason !== 'engine-changed') {
      replay = { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE };
    }
  }
  const game = createGame({ world: start, registry, time: host.time, firstSeq });
  return done(game, replay, fresh.candidate, fresh.hash);
}
