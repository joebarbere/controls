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
 * inlined: the bits are the standard's, only the arithmetic's JavaScript form is faster.
 */
function compress(h: Int32Array, w: Int32Array, bytes: Uint8Array, offset: number): void {
  // 1. Message schedule (big-endian words).
  for (let t = 0; t < 16; t++) {
    const i = offset + 4 * t;
    w[t] = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
  }
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const sigma0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const sigma1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (sigma1 + w[t - 7] + sigma0 + w[t - 16]) | 0;
  }
  // 2. Working variables.
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  // 3. Compression.
  for (let t = 0; t < 64; t++) {
    const bigSigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + bigSigma1 + ch + K[t] + w[t]) | 0;
    const bigSigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (bigSigma0 + maj) | 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
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
  const h = Int32Array.from(SHA256_H0);
  const w = new Int32Array(64);
  // The whole blocks straight from the message; only the tail is copied to be padded.
  const whole = message.length - (message.length % 64);
  for (let offset = 0; offset < whole; offset += 64) compress(h, w, message, offset);
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
  for (let offset = 0; offset < end; offset += 64) compress(h, w, tail, offset);

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

/** Lower-case hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lower-case hex digits. */
export function sha256Hex(text: string): string {
  return toHex(sha256(utf8Encode(text)));
}
