import { deflateSync, Inflate } from 'fflate';
import { CRC32_INITIAL, crc32, crc32Final, crc32Update } from './crc32';

/*
 * The small, strict subset of ZIP (PKWARE APPNOTE.TXT 6.3) that a `.ctrl` uses. fflate does the
 * DEFLATE; the archive structure is written and parsed here, because:
 *
 * - writing must be byte-for-byte deterministic, and fflate's `zipSync` stamps each entry with a
 *   DOS date computed in the *local time zone* (`Date#getHours` …), so the same save would differ
 *   between machines;
 * - reading must never trust the archive: fflate's `unzipSync` allocates whatever uncompressed size
 *   the header declares and inflates in one go, so a hostile header or a zip bomb costs memory
 *   before any check can run. Here every size is checked against a cap first, and entries are
 *   inflated in small slices with the running output size checked as it grows.
 *
 * Supported: stored (0) and DEFLATE (8) entries, no encryption, no ZIP64, one disk, ASCII names.
 */

/** DOS date for 1980-01-01 (the epoch of the format), the fixed timestamp of every entry written. */
export const ZIP_FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** DOS time 00:00:00. */
export const ZIP_FIXED_DOS_TIME = 0;
/** Fixed DEFLATE settings: changing them changes every container's bytes (and the golden hash). */
export const ZIP_DEFLATE_OPTIONS = { level: 6, mem: 12 } as const;

/** Compressed input is fed to the inflater in slices this big, so one step can't expand by more than ~4 MiB. */
const INFLATE_SLICE = 4096;
/** Longest entry name accepted, in bytes. */
export const MAX_ZIP_NAME_BYTES = 128;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** General-purpose flag bits a reader may accept: 1–2 (DEFLATE options), 3 (data descriptor), 11 (UTF-8 names). */
const ALLOWED_FLAGS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 11);
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** "Version needed to extract" above 2.0 means ZIP64, AES, LZMA, … none of which a `.ctrl` uses. */
const MAX_VERSION_NEEDED = 20;

export interface ZipWriteEntry {
  /** A plain relative ASCII path (see {@link checkEntryName}). */
  readonly name: string;
  readonly data: Uint8Array;
  /** DEFLATE it (JSON), or store it as is (already-compressed PNG). */
  readonly deflate: boolean;
}

/**
 * Writes a ZIP with the entries sorted by name (UTF-16 code units), every timestamp at
 * {@link ZIP_FIXED_DOS_DATE}, no extra fields, no comments, no attributes, and DEFLATE at
 * {@link ZIP_DEFLATE_OPTIONS}. The same entries always give the same bytes. Throws `TypeError` for
 * an unsafe or duplicate name; callers pass fixed names.
 */
