import { MAX_SAVE_BYTES } from '@controls/ipc-contract';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaveRefusal, SaveStore, type SaveFs, type SaveLocation } from './save-store';

const posix = process.platform !== 'win32';
const bytes = (...values: number[]) => new Uint8Array(values);

let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controls-saves-'));
  root = join(dir, 'saves');
  outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SaveRefusal) return error.code;
    throw error;
  }
  return 'resolved';
}

type Step = 'open' | 'write' | 'sync' | 'rename';

/**
 * Real fs, except that one step of the atomic write fails, as a crash or a full disk would:
 * `write` writes half of the data to the temp file and then throws, `sync` fails the fsync,
 * `rename` fails between the complete, synced temp file and the rename that would commit it.
 */
function failingFs(step: Step): SaveFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...fsp,
    calls,
    rename: async (from, to) => {
      calls.push('rename');
      if (step === 'rename') throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
      return fsp.rename(from, to);
    },
    open: (async (...args: Parameters<typeof fsp.open>) => {
      calls.push(`open:${String(args[1])}`);
      if (step === 'open' && args[1] === 'wx') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      const handle = await fsp.open(...args);
      if (step === 'write' && args[1] === 'wx') {
        handle.writeFile = async (data: unknown) => {
          const all = data as Uint8Array;
          await fsp.appendFile(String(args[0]), all.subarray(0, Math.floor(all.byteLength / 2)));
          throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
        };
      }
      if (step === 'sync' && args[1] === 'wx') handle.sync = async () => Promise.reject(new Error('EIO: fsync failed'));
      return handle;
    }) as typeof fsp.open,
  };
}

describe('SaveStore atomic writes', () => {
  it.each(['open', 'write', 'sync', 'rename'] as const)(
    'a manual save that fails at %s leaves the old file intact and no temp file',
    async (step) => {
      await new SaveStore(root).writeManual('Shop', bytes(1, 1, 1, 1), false);
      const store = new SaveStore(root, failingFs(step));
      await expect(store.writeManual('Shop', bytes(2, 2, 2, 2, 2, 2), true)).rejects.toThrow();
      expect(readFileSync(join(root, 'Shop.ctrl'))).toEqual(Buffer.from([1, 1, 1, 1]));
      expect(readdirSync(root)).toEqual(['Shop.ctrl']);
    },
  );

  it('writes data, fsyncs it, renames, then fsyncs the directory', async () => {
    const fs = failingFs('none' as Step);
    await new SaveStore(root, fs).writeManual('Shop', bytes(1), false);
    const order = fs.calls.filter((c) => c === 'open:wx' || c === 'rename' || c === 'open:r');
    expect(order).toEqual(posix ? ['open:wx', 'rename', 'open:r'] : ['open:wx', 'rename']);
  });

  it('a failed autosave neither creates a slot nor advances the rotation', async () => {
    let fail = false;
    const store = new SaveStore(root, {
      ...fsp,
      rename: async (from, to) => (fail ? Promise.reject(new Error('EIO')) : fsp.rename(from, to)),
    });
    await store.writeAutosave(3, bytes(1));
    fail = true;
    await expect(store.writeAutosave(3, bytes(2))).rejects.toThrow();
    expect(readdirSync(join(root, 'autosave'))).toEqual(['slot-1.ctrl']);
    fail = false;
    expect((await store.writeAutosave(3, bytes(3))).slot).toBe(2);
  });

  it('ignores temp files a crash left behind', async () => {
    writeFileSync(join(root, '.Shop.ctrl.123.0.tmp'), 'partial');
    writeFileSync(join(root, 'notes.txt'), 'not a save');
    await expect(new SaveStore(root).list()).resolves.toEqual([]);
  });
});

describe('SaveStore paths', () => {
  it('never resolves a location outside its directory', () => {
    const store = new SaveStore(root);
    for (const forged of [
      { kind: 'manual', name: '../escape' },
      { kind: 'manual', name: 'a/b' },
      { kind: 'manual', name: '/absolute' },
    ] as SaveLocation[])
      expect(() => store.pathOf(forged)).toThrow(SaveRefusal);
    expect(store.pathOf({ kind: 'manual', name: 'Shop' })).toBe(join(root, 'Shop.ctrl'));
    expect(store.pathOf({ kind: 'manual', name: '..' })).toBe(join(root, '...ctrl')); // a name, not a parent
    expect(store.pathOf({ kind: 'autosave', slot: 2 })).toBe(join(root, 'autosave', 'slot-2.ctrl'));
  });

  it('refuses a directory where a save should be', async () => {
    mkdirSync(join(root, 'Shop.ctrl'));
    const store = new SaveStore(root);
    expect(await refusal(store.read({ kind: 'manual', name: 'Shop' }))).toBe('not-a-file');
    expect(await refusal(store.writeManual('Shop', bytes(1), true))).toBe('not-a-file');
    expect(await refusal(store.writeManual('Shop', bytes(1), false))).toBe('exists');
  });

  it('reports a missing file as not-found', async () => {
    expect(await refusal(new SaveStore(root).read({ kind: 'manual', name: 'Gone' }))).toBe('not-found');
  });

  it('refuses an oversized file without reading it', async () => {
    const path = join(root, 'Big.ctrl');
    writeFileSync(path, '');
    await fsp.truncate(path, MAX_SAVE_BYTES + 1); // sparse: no 64 MiB write
    const open = vi.fn(fsp.open);
    const store = new SaveStore(root, { ...fsp, open: open as typeof fsp.open });
    expect(await refusal(store.read({ kind: 'manual', name: 'Big' }))).toBe('too-large');
    expect(open).not.toHaveBeenCalled();
  });
});

