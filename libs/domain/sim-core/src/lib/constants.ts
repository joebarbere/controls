/*
 * Sourced sim-core constants (realism charter, plan §3). Every electrical or physical constant names
 * where it comes from; values chosen for play say `game-design`, and solver settings `numerical`. Reviewed by
 * `electrical-realism-reviewer` before the PR that adds or changes one merges.
 */

export interface SourcedConstant {
  readonly value: number;
  /** SI unit symbol. */
  readonly unit: string;
  /** `numerical`: a solver setting with no electrical meaning (`gmin`, an iteration cap). */
  readonly kind: 'real-world' | 'game-design' | 'numerical';
  readonly source: string;
}

/**
 * The conductor temperature a test lead's resistance is taken at (F2.1). P2 has no conductor heating
 * (P3 brings it, with world v3 lead state), so every lead sits at this fixed temperature. It lies
 * inside the range where `leadResistanceOhm`'s linear α model holds (about 223 to 423 K), so the
 * compiler needs no clamp; a spec checks the range.
 */
export const LEAD_CONDUCTOR_TEMPERATURE_K: SourcedConstant = {
  value: 293.15,
  unit: 'K',
  kind: 'game-design',
  source:
    'game-design: the workshop bench is taken at 20 °C (293.15 K), a usual indoor ambient and the reference temperature of the International Annealed Copper Standard (IEC 60028), so a copper lead at ambient has exactly its catalogue resistivity. Self-heating is ignored until P3 adds conductor temperature.',
};

/**
 * `gmin`: the conductance the DC solver (F2.2) puts from every node to its island's reference node.
 * Numerical, not electrical: no real device is modelled by it. With it, an MNA matrix is singular
 * only for a loop of ideal (zero-ohm) voltage sources, which the solver flags `singular`; a node that
 * nothing but a current source reaches still gets a defined, finite voltage instead of NaN. Its loss,
 * gmin · V² per node, is part of the power balance.
 */
export const GMIN_S: SourcedConstant = {
  value: 1e-12,
  unit: 'S',
  kind: 'numerical',
  source:
    "numerical: the conventional SPICE minimum conductance, 1e-12 S (1 TΩ), the default GMIN of Berkeley SPICE2 (L. W. Nagel, \"SPICE2: A Computer Program to Simulate Semiconductor Circuits\", UCB/ERL M520, 1975) and of the ngspice user manual. sim-core puts it from every circuit node to the island reference, so F2.7's oracle decks match it with an explicit 1e12 Ω shunt resistor from each circuit node to the reference. Not ngspice's `rshunt` option, which also shunts the decks' 0 V sense-source nodes and each source's internal node, and so moves results. Its effect on a result is a relative error of about gmin × R_th, the Thévenin resistance the node sees: 1e-10 at 100 Ω, 1e-6 at 1 MΩ. That is below a bench meter's resolution, but not below an insulation-resistance tester's range, which must exclude it.",
};
