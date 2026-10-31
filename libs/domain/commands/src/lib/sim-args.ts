import { z } from 'zod';
import { NoArgs } from './builtin';
import { type AnyCommandDef, defineCommand, succeed } from './command';
import { SESSION_ACTIVE_KEY } from './file';
import type { BindingDecl } from './keybindings/keymap';
import { SIM_PAUSED_KEY, SIM_STATUS_KEY } from './sim-host';

/*
 * The sim time commands (ADR 0011 §13) and their argument schemas. F2.3a declares `sim.setSpeed`,
 * `sim.resume` and `sim.step` here, in domain code, so every registry (headless, the game, the sim
 * worker's mirror bus) knows them; F2.3b binds them to keys and the HUD. Their ids and these shapes
 * are save format from the moment they are logged (ADR 0011 §12): raising `MAX_STEP_TICKS` or adding
 * a speed needs no bump, lowering or removing one is never allowed. Their JSON Schema is frozen in
 * `world-model`'s `json-schema/command-args/` export, with a staleness check.
 *
 * There is no `sim.pause`: pausing is `sim.setSpeed {speed: 0}` (ADR 0011, R2).
 */

/** The sim speeds (spec §4.3): 0 (paused), 1×, 10× and 60×. */
export const SIM_SPEEDS = [0, 1, 10, 60] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];

/** Longest `sim.step` in ticks (1 tick = 1 ms): 10 minutes. A step can't be cancelled (ADR 0011 §2). */
export const MAX_STEP_TICKS = 600_000;

/** `sim.step`'s default: 1 s of sim time (ADR 0011 §2). */
export const DEFAULT_STEP_TICKS = 1_000;

/**
 * `sim.setSpeed {speed}`: `z.literal` of the speeds, so its JSON Schema is one `enum` (a union of
 * literals would give `anyOf`, which the palette's forms refuse).
 */
export const SimSetSpeedArgs = z.strictObject({
  speed: z.literal(SIM_SPEEDS).meta({
    title: 'Speed',
    description: '0 pauses; 1, 10 or 60 runs at that multiple of real time',
  }),
});
export type SimSetSpeedArgs = z.infer<typeof SimSetSpeedArgs>;

/** `sim.resume {}`: restores the last non-zero speed (1× by default). */
export const SimResumeArgs = NoArgs;
export type SimResumeArgs = z.infer<typeof SimResumeArgs>;

/** `sim.step {ticks}`: advances sim time by an exact number of ticks, 1 to {@link MAX_STEP_TICKS}. */
export const SimStepArgs = z.strictObject({
  ticks: z.int().min(1).max(MAX_STEP_TICKS).default(DEFAULT_STEP_TICKS).meta({ title: 'Sim time (ms)' }),
});
export type SimStepArgs = z.infer<typeof SimStepArgs>;

/** The sim commands' argument schemas, by command id (for the save-format export and their tests). */
export const SIM_COMMAND_ARGS: Readonly<Record<'sim.setSpeed' | 'sim.resume' | 'sim.step', z.ZodType>> = {
  'sim.setSpeed': SimSetSpeedArgs,
  'sim.resume': SimResumeArgs,
  'sim.step': SimStepArgs,
};

/** The id of `sim.step`, which a time host carries out by advancing (`Game.exec`, ADR 0011 §3). */
export const SIM_STEP_COMMAND = 'sim.step';

/**
 * The time keys' `when` (ADR 0011 §13): a game is in progress and its sim hasn't crashed. Headless
 * runs are unaffected (`exec` never evaluates `when`).
 */
export const SIM_TIME_WHEN = `${SESSION_ACTIVE_KEY} && ${SIM_STATUS_KEY} != 'crashed'`;

