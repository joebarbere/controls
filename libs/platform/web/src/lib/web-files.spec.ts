import { describeSaveIoContract, type SaveIoHarness } from '@controls/platform-api/testing';
import {
  WebSaveStore,
  type OpfsDirectoryHandle,
  type OpfsFile,
  type OpfsFileHandle,
  type OpfsWritable,
  type PickedFile,
} from './web-files';
import { WebPlatform } from './web-platform';

const domError = (name: string) => Object.assign(new Error(name), { name });

/**
 * An in-memory OPFS with the semantics the store relies on: `getFileHandle({ create: true })`
 * creates an empty file at once, and a writable stream buffers into a swap copy that only
 * `close()` puts in place (`abort()` drops it). `failNextClose` fails the commit itself.
 */
class FakeOpfs {
  failNextClose = false;
  clock = 1_000_000;

  directory(name: string): OpfsDirectoryHandle {
    const dirs = new Map<string, OpfsDirectoryHandle>();
    const files = new Map<string, { data: Uint8Array; lastModified: number }>();
    const fileHandle = (fileName: string): OpfsFileHandle => ({
      kind: 'file',
      name: fileName,
      getFile: async (): Promise<OpfsFile> => {
        const file = files.get(fileName);
        if (!file) throw domError('NotFoundError');
        const data = file.data.slice();
        return { size: data.byteLength, lastModified: file.lastModified, arrayBuffer: async () => data.buffer };
      },
      createWritable: async (): Promise<OpfsWritable> => {
        let swap = new Uint8Array();
        let open = true;
        return {
          write: async (chunk) => {
            const next = new Uint8Array(swap.byteLength + chunk.byteLength);
            next.set(swap);
            next.set(chunk, swap.byteLength);
            swap = next;
          },
          close: async () => {
            if (!open) throw domError('TypeError');
            open = false;
            if (this.failNextClose) {
              this.failNextClose = false;
              throw domError('InvalidStateError');
            }
            files.set(fileName, { data: swap, lastModified: (this.clock += 1000) });
          },
          abort: async () => {
            open = false;
          },
        };
      },
    });
    const self: OpfsDirectoryHandle = {
      kind: 'directory',
      name,
      getDirectoryHandle: async (dirName, options) => {
        if (files.has(dirName)) throw domError('TypeMismatchError');
        let dir = dirs.get(dirName);
        if (!dir) {
          if (!options?.create) throw domError('NotFoundError');
          dir = this.directory(dirName);
          dirs.set(dirName, dir);
        }
        return dir;
      },
      getFileHandle: async (fileName, options) => {
        if (dirs.has(fileName)) throw domError('TypeMismatchError');
        if (!files.has(fileName)) {
          if (!options?.create) throw domError('NotFoundError');
          files.set(fileName, { data: new Uint8Array(), lastModified: (this.clock += 1000) });
        }
        return fileHandle(fileName);
      },
      removeEntry: async (entryName) => {
        if (!files.delete(entryName) && !dirs.delete(entryName)) throw domError('NotFoundError');
      },
      values: async function* () {
        for (const dir of dirs.values()) yield dir;
        for (const fileName of files.keys()) yield fileHandle(fileName);
      },
    };
    return self;
  }
}

function webHarness(): SaveIoHarness & { opfs: FakeOpfs; downloads: { fileName: string; bytes: Uint8Array }[] } {
  const opfs = new FakeOpfs();
  const root = opfs.directory('');
  let nextPick: PickedFile | null = null;
  const downloads: { fileName: string; bytes: Uint8Array }[] = [];
  const store = new WebSaveStore(
    async () => root,
    {
      pickFile: async () => nextPick,
      download: (fileName, bytes) => downloads.push({ fileName, bytes: bytes.slice() }),
    },
    () => opfs.clock,
  );
  return {
    opfs,
    downloads,
    files: store.files,
    dialogs: store.dialogs,
    nextOpen: (pick) => {
      const data = pick?.bytes.slice();
      nextPick =
        pick && data
          ? { name: pick.fileName, size: data.byteLength, lastModified: 42, arrayBuffer: async () => data.buffer }
          : null;
    },
    nextSaveAs: () => undefined, // a download has no picker
    lastSavedAs: async () => downloads.at(-1),
    failNextCommit: () => (opfs.failNextClose = true),
    dispose: async () => undefined,
  };
}

describeSaveIoContract('web harness (WebSaveStore → fake OPFS)', async () => webHarness(), { saveAsIsDownload: true });

describe('WebSaveStore (web-only behaviour)', () => {
  it('reports unavailable storage without OPFS, and lists nothing', async () => {
    const store = new WebSaveStore(async () => undefined);
    await expect(store.files.list()).resolves.toEqual([]);
    await expect(store.files.write({ kind: 'autosave', slotCount: 1 }, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('turns a browser error into io and SecurityError into unavailable', async () => {
    const failing = (name: string) =>
      new WebSaveStore(async () => {
        throw domError(name);
      });
    await expect(failing('QuotaExceededError').files.list()).rejects.toMatchObject({ code: 'io' });
    await expect(failing('SecurityError').files.list()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('skips empty files a closed tab may have left behind', async () => {
    const h = webHarness();
    await h.files.write({ kind: 'manual', name: 'Real', overwrite: false }, new Uint8Array([1]));
    // getFileHandle({ create: true }) with no write after it, as when a tab dies mid-save:
    const saves = await (await h.opfs.directory('')).getDirectoryHandle('saves', { create: true });
    await saves.getFileHandle('Ghost.ctrl', { create: true });
    expect((await h.files.list()).map((e) => e.name)).toEqual(['Real']);
  });

  it('downloads a Save As write under the suggested file name', async () => {
    const h = webHarness();
    const target = await h.dialogs.saveAs({ fileType: 'ctrl', suggestedName: 'Shop' });
    await h.files.write({ kind: 'handle', handle: target?.handle ?? '' }, new Uint8Array([9]));
    expect(h.downloads).toEqual([{ fileName: 'Shop.ctrl', bytes: new Uint8Array([9]) }]);
  });

  it('allows one Open picker at a time', async () => {
    let release: (file: PickedFile | null) => void = () => undefined;
    const store = new WebSaveStore(async () => undefined, {
      pickFile: () => new Promise((resolve) => (release = resolve)),
      download: () => undefined,
    });
    const first = store.dialogs.open({ fileType: 'ctrl' });
    await expect(store.dialogs.open({ fileType: 'ctrl' })).rejects.toMatchObject({ code: 'busy' });
    release(null);
    await expect(first).resolves.toBeNull();
  });

  it('is what WebPlatform exposes', () => {
    const platform = new WebPlatform();
    expect(typeof platform.files.list).toBe('function');
    expect(typeof platform.dialogs.saveAs).toBe('function');
  });
});
