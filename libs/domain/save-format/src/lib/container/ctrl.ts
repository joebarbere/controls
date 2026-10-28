import { APP_VERSION } from '@controls/units';
import {
  CURRENT_SCHEMA_VERSION,
  type Manifest,
  migrateManifest,
  migrateReplayLog,
  migrateWorld,
  type ReplayLog,
  type World,
} from '../documents';
import type { LoadError, LoadResult, ValidationIssue } from '../migrate';
import { SemVer } from '../primitives';
import { utf8Decode, utf8Encode } from './utf8';
import { extractZipEntry, readZipDirectory, writeZip, type ZipEntry, type ZipError, type ZipWriteEntry } from './zip';

/*
 * The `.ctrl` save container (ADR 0004, F1.8b): a ZIP holding `manifest.json`, `world.json`, an
 * optional `replay.log` and an optional `thumbnail.png`. Bytes in, bytes out: no file system, no
 * clock, no framework. The Electron main process (or the web harness) stores the bytes.
 */

/** Entry names of a schemaVersion 1 container. */
export const CTRL_ENTRY = {
  manifest: 'manifest.json',
  world: 'world.json',
  replayLog: 'replay.log',
  thumbnail: 'thumbnail.png',
} as const;

/**
 * Directories reserved for later documents (prints P6, PLC programs P10, HMI screens P12). A v1
 * container may hold them as empty directory entries; any file inside them is refused until the
 * schemaVersion that defines it.
 */
export const CTRL_RESERVED_DIRECTORIES: readonly string[] = ['hmi/', 'plc/', 'prints/'];

/** The 8-byte PNG signature; `thumbnail.png` must start with it (it isn't decoded here). */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Size caps, in bytes. Applied when reading and when writing, so the game never writes a save it would refuse. */
export interface CtrlLimits {
  /** The whole `.ctrl` file. */
  readonly maxContainerBytes: number;
  /** ZIP entries (files and directories) in the central directory. */
  readonly maxEntries: number;
  /** Sum of every entry's uncompressed size. */
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
  readonly maxWorldBytes: number;
  readonly maxReplayLogBytes: number;
  readonly maxThumbnailBytes: number;
}

const MiB = 1024 * 1024;

/**
 * The caps (see docs/caveats/save-format.md for the reasoning). They are not part of the schema:
 * raising one later needs no `schemaVersion` bump, but an older build will refuse a save over its
 * own caps, so raise them before saves can grow past them.
 */
export const CTRL_LIMITS: CtrlLimits = Object.freeze({
  maxContainerBytes: 48 * MiB,
  maxEntries: 64,
  maxTotalBytes: 48 * MiB,
  maxManifestBytes: 64 * 1024,
  maxWorldBytes: 16 * MiB,
  maxReplayLogBytes: 32 * MiB,
  maxThumbnailBytes: 4 * MiB,
});

/** What a container holds, every document at the current schema version. */
export interface CtrlContents {
  readonly manifest: Manifest;
  readonly world: World;
  /** `null` when the save has no `replay.log`. */
  readonly replayLog: ReplayLog | null;
  /** PNG bytes (signature checked, not decoded), or `null`. */
  readonly thumbnail: Uint8Array | null;
  /** The `schemaVersion` the save was written at (before migration). */
  readonly fromVersion: number;
}

/** What {@link writeCtrl} takes. Documents must be at the current `schemaVersion`. */
export interface CtrlInput {
  readonly manifest: Manifest;
  readonly world: World;
  readonly replayLog?: ReplayLog | null;
  readonly thumbnail?: Uint8Array | null;
}

/**
 * Why a container can't be read. Discriminated on `kind`; `message` is a short, user-presentable
 * sentence. Nothing here echoes the file's content: entry names are shown only as printable ASCII,
 * cut to 64 characters, and document problems carry the value-free issues of a {@link LoadError}.
 */
