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
import {
  materialiseWorld,
  type SimStart,
  STATE_QUERY_TIMEOUT_MS,
  VERIFY_QUERY_MS_PER_TICK,
} from '@controls/sim-protocol';

/**
 * The deadlines of the one retry of a `world.json` start whose worker failed (#58 review 2): a slow
 * machine waits longer rather than seeing `sim-failed`, so the outcome depends on the simulator, not
 * on wall time. Six times the usual deadline (30 s).
 */
export const START_RETRY_MS = 6 * STATE_QUERY_TIMEOUT_MS;
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

/** The simulator failed starting the save (a crash, a worker that never loaded, a deadline): not the save's fault. */
export interface SimFailedError {
  readonly kind: 'sim-failed';
  readonly message: string;
}

/** Why a save didn't load in the game. */
export type GameLoadError = LoadGameError | SimUnavailableError | SimFailedError;

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

/**
 * How starting a candidate worker went. Only `start-failed` with a reason from the worker (protocol
 * 2) means the save itself is at fault; every other failure is the simulator's (`failed`): a crash, a
 * deadline passed, a worker that never loaded.
 */
type Started =
  | { readonly ok: true; readonly candidate: SimCandidate; readonly hash: string }
  | { readonly ok: false; readonly why: 'unavailable' }
  | { readonly ok: false; readonly why: 'start-failed'; readonly reason: SimStartFailure }
  | { readonly ok: false; readonly why: 'failed' };

const isFailure = (error: unknown): error is SimFailure =>
  typeof error === 'object' && error !== null && 'code' in error && 'beforeReady' in error;

/**
 * Starts a candidate and waits for `ready` (at most `readyMs`) and its state at the world's tick (at
 * most `stateMs`). The candidate is disposed on any failure.
 */
async function started(
  host: SimHost,
  start: SimStart,
  busWorld: World,
  stateMs: number,
  readyMs = STATE_QUERY_TIMEOUT_MS,
): Promise<Started> {
  const candidate = host.prepare(start);
  if (candidate === null) return { ok: false, why: 'unavailable' };
  try {
    await candidate.whenReady(readyMs);
    const reply = await candidate.state(busWorld.tick, stateMs);
    return { ok: true, candidate, hash: worldHash(materialiseWorld(busWorld, reply.export)) };
  } catch (error) {
    candidate.dispose();
    if (isFailure(error) && error.code === 'start-failed' && error.reason !== null) {
      return { ok: false, why: 'start-failed', reason: error.reason };
    }
    return { ok: false, why: 'failed' }; // a crash, a SimQueryRejection (crashed, timeout), a dead worker
  }
}

/**
 * The verification query's deadline: the usual one plus a budget per tick of log, so a slow machine
 * only waits longer and a load's outcome never depends on wall time (#58 review). Should even that
 * pass, verification counts as failed and the log restarts: never a refusal.
 */
export function verifyDeadlineMs(log: {
  readonly endTick: number;
  readonly initialWorld: { readonly tick: number };
}): number {
  return STATE_QUERY_TIMEOUT_MS + (log.endTick - log.initialWorld.tick) * VERIFY_QUERY_MS_PER_TICK;
}

const UNAVAILABLE: SimUnavailableError = {
  kind: 'sim-unavailable',
  message: 'The simulator isn’t available, so the save can’t be checked.',
};

const SIM_FAILED: SimFailedError = {
  kind: 'sim-failed',
  message: 'The simulator failed while starting the save.',
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
      const verified = await started(
        host,
        { kind: 'replay', log: plan.log },
        resumed.game.world() as World,
        verifyDeadlineMs(plan.log),
      );
      if (!verified.ok && verified.why === 'unavailable') return { ok: false, error: UNAVAILABLE };
      if (verified.ok && verified.hash === worldHash(world)) {
        return done(resumed.game, { status: 'continued' }, verified.candidate, verified.hash);
      }
      if (verified.ok) verified.candidate.dispose();
      // A mismatch, or a verifying worker that crashed or passed its deadline (the checker's fault:
      // `verify-unavailable`, never refused): the log isn't kept, the save is (D8).
      replay = verifyFailure(
        plan.compatibility,
        verified.ok ? { kind: 'hash-mismatch' } : { kind: 'verify-unavailable' },
      );
    }
  }

  // A new log from world.json, numbered on from the saved log.
  const firstSeq = log === null ? 0 : log.firstSeq + log.entries.length;
  // D8, as headless (F2.4): another engine's save keeps its devices' state but never its solution
  // record, which another engine's models computed: the worker solves again at the save's tick.
  let start: World = plan.compatibility === 'engine-changed' ? { ...world, sim: null } : world;
  const startFresh = async (): Promise<Started> => {
    const first = await started(host, { kind: 'world', world: start, firstSeq }, start, STATE_QUERY_TIMEOUT_MS);
    if (first.ok || first.why !== 'failed') return first;
    // The simulator failed (a crash, a deadline): once more, with longer deadlines.
    return started(host, { kind: 'world', world: start, firstSeq }, start, START_RETRY_MS, START_RETRY_MS);
  };
  let fresh = await startFresh();
  if (!fresh.ok && fresh.why === 'start-failed' && plan.compatibility !== 'verify') {
    // D8: another engine's solution record may not fit this build's netlist: drop it and solve anew.
    start = { ...world, sim: null };
    fresh = await startFresh();
    if (replay.status === 'restarted' && replay.reason !== 'engine-changed') {
      replay = { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE };
    }
  }
  if (!fresh.ok) {
    if (fresh.why === 'unavailable') return { ok: false, error: UNAVAILABLE };
    if (fresh.why === 'failed') return { ok: false, error: SIM_FAILED }; // twice, the second time with longer deadlines
    // A same-engine save whose solution record doesn't fit its circuit: damaged.
    return {
      ok: false,
      error: {
        kind: 'start-failed',
        reason: fresh.reason,
        message: "The save's simulation state doesn't fit its circuit.",
      },
    };
  }
  const game = createGame({ world: start, registry, time: host.time, firstSeq });
  return done(game, replay, fresh.candidate, fresh.hash);
}