describe.runIf(posix)('SaveStore symlinks', () => {
  beforeEach(() => writeFileSync(join(outside, 'secret.txt'), 'secret'));

  it('does not list or read a symlinked save', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'Evil.ctrl'));
    const store = new SaveStore(root);
    await expect(store.list()).resolves.toEqual([]);
    expect(await refusal(store.read({ kind: 'manual', name: 'Evil' }))).toBe('not-a-file');
  });

  it('refuses a file swapped for a symlink after the check (O_NOFOLLOW)', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'Swap.ctrl'));
    // lstat says "regular file" (as it did a moment before the swap); open must still refuse.
    const lstat = (async (path: string) => fsp.stat(path)) as typeof fsp.lstat;
    const store = new SaveStore(root, { ...fsp, lstat });
    expect(await refusal(store.read({ kind: 'manual', name: 'Swap' }))).toBe('not-a-file');
  });

  it('replaces a symlink on write instead of writing through it', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'Link.ctrl'));
    await new SaveStore(root).writeManual('Link', bytes(1, 2), true);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(readFileSync(join(root, 'Link.ctrl'))).toEqual(Buffer.from([1, 2]));
  });

  it('refuses an autosave directory that is a symlink, and still lists manual saves', async () => {
    symlinkSync(outside, join(root, 'autosave'));
    const store = new SaveStore(root);
    await store.writeManual('Shop', bytes(1), false);
    expect(await refusal(store.writeAutosave(2, bytes(1)))).toBe('not-a-file');
    expect(await refusal(store.read({ kind: 'autosave', slot: 1 }))).toBe('not-a-file');
    expect((await store.list()).map((e) => e.name)).toEqual(['Shop']);
    expect(readdirSync(outside)).toEqual(['secret.txt']);
  });

  it('resolves a picked symlink once, to its real file', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(outside, 'link.ctrl'));
    const store = new SaveStore(root);
    const location = await store.resolvePicked(join(outside, 'link.ctrl'));
    expect(location.path).toBe(await fsp.realpath(join(outside, 'secret.txt')));
    expect(await refusal(store.resolvePicked(outside))).toBe('not-a-file');
    expect(await refusal(store.resolvePicked(join(outside, 'none.ctrl')))).toBe('not-found');
  });
});

describe('SaveStore autosave rotation', () => {
  it('starts a new session at a free slot, then the oldest', async () => {
    const autosaveDir = join(root, 'autosave');
    mkdirSync(autosaveDir);
    for (const [slot, seconds] of [
      [1, 300],
      [2, 100],
      [3, 200],
    ] as const) {
      writeFileSync(join(autosaveDir, `slot-${slot}.ctrl`), 'x');
      utimesSync(join(autosaveDir, `slot-${slot}.ctrl`), seconds, seconds);
    }
    const store = new SaveStore(root);
    expect((await store.writeAutosave(3, bytes(1))).slot).toBe(2); // oldest
    expect((await store.writeAutosave(3, bytes(1))).slot).toBe(3); // then rotates
    expect((await store.writeAutosave(3, bytes(1))).slot).toBe(1);
  });

  it('serialises concurrent autosaves onto different slots', async () => {
    const store = new SaveStore(root);
    const slots = await Promise.all([1, 2, 3].map((v) => store.writeAutosave(3, bytes(v))));
    expect(slots.map((s) => s.slot)).toEqual([1, 2, 3]);
  });

  it('writeExternal adds nothing to the save directory', async () => {
    const store = new SaveStore(root);
    const path = join(outside, 'x.ctrl');
    const info = await store.writeExternal({ kind: 'external', path, access: 'write' }, bytes(5));
    expect(info).toMatchObject({ name: 'x.ctrl', kind: 'external', sizeBytes: 1 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('adds .ctrl to a Save As path only when missing', () => {
    expect(SaveStore.withSaveExtension('/a/b')).toBe('/a/b.ctrl');
    expect(SaveStore.withSaveExtension('/a/b.CTRL')).toBe('/a/b.CTRL');
    expect(SaveStore.withSaveExtension('/a/b.json')).toBe('/a/b.json.ctrl');
  });
});
