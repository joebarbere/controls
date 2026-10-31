import { defineViewCommand, NoArgs } from './builtin';
import type { AnyCommandDef, CommandDef } from './command';

/*
 * The game host's sim commands and context keys (F2.3b, ADR 0011 §10, §13). `sim.restart` restarts a
 * crashed sim worker from the session's replay log. Like `file.*` it is an **unlogged UI command**
 * registered by the game host (`Session`), never by `createWorldRegistry()`: a headless game has no
 * worker to restart, and a restart changes nothing a replay needs.
 */

/** Context key: the sim's status (`none`, `starting`, `running`, `paused`, `suspended`, `crashed`, `unavailable`). */
export const SIM_STATUS_KEY = 'sim.status';
/** Context key: the requested speed is 0 (`sim.setSpeed {speed: 0}`). */
export const SIM_PAUSED_KEY = 'sim.paused';
/** Context key: the requested speed (0, 1, 10 or 60). */
export const SIM_SPEED_KEY = 'sim.speed';

/** The id of the host's restart command. */
export const SIM_RESTART_COMMAND = 'sim.restart';

/** `sim.restart`: starts a new sim worker that replays the session's log to the current tick, paused. */
export function simRestartCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: SIM_RESTART_COMMAND,
    title: 'Restart simulation',
    category: 'Sim',
    args: NoArgs,
    when: `${SIM_STATUS_KEY} == 'crashed'`,
    logged: false,
  });
}

/** The game host's sim commands (`sim.restart`), for its registry next to `fileCommands()`. */
export function simHostCommands<S>(): AnyCommandDef<S>[] {
  return [simRestartCommand<S>()];
}
