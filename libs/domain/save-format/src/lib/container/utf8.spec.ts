import fc from 'fast-check';
import { safeStringArb } from '../../testing/arbitraries';
import { utf8ByteLength, utf8Decode, utf8Encode, Utf8Error } from './utf8';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('utf8Encode', () => {
  it('matches Node’s encoder for well-formed strings', () => {
    fc.assert(
      fc.property(safeStringArb, (s) => {
        expect(utf8Encode(s)).toStrictEqual(new Uint8Array(Buffer.from(s, 'utf8')));
      }),
    );
  });

  it.each([['\uD800'], ['a\uDC00'], ['\uDBFFA'], ['\uDC00\uD800']])('refuses the unpaired surrogate in %j', (s) => {
    expect(() => utf8Encode(s)).toThrow(Utf8Error);
  });
});

describe('utf8Decode', () => {
  it('round-trips every well-formed string', () => {
    fc.assert(
      fc.property(safeStringArb, (s) => {
        expect(utf8Decode(utf8Encode(s))).toBe(s);
      }),
    );
  });

  it('decodes long input across chunk boundaries', () => {
    const text = '€'.repeat(20_000) + '😀'.repeat(5_000);
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it.each([
    ['a lone continuation byte', bytes(0x80)],
    ['an overlong 2-byte form', bytes(0xc0, 0xaf)],
    ['an overlong 3-byte form', bytes(0xe0, 0x80, 0xaf)],
    ['an overlong 4-byte form', bytes(0xf0, 0x80, 0x80, 0xaf)],
    ['an encoded surrogate', bytes(0xed, 0xa0, 0x80)],
    ['a code point above U+10FFFF', bytes(0xf4, 0x90, 0x80, 0x80)],
    ['an invalid lead byte', bytes(0xff)],
    ['a truncated 2-byte sequence', bytes(0xc3)],
    ['a truncated 3-byte sequence', bytes(0xe2, 0x82)],
    ['a truncated 4-byte sequence', bytes(0xf0, 0x9f, 0x98)],
    ['a bad continuation', bytes(0xe2, 0x28, 0xa1)],
    ['a byte-order mark', bytes(0xef, 0xbb, 0xbf, 0x7b, 0x7d)],
  ])('refuses %s', (_name, input) => {
    expect(utf8Decode(input)).toBeNull();
  });

  it('agrees with a fatal TextDecoder on arbitrary bytes', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 16 }), (input) => {
        let expected: string | null;
        try {
          expected = decoder.decode(input);
        } catch {
          expected = null;
        }
        if (expected !== null && expected.startsWith('﻿')) expected = null;
        expect(utf8Decode(input)).toBe(expected);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('utf8ByteLength', () => {
  it('is the length utf8Encode gives, for any well-formed string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (s) => {
        expect(utf8ByteLength(s)).toBe(utf8Encode(s).length);
      }),
    );
    fc.assert(
      fc.property(safeStringArb, (s) => {
        expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'));
      }),
    );
  });

  it('counts 1, 2, 3 and 4 byte sequences, and an unpaired surrogate as U+FFFD', () => {
    expect([utf8ByteLength('a'), utf8ByteLength('é'), utf8ByteLength('€'), utf8ByteLength('😀')]).toEqual([1, 2, 3, 4]);
    expect([utf8ByteLength('\uD800'), utf8ByteLength('\uDC00x'), utf8ByteLength('')]).toEqual([3, 4, 0]);
  });
});
