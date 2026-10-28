import fc from 'fast-check';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { crc32 } from './crc32';
import { utf8Encode } from './utf8';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(utf8Encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches Node’s zlib for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        expect(crc32(bytes)).toBe(nodeCrc32(bytes));
      }),
    );
  });
});