/** Binding ids of the time keys (settings `controls.keybindings` keys; stable, like command ids). */
export const SIM_PAUSE_BINDING = 'sim.setSpeed.pause';
export const SIM_SPEED_1_BINDING = 'sim.setSpeed.x1';
export const SIM_SPEED_10_BINDING = 'sim.setSpeed.x10';
export const SIM_SPEED_60_BINDING = 'sim.setSpeed.x60';
export const SIM_STEP_SHORT_BINDING = 'sim.step.short';
export const SIM_STEP_LONG_BINDING = 'sim.step.long';

/** `sim.step`'s short and long keyed steps, in ticks (game-design choices: 10 ms, one solve; 1 s). */
export const SIM_STEP_SHORT_TICKS = 10;
export const SIM_STEP_LONG_TICKS = 1_000;

function speedBinding(id: string, title: string, speed: SimSpeed, chord: string, when = SIM_TIME_WHEN): BindingDecl {
  return {
    id,
    title,
    category: 'Sim',
    target: { kind: 'command', command: 'sim.setSpeed', args: { speed } },
    defaults: [chord],
    when,
  };
}

/**
 * The sim time commands. Each is logged and never changes the world: its `run` succeeds with no
 * change, so it leaves the undo and redo stacks alone (time passing is not a change, ADR 0011 §3).
 * The effect is the time host's: a headless game advances by `sim.step`'s ticks right after the
 * command is logged (so the next line is stamped at the new tick), and `sim.setSpeed` and
 * `sim.resume` are no-ops headless (pacing is the game's, F2.3b). On replay none of them moves time:
 * the next entry's tick, or the log's `endTick`, carries a step's effect.
 */
export function simCommands<S>(): AnyCommandDef<S>[] {
  // `P` toggles: pause while running, resume while paused (two bindings on disjoint `when`s, so the
  // log always says which, ADR 0011 R2). Space is avoided: it would hijack focused buttons.
  const setSpeed = defineCommand<SimSetSpeedArgs, S>({
    id: 'sim.setSpeed',
    title: 'Set sim speed',
    category: 'Sim',
    args: SimSetSpeedArgs,
    undoable: false,
    when: SIM_TIME_WHEN,
    bindings: [
      speedBinding(SIM_PAUSE_BINDING, 'Pause the sim (toggle)', 0, 'P', `${SIM_TIME_WHEN} && !${SIM_PAUSED_KEY}`),
      speedBinding(SIM_SPEED_1_BINDING, 'Sim speed 1×', 1, 'Shift+1'),
      speedBinding(SIM_SPEED_10_BINDING, 'Sim speed 10×', 10, 'Shift+2'),
      speedBinding(SIM_SPEED_60_BINDING, 'Sim speed 60×', 60, 'Shift+3'),
    ],
    run: () => succeed<S>(),
  });
  const resume = defineCommand<SimResumeArgs, S>({
    id: 'sim.resume',
    title: 'Resume the sim',
    category: 'Sim',
    args: SimResumeArgs,
    undoable: false,
    when: `${SIM_TIME_WHEN} && ${SIM_PAUSED_KEY}`,
    keybinding: 'P',
    run: () => succeed<S>(),
  });
  const step = defineCommand<SimStepArgs, S>({
    id: SIM_STEP_COMMAND,
    title: 'Step sim time',
    category: 'Sim',
    args: SimStepArgs,
    undoable: false,
    when: SIM_TIME_WHEN,
    bindings: [
      {
        id: SIM_STEP_SHORT_BINDING,
        title: 'Step 10 ms',
        category: 'Sim',
        target: { kind: 'command', command: SIM_STEP_COMMAND, args: { ticks: SIM_STEP_SHORT_TICKS } },
        defaults: ['Period'],
        when: SIM_TIME_WHEN,
      },
      {
        id: SIM_STEP_LONG_BINDING,
        title: 'Step 1 s',
        category: 'Sim',
        target: { kind: 'command', command: SIM_STEP_COMMAND, args: { ticks: SIM_STEP_LONG_TICKS } },
        defaults: ['Shift+Period'],
        when: SIM_TIME_WHEN,
      },
    ],
    run: () => succeed<S>(),
  });
  return [setSpeed, resume, step];
}
