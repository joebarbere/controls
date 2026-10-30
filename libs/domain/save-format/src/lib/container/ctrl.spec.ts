import { APP_VERSION } from '@controls/units';
import fc from 'fast-check';
import { deflateSync, unzipSync, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pngBytesArb,
  rawManifestV2Arb,
  rawReplayLogV2Arb,
  rawWorldV2Arb,
  rawZip,
  type RawZipEntry,
  TINY_PNG,
} from '../../testing/arbitraries';
import {
  createManifest as createManifestWith,
  createReplayLog,
  createWorld,
  Manifest,
  ReplayLog,
  World,
} from '../documents';
import {
  CTRL_ENTRY,
  CTRL_LIMITS,
  type CtrlError,
  type CtrlInput,
  ctrlJson,
  CtrlWriteError,
  looksLikeZip,
  readCtrl,
  writeCtrl,
} from './ctrl';
import { utf8Decode, utf8Encode } from './utf8';
import { checkEntryName, ZIP_FIXED_DOS_DATE } from './zip';

const fixturesRoot = join(import.meta.dirname, '../../../fixtures');
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(fixturesRoot, path), 'utf8'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MiB = 1024 * 1024;
/** A manifest for this build (the catalogue and engine versions don't matter to the container). */
const createManifest = () => createManifestWith({ catalogVersion: 1, simEngineVersion: 1 });

/** The golden sample: fixed documents (not `createManifest`, whose `appVersion` moves with every release). */
function sample(): CtrlInput {
  return {
    manifest: Manifest.parse(fixture('v2/manifest/basic.json')),
    world: World.parse(fixture('v2/world/bench-lamp-mid-interval.json')),
    replayLog: ReplayLog.parse(fixture('v2/replay-log/bench-lamp-mid-interval.json')),
    thumbnail: TINY_PNG,
  };
}

/**
 * SHA-256 of `writeCtrl(sample())`. It moves only if the container's bytes change: the entry layout,
 * the JSON formatting, the ZIP fields or fflate's DEFLATE output (a fflate upgrade can do that;
 * re-pin it and say so in the changelog). Saves written earlier still load either way.
 */
const GOLDEN_SAMPLE_SHA256 = 'a9296dc2574331a9d0210cf82e9dba419048a76ef0725298df792be90e7d4816';

const text = (value: unknown) => ctrlJson(value);
const manifestText = () => text(sample().manifest);
const worldText = () => text(sample().world);

/** A valid container built with the raw writer, with entries replaced (`null` drops one) or added. */
function container(replace: Record<string, Partial<RawZipEntry> | null> = {}, extra: RawZipEntry[] = []) {
  const base: Record<string, RawZipEntry> = {
    [CTRL_ENTRY.manifest]: { name: CTRL_ENTRY.manifest, data: manifestText() },
    [CTRL_ENTRY.world]: { name: CTRL_ENTRY.world, data: worldText() },
  };
  const entries: RawZipEntry[] = [];
  for (const [name, entry] of Object.entries(base)) {
    const override = replace[name];
    if (override === null) continue;
    entries.push({ ...entry, ...override });
  }
  for (const [name, entry] of Object.entries(replace)) {
    if (!(name in base) && entry !== null) entries.push({ name, ...entry });
  }
  return rawZip([...entries, ...extra]);
}

function readError(bytes: Uint8Array, options?: Parameters<typeof readCtrl>[1]): CtrlError {
  const result = readCtrl(bytes, options);
  if (result.ok) throw new Error('expected readCtrl to fail');
  return result.error;
}