export function writeZip(entries: readonly ZipWriteEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const records: { name: Uint8Array; method: number; crc: number; size: number; body: Uint8Array }[] = [];
  sorted.forEach((entry, index) => {
    const problem = checkEntryName(entry.name);
    if (problem !== null) throw new TypeError(`Unsafe ZIP entry name (${problem})`);
    if (index > 0 && sorted[index - 1].name === entry.name) throw new TypeError('Duplicate ZIP entry name');
    const body = entry.deflate ? deflateSync(entry.data, ZIP_DEFLATE_OPTIONS) : entry.data;
    records.push({
      name: asciiBytes(entry.name),
      method: entry.deflate ? METHOD_DEFLATE : METHOD_STORED,
      crc: crc32(entry.data),
      size: entry.data.length,
      body,
    });
  });

  const localSize = records.reduce((sum, r) => sum + LOCAL_SIZE + r.name.length + r.body.length, 0);
  const centralSize = records.reduce((sum, r) => sum + CENTRAL_SIZE + r.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + EOCD_SIZE);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const r of records) {
    offsets.push(at);
    view.setUint32(at, SIG_LOCAL, true);
    view.setUint16(at + 4, r.method === METHOD_DEFLATE ? 20 : 10, true);
    view.setUint16(at + 6, 0, true);
    view.setUint16(at + 8, r.method, true);
    view.setUint16(at + 10, ZIP_FIXED_DOS_TIME, true);
    view.setUint16(at + 12, ZIP_FIXED_DOS_DATE, true);
    view.setUint32(at + 14, r.crc, true);
    view.setUint32(at + 18, r.body.length, true);
    view.setUint32(at + 22, r.size, true);
    view.setUint16(at + 26, r.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(r.name, at + LOCAL_SIZE);
    out.set(r.body, at + LOCAL_SIZE + r.name.length);
    at += LOCAL_SIZE + r.name.length + r.body.length;
  }
  const centralStart = at;
  records.forEach((r, i) => {
    view.setUint32(at, SIG_CENTRAL, true);
    view.setUint16(at + 4, 20, true); // made by: version 2.0, MS-DOS attributes (host 0)
    view.setUint16(at + 6, r.method === METHOD_DEFLATE ? 20 : 10, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, r.method, true);
    view.setUint16(at + 12, ZIP_FIXED_DOS_TIME, true);
    view.setUint16(at + 14, ZIP_FIXED_DOS_DATE, true);
    view.setUint32(at + 16, r.crc, true);
    view.setUint32(at + 20, r.body.length, true);
    view.setUint32(at + 24, r.size, true);
    view.setUint16(at + 28, r.name.length, true);
    // extra length, comment length, disk number, internal and external attributes: all 0
    view.setUint32(at + 42, offsets[i], true);
    out.set(r.name, at + CENTRAL_SIZE);
    at += CENTRAL_SIZE + r.name.length;
  });
  view.setUint32(at, SIG_EOCD, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

/** One entry of a parsed archive. Its data hasn't been read yet (see {@link extractZipEntry}). */
export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  /** As declared by the central directory: a claim, checked while extracting. */
  readonly uncompressedSize: number;
  /** Offset of the entry's data (after its local header). */
  readonly dataStart: number;
}

/** Why an archive or an entry can't be read. Messages never contain archive content. */
export type ZipError =
  | { readonly kind: 'not-a-zip'; readonly message: string }
  | { readonly kind: 'unsupported-zip'; readonly message: string }
  | { readonly kind: 'too-many-entries'; readonly limit: number; readonly message: string }
  | { readonly kind: 'unsafe-path'; readonly entry: string; readonly message: string }
  | { readonly kind: 'duplicate-entry'; readonly entry: string; readonly message: string }
  | { readonly kind: 'entry-too-large'; readonly entry: string; readonly limit: number; readonly message: string }
  | { readonly kind: 'corrupt-entry'; readonly entry: string; readonly message: string };

export type ZipDirectoryResult =
  { readonly ok: true; readonly entries: readonly ZipEntry[] } | { readonly ok: false; readonly error: ZipError };

/**
 * Parses and checks an archive's structure without decompressing anything: the end-of-central-
 * directory record, every central and local header, the names (plain relative ASCII paths, no
 * duplicates) and the byte ranges (inside the file, not overlapping). Never throws.
 */
export function readZipDirectory(bytes: Uint8Array, maxEntries: number): ZipDirectoryResult {
  const fail = (error: ZipError): ZipDirectoryResult => ({ ok: false, error });
  const notZip = (detail: string) => fail({ kind: 'not-a-zip', message: `Not a valid ZIP archive: ${detail}.` });
  const unsupported = (detail: string) =>
    fail({ kind: 'unsupported-zip', message: `The ZIP archive uses a feature saves never use: ${detail}.` });

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  // End of central directory: the last record whose comment runs exactly to the end of the file.
  let eocd = -1;
  for (let at = bytes.length - EOCD_SIZE; at >= 0 && at >= bytes.length - EOCD_SIZE - MAX_COMMENT; at--) {
    if (u32(at) === SIG_EOCD && at + EOCD_SIZE + u16(at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return notZip('no end-of-central-directory record');
  if (eocd >= 20 && u32(eocd - 20) === SIG_ZIP64_LOCATOR) return unsupported('ZIP64');
  const disk = u16(eocd + 4);
  const centralDisk = u16(eocd + 6);
  const countOnDisk = u16(eocd + 8);
  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralStart = u32(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) return unsupported('ZIP64');
  if (disk !== 0 || centralDisk !== 0 || countOnDisk !== count) return unsupported('multiple disks');
  if (count > maxEntries) {
    return fail({
      kind: 'too-many-entries',
      limit: maxEntries,
      message: `The archive has more than ${maxEntries} entries.`,
    });
  }
  if (centralStart + centralSize !== eocd) return notZip('the central directory is not where the archive says');

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  let at = centralStart;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > eocd || u32(at) !== SIG_CENTRAL) return notZip('a central directory header is damaged');
    const versionNeeded = u16(at + 6) & 0xff;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const uncompressedSize = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const startDisk = u16(at + 34);
    const localStart = u32(at + 42);
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > eocd) return notZip('a central directory header is damaged');
    const nameBytes = bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    at = next;

    if (flags & 1 || flags & (1 << 6) || flags & (1 << 13)) return unsupported('encryption');
    if (flags & ~ALLOWED_FLAGS) return unsupported('unknown general-purpose flags');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localStart === 0xffffffff) {
      return unsupported('ZIP64');
    }
    if (versionNeeded > MAX_VERSION_NEEDED) return unsupported(`version needed ${versionNeeded / 10}`);
    if (startDisk !== 0) return unsupported('multiple disks');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) return unsupported(`compression method ${method}`);

    const name = asciiName(nameBytes);
    const problem =
      name !== null
        ? checkEntryName(name)
        : nameBytes.length > MAX_ZIP_NAME_BYTES
          ? 'name too long'
          : 'not a printable ASCII name';
    const label = displayName(nameBytes);
    if (name === null || problem !== null) {
      return fail({ kind: 'unsafe-path', entry: label, message: `Entry "${label}" has an unsafe path (${problem}).` });
    }
    if (names.has(name)) {
      return fail({ kind: 'duplicate-entry', entry: label, message: `Entry "${label}" appears more than once.` });
    }
    names.add(name);
    const isDirectory = name.endsWith('/');
    if (isDirectory && (uncompressedSize !== 0 || compressedSize > 2)) {
      return notZip(`directory entry "${label}" has content`);
    }
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
      return notZip(`stored entry "${label}" has inconsistent sizes`);
    }

    // The local header must agree with the central one, and the data must lie inside the archive.
    if (localStart + LOCAL_SIZE > centralStart || u32(localStart) !== SIG_LOCAL) {
      return notZip(`the local header of "${label}" is damaged`);
    }
    const localNameLength = u16(localStart + 26);
    const localExtraLength = u16(localStart + 28);
    const dataStart = localStart + LOCAL_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralStart) return notZip(`the data of "${label}" runs past the end of the archive`);
    if (
      u16(localStart + 8) !== method ||
      localNameLength !== nameLength ||
      !sameBytes(bytes.subarray(localStart + LOCAL_SIZE, localStart + LOCAL_SIZE + nameLength), nameBytes)
    ) {
      return notZip(`the local header of "${label}" disagrees with the central directory`);
    }
    ranges.push({ start: localStart, end: dataEnd });
    entries.push({ name, isDirectory, method, crc, compressedSize, uncompressedSize, dataStart });
  }
  if (at !== eocd) return notZip('the central directory has trailing bytes');

  // Overlapping entries are how non-recursive zip bombs reuse one compressed stream many times.
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) return notZip('entries overlap');
  }
  return { ok: true, entries };
}

