import fc from 'fast-check';
import { pngBytesArb, rawZip, TINY_PNG } from '../../testing/arbitraries';
import { createManifest, createReplayLog, createWorld } from '../documents';
import { CTRL_ENTRY, CTRL_LIMITS, readCtrl, writeCtrl } from './ctrl';
import { bytesSource, readCtrlThumbnail, type RandomAccessBytes } from './thumbnail';

/*
 * `readCtrlThumbnail` (ADR 0009 amendment, P4 Saves): only `thumbnail.png`, through a random-access
 * source, and `null` (never an error) for anything that isn't a clean `.ctrl` thumbnail.
 */

const manifest = () => createManifest({ catalogVersion: 1, simEngineVersion: 1 });
const world = createWorld({ seed: 7 });
const save = (thumbnail: Uint8Array | null, withLog = false) =>
  writeCtrl({ manifest: manifest(), world, replayLog: withLog ? createReplayLog(world) : null, thumbnail });

/** A source that records every range read. */
function recording(bytes: Uint8Array): RandomAccessBytes & { reads: [number, number][] } {
  const reads: [number, number][] = [];
  const inner = bytesSource(bytes);
  return {
    size: inner.size,
    reads,
    read: (offset, length) => (reads.push([offset, length]), inner.read(offset, length)),
  };
}

describe('readCtrlThumbnail', () => {
  it('reads the thumbnail a save holds, the same bytes readCtrl gives', async () => {
    const bytes = save(TINY_PNG, true);
    const read = readCtrl(bytes);
    expect(read.ok && read.value.thumbnail).toStrictEqual(TINY_PNG);
    await expect(readCtrlThumbnail(bytesSource(bytes))).resolves.toStrictEqual(TINY_PNG);
  });

  it('is null for a save without one', async () => {
    await expect(readCtrlThumbnail(bytesSource(save(null, true)))).resolves.toBeNull();
  });

  it('reads only the tail, the central directory and the thumbnail entry', async () => {
    // A save with a large replay log in front of the thumbnail: none of it is read.
    const entries = Array.from({ length: 2_000 }, (_, i) => ({ seq: i, tick: 0, id: 'view.focus', args: {} }));
    const big = writeCtrl({
      manifest: manifest(),
      world,
      replayLog: createReplayLog(world, entries),
      thumbnail: TINY_PNG,
    });
    const source = recording(big);
    await expect(readCtrlThumbnail(source)).resolves.toStrictEqual(TINY_PNG);
    expect(source.reads).toHaveLength(4); // tail, central directory, local header, data
    const total = source.reads.reduce((sum, [, length]) => sum + length, 0);
    expect(total).toBeLessThan(TINY_PNG.length + 66_000);
  });

  it('round-trips any PNG-signed thumbnail (property)', async () => {
    await fc.assert(
      fc.asyncProperty(pngBytesArb, async (png) => {
        expect(await readCtrlThumbnail(bytesSource(save(png)))).toStrictEqual(png);
      }),
      { numRuns: 30 },
    );
  });

  it('accepts a DEFLATE thumbnail entry from another writer', async () => {
    const zip = rawZip([
      { name: CTRL_ENTRY.manifest, data: '{}' },
      { name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 8 },
    ]);
    await expect(readCtrlThumbnail(bytesSource(zip))).resolves.toStrictEqual(TINY_PNG);
  });

  it.each([
    ['not a PNG', [{ name: CTRL_ENTRY.thumbnail, data: 'GIF89a', method: 0 }], {}],
    ['a CRC-32 mismatch', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0, crc: 1 }], {}],
    ['encryption', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0, flags: 1 }], {}],
    ['an unknown method', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 12 }], {}],
    [
      'a lying stored size',
      [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0, uncompressedSize: TINY_PNG.length + 1 }],
      {},
    ],
    [
      'an oversized claim',
      [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, uncompressedSize: CTRL_LIMITS.maxThumbnailBytes + 1 }],
      {},
    ],
    [
      'a local header name that disagrees',
      [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, localName: 'x.png1234' }],
      {},
    ],
    ['a local offset past the directory', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, localOffset: 1 << 30 }], {}],
    ['a ZIP64 locator', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0 }], { zip64Locator: true }],
    [
      'a wrong central directory offset',
      [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0 }],
      { centralStart: 3 },
    ],
    ['multiple disks', [{ name: CTRL_ENTRY.thumbnail, data: TINY_PNG, method: 0 }], { eocdDisk: 1 }],
  ] as const)('is null for %s', async (_label, entries, options) => {
    await expect(readCtrlThumbnail(bytesSource(rawZip(entries, options)))).resolves.toBeNull();
  });

  it('is null for files that are no ZIP at all, empty, truncated or over the container cap', async () => {
    const good = save(TINY_PNG);
    await expect(readCtrlThumbnail(bytesSource(new Uint8Array()))).resolves.toBeNull();
    await expect(
      readCtrlThumbnail(bytesSource(new TextEncoder().encode('not a zip at all, sorry'))),
    ).resolves.toBeNull();
    await expect(readCtrlThumbnail(bytesSource(good.subarray(0, good.length - 1)))).resolves.toBeNull();
    // A source whose size claims more than it can read (the file shrank between stat and read).
    const shrunk: RandomAccessBytes = { size: good.length + 10, read: bytesSource(good).read };
    await expect(readCtrlThumbnail(shrunk)).resolves.toBeNull();
    const huge: RandomAccessBytes = {
      size: CTRL_LIMITS.maxContainerBytes + 1,
      read: () => Promise.reject(new Error('read')),
    };
    await expect(readCtrlThumbnail(huge)).resolves.toBeNull();
  });

  it('never throws on arbitrary bytes (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const result = await readCtrlThumbnail(bytesSource(bytes));
        expect(result === null || result instanceof Uint8Array).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('passes an I/O error through', async () => {
    const failing: RandomAccessBytes = { size: 100, read: () => Promise.reject(new Error('EIO')) };
    await expect(readCtrlThumbnail(failing)).rejects.toThrow('EIO');
  });
});