describe('writeCtrl', () => {
  it('writes a deterministic container: pinned golden SHA-256', () => {
    const bytes = writeCtrl(sample());
    expect(writeCtrl(sample())).toStrictEqual(bytes);
    expect(sha256(bytes)).toBe(GOLDEN_SAMPLE_SHA256);
  });

  it('sorts entries, fixes every timestamp and stores the PNG', () => {
    const bytes = writeCtrl(sample());
    const names: string[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
      expect(view.getUint16(at + 10, true)).toBe(0); // time
      expect(view.getUint16(at + 12, true)).toBe(ZIP_FIXED_DOS_DATE);
      const nameLength = view.getUint16(at + 26, true);
      const name = String.fromCharCode(...bytes.subarray(at + 30, at + 30 + nameLength));
      names.push(name);
      expect(view.getUint16(at + 8, true), name).toBe(name === CTRL_ENTRY.thumbnail ? 0 : 8);
      at += 30 + nameLength + view.getUint32(at + 18, true);
    }
    expect(names).toStrictEqual(['manifest.json', 'replay.log', 'thumbnail.png', 'world.json']);
  });

  it('writes sorted-key, indented JSON with a final newline that other unzip tools read', () => {
    const files = unzipSync(writeCtrl(sample()));
    expect(Object.keys(files).sort()).toStrictEqual(['manifest.json', 'replay.log', 'thumbnail.png', 'world.json']);
    const manifest = utf8Decode(files['manifest.json']);
    expect(manifest).toBe(
      '{\n  "appVersion": "0.3.0",\n  "catalogVersion": 1,\n  "extensions": {},\n  "format": "controls.ctrl",\n  "schemaVersion": 2,\n  "simEngineVersion": 1\n}\n',
    );
    expect(files['thumbnail.png']).toStrictEqual(TINY_PNG);
  });

  it('gives the same bytes whatever order object keys were built in', () => {
    const world = createWorld({ seed: 7 });
    const a = { ...world, extensions: { 'mod.a': 1, 'mod.b': { y: 2, x: 1 } } };
    const b = { ...world, extensions: { 'mod.b': { x: 1, y: 2 }, 'mod.a': 1 } };
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as World;
    const manifest = createManifest();
    expect(writeCtrl({ manifest, world: reordered })).toStrictEqual(writeCtrl({ manifest, world: a }));
  });

  it('omits replay.log and thumbnail.png when they are null or absent', () => {
    const input = { manifest: createManifest(), world: createWorld({ seed: 1 }) };
    const files = unzipSync(writeCtrl({ ...input, replayLog: null, thumbnail: null }));
    expect(Object.keys(files).sort()).toStrictEqual(['manifest.json', 'world.json']);
    expect(writeCtrl(input)).toStrictEqual(writeCtrl({ ...input, replayLog: null, thumbnail: null }));
  });

  it('records this build’s APP_VERSION through createManifest', () => {
    const read = readCtrl(writeCtrl({ manifest: createManifest(), world: createWorld({ seed: 1 }) }));
    expect(read.ok && read.value.manifest.appVersion).toBe(APP_VERSION);
  });

  it('refuses an invalid document, naming the entry without echoing it', () => {
    const world = { ...createWorld({ seed: 1 }), regionId: 'x'.repeat(10_000) } as unknown as World;
    const error = (() => {
      try {
        writeCtrl({ manifest: createManifest(), world });
      } catch (e) {
        return e;
      }
      throw new Error('expected a throw');
    })() as CtrlWriteError;
    expect(error).toBeInstanceOf(CtrlWriteError);
    expect(error.kind).toBe('invalid-document');
    expect(error.entry).toBe('world.json');
    expect(error.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify({ m: error.message, i: error.issues })).not.toContain('xxxxxxxxxx');
  });

  it('refuses a thumbnail that is not a PNG, and one over the cap', () => {
    const base = { manifest: createManifest(), world: createWorld({ seed: 1 }) };
    expect(() => writeCtrl({ ...base, thumbnail: new Uint8Array([1, 2, 3]) })).toThrow(
      expect.objectContaining({ kind: 'invalid-thumbnail' }),
    );
    const big = new Uint8Array(CTRL_LIMITS.maxThumbnailBytes + 1);
    big.set(TINY_PNG);
    expect(() => writeCtrl({ ...base, thumbnail: big })).toThrow(
      expect.objectContaining({ kind: 'too-large', entry: 'thumbnail.png' }),
    );
  });

  it('refuses a document over its cap', () => {
    const world = { ...createWorld({ seed: 1 }), extensions: { big: 'y'.repeat(CTRL_LIMITS.maxWorldBytes) } };
    expect(() => writeCtrl({ manifest: createManifest(), world })).toThrow(
      expect.objectContaining({ kind: 'too-large', entry: 'world.json' }),
    );
  });

  it('refuses a document from a future version', () => {
    const manifest = { ...createManifest(), schemaVersion: 3 } as unknown as Manifest;
    expect(() => writeCtrl({ manifest, world: createWorld({ seed: 1 }) })).toThrow(
      expect.objectContaining({ kind: 'invalid-document', entry: 'manifest.json' }),
    );
  });
});

