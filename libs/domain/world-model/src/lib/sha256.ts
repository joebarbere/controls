/*
 * SHA-256 per FIPS 180-4 (sections 4.1.2, 4.2.2, 5.1.1, 5.3.3 and 6.2), written from the standard
 * in plain TypeScript. Synchronous and dependency-free, so domain code can hash in Node, the
 * renderer and the sim worker alike (WebCrypto is async, and the `crypto` global is banned in
 * domain code). Not constant-time: it hashes public data (world documents), never secrets.
 */

/**
 * Section 4.2.2: the first 32 bits of the fractional parts of the cube roots of the first 64
 * primes. The spec recomputes them independently with exact integer arithmetic.
 */
export const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

/** Section 5.3.3: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
export const SHA256_H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const K = Int32Array.from(SHA256_K);

/**
 * Section 6.2.2's compression of the 64-byte block at `offset` of `bytes` into `h`, on int32 words
 * (`| 0` is addition modulo 2^32, as `>>> 0` is, in another representation) with the rotations
 * inlined: the bits are the standard's, only the arithmetic's JavaScript form is faster. Sums are
 * reduced pairwise (`| 0` after each pair) so V8 keeps them in int32 arithmetic, and Ch and Maj use
 * their equivalent two-operation forms, g ^ (e & (f ^ g)) and (a & b) ^ (c & (a ^ b)): about 10 % faster
 * on a 2,000-node plant's topology encoding (F3.6 part 2's toggle path). Golden vectors pin the bits.
 *
 * Unrolled by 16 (perf only; about 18 % faster again on the reference machine, a 62 KB encoding in
 * 0.21 ms rather than 0.26). The message schedule lives in 16 locals rather than a 64-word array, as a
 * rolling window (W_t in `w{t mod 16}`), extended in place before each pass after the first. The
 * working variables are never shifted (step 3's h = g, g = f, …): each round renames them instead, so
 * it writes only the two that change, d + T1 and T1 + T2, into the variables playing d and h in that
 * round. The roles rotate by one a round and repeat every 8, so 16 rounds end where they began.
 */