export type ZipExtractResult =
  { readonly ok: true; readonly data: Uint8Array } | { readonly ok: false; readonly error: ZipError };

class InflateLimitExceeded extends Error {}

/**
 * Decompresses one entry, refusing it if its declared size exceeds `limit`. Never trusts the
 * declared size: DEFLATE data is inflated in {@link INFLATE_SLICE}-byte slices and aborted as soon
 * as the output passes the declared size, so a bomb costs at most a few MiB before it is refused.
 * The result must match the declared size and CRC-32 exactly. Never throws.
 */
export function extractZipEntry(bytes: Uint8Array, entry: ZipEntry, limit: number): ZipExtractResult {
  const label = entry.name;
  const corrupt = (detail: string): ZipExtractResult => ({
    ok: false,
    error: { kind: 'corrupt-entry', entry: label, message: `Entry "${label}" is damaged (${detail}).` },
  });
  if (entry.uncompressedSize > limit) {
    return {
      ok: false,
      error: {
        kind: 'entry-too-large',
        entry: label,
        limit,
        message: `Entry "${label}" is larger than ${limit} bytes.`,
      },
    };
  }
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = compressed.slice();
  } else {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const inflater = new Inflate((chunk) => {
      total += chunk.length;
      if (total > entry.uncompressedSize) throw new InflateLimitExceeded();
      chunks.push(chunk);
    });
    try {
      for (let at = 0; at < compressed.length || at === 0; at += INFLATE_SLICE) {
        const end = Math.min(at + INFLATE_SLICE, compressed.length);
        inflater.push(compressed.subarray(at, end), end === compressed.length);
        if (end === compressed.length) break;
      }
    } catch (error) {
      return corrupt(
        error instanceof InflateLimitExceeded ? 'it inflates to more than its declared size' : 'invalid DEFLATE data',
      );
    }
    data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (data.length !== entry.uncompressedSize) return corrupt('its size does not match the archive');
  if (crc32Final(crc32Update(CRC32_INITIAL, data)) !== entry.crc) return corrupt('CRC-32 mismatch');
  return { ok: true, data };
}

/**
 * `null` if `name` is a plain relative path (printable ASCII, `/`-separated, no empty, `.` or `..`
 * segments, no `\` or `:`, at most {@link MAX_ZIP_NAME_BYTES} bytes; a trailing `/` marks a
 * directory), otherwise the reason it isn't.
 */
export function checkEntryName(name: string): string | null {
  if (name.length === 0) return 'empty name';
  if (name.length > MAX_ZIP_NAME_BYTES) return 'name too long';
  if (!/^[\x20-\x7e]+$/.test(name)) return 'not a printable ASCII name';
  if (name.includes('\\')) return 'backslash';
  if (name.includes(':')) return 'drive or stream separator';
  if (name.startsWith('/')) return 'absolute path';
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (segments.some((s) => s === '..')) return 'parent-directory segment';
  if (segments.some((s) => s === '' || s === '.')) return 'empty or "." segment';
  return null;
}

function asciiBytes(name: string): Uint8Array {
  const out = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i);
  return out;
}

function asciiName(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_ZIP_NAME_BYTES) return null;
  let name = '';
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return null;
    name += String.fromCharCode(byte);
  }
  return name;
}

/** An entry name safe to show in a message: printable ASCII only, at most 64 characters. */
function displayName(bytes: Uint8Array): string {
  let name = '';
  for (const byte of bytes.subarray(0, 64)) name += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '?';
  return bytes.length > 64 ? `${name}…` : name;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