describe('readCtrl', () => {
  it('reads what writeCtrl wrote', () => {
    const input = sample();
    expect(readCtrl(writeCtrl(input))).toStrictEqual({
      ok: true,
      value: { ...input, fromVersion: 2 },
    });
  });

  it('round-trips arbitrary valid documents losslessly, and re-writing gives identical bytes', () => {
    fc.assert(
      fc.property(
        rawManifestV2Arb,
        rawWorldV2Arb,
        fc.option(rawReplayLogV2Arb),
        fc.option(pngBytesArb),
        (manifest, world, log, thumbnail) => {
          if (log !== null) {
            // world.json is at the log's endTick (ADR 0013): move both to the later of the two.
            const tick = Math.max(world.tick, log.endTick);
            world = { ...world, tick };
            log = { ...log, endTick: tick };
          }
          const input = {
            manifest: Manifest.parse(manifest),
            world: World.parse(world),
            replayLog: log === null ? null : ReplayLog.parse(log),
            thumbnail,
          };
          // Raw documents (with -0) are accepted and normalised.
          const bytes = writeCtrl({ manifest, world, replayLog: log, thumbnail } as unknown as CtrlInput);
          const read = readCtrl(bytes);
          expect(read).toStrictEqual({ ok: true, value: { ...input, fromVersion: 2 } });
          if (!read.ok) return;
          expect(writeCtrl(read.value)).toStrictEqual(bytes);
          expect(JSON.parse(JSON.stringify(read.value.world))).toStrictEqual(read.value.world);
        },
      ),
      { numRuns: 100 },
    );
    // Generous: each run validates three documents twice and builds two archives, and `pnpm verify`
    // runs every project's tests in parallel.
  }, 60_000);

  it('reads containers from other ZIP writers (fflate zipSync, extra directory entries)', () => {
    const files = unzipSync(writeCtrl(sample()));
    const other = zipSync({ ...files, 'prints/': new Uint8Array(0), 'plc/': new Uint8Array(0) }, { level: 9 });
    expect(readCtrl(other)).toStrictEqual({ ok: true, value: { ...sample(), fromVersion: 2 } });
  });

  it('tolerates the empty reserved directories prints/, plc/ and hmi/', () => {
    const bytes = container({}, [{ name: 'prints/' }, { name: 'plc/' }, { name: 'hmi/' }]);
    expect(readCtrl(bytes).ok).toBe(true);
  });

  it('accepts an archive comment', () => {
    const entries = [
      { name: 'manifest.json', data: manifestText() },
      { name: 'world.json', data: worldText() },
    ];
    expect(readCtrl(rawZip(entries, { comment: utf8Encode('hello') })).ok).toBe(true);
  });

  it('the raw builder’s baseline container is valid (so each refusal below has one cause)', () => {
    const read = readCtrl(container());
    expect(read.ok && read.value.replayLog).toBeNull();
    expect(read.ok && read.value.thumbnail).toBeNull();
  });

  describe('refuses damaged archives (not-a-zip)', () => {
    const valid = () => writeCtrl(sample());
    it.each([
      ['empty input', () => new Uint8Array(0)],
      ['random bytes', () => new Uint8Array(100).fill(7)],
      ['a truncated archive', () => valid().subarray(0, 200)],
      ['an archive with its end cut off', () => valid().subarray(0, valid().length - 1)],
      ['JSON instead of a ZIP', () => utf8Encode(worldText())],
      [
        'a misplaced central directory',
        () => rawZip([{ name: 'manifest.json', data: manifestText() }], { centralStart: 3 }),
      ],
      ['a local header offset outside the archive', () => container({ 'world.json': { localOffset: 99_999 } })],
      ['a local header that names another entry', () => container({ 'world.json': { localName: 'other.json' } })],
      [
        'a stored entry with two different sizes',
        () => container({ 'world.json': { method: 0, uncompressedSize: 5 } }),
      ],
      ['a directory entry with content', () => container({}, [{ name: 'prints/', data: 'x', method: 0 }])],
      [
        'overlapping entries (the non-recursive zip bomb shape)',
        () => {
          const world = utf8Encode(worldText());
          return container(
            { 'manifest.json': { compressedSize: deflateSync(utf8Encode(manifestText())).length + 40 } },
            [{ name: 'replay.log', data: world }],
          );
        },
      ],
    ])('%s', (_name, bytes) => {
      expect(readError(bytes()).kind).toBe('not-a-zip');
    });
  });

  describe('refuses ZIP features saves never use (unsupported-zip)', () => {
    it.each([
      ['encryption', () => container({ 'world.json': { flags: 1 } })],
      ['strong encryption', () => container({ 'world.json': { flags: 1 << 6 } })],
      ['unknown flags', () => container({ 'world.json': { flags: 1 << 4 } })],
      ['LZMA', () => container({ 'world.json': { method: 14 } })],
      ['a version needed above 2.0', () => container({ 'world.json': { versionNeeded: 45 } })],
      ['a ZIP64 locator', () => rawZip([{ name: 'manifest.json', data: manifestText() }], { zip64Locator: true })],
      ['a ZIP64 entry count', () => rawZip([{ name: 'manifest.json', data: manifestText() }], { eocdCount: 0xffff })],
      ['ZIP64 entry sizes', () => container({ 'world.json': { uncompressedSize: 0xffffffff } })],
      ['multiple disks', () => rawZip([{ name: 'manifest.json', data: manifestText() }], { eocdDisk: 1 })],
      ['an entry on another disk', () => container({ 'world.json': { startDisk: 1 } })],
    ])('%s', (_name, bytes) => {
      expect(readError(bytes()).kind).toBe('unsupported-zip');
    });
  });

  describe('refuses unsafe entry names without echoing them in full', () => {
    it.each([
      ['../world.json'],
      ['/world.json'],
      ['C:/world.json'],
      ['prints\\a.json'],
      ['prints/../world.json'],
      ['./world.json'],
      ['prints//a.json'],
      ['wörld.json'],
      ['a'.repeat(129)],
    ])('%j', (name) => {
      const error = readError(container({}, [{ name, data: '{}' }]));
      expect(error.kind).toBe('unsafe-path');
      expect(error.message.length).toBeLessThan(160);
    });

    it('names containing NUL or control bytes', () => {
      const name = new Uint8Array([0x77, 0x00, 0x2e, 0x6a, 0x0a]);
      const error = readError(container({}, [{ name, data: '{}' }]));
      expect(error).toMatchObject({ kind: 'unsafe-path', entry: 'w?.j?' });
    });
  });

  it.each([['notes.txt'], ['prints/sheet-1.json'], ['__MACOSX/'], ['World.json'], ['thumbnail.jpg'], ['replay.log/']])(
    'refuses the unexpected entry %j',
    (name) => {
      expect(readError(container({}, [{ name, data: name.endsWith('/') ? undefined : '{}' }]))).toMatchObject({
        kind: 'unexpected-entry',
        entry: name,
      });
    },
  );

  it('refuses a duplicate entry', () => {
    expect(readError(container({}, [{ name: 'world.json', data: worldText() }]))).toMatchObject({
      kind: 'duplicate-entry',
      entry: 'world.json',
    });
  });

  it.each([['manifest.json'], ['world.json']])('refuses a save without %s', (name) => {
    expect(readError(container({ [name]: null }))).toMatchObject({ kind: 'missing-entry', entry: name });
  });

  describe('caps sizes', () => {
    it('refuses a container over the size cap before parsing it', () => {
      expect(readError(writeCtrl(sample()), { limits: { maxContainerBytes: 100 } })).toMatchObject({
        kind: 'too-large',
        limit: 100,
      });
    });

    it('refuses too many entries', () => {
      const bytes = container({}, [{ name: 'prints/' }, { name: 'plc/' }]);
      expect(readError(bytes, { limits: { maxEntries: 3 } })).toMatchObject({ kind: 'too-many-entries', limit: 3 });
    });

    it('refuses an entry whose declared size is over its cap, without inflating it', () => {
      expect(readError(container(), { limits: { maxWorldBytes: 100 } })).toMatchObject({
        kind: 'entry-too-large',
        entry: 'world.json',
        limit: 100,
      });
      const lying = container({ 'world.json': { uncompressedSize: CTRL_LIMITS.maxWorldBytes + 1 } });
      expect(readError(lying)).toMatchObject({ kind: 'entry-too-large', limit: CTRL_LIMITS.maxWorldBytes });
    });

    it('caps can only be lowered', () => {
      const lying = container({ 'world.json': { uncompressedSize: CTRL_LIMITS.maxWorldBytes + 1 } });
      expect(readError(lying, { limits: { maxWorldBytes: 10 * CTRL_LIMITS.maxWorldBytes } })).toMatchObject({
        kind: 'entry-too-large',
        limit: CTRL_LIMITS.maxWorldBytes,
      });
    });

    it('refuses a total over the cap even when every entry is under its own', () => {
      expect(readError(writeCtrl(sample()), { limits: { maxTotalBytes: 2000 } })).toMatchObject({
        kind: 'total-too-large',
        limit: 2000,
      });
    });

    it('refuses a zip bomb while inflating it: the output is checked as it grows, not just the header', () => {
      const bomb = new Uint8Array(20 * MiB).fill(0x20); // ~20 KiB compressed
      const bytes = container({ 'world.json': { data: bomb, uncompressedSize: 1000 } });
      expect(bytes.length).toBeLessThan(100_000);
      const error = readError(bytes);
      expect(error).toMatchObject({ kind: 'corrupt-entry', entry: 'world.json' });
      expect(error.message).toContain('more than its declared size');
    });
  });

  describe('refuses damaged entries (corrupt-entry)', () => {
    it.each([
      ['a CRC-32 mismatch', { crc: 12345 }],
      ['a declared size larger than the data', { uncompressedSize: utf8Encode(worldText()).length + 10 }],
      ['invalid DEFLATE data', { rawBody: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }],
      ['an empty DEFLATE stream', { rawBody: new Uint8Array(0) }],
      ['a truncated DEFLATE stream', { rawBody: deflateSync(utf8Encode(worldText())).subarray(0, 20) }],
    ])('%s', (_name, override) => {
      expect(readError(container({ 'world.json': override }))).toMatchObject({
        kind: 'corrupt-entry',
        entry: 'world.json',
      });
    });
  });

  it('refuses a document that is not UTF-8, or not JSON', () => {
    expect(readError(container({ 'world.json': { data: new Uint8Array([0x7b, 0xff, 0x7d]) } }))).toMatchObject({
      kind: 'not-utf8',
      entry: 'world.json',
    });
    expect(readError(container({ 'manifest.json': { data: 'not json' } }))).toMatchObject({
      kind: 'not-json',
      entry: 'manifest.json',
    });
  });

  describe('a save from a newer build', () => {
    const newer = (appVersion: unknown) =>
      container(
        { 'manifest.json': { data: text({ ...sample().manifest, schemaVersion: 3, appVersion }) } },
        // A later version may define entries this build doesn't know: the version is checked first.
        [{ name: 'prints/sheet-1.json', data: '{}' }],
      );

    it('is refused with a typed error naming the writer', () => {
      const error = readError(newer('0.9.0'));
      expect(error).toMatchObject({ kind: 'newer-than-build', found: 3, supported: 2, appVersion: '0.9.0' });
      expect(error.message).toBe(
        `This save was written by Controls 0.9.0 (save format 3). This build (${APP_VERSION}) reads save formats up to 2. Update the game to open it.`,
      );
    });

    it('does not echo a malformed appVersion', () => {
      const error = readError(newer('z'.repeat(5000)));
      expect(error).toMatchObject({ kind: 'newer-than-build', appVersion: null });
      expect(error.message).toContain('a newer version of Controls');
      expect(error.message).not.toContain('zzz');
    });
  });

  it('refuses a replay.log whose endTick is not world.json’s tick, and writeCtrl won’t write one (ADR 0013)', () => {
    const log = text({ ...sample().replayLog, endTick: (sample().replayLog?.endTick ?? 0) + 1 });
    expect(readError(container({ 'replay.log': { data: log } }))).toMatchObject({
      kind: 'end-tick-mismatch',
      worldTick: 2147483655,
      endTick: 2147483656,
    });
    const world = { ...createWorld({ seed: 1 }), tick: 5 };
    const replayLog = { ...createReplayLog(createWorld({ seed: 1 })), endTick: 4 };
    expect(() => writeCtrl({ manifest: createManifest(), world, replayLog })).toThrow(
      expect.objectContaining({ kind: 'invalid-document', entry: 'replay.log' }),
    );
  });

  it('refuses documents whose schemaVersion disagrees with the manifest', () => {
    const world = text({ ...sample().world, schemaVersion: 1 });
    expect(readError(container({ 'world.json': { data: world } }))).toMatchObject({
      kind: 'version-mismatch',
      entry: 'world.json',
      expected: 2,
      found: 1,
    });
  });

  describe('validates every document (invalid-document)', () => {
    it('the manifest', () => {
      const error = readError(container({ 'manifest.json': { data: text({ ...sample().manifest, format: 'zip' }) } }));
      expect(error).toMatchObject({ kind: 'invalid-document', entry: 'manifest.json', error: { kind: 'invalid' } });
    });

    it('the world, without echoing a large payload', () => {
      const payload = 'q'.repeat(100_000);
      const world = text({ ...sample().world, difficulty: payload });
      const error = readError(container({ 'world.json': { data: world } }));
      expect(error).toMatchObject({ kind: 'invalid-document', entry: 'world.json' });
      const serialised = JSON.stringify(error);
      expect(serialised).not.toContain('qqqqqqqqqq');
      expect(serialised.length).toBeLessThan(2000);
    });

    it('the world, refusing hostile nesting and __proto__ keys before Zod sees them', () => {
      let deep = '0';
      for (let i = 0; i < 100_000; i++) deep = `[${deep}]`;
      const nested = worldText().replace('"extensions": {}', `"extensions": {"a": ${deep}}`);
      expect(readError(container({ 'world.json': { data: nested } }))).toMatchObject({
        kind: 'invalid-document',
        error: { kind: 'too-deep' },
      });
      const proto = worldText().replace('"extensions": {}', '"extensions": {"__proto__": {"x": 1}}');
      expect(readError(container({ 'world.json': { data: proto } }))).toMatchObject({
        kind: 'invalid-document',
        error: { kind: 'invalid' },
      });
    });

    it('a world that is not an object or has no version', () => {
      expect(readError(container({ 'world.json': { data: '[]' } }))).toMatchObject({
        kind: 'invalid-document',
        error: { kind: 'not-an-object' },
      });
      expect(readError(container({ 'world.json': { data: '{}' } }))).toMatchObject({
        kind: 'invalid-document',
        error: { kind: 'missing-version' },
      });
    });

    it('the replay log', () => {
      const log = text({ ...sample().replayLog, entries: [{ seq: 5, tick: 0, id: 'entity.place', args: {} }] });
      expect(readError(container({ 'replay.log': { data: log } }))).toMatchObject({
        kind: 'invalid-document',
        entry: 'replay.log',
      });
    });
  });

  it('refuses a thumbnail that is not a PNG', () => {
    expect(readError(container({ 'thumbnail.png': { data: 'GIF89a', method: 0 } }))).toMatchObject({
      kind: 'invalid-thumbnail',
    });
  });
});

