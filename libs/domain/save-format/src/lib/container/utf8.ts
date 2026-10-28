/*
 * Strict UTF-8 for the `.ctrl` container. `TextEncoder` and `TextDecoder` aren't ECMAScript globals
 * (domain code compiles against `es2022` only and also runs in the sim worker), and the decoder must
 * refuse malformed input rather than replace it with U+FFFD: a save that doesn't decode exactly is
 * corrupt, not "nearly right".
 */

/** Thrown by {@link utf8Encode} for a string that UTF-8 can't represent losslessly. */
export class Utf8Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Utf8Error';
  }
}

/** UTF-8 bytes of `text`. Throws {@link Utf8Error} on an unpaired surrogate (which UTF-8 would replace). */
export function utf8Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const next = text.charCodeAt(i + 1); // NaN past the end
      if (cp > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Utf8Error(`Unpaired UTF-16 surrogate at index ${i}`);
      }
      cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
      i++;
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

/** Code units are flushed to a string in chunks of this size (`String.fromCharCode` argument limit). */
const CHUNK = 8192;

/**
 * Decodes UTF-8 strictly (RFC 3629): no overlong forms, no encoded surrogates, nothing above
 * U+10FFFF, no truncated sequences. A leading byte-order mark is refused too (the container never
 * writes one). Returns `null` for malformed input; never throws.
 */
export function utf8Decode(bytes: Uint8Array): string | null {
  const parts: string[] = [];
  const units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = bytes[i + 1];
      if (!isCont(b1)) return null;
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (!isCont(b1) || !isCont(b2)) return null;
      if (b0 === 0xe0 && b1 < 0xa0) return null; // overlong
      if (b0 === 0xed && b1 > 0x9f) return null; // U+D800..U+DFFF
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      i += 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (!isCont(b1) || !isCont(b2) || !isCont(b3)) return null;
      if (b0 === 0xf0 && b1 < 0x90) return null; // overlong
      if (b0 === 0xf4 && b1 > 0x8f) return null; // above U+10FFFF
      cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      i += 4;
    } else {
      return null; // continuation byte without a lead, C0/C1 overlong leads, F5..FF
    }
    if (cp === 0xfeff && parts.length === 0 && units.length === 0) return null; // byte-order mark
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 | (v >> 10), 0xdc00 | (v & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= CHUNK) {
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  parts.push(String.fromCharCode(...units));
  return parts.join('');
}

function isCont(b: number | undefined): boolean {
  return b !== undefined && (b & 0xc0) === 0x80;
}
