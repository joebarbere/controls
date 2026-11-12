import {
  type AccessoryDefinition,
  type ConductorStranding,
  gaugeRow,
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
 * The numbers below are **game-design**, decided in F3.3 part 1 (ADR 0018 §4.3, ADR 0015
 * implementation note 11; `electrical-realism-reviewer` signs them off) and frozen at v0.4.0. Each is
 * read through ADR 0018's contact model, which is what makes them mean something:
 *
 * - **Nicks.** A hole that is too small cuts into the metal: a share per AWG step it is too small,
 *   plus a little for a hole cut for the other stranding, with a seeded spread, and never more than
 *   the hole can geometrically reach, 1 − (d_hole/d_cond)² (the area outside the blade circle). A
 *   stranded conductor (and a stranded hole) is taken 3/√7 ≈ 1.134 times the solid diameter of its
 *   gauge, a 7-strand concentric bundle (an abstraction: 19 and 37 strands sit at 1.147 and 1.151).
 *   So the right hole, a larger one, or the stranded hole of the same gauge on a solid conductor
 *   (physically the solid hole one size up) nicks nothing. The contact model reads a nick as 1/(1 − f).
 * - **Crimps.** The right die closes fully (1); a die the accessory doesn't list is an under-crimp at
 *   0.25, inside ADR 0018's loose regime (14.1 mΩ for the crimp alone, golden 5); each AWG step the
 *   conductor lies outside the die's range takes 0.3 more (one size off still seats, three are loose);
 *   an imperfect crimp gets a seeded spread below its base.
 * - **Clamp torque.** A torque driver lands within its stated accuracy of its setting. A plain
 *   screwdriver is **biased low and wide**: uniform in [0.15, 1.45) × the marked torque (mean 0.8),
 *   a game-design fit to a trade-press summary of a 2009 field study of connections made without a
 *   torque tool: about half land under 80 % of the mark, about 27 % under 50 %, about 19 % below ADR
 *   0018's seat fraction (0.4, the loose regime, up to about 130 × R₀ at 0.15) and about 19 % above 120 %. The contact
 *   model caps the benefit at the mark.
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

/**
 * game-design: the area share nicked per AWG step a strip hole is too small. Below the geometric
 * reach of one step (a blade circle one gauge smaller lies outside 20.7 % of the area), since a blade
 * scores rather than severs the metal it reaches.
 */
export const NICK_FRACTION_PER_AWG_STEP = 0.15;
/** game-design: the area share nicked by a hole cut for the other stranding (only where it is smaller, by the cap). */
export const NICK_FRACTION_STRANDING_MISMATCH = 0.05;
/** game-design: a nick's seeded spread, a factor in [1 − s, 1 + s) (then capped at the geometric reach). */
export const NICK_SPREAD = 0.25;
/**
 * physics (geometry): a 7-strand concentric conductor's diameter squared over the solid conductor's of
 * the same area, (3/√7)² = 9/7 (seven strands of d/√7 make a bundle three strands wide). Applied to
 * stranded conductors and stranded holes in the nick cap; an abstraction for 19 and 37 strands.
 */
export const STRANDED_DIAMETER_SQUARED_RATIO = 9 / 7;
/**
 * game-design: crimp quality with a die the accessory doesn't list, an under-crimp in ADR 0018's
 * loose regime (below its 0.4 seat fraction; ADR 0018 §12 golden 5).
 */
export const WRONG_DIE_CRIMP_QUALITY = 0.25;
/** game-design: quality lost per AWG step the conductor lies outside the die's range (one off seats, three are loose). */
export const CRIMP_QUALITY_PER_AWG_STEP = 0.3;
/** game-design: an imperfect crimp's seeded spread, a factor in (1 − s, 1]. */
export const CRIMP_SPREAD = 0.1;
/**
 * game-design, real-world anchor (ADR 0015 Review asked for a field-study source or game-design): a plain
 * screwdriver's achieved torque is biased low, centred on 0.8 × the marked torque. Anchor: IAEI
 * Magazine, "Are you the weakest link?" (July 2011,
 * https://iaeimagazine.org/2011/july2011/are-you-the-weakest-link/), a trade-press summary of an
 * unnamed 2009 study of set-screw connections made without a torque wrench: over half under 80 % of
 * the specified torque, nearly a third under 50 %, about a quarter over 120 %. The original study is
 * unidentified, so the band below is a game-design fit to that summary, not a measurement. NFPA
 * 70-2023 Art. 110.14(D) (cited by number) requires an approved tightening means where a torque is
 * marked.
 */
export const SCREWDRIVER_TORQUE_MEAN_FRACTION = 0.8;
/**
 * game-design: a plain screwdriver's spread around its mean, ± 0.65 × the marked torque, so it lands
 * uniformly in [0.15, 1.45) × the mark: about 50 % under 80 %, 27 % under 50 %, 19 % below ADR 0018's
 * seat fraction (0.4) and 19 % over 120 % (the summary's "about a quarter"; a uniform band can't fit
 * every quantile).
 */
export const SCREWDRIVER_TORQUE_SPREAD = 0.65;

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

/** A size's diameter squared, relative: its gauge area, × 9/7 when stranded (a 7-strand bundle). */
function diameterSquared(awg: number, stranding: ConductorStranding): number {
  const area = gaugeRow(awg)?.areaMm2 ?? 0;
  return stranding === 'stranded' ? area * STRANDED_DIAMETER_SQUARED_RATIO : area;
}

/**
 * The most a strip hole can nick: the conductor's area outside the blade circle, 1 − (d_hole/d_cond)²,
 * or 0 when the hole is at least as wide as the conductor.
 */
export function nickCap(hole: ToolHole, conductor: TerminationConductor): number {
  const cond = diameterSquared(conductor.awg, conductor.stranding);
  const reach = cond > 0 ? 1 - diameterSquared(hole.awg, hole.stranding) / cond : 0;
  return reach > 0 ? reach : 0;
}

/**
 * The share of the conductor's area a strip hole nicks (before the spread): the per-step model,
 * min(1, steps × 0.15 + mismatch), never above {@link nickCap}. 0 for the right hole or a wider one.
 */
export function nickBase(hole: ToolHole, conductor: TerminationConductor): number {
  const steps = hole.awg - conductor.awg; // > 0: a hole for a thinner conductor
  if (steps < 0) return 0;
  const mismatch = hole.stranding === conductor.stranding ? 0 : NICK_FRACTION_STRANDING_MISMATCH;
  return Math.min(1, steps * NICK_FRACTION_PER_AWG_STEP + mismatch, nickCap(hole, conductor));
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
    nick === 0
      ? 0
      : Math.min(
          nickCap(tools.strip.hole, conductor),
          nick * (1 - NICK_SPREAD + 2 * NICK_SPREAD * streams.strip().nextFloat()),
        );
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
      torqueNm =
        (spec.torqueNm as number) * (SCREWDRIVER_TORQUE_MEAN_FRACTION + SCREWDRIVER_TORQUE_SPREAD * (2 * u - 1));
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
