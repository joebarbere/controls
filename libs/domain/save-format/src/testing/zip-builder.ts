import { deflateSync } from 'fflate';
import { crc32 } from '../lib/container/crc32';
import { utf8Encode } from '../lib/container/utf8';

/*
 * Test-only: a raw ZIP writer that will write anything, including archives the real writer never
 * produces (lying sizes, traversal names, encryption flags, overlapping entries …), so the reader's
 * refusals can be tested one by one.
 */

export interface RawZipEntry {
  /** A string (UTF-8 encoded) or raw name bytes. */
  readonly name: string | Uint8Array;
  readonly data?: Uint8Array | string;
  /** 0 stored (default for directories), 8 deflate (default). Any other number is written as is. */
  readonly method?: number;
  /** Bytes written as the entry's data instead of compressing `data` (for corrupt streams). */
  readonly rawBody?: Uint8Array;
  readonly flags?: number;
  readonly versionNeeded?: number;
  readonly crc?: number;
  readonly compressedSize?: number;
  readonly uncompressedSize?: number;
  /** Name written into the local header, if different. */
  readonly localName?: string;
  /** Local header offset written into the central directory, if different. */
  readonly localOffset?: number;
  readonly startDisk?: number;
}

export interface RawZipOptions {
  readonly comment?: Uint8Array;
  readonly eocdCount?: number;
  readonly eocdCountOnDisk?: number;
  readonly eocdDisk?: number;
  readonly centralStart?: number;
  readonly centralSize?: number;
  /** Bytes inserted before the first local header. */
  readonly prefix?: Uint8Array;
  /** Writes a ZIP64 end-of-central-directory locator just before the end record. */
  readonly zip64Locator?: boolean;
}

const bytesOf = (value: Uint8Array | string | undefined): Uint8Array =>
  value === undefined ? new Uint8Array(0) : typeof value === 'string' ? utf8Encode(value) : value;

export function rawZip(entries: readonly RawZipEntry[], options: RawZipOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    at += bytes.length;
  };
  if (options.prefix) push(options.prefix);

  const central: Uint8Array[] = [];
  for (const entry of entries) {
    const name = bytesOf(entry.name);
    const localName = entry.localName === undefined ? name : utf8Encode(entry.localName);
    const data = bytesOf(entry.data);
    const isDirectory = typeof entry.name === 'string' && entry.name.endsWith('/');
    const method = entry.method ?? (isDirectory ? 0 : 8);
    const body = entry.rawBody ?? (method === 8 ? deflateSync(data) : data);
    const crc = entry.crc ?? crc32(data);
    const compressedSize = entry.compressedSize ?? body.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const flags = entry.flags ?? 0;
    const versionNeeded = entry.versionNeeded ?? 20;
    const offset = at;

    const local = new Uint8Array(30 + localName.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, versionNeeded, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    push(local);
    push(body);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, versionNeeded, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(34, entry.startDisk ?? 0, true);
    cv.setUint32(42, entry.localOffset ?? offset, true);
    record.set(name, 46);
    central.push(record);
  }
  const centralStart = at;
  for (const record of central) push(record);
  const centralSize = at - centralStart;
  if (options.zip64Locator) {
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    push(locator);
  }
  const comment = options.comment ?? new Uint8Array(0);
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, options.eocdDisk ?? 0, true);
  ev.setUint16(8, options.eocdCountOnDisk ?? options.eocdCount ?? entries.length, true);
  ev.setUint16(10, options.eocdCount ?? entries.length, true);
  ev.setUint32(12, options.centralSize ?? centralSize, true);
  ev.setUint32(16, options.centralStart ?? centralStart, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  push(eocd);

  const out = new Uint8Array(at);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A minimal valid PNG (1 × 1, one grey pixel), for thumbnails in tests. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b, 0x55, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x68, 0x00, 0x00, 0x00, 0x82, 0x00, 0x81, 0xda, 0x45, 0x08, 0x3b, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
