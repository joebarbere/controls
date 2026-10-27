import fc from 'fast-check';
import { commandStreamKey, deriveStream, entityStreamKey, hashStreamKey, mix32, Sfc32, STREAM_WARMUP } from './prng';

const take = (rng: Sfc32, n: number) => Array.from({ length: n }, () => rng.nextU32());

describe('Sfc32', () => {
  it('follows the published step function (worked by hand from an all-zero state)', () => {
    // t = a + b + counter; a = b ^ b>>>9; b = c + c<<3; c = rotl(c, 21) + t.
    // Step 1: t = 1, c = 1. Step 2: t = 2, b = 9, c = 2^21 + 2. Step 3: t = 0 + 9 + 3 = 12.
    expect(take(new Sfc32(0, 0, 0, 1), 3)).toEqual([1, 2, 12]);
  });

  // Golden vectors: any change to the generator changes every seeded behaviour (ADR 0007).
  it('produces the pinned output sequences', () => {
    expect(take(new Sfc32(0, 0, 0, 1), 8)).toEqual([1, 2, 12, 18874399, 56669315, 2581679515, 3653559774, 1064146342]);
    expect(take(new Sfc32(0xdeadbeef, 0x12345678, 0x9abcdef0, 1), 8)).toEqual([
      4041348456, 2195792581, 3074186425, 2226557559, 1337138538, 3642565243, 2010352676, 2662284053,
    ]);
  });

  it('defaults the counter to 1 and exposes its state', () => {
    const rng = new Sfc32(5, 6, 7);
    expect(rng.state()).toEqual([5, 6, 7, 1]);
    rng.nextU32();
    expect(rng.state()[3]).toBe(2);
  });

  it('wraps the counter at 2^32', () => {
    const rng = new Sfc32(0, 0, 0, 0xffff_ffff);
    rng.nextU32();
    expect(rng.state()[3]).toBe(0);
  });

  it.each([[-1], [0x1_0000_0000], [1.5], [Number.NaN]])('rejects the state word %s', (word) => {
    expect(() => new Sfc32(word, 0, 0)).toThrow(RangeError);
  });

  it('nextU32 stays in [0, 2^32) and nextFloat in [0, 1)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffff_ffff }), fc.string(), (seed, key) => {
        const rng = deriveStream(seed, key);
        for (let i = 0; i < 20; i++) {
          const u = rng.nextU32();
          expect(Number.isInteger(u) && u >= 0 && u < 2 ** 32).toBe(true);
          const f = rng.nextFloat();
          expect(f >= 0 && f < 1).toBe(true);
        }
      }),
    );
  });

  it('nextInt stays within inclusive bounds', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 0xffff_ffff }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.nat({ max: 1_000 }),
        (seed, min, width) => {
          const rng = deriveStream(seed, 'test');
          for (let i = 0; i < 10; i++) {
            const n = rng.nextInt(min, min + width);
            expect(Number.isInteger(n) && n >= min && n <= min + width).toBe(true);
          }
        },
      ),
    );
  });

  it('nextInt covers a small range evenly and handles the full 2^32 range', () => {
    const rng = deriveStream(42, 'dice');
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) counts[rng.nextInt(1, 6) - 1]++;
    for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
    expect(rng.nextInt(7, 7)).toBe(7);
    const full = rng.nextInt(0, 0xffff_ffff);
    expect(full >= 0 && full <= 0xffff_ffff).toBe(true);
  });

  it('nextInt redraws outputs in the incomplete top bucket (no modulo bias)', () => {
    // Range 3·2^30: outputs at or above 2^32 - (2^32 mod range) = 3·2^30 are rejected (a quarter of them).
    const range = 3 * 2 ** 30;
    let rejections = 0;
    for (let seed = 0; seed < 64; seed++) {
      const rng = deriveStream(seed, 'bias');
      const reference = deriveStream(seed, 'bias');
      let r = reference.nextU32();
      while (r >= range) {
        rejections++;
        r = reference.nextU32();
      }
      expect(rng.nextInt(0, range - 1)).toBe(r % range);
      expect(rng.state()).toEqual(reference.state());
    }
    expect(rejections).toBeGreaterThan(0);
  });

  it.each([
    [1.5, 2],
    [2, 1],
    [0, 2 ** 32],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
  ])('nextInt(%s, %s) throws', (min, max) => {
    expect(() => new Sfc32(1, 2, 3).nextInt(min, max)).toThrow(RangeError);
  });
});

describe('mix32 and hashStreamKey', () => {
  it('pins the finaliser and key hash', () => {
    expect([mix32(0), mix32(1), mix32(0xffff_ffff)]).toEqual([0, 1364076727, 2180083513]);
    expect([hashStreamKey(''), hashStreamKey('command:0'), hashStreamKey('entity:1')]).toEqual([
      2872998923, 959754756, 963357040,
    ]);
  });

  it('mix32 is injective on a sample (it is a bijection)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) seen.add(mix32(i * 40_503));
    expect(seen.size).toBe(100_000);
  });

  it('distinguishes keys by content and length', () => {
    expect(hashStreamKey('a')).not.toBe(hashStreamKey('b'));
    expect(hashStreamKey('ab')).not.toBe(hashStreamKey('ba'));
    expect(hashStreamKey('\u0000')).not.toBe(hashStreamKey(''));
  });
});

describe('deriveStream', () => {
  // Golden vectors for the derivation (ADR 0007: F1.2 fixes it and pins outputs).
  it.each([
    [0, '', [1921722410, 916869832, 3307800322, 13], [2838592255, 623788289, 3286313139, 1204605188]],
    [0, 'command:0', [2901123454, 2626585339, 2088705606, 13], [1232741510, 4248360510, 81757246, 2180593470]],
    [123456789, 'command:0', [3232266947, 443684284, 2539555420, 13], [3675951244, 1825704448, 2929021862, 409284897]],
    [4294967295, 'entity:1', [4093162839, 3049710979, 565514075, 13], [2847906535, 3841560882, 1837925069, 80437250]],
  ])('seed %s, key %j gives the pinned state and outputs', (seed, key, state, outputs) => {
    const rng = deriveStream(seed, key);
    expect(rng.state()).toEqual(state);
    expect(take(rng, 4)).toEqual(outputs);
  });

  it('discards the warm-up outputs (the counter starts at 1 + warm-up)', () => {
    expect(STREAM_WARMUP).toBe(12);
    expect(deriveStream(1, 'x').state()[3]).toBe(1 + STREAM_WARMUP);
  });

  it('is a pure function of (seed, key)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffff_ffff }), fc.string(), (seed, key) => {
        expect(take(deriveStream(seed, key), 4)).toEqual(take(deriveStream(seed, key), 4));
      }),
    );
  });

  it('gives different streams for neighbouring seeds and keys', () => {
    const first = (seed: number, key: string) => deriveStream(seed, key).nextU32();
    const outputs = new Set<number>();
    for (let seed = 0; seed < 50; seed++)
      for (let seq = 0; seq < 50; seq++) outputs.add(first(seed, commandStreamKey(seq)));
    expect(outputs.size).toBeGreaterThan(2490); // 2500 draws; a 32-bit collision or two is fine
  });

  it.each([[-1], [2 ** 32], [0.5]])('rejects the seed %s', (seed) => {
    expect(() => deriveStream(seed, 'x')).toThrow('seed must be an unsigned 32-bit integer');
  });

  it('formats the documented stream keys', () => {
    expect(commandStreamKey(7)).toBe('command:7');
    expect(entityStreamKey(3)).toBe('entity:3');
  });
});