export type CtrlError =
  | ZipError
  | { readonly kind: 'too-large'; readonly limit: number; readonly message: string }
  | { readonly kind: 'total-too-large'; readonly limit: number; readonly message: string }
  | { readonly kind: 'unexpected-entry'; readonly entry: string; readonly message: string }
  | { readonly kind: 'missing-entry'; readonly entry: string; readonly message: string }
  | { readonly kind: 'not-utf8'; readonly entry: string; readonly message: string }
  | { readonly kind: 'not-json'; readonly entry: string; readonly message: string }
  | {
      readonly kind: 'newer-than-build';
      readonly found: number;
      readonly supported: number;
      /** The writer's `appVersion`, if the manifest holds a well-formed one. */
      readonly appVersion: string | null;
      readonly message: string;
    }
  | {
      readonly kind: 'version-mismatch';
      readonly entry: string;
      readonly expected: number;
      readonly found: number;
      readonly message: string;
    }
  | { readonly kind: 'invalid-document'; readonly entry: string; readonly error: LoadError; readonly message: string }
  | { readonly kind: 'invalid-thumbnail'; readonly message: string };

export type CtrlErrorKind = CtrlError['kind'];

export type CtrlReadResult =
  { readonly ok: true; readonly value: CtrlContents } | { readonly ok: false; readonly error: CtrlError };

export interface ReadCtrlOptions {
  /** Tighter caps (for example an IPC payload limit). Each is clamped to {@link CTRL_LIMITS}: they can only go down. */
  readonly limits?: Partial<CtrlLimits>;
}

/**
 * Reads a `.ctrl` from untrusted bytes. Never throws, never trusts the archive:
 *
 * 1. the file size, the ZIP structure, every entry name (no traversal) and every declared size are
 *    checked against {@link CTRL_LIMITS} before anything is decompressed;
 * 2. `manifest.json` is read first, so a save from a newer build gets a typed `newer-than-build`
 *    refusal even if it holds entries this build doesn't know;
 * 3. the entry list is checked against the layout of the save's version (unknown entries refused);
 * 4. each document is decoded (strict UTF-8), parsed, migrated and validated, and must carry the
 *    manifest's `schemaVersion`. Entries are inflated with their size checked as they grow, and must
 *    match their declared size and CRC-32.
 */
export function readCtrl(bytes: Uint8Array, options: ReadCtrlOptions = {}): CtrlReadResult {
  const limits = clampLimits(options.limits);
  const fail = (error: CtrlError): CtrlReadResult => ({ ok: false, error });

  if (bytes.length > limits.maxContainerBytes) {
    return fail({
      kind: 'too-large',
      limit: limits.maxContainerBytes,
      message: `The save is larger than ${limits.maxContainerBytes} bytes.`,
    });
  }
  const directory = readZipDirectory(bytes, limits.maxEntries);
  if (!directory.ok) return fail(directory.error);
  const entries = new Map(directory.entries.map((entry) => [entry.name, entry]));
  const declaredTotal = directory.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (declaredTotal > limits.maxTotalBytes) {
    // Extraction refuses any entry whose real size differs from its declared size, so this bounds the real total too.
    return fail({
      kind: 'total-too-large',
      limit: limits.maxTotalBytes,
      message: `The save's contents are larger than ${limits.maxTotalBytes} bytes in total.`,
    });
  }

  const manifestJson = readJsonEntry(bytes, entries, CTRL_ENTRY.manifest, limits.maxManifestBytes);
  if (!manifestJson.ok) return fail(manifestJson.error);
  const manifest = migrateManifest(manifestJson.json);
  if (!manifest.ok) {
    if (manifest.error.kind === 'newer-than-build') return fail(newerThanBuild(manifest.error, manifestJson.json));
    return fail(invalidDocument(CTRL_ENTRY.manifest, manifest.error));
  }
  const version = manifest.fromVersion;

  for (const entry of directory.entries) {
    if (!isV1Entry(entry)) {
      return fail({
        kind: 'unexpected-entry',
        entry: entry.name,
        message: `The save holds an entry this save format doesn't define: "${clipName(entry.name)}".`,
      });
    }
  }

  const world = readDocument(bytes, entries, CTRL_ENTRY.world, limits.maxWorldBytes, version, migrateWorld);
  if (!world.ok) return fail(world.error);
  let replayLog: ReplayLog | null = null;
  if (entries.has(CTRL_ENTRY.replayLog)) {
    const log = readDocument(bytes, entries, CTRL_ENTRY.replayLog, limits.maxReplayLogBytes, version, migrateReplayLog);
    if (!log.ok) return fail(log.error);
    replayLog = log.value;
  }
  let thumbnail: Uint8Array | null = null;
  const thumbnailEntry = entries.get(CTRL_ENTRY.thumbnail);
  if (thumbnailEntry) {
    const data = extractZipEntry(bytes, thumbnailEntry, limits.maxThumbnailBytes);
    if (!data.ok) return fail(data.error);
    if (!isPng(data.data)) return fail(invalidThumbnail());
    thumbnail = data.data;
  }

  return {
    ok: true,
    value: { manifest: manifest.value, world: world.value, replayLog, thumbnail, fromVersion: version },
  };
}

