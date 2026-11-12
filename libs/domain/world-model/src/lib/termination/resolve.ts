import {
  type AccessoryDefinition,
  type ConductorStranding,
  type TerminalMethodSpec,
  terminationMethod,
  type ToolDefinition,
  type ToolDie,
  type ToolHole,
} from '@controls/catalog';
import type { CatalogRef, TerminationV3 } from '@controls/save-format';
import { deriveStream, type Sfc32, terminationStreamKey } from '../prng';

/*
 * What a landing makes (ADR 0015, "TerminationV3 and TerminationArgs"; D8, D9): the outcome of the
 * tool steps, resolved once when the end is landed and stored in the world. Never a contact
 * resistance (the engine computes that from the outcome, ADR 0018), and `world-model` never needs
 * `sim-core`.
 *
 * Pure, and held to the D6 rule (only `+ − × ÷`, `Math.sqrt`, `min`/`max`/`floor`/`ceil`): an outcome
 * is a function of the arguments, the catalogue data and the termination's own streams
 * (`termination:<id>:strip`, `:crimp`, `:clamp`), each step drawing at most once from its own stream,
 * so no outcome depends on how many draws another step made. Keyed by the world-allocated termination
 * id, the same circuit wired from any surface draws the same outcomes. Golden vectors in
 * `resolve.spec.ts` freeze it at v0.4.0; after that a changed outcome is a new method id or a
 * versioned resolver, never a silent edit.
 *
 * The numbers below are **game-design, provisional**: they are decided in the F3.3 part 1 PR
 * (`sim-engine-engineer` with `electrical-realism-reviewer`), which re-pins the golden vectors;
 * otherwise they freeze as game-design at v0.4.0 (ADR 0015 implementation note 11). The rules they follow are fixed here: the right hole nicks nothing,
 * a smaller one nicks more per gauge step; the right die crimps fully (1), another die less; a torque
 * driver lands within its stated accuracy of its setting; a plain screwdriver lands with a seeded
 * spread around the specified torque.
 */

/** A conductor as a termination sees it: its integer AWG designation and how it is made. */
export interface TerminationConductor {
  readonly awg: number;
  readonly stranding: ConductorStranding;
}

/** One landing's tool steps as a surface sends them (the logged argument, ADR 0015). */
export interface TerminationArgs {
  readonly method: string;
  readonly strip: { readonly tool: CatalogRef; readonly hole: string; readonly lengthMm: number };
  readonly accessory: { readonly ref: CatalogRef; readonly tool: CatalogRef; readonly die: string } | null;
  readonly clamp: { readonly tool: CatalogRef | null; readonly torqueNm: number | null };
}

/** `'auto'` (Trainee only, D9) or the explicit steps. */
export type TerminationArg = 'auto' | TerminationArgs;

/** The catalogue data each named step resolved to (checked by the command before resolving). */
export interface TerminationTools {
  readonly strip: { readonly tool: ToolDefinition; readonly hole: ToolHole };
  readonly accessory: {
    readonly accessory: AccessoryDefinition;
    readonly tool: ToolDefinition;
    readonly die: ToolDie;
  } | null;
  /** The clamp tool, or `null` for a method without a clamp torque. */
  readonly clamp: ToolDefinition | null;
}

/** The termination's own streams, one per command-time step (ADR 0015, "PRNG stream keys"). */
export interface TerminationStreams {
  strip(): Sfc32;
  crimp(): Sfc32;
  clamp(): Sfc32;
}

/** The stream key of one step of termination `id`: `termination:<id>:strip`, `:crimp` or `:clamp`. */
export function terminationStepKey(id: number, step: 'strip' | 'crimp' | 'clamp'): string {
  return `${terminationStreamKey(id)}:${step}`;
}

/** The streams of termination `id` in a world with `seed`, each derived only when its step draws. */
export function terminationStreams(seed: number, id: number): TerminationStreams {
  return {
    strip: () => deriveStream(seed, terminationStepKey(id, 'strip')),
    crimp: () => deriveStream(seed, terminationStepKey(id, 'crimp')),
    clamp: () => deriveStream(seed, terminationStepKey(id, 'clamp')),
  };
}

/** game-design, provisional (F3.3 part 1 decides): area lost per AWG step a strip hole is too small. */
export const NICK_FRACTION_PER_AWG_STEP = 0.15;
/** game-design, provisional: area lost to a hole cut for the other stranding (and not too large). */
export const NICK_FRACTION_STRANDING_MISMATCH = 0.05;
/** game-design, provisional: a nick's seeded spread, a factor in [1 − s, 1 + s). */
export const NICK_SPREAD = 0.25;
/** game-design, provisional: crimp quality with a die the accessory doesn't list (an under-crimp). */
export const WRONG_DIE_CRIMP_QUALITY = 0.5;
/** game-design, provisional: quality lost per AWG step the conductor lies outside the die's range. */
export const CRIMP_QUALITY_PER_AWG_STEP = 0.2;
/** game-design, provisional: an imperfect crimp's seeded spread, a factor in (1 − s, 1]. */
export const CRIMP_SPREAD = 0.1;
/**
 * game-design, provisional (ADR 0015 Review, content: "a field-study source for the screwdriver
 * spread, or game-design"): a plain screwdriver lands within ±40 % of the specified torque.
 */
