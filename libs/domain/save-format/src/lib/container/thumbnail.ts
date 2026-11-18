import { CTRL_ENTRY, CTRL_LIMITS, PNG_SIGNATURE } from './ctrl';
import { extractZipEntry } from './zip';

/*
 * Reading only `thumbnail.png` out of a `.ctrl` (the Load list, ADR 0009 amendment 2026-11-18):
 * the end-of-central-directory record, the central directory and that one entry, through a
 * random-access source, so a 30 MiB save costs a few reads of a few KiB rather than the whole file.
 * Electron main reads through a file descriptor; the web harness through `File.slice()`.
 *
 * This is a display path, not a load: anything it doesn't like is `null` (no thumbnail), never an
 * error, and a save it shows a thumbnail for may still fail to load. For the one entry it reads, the
 * same checks as `readZipDirectory` (no ZIP64, version needed ≤ 2.0, only the allowed flags, stored
 * or DEFLATE, one disk, a local header whose method and name bytes match the central directory), the
 * same caps and the same CRC-32 check; the PNG signature is checked, the image isn't decoded. Not
 * checked, because they are never read: the other entries' headers, names and overlaps.
 */

/** Byte ranges of a file, read on demand. `read` resolves at most `length` bytes (fewer at the end). */
export interface RandomAccessBytes {
  /** The file's size in bytes. */
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** General-purpose flag bits accepted, as `readZipDirectory`: 1–2 (DEFLATE options), 3 (data descriptor), 11 (UTF-8). */
const ALLOWED_FLAGS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 11);
/** "Version needed to extract" above 2.0 means ZIP64, AES, LZMA, … (as `readZipDirectory`). */
const MAX_VERSION_NEEDED = 20;
/**
 * The largest central directory read: `CTRL_LIMITS.maxEntries` headers with the longest name a
 * reader accepts (128 bytes) and generous room for extra fields and comments. A save written by the
 * game has none, so its directory is about 300 bytes.
 */
export const MAX_THUMBNAIL_CENTRAL_DIRECTORY_BYTES = 256 * 1024;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The PNG bytes of a `.ctrl`'s `thumbnail.png`, or `null` when there is none or the archive is
 * malformed, too large or not a `.ctrl`. Reads four ranges: the tail (up to 64 KiB + 22 bytes), the
 * central directory (at most {@link MAX_THUMBNAIL_CENTRAL_DIRECTORY_BYTES}), the entry's local header
 * with its name (43 bytes), then its data (at most `CTRL_LIMITS.maxThumbnailBytes`). Rejects only when
 * `source.read` does (an I/O error).
 */
export async function readCtrlThumbnail(source: RandomAccessBytes): Promise<Uint8Array | null> {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size < EOCD_SIZE || size > CTRL_LIMITS.maxContainerBytes) return null;
  const exact = async (offset: number, length: number): Promise<Uint8Array | null> => {
    const bytes = await source.read(offset, length);
    return bytes.byteLength === length ? bytes : null;
  };

  // End of central directory: the last record whose comment runs exactly to the end of the file.
  const tailStart = Math.max(0, size - EOCD_SIZE - MAX_COMMENT);
  const tail = await exact(tailStart, size - tailStart);
  if (tail === null) return null;
  const t = view(tail);
  let eocd = -1;
  for (let at = tail.length - EOCD_SIZE; at >= 0; at--) {
    if (t.getUint32(at, true) === SIG_EOCD && at + EOCD_SIZE + t.getUint16(at + 20, true) === tail.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  if (eocd >= 20 && t.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) return null;
  const count = t.getUint16(eocd + 10, true);
  const centralSize = t.getUint32(eocd + 12, true);
  const centralStart = t.getUint32(eocd + 16, true);
  if (
    t.getUint16(eocd + 4, true) !== 0 ||
    t.getUint16(eocd + 6, true) !== 0 ||
    t.getUint16(eocd + 8, true) !== count ||
    count > CTRL_LIMITS.maxEntries ||
    centralSize > MAX_THUMBNAIL_CENTRAL_DIRECTORY_BYTES ||
    centralStart + centralSize !== tailStart + eocd
  ) {
    return null;
  }

  const central = await exact(centralStart, centralSize);
  if (central === null) return null;
  const c = view(central);
  const wanted = CTRL_ENTRY.thumbnail;
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > central.length || c.getUint32(at, true) !== SIG_CENTRAL) return null;
    const nameLength = c.getUint16(at + 28, true);
    const next = at + CENTRAL_SIZE + nameLength + c.getUint16(at + 30, true) + c.getUint16(at + 32, true);
    if (next > central.length) return null;
    const name = central.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    if (sameAscii(name, wanted)) {
      return readEntry(exact, {
        versionNeeded: c.getUint16(at + 6, true) & 0xff,
        flags: c.getUint16(at + 8, true),
        method: c.getUint16(at + 10, true),
        crc: c.getUint32(at + 16, true),
        compressedSize: c.getUint32(at + 20, true),
        uncompressedSize: c.getUint32(at + 24, true),
        diskStart: c.getUint16(at + 34, true),
        localStart: c.getUint32(at + 42, true),
        nameLength,
        centralStart,
      });
    }
    at = next;
  }
  return null; // no thumbnail
}

