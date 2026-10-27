/*
 * Seeded randomness (ADR 0007, ADR 0006). sfc32 ("Small Fast Chaotic", 128-bit state, 32-bit
 * output) is from Chris Doty-Humphrey's public-domain PractRand suite. Reimplemented here from the
 * published algorithm description: three state words a, b, c and a counter; each step outputs
 * t = a + b + counter, increments the counter, then sets a = b ^ (b >>> 9), b = c + (c << 3) and
 * c = rotl(c, 21) + t, all modulo 2^32.
 *
 * No generator state is persisted. Each consumer derives an independent stream from the world seed
 * and a stable **stream key** (see {@link deriveStream}), so undo, redo, save and load never need
 * to rewind a generator.
 */

const TWO_POW_32 = 0x1_0000_0000;

/** Throws unless `n` is an integer in [0, 2^32). */
function assertUint32(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n >= TWO_POW_32)
    throw new RangeError(`${what} must be an unsigned 32-bit integer`);
}

/** A sfc32 generator. Deterministic on every platform: only 32-bit integer arithmetic. */
export class Sfc32 {
  private a: number;
  private b: number;
  private c: number;
  private counter: number;

  constructor(a: number, b: number, c: number, counter = 1) {
    [a, b, c, counter].forEach((word) => assertUint32(word, 'sfc32 state word'));
    this.a = a;
    this.b = b;
    this.c = c;
    this.counter = counter;
  }

  /** The next output, an integer in [0, 2^32). */
  nextU32(): number {
    const t = (this.a + this.b + this.counter) >>> 0;
    this.counter = (this.counter + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) >>> 0;
    return t;
  }

  /** A float in [0, 1) with 32 random bits. */
  nextFloat(): number {
    return this.nextU32() / TWO_POW_32;
  }

  /**
   * A uniformly distributed integer in [min, max] (inclusive), without modulo bias: outputs in the
   * incomplete top bucket are rejected and redrawn. The range may hold at most 2^32 values.
   */
  nextInt(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError('nextInt needs safe integers with min <= max');
    }
    const range = max - min + 1;
    if (range > TWO_POW_32) throw new RangeError('nextInt range is wider than 2^32 values');
    const limit = TWO_POW_32 - (TWO_POW_32 % range);
    for (;;) {
      const r = this.nextU32();
      if (r < limit) return min + (r % range);
    }
  }

  /** The current state `[a, b, c, counter]`, for tests and diagnostics. */
  state(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.counter];
  }
}

/**
 * A 32-bit integer finaliser: xor-shift and multiply rounds that spread every input bit over the
 * output (the MurmurHash3 `fmix32` constants, public domain). Bijective on [0, 2^32).
 */
export function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit hash of a stream key: FNV-1a over its UTF-16 code units, folded with the length, then mixed. */
export function hashStreamKey(key: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x0100_0193);
  return mix32((h ^ key.length) >>> 0);
}

/** Outputs discarded after seeding, so the first value a consumer sees is well mixed. */
export const STREAM_WARMUP = 12;

/**
 * The generator for one consumer: a deterministic function of the world seed and a stream key.
 *
 *   k = hashStreamKey(key)
 *   a = mix32(seed ^ 0x9e3779b9)
 *   b = mix32(k ^ 0x85ebca6b)
 *   c = mix32((seed + k) ^ 0xc2b2ae35)      (sums modulo 2^32)
 *   counter = 1, then discard {@link STREAM_WARMUP} outputs.
 *
 * Keys are stable data, never anything clock- or order-dependent: `command:<seq>` for a command
 * (see {@link commandStreamKey}), `entity:<id>` for an entity. Golden vectors pin this derivation;
 * changing it changes every save's behaviour and needs a `schemaVersion` bump.
 */
export function deriveStream(seed: number, key: string): Sfc32 {
  assertUint32(seed, 'seed');
  const k = hashStreamKey(key);
  const rng = new Sfc32(mix32(seed ^ 0x9e37_79b9), mix32(k ^ 0x85eb_ca6b), mix32(((seed + k) >>> 0) ^ 0xc2b2_ae35), 1);
  for (let i = 0; i < STREAM_WARMUP; i++) rng.nextU32();
  return rng;
}

/** The stream key for the command logged at `seq`: stable across undo, redo and replay. */
export function commandStreamKey(seq: number): string {
  return `command:${seq}`;
}

/** The stream key for an entity's own randomness (wear, tolerances…), stable for its lifetime. */
export function entityStreamKey(id: number): string {
  return `entity:${id}`;
}
