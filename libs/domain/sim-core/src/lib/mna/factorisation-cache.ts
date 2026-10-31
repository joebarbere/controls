import { FACTORISATION_CACHE_CAPACITY, FACTORISATION_CACHE_MODE_VARIANTS } from '../constants';
import type { CscPattern, SparseFactors } from '../lu/sparse-lu';

/*
 * The factorisation cache (plan F2.2 part 3, spec §4.5): a sparse island's symbolic factorisation,
 * kept by `topologyHash` so a value-only change (a lamp's R(T), a battery's EMF) or a return to an
 * earlier switch state skips rebuilding it.
 *
 * What it keeps is a pure function of the topology and the stamp modes, never of the values: the
 * matrix pattern (CSC), the map from each stamp call to its slot in the pattern, and the AMD column
 * order. Beside them it keeps the island's last numeric factors, so the next factorisation can replay
 * their pivot sequence and L/U patterns instead of searching again; a replay is accepted only when
 * the full pivot rule picks the same pivot at every column, which makes it bit-identical to a fresh
 * factorisation (`sparse-lu.ts`). So a warm cache returns precisely what a cold one would compute,
 * and a solve's bits never depend on the cache's state: cold, warm, shared or evicted.
 *
 * Within a topology, the pattern also depends on each branch's stamp mode: a `vsource` element in
 * current limit has no voltage terms in its row, and a current source conducts nothing, which can
 * split a conductive component (`dc.ts`). So each island keeps up to
 * `FACTORISATION_CACHE_MODE_VARIANTS` variants, keyed by its branches' stamp codes.
 *
 * Eviction is least recently used by a logical clock (a counter, never wall time), over topologies,
 * and within a topology's island over its mode variants. Deterministic: the same sequence of lookups
 * evicts the same entries in every runtime.
 */

/**
 * One island's symbolic factorisation in one set of stamp modes. `F` is the numeric factors' type:
 * `SparseFactors` for the DC solver, `ComplexSparseFactors` for the phasor solver (F2.2 part 2), which
 * keeps its own cache of the same shape.
 */
export interface IslandSymbolic<F = SparseFactors> {
  /** The order of the island's system. */
  readonly unknowns: number;
  /** The island's branches' stamp codes (`DC_STAMP_*`, or the AC solver's pattern classes), in island branch order. */
  readonly signature: Uint8Array;
  /** The matrix pattern. */
  readonly pattern: CscPattern;
  /** Stamp call → its entry in `pattern.rowIdx` (duplicates add into one entry, in call order). */
  readonly slots: Int32Array;
  /** The AMD column order: `order[k]` is the column eliminated `k`-th. */
  readonly order: Int32Array;
  /**
   * The island's last numeric factors, which the next factorisation replays (pivot sequence and L/U
   * patterns) when the pivot rule still picks the same rows, else redoes afresh (`sparse-lu.ts`).
   * Mutable working storage: it never changes a result bit.
   */
  readonly factors: F;
  // The stamp program (`dc.ts`): per matrix call its value code and branch, then the right-hand side.
  readonly codes: Uint8Array;
  readonly branches: Int32Array;
  readonly rhsTargets: Int32Array;
  readonly rhsCodes: Uint8Array;
  readonly rhsBranches: Int32Array;
  /** Each island node's conductive component (its smallest node), in island node order (empty for AC). */
  readonly comp: Int32Array;
  /** A fingerprint of the island's branch ends, checked on every hit. */
  readonly ends: number;
}

/** Counters, for tests and the bench. They never feed a result. */
export interface FactorisationCacheStats {
  /** Island lookups answered from the cache. */
  readonly hits: number;
  /** Island lookups that had to build a symbolic factorisation. */
  readonly misses: number;
  /** Topologies evicted to make room. */
  readonly evictions: number;
  /** Topologies held now. */
  readonly topologies: number;
}

interface TopologyEntry<F> {
  lastUse: number;
  /** Island index → its mode variants, most recently used first. */
  readonly islands: Map<number, IslandSymbolic<F>[]>;
}

function sameSignature(signature: Uint8Array, stamps: Uint8Array, length: number): boolean {
  if (signature.length !== length) return false;
  for (let i = 0; i < length; i++) if (signature[i] !== stamps[i]) return false;
  return true;
}

/** A fixed-size LRU of symbolic factorisations, keyed by `topologyHash`, island and stamp modes. */
export class FactorisationCache<F = SparseFactors> {
  readonly capacity: number;
  readonly modeVariants: number;
  private readonly topologies = new Map<string, TopologyEntry<F>>();
  private clock = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(capacity = FACTORISATION_CACHE_CAPACITY.value, modeVariants = FACTORISATION_CACHE_MODE_VARIANTS.value) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError(`cache capacity must be ≥ 1, got ${capacity}`);
    if (!Number.isInteger(modeVariants) || modeVariants < 1) {
      throw new RangeError(`cache mode variants must be ≥ 1, got ${modeVariants}`);
    }
    this.capacity = capacity;
    this.modeVariants = modeVariants;
  }

  get stats(): FactorisationCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      topologies: this.topologies.size,
    };
  }

  /** Whether `topologyHash` is held (no effect on recency or the counters). */
  has(topologyHash: string): boolean {
    return this.topologies.has(topologyHash);
  }

  /**
   * The symbolic factorisation of island `island` of `topologyHash` whose signature is the first
   * `length` codes of `stamps`, or `undefined` (counted as a miss: the caller builds and `store`s
   * it). A hit makes the topology and the variant the most recently used.
   */
  find(topologyHash: string, island: number, stamps: Uint8Array, length: number): IslandSymbolic<F> | undefined {
    const entry = this.topologies.get(topologyHash);
    if (entry !== undefined) {
      entry.lastUse = ++this.clock;
      const variants = entry.islands.get(island);
      if (variants !== undefined) {
        for (let v = 0; v < variants.length; v++) {
          const symbolic = variants[v];
          if (!sameSignature(symbolic.signature, stamps, length)) continue;
          if (v > 0) {
            variants.splice(v, 1);
            variants.unshift(symbolic);
          }
          this.hitCount++;
          return symbolic;
        }
      }
    }
    this.missCount++;
    return undefined;
  }

  /** Stores a symbolic factorisation built after a miss, evicting the least recently used as needed. */
  store(topologyHash: string, island: number, symbolic: IslandSymbolic<F>): void {
    let entry = this.topologies.get(topologyHash);
    if (entry === undefined) {
      if (this.topologies.size >= this.capacity) this.evictLeastRecent();
      entry = { lastUse: ++this.clock, islands: new Map() };
      this.topologies.set(topologyHash, entry);
    } else {
      entry.lastUse = ++this.clock;
    }
    let variants = entry.islands.get(island);
    if (variants === undefined) {
      variants = [];
      entry.islands.set(island, variants);
    }
    variants.unshift(symbolic);
    if (variants.length > this.modeVariants) variants.length = this.modeVariants;
  }

  /** Forgets everything (the counters too). */
  clear(): void {
    this.topologies.clear();
    this.clock = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  private evictLeastRecent(): void {
    // The logical clock is strictly increasing, so the minimum is unique: the scan order of the Map
    // can't change which entry goes.
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [hash, entry] of this.topologies) {
      if (entry.lastUse < oldest) {
        oldest = entry.lastUse;
        victim = hash;
      }
    }
    if (victim !== null) {
      this.topologies.delete(victim);
      this.evictionCount++;
    }
  }
}