/** Thrown by {@link writeCtrl}. The game must never write a save it would refuse to read. */
export class CtrlWriteError extends Error {
  constructor(
    readonly kind: 'invalid-document' | 'too-large' | 'invalid-thumbnail',
    /** The entry at fault, or `null` for the whole container. */
    readonly entry: string | null,
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'CtrlWriteError';
  }
}

/**
 * Writes a `.ctrl`. Deterministic: the same documents give the same bytes on every machine and in
 * every time zone. JSON entries are written with object keys sorted, two-space indents and a final
 * newline; ZIP entries are sorted by name with fixed timestamps and fixed DEFLATE settings
 * (`zip.ts`); the PNG is stored, not recompressed. Every document is validated at the current
 * `schemaVersion` first and every cap in {@link CTRL_LIMITS} is applied.
 *
 * Throws {@link CtrlWriteError} for an invalid document, a document from an older schema version,
 * a thumbnail that isn't a PNG, or a save over a cap.
 */
export function writeCtrl(input: CtrlInput): Uint8Array {
  const limits = CTRL_LIMITS;
  const manifest = checkCurrent(CTRL_ENTRY.manifest, migrateManifest(input.manifest));
  const world = checkCurrent(CTRL_ENTRY.world, migrateWorld(input.world));
  const replayLog =
    input.replayLog == null ? null : checkCurrent(CTRL_ENTRY.replayLog, migrateReplayLog(input.replayLog));
  const thumbnail = input.thumbnail ?? null;

  const entries: ZipWriteEntry[] = [
    jsonEntry(CTRL_ENTRY.manifest, manifest, limits.maxManifestBytes),
    jsonEntry(CTRL_ENTRY.world, world, limits.maxWorldBytes),
  ];
  if (replayLog !== null) entries.push(jsonEntry(CTRL_ENTRY.replayLog, replayLog, limits.maxReplayLogBytes));
  if (thumbnail !== null) {
    if (!isPng(thumbnail))
      throw new CtrlWriteError('invalid-thumbnail', CTRL_ENTRY.thumbnail, invalidThumbnail().message);
    if (thumbnail.length > limits.maxThumbnailBytes) throw tooLarge(CTRL_ENTRY.thumbnail, limits.maxThumbnailBytes);
    entries.push({ name: CTRL_ENTRY.thumbnail, data: thumbnail, deflate: false });
  }
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > limits.maxTotalBytes) throw tooLarge(null, limits.maxTotalBytes);
  const bytes = writeZip(entries);
  if (bytes.length > limits.maxContainerBytes) throw tooLarge(null, limits.maxContainerBytes);
  return bytes;
}

/**
 * The text of a JSON entry: keys sorted (a pure function of the document, whatever order its
 * objects were built in), two-space indents, a final newline. Readable and diffable once unzipped.
 */
export function ctrlJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** True if `bytes` starts like a ZIP archive (a local header, or the end record of an empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

// ---------------------------------------------------------------------------------------------

function clampLimits(overrides: Partial<CtrlLimits> = {}): CtrlLimits {
  const out: Record<string, number> = { ...CTRL_LIMITS };
  for (const key of Object.keys(CTRL_LIMITS) as (keyof CtrlLimits)[]) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.min(out[key], value);
  }
  return out as unknown as CtrlLimits;
}

function isV1Entry(entry: ZipEntry): boolean {
  if (entry.isDirectory) return CTRL_RESERVED_DIRECTORIES.includes(entry.name);
  return (Object.values(CTRL_ENTRY) as string[]).includes(entry.name);
}

type JsonEntryResult = { ok: true; json: unknown } | { ok: false; error: CtrlError };

