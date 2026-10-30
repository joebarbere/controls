/*
 * Sourced sim-core constants (realism charter, plan §3). Every electrical or physical constant names
 * where it comes from; values chosen for play say `game-design`. Reviewed by
 * `electrical-realism-reviewer` before the PR that adds or changes one merges.
 */

export interface SourcedConstant {
  readonly value: number;
  /** SI unit symbol. */
  readonly unit: string;
  readonly kind: 'real-world' | 'game-design';
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
