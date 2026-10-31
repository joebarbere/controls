import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { sha256, SHA256_H0, SHA256_K, sha256Hex, toHex, utf8Encode } from './sha256';

/** Integer k-th root of a non-negative bigint (largest r with r^k <= n), by bisection. */
function integerRoot(n: bigint, k: bigint): bigint {
  let lo = 0n;
  let hi = 1n;
  while (hi ** k <= n) hi *= 2n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (mid ** k <= n) lo = mid;
    else hi = mid;
  }
  return lo;
}

function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let n = 2; primes.length < count; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
  return primes;
}

/** First 32 bits of the fractional part of p^(1/k): floor(p^(1/k) · 2^32) mod 2^32, computed exactly. */
const fractionBits = (p: number, k: bigint) => Number(integerRoot(BigInt(p) << (32n * k), k) & 0xffff_ffffn);

const NODE = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * A string unit: any code point (lone surrogates included), or one from each of UTF-8's encoded
 * lengths, the surrogate range on its own (so halves land next to each other: pairs, reversed
 * pairs, a high half before a real pair, a half at the end) or an edge between them. `utf8Encode`
 * reads code units, so these reach every branch it has.
 *
 * It replaces `fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }))`, which
 * never drew a lone surrogate (fast-check's binary unit skips U+D800–U+DFFF) and was slow: building
 * `fc.string({ unit: 'binary' })` tokenizes fast-check's "dangerous strings" with the unit, which
 * first maps all 1,114,112 code points into a reverse table, about 0.6 s the first time in each
 * process, nearly all of the test's time. A custom unit has no unmapper, so it skips that, and
 * graphemes are only sequences of these code points.
 */
const codePointArb = fc
  .oneof(
    fc.integer({ min: 0, max: 0x10_ffff }),
    fc.integer({ min: 0, max: 0x7f }),
    fc.integer({ min: 0x80, max: 0x7ff }),
    fc.integer({ min: 0x800, max: 0xffff }),
    fc.integer({ min: 0xd800, max: 0xdfff }),
    fc.integer({ min: 0x1_0000, max: 0x10_ffff }),
    fc.constantFrom(
      ...[0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff],
      ...[0x1_0000, 0x10_ffff],
    ),
  )
  .map((cp) => String.fromCodePoint(cp));

describe('SHA-256 (FIPS 180-4)', () => {
  it('uses the constants defined in sections 4.2.2 and 5.3.3 (recomputed exactly from the primes)', () => {
    const primes = firstPrimes(64);
    expect(SHA256_K).toEqual(primes.map((p) => fractionBits(p, 3n)));
    expect(SHA256_H0).toEqual(primes.slice(0, 8).map((p) => fractionBits(p, 2n)));
  });

  // The FIPS 180-2 appendix B / NIST "Example Algorithms" SHA-256 vectors.
  it.each([
    ['the empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc" (one block)', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message (padding spills into a second block)',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'the 896-bit message (multi-block)',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
    [
      'one million "a" (15 625 blocks)',
      'a'.repeat(1_000_000),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    ],
  ])('hashes %s', (_name, message, digest) => {
    expect(sha256Hex(message)).toBe(digest);
  });

  it('pads correctly at every length around the block boundaries', () => {
    for (let length = 0; length <= 130; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(toHex(sha256(bytes))).toBe(NODE(bytes));
    }
  });

  it('agrees with Node for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(NODE(bytes));
      }),
    );
  });

  it('does not modify its input', () => {
    const bytes = Uint8Array.of(1, 2, 3);
    sha256(bytes);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe('utf8Encode', () => {
  it.each([
    ['ASCII', 'abc', [0x61, 0x62, 0x63]],
    ['two bytes', 'é', [0xc3, 0xa9]],
    ['three bytes', '中', [0xe4, 0xb8, 0xad]],
    ['four bytes (surrogate pair)', '🔌', [0xf0, 0x9f, 0x94, 0x8c]],
    ['a lone high surrogate → U+FFFD', '\uD83Dx', [0xef, 0xbf, 0xbd, 0x78]],
    ['a lone high surrogate at the end', 'x\uD83D', [0x78, 0xef, 0xbf, 0xbd]],
    ['a lone low surrogate', '\uDC0C', [0xef, 0xbf, 0xbd]],
    ['boundaries', '\u007f\u0080߿ࠀ￿', [0x7f, 0xc2, 0x80, 0xdf, 0xbf, 0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf]],
  ])('encodes %s', (_name, text, bytes) => {
    expect([...utf8Encode(text)]).toEqual(bytes);
  });

  it('matches Node for any string, including unpaired surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: codePointArb }), (text) => {
        expect(Buffer.from(utf8Encode(text)).equals(Buffer.from(text, 'utf8'))).toBe(true);
      }),
    );
  });
});

describe('toHex', () => {
  it('is lower case and zero-padded', () => {
    expect(toHex(Uint8Array.of(0, 1, 0xab, 0xff))).toBe('0001abff');
    expect(toHex(new Uint8Array(0))).toBe('');
  });
});
