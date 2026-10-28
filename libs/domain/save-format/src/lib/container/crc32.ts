/*
 * CRC-32 as used by ZIP (APPNOTE.TXT 4.4.7): the IEEE 802.3 polynomial, reflected (0xEDB88320),
 * initial value and final XOR 0xFFFFFFFF. Implemented from the published definition; fflate doesn't
 * export its own.
 */

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** Incremental CRC-32: start with {@link CRC32_INITIAL}, feed chunks, then {@link crc32Final}. */
export const CRC32_INITIAL = 0xffffffff;

export function crc32Update(crc: number, bytes: Uint8Array): number {
  const t = crcTable();
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 of `bytes` as an unsigned 32-bit integer (`crc32(utf8("123456789")) === 0xcbf43926`). */
export function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_INITIAL, bytes));
}