export const SCREWDRIVER_TORQUE_SPREAD = 0.4;

/** The ideal outcome `'auto'` makes: the method at its nominal strip and torque, no nicks, no accessory. */
export function autoTermination(id: number, spec: TerminalMethodSpec): TerminationV3 {
  return {
    id,
    method: spec.method,
    auto: true,
    stripLengthMm: spec.stripLengthMm.nominal,
    nickedStrandFraction: 0,
    torqueNm: spec.torqueNm,
    accessory: null,
  };
}

/** The share of the conductor's area a strip hole nicks (before the spread): 0 for the right hole. */
export function nickBase(hole: ToolHole, conductor: TerminationConductor): number {
  const steps = hole.awg - conductor.awg; // > 0: a hole for a thinner conductor
  if (steps < 0) return 0;
  const mismatch = hole.stranding === conductor.stranding ? 0 : NICK_FRACTION_STRANDING_MISMATCH;
  return Math.min(1, steps * NICK_FRACTION_PER_AWG_STEP + mismatch);
}

/** How many AWG steps `awg` lies outside `range` (0 inside it). */
function stepsOutside(awg: number, range: { readonly smallest: number; readonly largest: number }): number {
  if (awg > range.smallest) return awg - range.smallest;
  if (awg < range.largest) return range.largest - awg;
  return 0;
}

/** The crimp quality (before the spread): 1 for a die the accessory lists that covers the conductor. */
export function crimpBase(accessory: AccessoryDefinition, die: ToolDie, conductor: TerminationConductor): number {
  const listed = accessory.dies.includes(die.id) ? 1 : WRONG_DIE_CRIMP_QUALITY;
  return Math.max(0, listed - stepsOutside(conductor.awg, die.awgRange) * CRIMP_QUALITY_PER_AWG_STEP);
}

/**
 * Resolves one landing into its stored outcome (ADR 0015). `args` and `tools` have passed the
 * command's checks (method, gauge, tool capabilities, hole, die, torque range); `'auto'` needs no
 * tools. Each step draws at most once, from its own stream, and only when it has a spread.
 */
export function resolveTermination(
  id: number,
  args: TerminationArg,
  spec: TerminalMethodSpec,
  conductor: TerminationConductor,
  tools: TerminationTools | null,
  streams: TerminationStreams,
): TerminationV3 {
  if (args === 'auto' || tools === null) return autoTermination(id, spec);
  // Strip: the length as asked; nicks from a hole too small (or for the other stranding).
  const nick = nickBase(tools.strip.hole, conductor);
  const nickedStrandFraction =
    nick === 0 ? 0 : Math.min(1, nick * (1 - NICK_SPREAD + 2 * NICK_SPREAD * streams.strip().nextFloat()));
  // Crimp: 1 with the right die, less (with a spread) otherwise.
  let accessory: TerminationV3['accessory'] = null;
  if (tools.accessory !== null && args.accessory !== null) {
    const base = crimpBase(tools.accessory.accessory, tools.accessory.die, conductor);
    const crimpQuality = base === 1 ? 1 : base * (1 - CRIMP_SPREAD * streams.crimp().nextFloat());
    accessory = { ref: { ...args.accessory.ref }, crimpQuality };
  }
  // Clamp: a torque driver's accuracy around its setting, or a screwdriver's spread around the spec.
  // The uniform shape of the draw is game-design: ISO 6789-1 gives only a maximum permissible
  // deviation (±6 % for Type II Class D), not a distribution.
  let torqueNm: number | null = null;
  const clamped = terminationMethod(spec.method)?.clampTorque === true && spec.torqueNm !== null;
  if (clamped && tools.clamp !== null) {
    const u = streams.clamp().nextFloat();
    const torque = tools.clamp.torque;
    if (torque !== null && args.clamp.torqueNm !== null) {
      torqueNm = args.clamp.torqueNm * (1 + torque.accuracyFraction * (2 * u - 1));
    } else {
      torqueNm = (spec.torqueNm as number) * (1 + SCREWDRIVER_TORQUE_SPREAD * (2 * u - 1));
    }
  }
  return {
    id,
    method: spec.method,
    auto: false,
    stripLengthMm: args.strip.lengthMm,
    nickedStrandFraction,
    torqueNm,
    accessory,
  };
}
