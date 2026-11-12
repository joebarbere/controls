import type { SourcedConstant } from '../constants';

/*
 * Sourced constants of the as-made contact model (ADR 0018 §4, §11). The good-connection resistance R₀
 * itself is catalogue data per terminal method (`TerminalMethodSpec.contactOhm`), never a constant
 * here. Holm's constriction theory gives only the shape (R ∝ F^−½ while the clamp is seated); the end
 * points are calibrated to NBS BSS 103 and BSS 128; everything between them is a game-design shape.
 */

/**
 * The torque ratio from which a screw clamp is seated (r_seat). Below it the conductor is held by a
 * few asperities through surface films, and the loose film term takes over (ADR 0018 §4.2).
 */
export const SEAT_FRACTION: SourcedConstant = {
  value: 0.4,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §4.2): a screw clamp is seated from 40 % of its marked torque. Holm’s R ∝ F^−½ (Greenwood 1966) holds only while seated; with R₀ = 0.3 mΩ any r_seat ≳ 0.237 keeps 20 % torque at least 10× R₀, as the phase acceptance asks.',
};

/**
 * The loose-film resistance at zero clamp force: the film term rises quadratically from 0 at
 * r_seat to this at r = 0 (ADR 0018 §4.2).
 */
export const LOOSE_FILM_OHM: SourcedConstant = {
  value: 0.1,
  unit: 'Ω',
  kind: 'game-design',
  source:
    'game-design shape, real-world anchor (ADR 0018 §4.2): NBS Building Science Series 128 (1980, read in the P3 pre-audit) classes a connection of 100 mΩ or more as loose, and BSS 103 (1977) measured glowing connections at 80 to 160 mΩ. Reading the loose class as a fresh zero-torque termination, and the quadratic approach from r_seat, are game-design; only the 100 mΩ end point is sourced.',
};

/**
 * The clamp-ratio factor for a bare stranded conductor under a binding screw: its strands splay from
 * under the screw head (ADR 0018 §4.3). Pressure plates, box clamps, spring cages and accessories hold
 * the strands and get none.
 */
export const STRAND_SPREAD_FACTOR: SourcedConstant = {
  value: 0.5,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §4.3): bare strands under a binding-head screw splay out from under it, so the clamp seats like half torque (1.41 R₀ at full torque). A ferrule or lug consolidates the strands and removes the factor.',
};

/** The cap on the nicked-strand fraction the contact model counts (ADR 0018 §4.3): 1/(1 − f) at most 10×. */
export const NICK_MAX_FRACTION: SourcedConstant = {
  value: 0.9,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §4.3): contact spots carry current only through the intact strands, so the contact resistance scales by 1/(1 − f) for a nicked fraction f, capped at f = 0.9 (10×). A nick’s local loss of conductor cross-section and its later strand breakage are not modelled in P3 (P5 faults).',
};

/** A good crimp's resistance, in series with the clamp contact for a ferrule or lug (ADR 0018 §4.3). */
export const CRIMP_GOOD_OHM: SourcedConstant = {
  value: 5e-5,
  unit: 'Ω',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §4.3): a fully closed crimp is a cold-welded joint well below a screw contact’s 0.3 mΩ; an under-closed crimp follows the same seated/loose law as a clamp, with its quality q in place of the torque ratio.',
};

/**
 * The resistivity a terminal's contact member is taken at: annealed copper, 100 % IACS, exactly 1/58
 * Ω·mm²/m at 20 °C. A conductor of another metal scales the constriction by the two members' mean
 * resistivity over copper's (ADR 0018 §4.3).
 */
export const TERMINAL_RESISTIVITY_OHM_M: SourcedConstant = {
  value: 1 / 58e6,
  unit: 'Ω·m',
  kind: 'real-world',
  source:
    'real-world: the International Annealed Copper Standard defines 100 % IACS as 1/58 Ω·mm²/m at 20 °C (NBS Handbook 100, 1966, read; the materials table’s copper row). Holm: the constriction resistance between two members scales with their mean resistivity (Greenwood 1966, read), so an aluminium conductor (61.0 % IACS, NBS Handbook 109) on a terminal taken as copper gives (ρ_Al + ρ_Cu)/(2ρ_Cu) = 1.31966. The terminal is taken as copper, an abstraction: brass or plated steel would give a smaller ratio. The factor scales resistivity only: it ignores aluminium’s lower hardness (a larger a-spot at the same force, so a lower resistance) and its oxide film, the dominant real effect, which F3.6’s degradation stands in for.',
};

/**
 * The degradation-rate multiplier for an aluminium conductor on a method not rated for it (ADR 0018
 * §5). It changes **only** the rate (F3.6 part 2 reads it), never the as-made contact resistance.
 */
export const AL_UNRATED_DEGRADATION_MULTIPLIER: SourcedConstant = {
  value: 10,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design, real-world anchor (ADR 0018 §5): CPSC Publication 516 (2011, read) reports pre-1972 aluminium-wired homes as 55× more likely to reach fire-hazard conditions. That is a population statistic, not a rate constant, so it is used only as an order of magnitude; 10 keeps the effect visible without making every such end run away within minutes. Creep and cold flow loosening the clamp, the real mechanism, are a P5 fault.',
};
