/*
 * A sourced constant (realism charter, plan §3): every electrical or physical constant names where it
 * comes from; values chosen for play say `game-design`, and solver settings `numerical`. Reviewed by
 * `electrical-realism-reviewer` before the PR that adds or changes one merges. Defined here (not in
 * sim-core) since F3.6 part 1: the catalogue's load-time thermal time-constant check reads the
 * conductor heat-path constants, and sim-core re-exports the type.
 */
export interface SourcedConstant {
  readonly value: number;
  /** SI unit symbol. */
  readonly unit: string;
  /** `numerical`: a solver setting with no electrical meaning (`gmin`, an iteration cap). */
  readonly kind: 'real-world' | 'game-design' | 'numerical';
  readonly source: string;
}
