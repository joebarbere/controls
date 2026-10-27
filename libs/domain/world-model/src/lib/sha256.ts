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

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Section 6.2.2: hashes `message` and returns the 32-byte digest. */
export function sha256(message: Uint8Array): Uint8Array {
  // Section 5.1.1: append a 1 bit, pad with zeros to 56 mod 64 bytes, then the 64-bit big-endian bit length.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = message.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bits >>> 0);

  const h = Uint32Array.from(SHA256_H0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    // 1. Message schedule.
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const sigma0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const sigma1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (sigma1 + w[t - 7] + sigma0 + w[t - 16]) >>> 0;
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
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + bigSigma1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigSigma0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    // 4. Intermediate hash value.
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  h.forEach((word, i) => out.setUint32(i * 4, word));
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
