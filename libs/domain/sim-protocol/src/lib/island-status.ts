import { ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR, ISLAND_KIND_MIXED } from './layout';

/**
 * Why an island's values are or aren't a reading (plan F2.3b, #52 review). Every reader decides it
 * the same way, from the island's kind, flags and iterations alone, so the engine, the inspector,
 * the overlays and the HUD agree, headless and from a snapshot:
 *
 * - `solved`: a reading;
 * - `singular`: a loop of ideal sources (ADR 0011 §5.3): its zeros are not 0 V;
 * - `nonConverged`: the outer loop hit its cap: values that look real but aren't settled;
 * - `unmodelled`: not solved (0 iterations): an element no device model can value yet;
 * - `mixed`: DC and AC sources in one island (P2 has no converters): not solved.
 */
export type IslandStatus = 'solved' | 'singular' | 'nonConverged' | 'unmodelled' | 'mixed';

/**
 * An island's {@link IslandStatus} from its `ISLAND_KIND_*` code, its `ISLAND_FLAG_*` bits and its
 * outer-loop iteration count (0 means it was not solved, ADR 0011 "Implementation notes"). Mixed
 * first, then not solved, then singular, then non-converged.
 */
export function islandStatus(kind: number, flags: number, iterations: number): IslandStatus {
  if (kind === ISLAND_KIND_MIXED) return 'mixed';
  if (iterations === 0) return 'unmodelled';
  if ((flags & ISLAND_FLAG_SINGULAR) !== 0) return 'singular';
  if ((flags & ISLAND_FLAG_NON_CONVERGED) !== 0) return 'nonConverged';
  return 'solved';
}