function readJsonEntry(
  bytes: Uint8Array,
  entries: ReadonlyMap<string, ZipEntry>,
  name: string,
  limit: number,
): JsonEntryResult {
  const entry = entries.get(name);
  if (!entry) {
    return { ok: false, error: { kind: 'missing-entry', entry: name, message: `The save has no ${name}.` } };
  }
  const data = extractZipEntry(bytes, entry, limit);
  if (!data.ok) return data;
  const text = utf8Decode(data.data);
  if (text === null) {
    return { ok: false, error: { kind: 'not-utf8', entry: name, message: `${name} is not valid UTF-8.` } };
  }
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { kind: 'not-json', entry: name, message: `${name} is not valid JSON.` } };
  }
}

function readDocument<T>(
  bytes: Uint8Array,
  entries: ReadonlyMap<string, ZipEntry>,
  name: string,
  limit: number,
  expectedVersion: number,
  migrate: (input: unknown) => LoadResult<T>,
): { ok: true; value: T } | { ok: false; error: CtrlError } {
  const json = readJsonEntry(bytes, entries, name, limit);
  if (!json.ok) return json;
  // One schemaVersion per save (ADR 0007): every document must carry the manifest's.
  const raw = json.json;
  const found =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['schemaVersion']
      : undefined;
  if (typeof found === 'number' && Number.isSafeInteger(found) && found !== expectedVersion) {
    return {
      ok: false,
      error: {
        kind: 'version-mismatch',
        entry: name,
        expected: expectedVersion,
        found,
        message: `${name} has schemaVersion ${found}, but the manifest says ${expectedVersion}.`,
      },
    };
  }
  // A missing or non-integer version (or a non-object) is reported by the migrator.
  const loaded = migrate(raw);
  if (!loaded.ok) return { ok: false, error: invalidDocument(name, loaded.error) };
  return { ok: true, value: loaded.value };
}

function newerThanBuild(error: Extract<LoadError, { kind: 'newer-than-build' }>, rawManifest: unknown): CtrlError {
  const raw = (rawManifest as Record<string, unknown>)['appVersion'];
  const appVersion = SemVer.safeParse(raw).success ? (raw as string) : null;
  const writer = appVersion === null ? 'a newer version of Controls' : `Controls ${appVersion}`;
  return {
    kind: 'newer-than-build',
    found: error.found,
    supported: error.supported,
    appVersion,
    message: `This save was written by ${writer} (save format ${error.found}). This build (${APP_VERSION}) reads save formats up to ${error.supported}. Update the game to open it.`,
  };
}

function invalidDocument(entry: string, error: LoadError): CtrlError {
  return { kind: 'invalid-document', entry, error, message: `${entry}: ${error.message}` };
}

function invalidThumbnail(): Extract<CtrlError, { kind: 'invalid-thumbnail' }> {
  return { kind: 'invalid-thumbnail', message: `${CTRL_ENTRY.thumbnail} is not a PNG image.` };
}

function checkCurrent<T>(entry: string, result: LoadResult<T>): T {
  if (!result.ok) {
    const issues = result.error.kind === 'invalid' ? result.error.issues : [];
    throw new CtrlWriteError('invalid-document', entry, `${entry}: ${result.error.message}`, issues);
  }
  if (result.fromVersion !== CURRENT_SCHEMA_VERSION) {
    throw new CtrlWriteError(
      'invalid-document',
      entry,
      `${entry}: only schemaVersion ${CURRENT_SCHEMA_VERSION} documents are written (found ${result.fromVersion}); migrate it first.`,
    );
  }
  return result.value;
}

function jsonEntry(name: string, value: unknown, limit: number): ZipWriteEntry {
  const data = utf8Encode(ctrlJson(value));
  if (data.length > limit) throw tooLarge(name, limit);
  return { name, data, deflate: true };
}

function tooLarge(entry: string | null, limit: number): CtrlWriteError {
  return new CtrlWriteError('too-large', entry, `${entry ?? 'The save'} would be larger than ${limit} bytes.`);
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

function clipName(name: string): string {
  return name.length <= 64 ? name : `${name.slice(0, 64)}…`;
}

/** A copy with object keys sorted. `Object.fromEntries` defines keys, so `"__proto__"` stays an ordinary key. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