interface CentralRecord {
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly diskStart: number;
  readonly localStart: number;
  readonly nameLength: number;
  readonly centralStart: number;
}

async function readEntry(
  exact: (offset: number, length: number) => Promise<Uint8Array | null>,
  r: CentralRecord,
): Promise<Uint8Array | null> {
  const limit = CTRL_LIMITS.maxThumbnailBytes;
  // `readZipDirectory`'s per-entry checks: no unknown flags (encryption among them), version ≤ 2.0, one disk.
  if (r.flags & ~ALLOWED_FLAGS || r.versionNeeded > MAX_VERSION_NEEDED || r.diskStart !== 0) return null;
  if (r.method !== METHOD_STORED && r.method !== METHOD_DEFLATE) return null;
  if (r.uncompressedSize > limit || r.compressedSize > limit) return null;
  if (r.method === METHOD_STORED && r.compressedSize !== r.uncompressedSize) return null;
  if (r.localStart + LOCAL_SIZE + r.nameLength > r.centralStart) return null;

  // The local header and its name, which must agree with the central directory byte for byte.
  const local = await exact(r.localStart, LOCAL_SIZE + r.nameLength);
  if (local === null) return null;
  const l = view(local);
  if (
    l.getUint32(0, true) !== SIG_LOCAL ||
    l.getUint16(8, true) !== r.method ||
    l.getUint16(26, true) !== r.nameLength ||
    !sameAscii(local.subarray(LOCAL_SIZE), CTRL_ENTRY.thumbnail)
  ) {
    return null;
  }
  const dataStart = r.localStart + LOCAL_SIZE + r.nameLength + l.getUint16(28, true);
  if (dataStart + r.compressedSize > r.centralStart) return null;
  const body = await exact(dataStart, r.compressedSize);
  if (body === null) return null;
  // The same slice-wise inflate, size and CRC-32 checks as a load.
  const extracted = extractZipEntry(
    body,
    {
      name: CTRL_ENTRY.thumbnail,
      isDirectory: false,
      method: r.method,
      crc: r.crc,
      compressedSize: r.compressedSize,
      uncompressedSize: r.uncompressedSize,
      dataStart: 0,
    },
    limit,
  );
  if (!extracted.ok) return null;
  const png = extracted.data;
  return png.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => png[i] === byte) ? png : null;
}

function sameAscii(bytes: Uint8Array, text: string): boolean {
  if (bytes.length !== text.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/** A {@link RandomAccessBytes} over bytes already in memory (tests, and a caller that has the file). */
export function bytesSource(bytes: Uint8Array): RandomAccessBytes {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.slice(offset, Math.min(bytes.byteLength, offset + length)),
  };
}