function compress(h: Int32Array, bytes: Uint8Array, offset: number): void {
  // 1. The message schedule's first 16 words (big-endian), in a rolling window: W_t is held in w{t mod 16}.
  let w0 = (bytes[offset + 0] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  let w1 = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
  let w2 = (bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11];
  let w3 = (bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15];
  let w4 = (bytes[offset + 16] << 24) | (bytes[offset + 17] << 16) | (bytes[offset + 18] << 8) | bytes[offset + 19];
  let w5 = (bytes[offset + 20] << 24) | (bytes[offset + 21] << 16) | (bytes[offset + 22] << 8) | bytes[offset + 23];
  let w6 = (bytes[offset + 24] << 24) | (bytes[offset + 25] << 16) | (bytes[offset + 26] << 8) | bytes[offset + 27];
  let w7 = (bytes[offset + 28] << 24) | (bytes[offset + 29] << 16) | (bytes[offset + 30] << 8) | bytes[offset + 31];
  let w8 = (bytes[offset + 32] << 24) | (bytes[offset + 33] << 16) | (bytes[offset + 34] << 8) | bytes[offset + 35];
  let w9 = (bytes[offset + 36] << 24) | (bytes[offset + 37] << 16) | (bytes[offset + 38] << 8) | bytes[offset + 39];
  let w10 = (bytes[offset + 40] << 24) | (bytes[offset + 41] << 16) | (bytes[offset + 42] << 8) | bytes[offset + 43];
  let w11 = (bytes[offset + 44] << 24) | (bytes[offset + 45] << 16) | (bytes[offset + 46] << 8) | bytes[offset + 47];
  let w12 = (bytes[offset + 48] << 24) | (bytes[offset + 49] << 16) | (bytes[offset + 50] << 8) | bytes[offset + 51];
  let w13 = (bytes[offset + 52] << 24) | (bytes[offset + 53] << 16) | (bytes[offset + 54] << 8) | bytes[offset + 55];
  let w14 = (bytes[offset + 56] << 24) | (bytes[offset + 57] << 16) | (bytes[offset + 58] << 8) | bytes[offset + 59];
  let w15 = (bytes[offset + 60] << 24) | (bytes[offset + 61] << 16) | (bytes[offset + 62] << 8) | bytes[offset + 63];
  // 2. Working variables.
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  let s = 0;
  let t1 = 0;
  // 3. Compression, 16 rounds a pass.
  for (let t = 0; t < 64; t += 16) {
    if (t > 0) {
      // The schedule's next 16 words, W_t … W_t+15, in place: in order, each reads only words of the
      // window it may (W_t−2 and W_t−7 may be new, W_t−15 and W_t−16 are not yet overwritten).
      s = ((w14 >>> 17) | (w14 << 15)) ^ ((w14 >>> 19) | (w14 << 13)) ^ (w14 >>> 10);
      w0 = (((s + w9) | 0) + (((((w1 >>> 7) | (w1 << 25)) ^ ((w1 >>> 18) | (w1 << 14)) ^ (w1 >>> 3)) + w0) | 0)) | 0;
      s = ((w15 >>> 17) | (w15 << 15)) ^ ((w15 >>> 19) | (w15 << 13)) ^ (w15 >>> 10);
      w1 = (((s + w10) | 0) + (((((w2 >>> 7) | (w2 << 25)) ^ ((w2 >>> 18) | (w2 << 14)) ^ (w2 >>> 3)) + w1) | 0)) | 0;
      s = ((w0 >>> 17) | (w0 << 15)) ^ ((w0 >>> 19) | (w0 << 13)) ^ (w0 >>> 10);
      w2 = (((s + w11) | 0) + (((((w3 >>> 7) | (w3 << 25)) ^ ((w3 >>> 18) | (w3 << 14)) ^ (w3 >>> 3)) + w2) | 0)) | 0;
      s = ((w1 >>> 17) | (w1 << 15)) ^ ((w1 >>> 19) | (w1 << 13)) ^ (w1 >>> 10);
      w3 = (((s + w12) | 0) + (((((w4 >>> 7) | (w4 << 25)) ^ ((w4 >>> 18) | (w4 << 14)) ^ (w4 >>> 3)) + w3) | 0)) | 0;
      s = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w4 = (((s + w13) | 0) + (((((w5 >>> 7) | (w5 << 25)) ^ ((w5 >>> 18) | (w5 << 14)) ^ (w5 >>> 3)) + w4) | 0)) | 0;
      s = ((w3 >>> 17) | (w3 << 15)) ^ ((w3 >>> 19) | (w3 << 13)) ^ (w3 >>> 10);
      w5 = (((s + w14) | 0) + (((((w6 >>> 7) | (w6 << 25)) ^ ((w6 >>> 18) | (w6 << 14)) ^ (w6 >>> 3)) + w5) | 0)) | 0;
      s = ((w4 >>> 17) | (w4 << 15)) ^ ((w4 >>> 19) | (w4 << 13)) ^ (w4 >>> 10);
      w6 = (((s + w15) | 0) + (((((w7 >>> 7) | (w7 << 25)) ^ ((w7 >>> 18) | (w7 << 14)) ^ (w7 >>> 3)) + w6) | 0)) | 0;
      s = ((w5 >>> 17) | (w5 << 15)) ^ ((w5 >>> 19) | (w5 << 13)) ^ (w5 >>> 10);
      w7 = (((s + w0) | 0) + (((((w8 >>> 7) | (w8 << 25)) ^ ((w8 >>> 18) | (w8 << 14)) ^ (w8 >>> 3)) + w7) | 0)) | 0;
      s = ((w6 >>> 17) | (w6 << 15)) ^ ((w6 >>> 19) | (w6 << 13)) ^ (w6 >>> 10);
      w8 = (((s + w1) | 0) + (((((w9 >>> 7) | (w9 << 25)) ^ ((w9 >>> 18) | (w9 << 14)) ^ (w9 >>> 3)) + w8) | 0)) | 0;
      s = ((w7 >>> 17) | (w7 << 15)) ^ ((w7 >>> 19) | (w7 << 13)) ^ (w7 >>> 10);
      w9 =
        (((s + w2) | 0) + (((((w10 >>> 7) | (w10 << 25)) ^ ((w10 >>> 18) | (w10 << 14)) ^ (w10 >>> 3)) + w9) | 0)) | 0;
      s = ((w8 >>> 17) | (w8 << 15)) ^ ((w8 >>> 19) | (w8 << 13)) ^ (w8 >>> 10);
      w10 =
        (((s + w3) | 0) + (((((w11 >>> 7) | (w11 << 25)) ^ ((w11 >>> 18) | (w11 << 14)) ^ (w11 >>> 3)) + w10) | 0)) | 0;
      s = ((w9 >>> 17) | (w9 << 15)) ^ ((w9 >>> 19) | (w9 << 13)) ^ (w9 >>> 10);
      w11 =
        (((s + w4) | 0) + (((((w12 >>> 7) | (w12 << 25)) ^ ((w12 >>> 18) | (w12 << 14)) ^ (w12 >>> 3)) + w11) | 0)) | 0;
      s = ((w10 >>> 17) | (w10 << 15)) ^ ((w10 >>> 19) | (w10 << 13)) ^ (w10 >>> 10);
      w12 =
        (((s + w5) | 0) + (((((w13 >>> 7) | (w13 << 25)) ^ ((w13 >>> 18) | (w13 << 14)) ^ (w13 >>> 3)) + w12) | 0)) | 0;
      s = ((w11 >>> 17) | (w11 << 15)) ^ ((w11 >>> 19) | (w11 << 13)) ^ (w11 >>> 10);
      w13 =
        (((s + w6) | 0) + (((((w14 >>> 7) | (w14 << 25)) ^ ((w14 >>> 18) | (w14 << 14)) ^ (w14 >>> 3)) + w13) | 0)) | 0;
      s = ((w12 >>> 17) | (w12 << 15)) ^ ((w12 >>> 19) | (w12 << 13)) ^ (w12 >>> 10);
      w14 =
        (((s + w7) | 0) + (((((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) + w14) | 0)) | 0;
      s = ((w13 >>> 17) | (w13 << 15)) ^ ((w13 >>> 19) | (w13 << 13)) ^ (w13 >>> 10);
      w15 = (((s + w8) | 0) + (((((w0 >>> 7) | (w0 << 25)) ^ ((w0 >>> 18) | (w0 << 14)) ^ (w0 >>> 3)) + w15) | 0)) | 0;
    }
    // Round t + 0: a … h are a, b, c, d, e, f, g, hh.
    s = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    t1 = (((((hh + s) | 0) + (((g ^ (e & (f ^ g))) + K[t + 0]) | 0)) | 0) + w0) | 0;
    d = (d + t1) | 0;
    s = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    hh = (t1 + ((s + ((a & b) ^ (c & (a ^ b)))) | 0)) | 0;
    // Round t + 1: a … h are hh, a, b, c, d, e, f, g.
    s = ((d >>> 6) | (d << 26)) ^ ((d >>> 11) | (d << 21)) ^ ((d >>> 25) | (d << 7));
    t1 = (((((g + s) | 0) + (((f ^ (d & (e ^ f))) + K[t + 1]) | 0)) | 0) + w1) | 0;
    c = (c + t1) | 0;
    s = ((hh >>> 2) | (hh << 30)) ^ ((hh >>> 13) | (hh << 19)) ^ ((hh >>> 22) | (hh << 10));
    g = (t1 + ((s + ((hh & a) ^ (b & (hh ^ a)))) | 0)) | 0;
    // Round t + 2: a … h are g, hh, a, b, c, d, e, f.
    s = ((c >>> 6) | (c << 26)) ^ ((c >>> 11) | (c << 21)) ^ ((c >>> 25) | (c << 7));
    t1 = (((((f + s) | 0) + (((e ^ (c & (d ^ e))) + K[t + 2]) | 0)) | 0) + w2) | 0;
    b = (b + t1) | 0;
    s = ((g >>> 2) | (g << 30)) ^ ((g >>> 13) | (g << 19)) ^ ((g >>> 22) | (g << 10));
    f = (t1 + ((s + ((g & hh) ^ (a & (g ^ hh)))) | 0)) | 0;
    // Round t + 3: a … h are f, g, hh, a, b, c, d, e.
    s = ((b >>> 6) | (b << 26)) ^ ((b >>> 11) | (b << 21)) ^ ((b >>> 25) | (b << 7));
    t1 = (((((e + s) | 0) + (((d ^ (b & (c ^ d))) + K[t + 3]) | 0)) | 0) + w3) | 0;
    a = (a + t1) | 0;
    s = ((f >>> 2) | (f << 30)) ^ ((f >>> 13) | (f << 19)) ^ ((f >>> 22) | (f << 10));
    e = (t1 + ((s + ((f & g) ^ (hh & (f ^ g)))) | 0)) | 0;
    // Round t + 4: a … h are e, f, g, hh, a, b, c, d.
    s = ((a >>> 6) | (a << 26)) ^ ((a >>> 11) | (a << 21)) ^ ((a >>> 25) | (a << 7));
    t1 = (((((d + s) | 0) + (((c ^ (a & (b ^ c))) + K[t + 4]) | 0)) | 0) + w4) | 0;
    hh = (hh + t1) | 0;
    s = ((e >>> 2) | (e << 30)) ^ ((e >>> 13) | (e << 19)) ^ ((e >>> 22) | (e << 10));
    d = (t1 + ((s + ((e & f) ^ (g & (e ^ f)))) | 0)) | 0;
    // Round t + 5: a … h are d, e, f, g, hh, a, b, c.
    s = ((hh >>> 6) | (hh << 26)) ^ ((hh >>> 11) | (hh << 21)) ^ ((hh >>> 25) | (hh << 7));
    t1 = (((((c + s) | 0) + (((b ^ (hh & (a ^ b))) + K[t + 5]) | 0)) | 0) + w5) | 0;
    g = (g + t1) | 0;
    s = ((d >>> 2) | (d << 30)) ^ ((d >>> 13) | (d << 19)) ^ ((d >>> 22) | (d << 10));
    c = (t1 + ((s + ((d & e) ^ (f & (d ^ e)))) | 0)) | 0;
    // Round t + 6: a … h are c, d, e, f, g, hh, a, b.
    s = ((g >>> 6) | (g << 26)) ^ ((g >>> 11) | (g << 21)) ^ ((g >>> 25) | (g << 7));
    t1 = (((((b + s) | 0) + (((a ^ (g & (hh ^ a))) + K[t + 6]) | 0)) | 0) + w6) | 0;
    f = (f + t1) | 0;
    s = ((c >>> 2) | (c << 30)) ^ ((c >>> 13) | (c << 19)) ^ ((c >>> 22) | (c << 10));
    b = (t1 + ((s + ((c & d) ^ (e & (c ^ d)))) | 0)) | 0;
    // Round t + 7: a … h are b, c, d, e, f, g, hh, a.
    s = ((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7));
    t1 = (((((a + s) | 0) + (((hh ^ (f & (g ^ hh))) + K[t + 7]) | 0)) | 0) + w7) | 0;
    e = (e + t1) | 0;
    s = ((b >>> 2) | (b << 30)) ^ ((b >>> 13) | (b << 19)) ^ ((b >>> 22) | (b << 10));
    a = (t1 + ((s + ((b & c) ^ (d & (b ^ c)))) | 0)) | 0;
    // Round t + 8: a … h are a, b, c, d, e, f, g, hh.
    s = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    t1 = (((((hh + s) | 0) + (((g ^ (e & (f ^ g))) + K[t + 8]) | 0)) | 0) + w8) | 0;
    d = (d + t1) | 0;
    s = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    hh = (t1 + ((s + ((a & b) ^ (c & (a ^ b)))) | 0)) | 0;
    // Round t + 9: a … h are hh, a, b, c, d, e, f, g.
    s = ((d >>> 6) | (d << 26)) ^ ((d >>> 11) | (d << 21)) ^ ((d >>> 25) | (d << 7));
    t1 = (((((g + s) | 0) + (((f ^ (d & (e ^ f))) + K[t + 9]) | 0)) | 0) + w9) | 0;
    c = (c + t1) | 0;
    s = ((hh >>> 2) | (hh << 30)) ^ ((hh >>> 13) | (hh << 19)) ^ ((hh >>> 22) | (hh << 10));
    g = (t1 + ((s + ((hh & a) ^ (b & (hh ^ a)))) | 0)) | 0;
    // Round t + 10: a … h are g, hh, a, b, c, d, e, f.
    s = ((c >>> 6) | (c << 26)) ^ ((c >>> 11) | (c << 21)) ^ ((c >>> 25) | (c << 7));
    t1 = (((((f + s) | 0) + (((e ^ (c & (d ^ e))) + K[t + 10]) | 0)) | 0) + w10) | 0;
    b = (b + t1) | 0;
    s = ((g >>> 2) | (g << 30)) ^ ((g >>> 13) | (g << 19)) ^ ((g >>> 22) | (g << 10));
    f = (t1 + ((s + ((g & hh) ^ (a & (g ^ hh)))) | 0)) | 0;
    // Round t + 11: a … h are f, g, hh, a, b, c, d, e.
    s = ((b >>> 6) | (b << 26)) ^ ((b >>> 11) | (b << 21)) ^ ((b >>> 25) | (b << 7));
    t1 = (((((e + s) | 0) + (((d ^ (b & (c ^ d))) + K[t + 11]) | 0)) | 0) + w11) | 0;
    a = (a + t1) | 0;
    s = ((f >>> 2) | (f << 30)) ^ ((f >>> 13) | (f << 19)) ^ ((f >>> 22) | (f << 10));
    e = (t1 + ((s + ((f & g) ^ (hh & (f ^ g)))) | 0)) | 0;
    // Round t + 12: a … h are e, f, g, hh, a, b, c, d.
    s = ((a >>> 6) | (a << 26)) ^ ((a >>> 11) | (a << 21)) ^ ((a >>> 25) | (a << 7));
    t1 = (((((d + s) | 0) + (((c ^ (a & (b ^ c))) + K[t + 12]) | 0)) | 0) + w12) | 0;
    hh = (hh + t1) | 0;
    s = ((e >>> 2) | (e << 30)) ^ ((e >>> 13) | (e << 19)) ^ ((e >>> 22) | (e << 10));
    d = (t1 + ((s + ((e & f) ^ (g & (e ^ f)))) | 0)) | 0;
    // Round t + 13: a … h are d, e, f, g, hh, a, b, c.
    s = ((hh >>> 6) | (hh << 26)) ^ ((hh >>> 11) | (hh << 21)) ^ ((hh >>> 25) | (hh << 7));
    t1 = (((((c + s) | 0) + (((b ^ (hh & (a ^ b))) + K[t + 13]) | 0)) | 0) + w13) | 0;
    g = (g + t1) | 0;
    s = ((d >>> 2) | (d << 30)) ^ ((d >>> 13) | (d << 19)) ^ ((d >>> 22) | (d << 10));
    c = (t1 + ((s + ((d & e) ^ (f & (d ^ e)))) | 0)) | 0;
    // Round t + 14: a … h are c, d, e, f, g, hh, a, b.
    s = ((g >>> 6) | (g << 26)) ^ ((g >>> 11) | (g << 21)) ^ ((g >>> 25) | (g << 7));
    t1 = (((((b + s) | 0) + (((a ^ (g & (hh ^ a))) + K[t + 14]) | 0)) | 0) + w14) | 0;
    f = (f + t1) | 0;
    s = ((c >>> 2) | (c << 30)) ^ ((c >>> 13) | (c << 19)) ^ ((c >>> 22) | (c << 10));
    b = (t1 + ((s + ((c & d) ^ (e & (c ^ d)))) | 0)) | 0;
    // Round t + 15: a … h are b, c, d, e, f, g, hh, a.
    s = ((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7));
    t1 = (((((a + s) | 0) + (((hh ^ (f & (g ^ hh))) + K[t + 15]) | 0)) | 0) + w15) | 0;
    e = (e + t1) | 0;
    s = ((b >>> 2) | (b << 30)) ^ ((b >>> 13) | (b << 19)) ^ ((b >>> 22) | (b << 10));
    a = (t1 + ((s + ((b & c) ^ (d & (b ^ c)))) | 0)) | 0;
  }
  // 4. Intermediate hash value.
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0;
  h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0;
  h[7] = (h[7] + hh) | 0;
}

/** Section 6.2.2: hashes `message` and returns the 32-byte digest. */
export function sha256(message: Uint8Array): Uint8Array {
  return sha256Finish(Int32Array.from(SHA256_H0), message, 0);
}

/**
 * The hash state after the whole 64-byte blocks of `message` before `end` (rounded down to a block):
 * a midstate a later {@link sha256Finish} of a message with the same leading bytes can resume from, so
 * an unchanged prefix isn't hashed again (F3.6 part 2: a netlist's node section across a connection
 * toggle). Returns `[state, bytes]`, the state and how many bytes it covers.
 */
export function sha256Prefix(message: Uint8Array, end: number): readonly [Int32Array, number] {
  const h = Int32Array.from(SHA256_H0);
  const whole = Math.min(end, message.length) - (Math.min(end, message.length) % 64);
  for (let offset = 0; offset < whole; offset += 64) compress(h, message, offset);
  return [h, whole];
}

/**
 * The digest of `message`, from `state`, the hash state after its first `offset` bytes (a multiple of
 * 64: the initial values for 0, or a {@link sha256Prefix} of a message with the same first `offset`
 * bytes). `state` is not modified.
 */
export function sha256Finish(state: Int32Array, message: Uint8Array, offset: number): Uint8Array {
  if (offset % 64 !== 0 || offset > message.length)
    throw new RangeError('sha256Finish: offset must be a block boundary');
  const h = Int32Array.from(state);
  // The whole blocks straight from the message; only the tail is copied to be padded.
  const whole = message.length - (message.length % 64);
  for (let block = offset; block < whole; block += 64) compress(h, message, block);
  // Section 5.1.1: append a 1 bit, pad with zeros to 56 mod 64 bytes, then the 64-bit big-endian
  // bit length: one or two more blocks.
  const rest = message.length - whole;
  const tail = new Uint8Array(rest + 9 <= 64 ? 64 : 128);
  tail.set(message.subarray(whole));
  tail[rest] = 0x80;
  const bits = message.length * 8;
  const high = Math.floor(bits / 0x1_0000_0000);
  const low = bits >>> 0;
  const end = tail.length;
  tail[end - 8] = high >>> 24;
  tail[end - 7] = (high >>> 16) & 0xff;
  tail[end - 6] = (high >>> 8) & 0xff;
  tail[end - 5] = high & 0xff;
  tail[end - 4] = low >>> 24;
  tail[end - 3] = (low >>> 16) & 0xff;
  tail[end - 2] = (low >>> 8) & 0xff;
  tail[end - 1] = low & 0xff;
  for (let block = 0; block < end; block += 64) compress(h, tail, block);

  const digest = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const word = h[i];
    digest[4 * i] = word >>> 24;
    digest[4 * i + 1] = (word >>> 16) & 0xff;
    digest[4 * i + 2] = (word >>> 8) & 0xff;
    digest[4 * i + 3] = word & 0xff;
  }
  return digest;
}

/**
 * UTF-8 encoding of a string, like `TextEncoder` (which isn't an ECMAScript global, so domain code
 * can't rely on it): an unpaired surrogate becomes U+FFFD. World strings are well-formed anyway.
 */
export function utf8Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const next = text.charCodeAt(i + 1); // NaN past the end
      if (cp <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    }
    if (cp < 0x80) {
      bytes[n++] = cp;
    } else if (cp < 0x800) {
      bytes[n++] = 0xc0 | (cp >> 6);
      bytes[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      bytes[n++] = 0xe0 | (cp >> 12);
      bytes[n++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[n++] = 0x80 | (cp & 0x3f);
    } else {
      bytes[n++] = 0xf0 | (cp >> 18);
      bytes[n++] = 0x80 | ((cp >> 12) & 0x3f);
      bytes[n++] = 0x80 | ((cp >> 6) & 0x3f);
      bytes[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return bytes.slice(0, n);
}

/** Each byte's two lower-case hex digits, so `toHex` formats no number (perf only). */
const HEX_DIGITS: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

/** Lower-case hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += HEX_DIGITS[bytes[i]];
  return hex;
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lower-case hex digits. */
export function sha256Hex(text: string): string {
  return toHex(sha256(utf8Encode(text)));
}
