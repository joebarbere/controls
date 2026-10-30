import { z } from 'zod';
import { NoArgs } from './builtin';

/*
 * Argument schemas of the sim time commands (ADR 0011 §13), declared ahead of the commands
 * themselves: F2.3a registers `sim.setSpeed`, `sim.resume` and `sim.step` (headless) and F2.3b binds
 * them to keys and the HUD. Their ids and these shapes are save format from the moment they are
 * logged (ADR 0011 §12): raising `MAX_STEP_TICKS` or adding a speed needs no bump, lowering or
 * removing one is never allowed. Their JSON Schema is frozen in `world-model`'s
 * `json-schema/command-args/` export, with a staleness check.
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