describe('helpers', () => {
  it('looksLikeZip', () => {
    expect(looksLikeZip(writeCtrl(sample()))).toBe(true);
    expect(looksLikeZip(rawZip([]))).toBe(true);
    expect(looksLikeZip(utf8Encode('{}'))).toBe(false);
    expect(looksLikeZip(new Uint8Array(0))).toBe(false);
  });

  it.each([
    ['world.json', null],
    ['prints/', null],
    ['prints/a.json', null],
    ['', 'empty name'],
    ['a'.repeat(129), 'name too long'],
    ['a\tb', 'not a printable ASCII name'],
    ['a\\b', 'backslash'],
    ['c:x', 'drive or stream separator'],
    ['/x', 'absolute path'],
    ['a/../b', 'parent-directory segment'],
    ['a/./b', 'empty or "." segment'],
  ])('checkEntryName(%j) → %j', (name, problem) => {
    expect(checkEntryName(name)).toBe(problem);
  });

  it('ctrlJson sorts keys at every depth and keeps "__proto__" as a plain key', () => {
    const value = JSON.parse('{"b":{"z":1,"a":[{"y":1,"x":2}]},"__proto__":{"k":1},"a":0}') as unknown;
    expect(ctrlJson(value)).toBe(
      '{\n  "__proto__": {\n    "k": 1\n  },\n  "a": 0,\n  "b": {\n    "a": [\n      {\n        "x": 2,\n        "y": 1\n      }\n    ],\n    "z": 1\n  }\n}\n',
    );
  });
});
