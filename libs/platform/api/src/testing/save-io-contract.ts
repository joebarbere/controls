import {
  compareSaveEntries,
  MAX_SAVE_BYTES,
  SaveEntrySchema,
  type SaveEntry,
  type SaveIoErrorCode,
  type SaveTarget,
} from '@controls/ipc-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DialogService, FileService } from '../lib/files';

/**
 * One contract, two platforms (F1.8b): `describeSaveIoContract` runs the same behaviour tests against
 * Electron (`ElectronPlatform` over an in-process bridge to main's real handlers and a temp dir,
 * in `apps/desktop`) and the web harness (`WebPlatform` over a fake OPFS, in `platform-web`).
 */
export interface SaveIoHarness {
  readonly files: FileService;
  readonly dialogs: DialogService;
  /** The player's next Open pick: a file with this base name and these bytes, or a cancel (`null`). */
  nextOpen(pick: { readonly fileName: string; readonly bytes: Uint8Array } | null): void;
  /** The player's next Save As pick (`<fileName>` as typed in the dialog), or a cancel. */
  nextSaveAs(pick: { readonly fileName: string } | null): void;
  /** What the last write to a Save As target produced: the file on disk, or the download. */
  lastSavedAs(): Promise<{ readonly fileName: string; readonly bytes: Uint8Array } | undefined>;
  /** Makes the next write fail after its data is written and before it is committed (renamed / closed). */
  failNextCommit(): void;
  dispose(): Promise<void>;
}

const bytes = (...values: number[]) => new Uint8Array(values);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function codeOf(promise: Promise<unknown>): Promise<SaveIoErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    expect((error as Error).name).toBe('SaveIoError');
    return code as SaveIoErrorCode;
  }
}

export interface SaveIoContractOptions {
  /**
   * The web harness's Save As is a download: no picker, so it can't be cancelled and the file name is
   * the suggested one. The tests that need a real picker are skipped there.
   */
  readonly saveAsIsDownload?: boolean;
}

export function describeSaveIoContract(
  label: string,
  create: () => Promise<SaveIoHarness>,
  options: SaveIoContractOptions = {},
): void {
  const picker = !options.saveAsIsDownload;
  describe(`save I/O contract: ${label}`, () => {
    let h: SaveIoHarness;
    beforeEach(async () => {
      h = await create();
    });
    afterEach(async () => {
      await h.dispose();
    });

    const manual = (name: string, overwrite = false): SaveTarget => ({ kind: 'manual', name, overwrite });

    describe('FileService', () => {
      it('starts empty', async () => {
        await expect(h.files.list()).resolves.toEqual([]);
      });

      it('writes a manual save, lists it and reads the same bytes back', async () => {
        const entry = await h.files.write(manual('Workshop'), bytes(1, 2, 3));
        expect(SaveEntrySchema.parse(entry)).toEqual(entry);
        expect(entry).toMatchObject({ name: 'Workshop', kind: 'manual', slot: null, sizeBytes: 3 });
        const listed = await h.files.list();
        expect(listed).toEqual([entry]);
        await expect(h.files.read(entry.handle)).resolves.toEqual(bytes(1, 2, 3));
      });

      it('gives one save one stable handle', async () => {
        const first = await h.files.write(manual('A'), bytes(1));
        const [listed] = await h.files.list();
        expect(listed?.handle).toBe(first.handle);
      });

      it('refuses to replace a manual save unless asked, then replaces it', async () => {
        await h.files.write(manual('A'), bytes(1));
        expect(await codeOf(h.files.write(manual('A'), bytes(2)))).toBe('exists');
        await h.files.write(manual('A', true), bytes(2, 2));
        const [entry, ...rest] = await h.files.list();
        expect(rest).toEqual([]);
        await expect(h.files.read(entry?.handle ?? '')).resolves.toEqual(bytes(2, 2));
      });

      it('overwrites a manual save through its handle', async () => {
        const entry = await h.files.write(manual('A'), bytes(1));
        const again = await h.files.write({ kind: 'handle', handle: entry.handle }, bytes(9, 9));
        expect(again).toMatchObject({ handle: entry.handle, name: 'A', kind: 'manual', sizeBytes: 2 });
        await expect(h.files.read(entry.handle)).resolves.toEqual(bytes(9, 9));
      });

      it('lists newest first', async () => {
        await h.files.write(manual('old'), bytes(1));
        await sleep(30);
        await h.files.write(manual('new'), bytes(2));
        await sleep(30);
        await h.files.write({ kind: 'autosave', slotCount: 3 }, bytes(3));
        const listed = await h.files.list();
        expect(listed.map((e) => e.name)).toEqual(['Autosave 1', 'new', 'old']);
        expect(listed).toEqual([...listed].sort(compareSaveEntries));
      });

      it.each(['../evil', 'a/b', 'a\\b', '', '.hidden', 'CON', 'x'.repeat(65), 'trailing.'])(
        'refuses the name %j as invalid',
        async (name) => {
          expect(await codeOf(h.files.write(manual(name), bytes(1)))).toBe('invalid');
          await expect(h.files.list()).resolves.toEqual([]);
        },
      );

      it('refuses empty and oversized bytes', async () => {
        expect(await codeOf(h.files.write(manual('A'), new Uint8Array()))).toBe('invalid');
        expect(await codeOf(h.files.write(manual('A'), new Uint8Array(MAX_SAVE_BYTES + 1)))).toBe('too-large');
        await expect(h.files.list()).resolves.toEqual([]);
      });

      it('refuses forged and malformed handles', async () => {
        await h.files.write(manual('A'), bytes(1));
        expect(await codeOf(h.files.read('AAAAAAAAAAAAAAAAAAAAAA'))).toBe('unknown-handle');
        expect(await codeOf(h.files.write({ kind: 'handle', handle: 'AAAAAAAAAAAAAAAAAAAAAA' }, bytes(1)))).toBe(
          'unknown-handle',
        );
        for (const forged of ['../../etc/passwd', 'A.ctrl', 'autosave/slot-1.ctrl', ''])
          expect(await codeOf(h.files.read(forged))).toBe('invalid');
      });

      it('a write that fails before it commits leaves the old save intact', async () => {
        const entry = await h.files.write(manual('A'), bytes(1, 1, 1));
        h.failNextCommit();
        expect(await codeOf(h.files.write(manual('A', true), bytes(2, 2)))).toBe('io');
        await expect(h.files.read(entry.handle)).resolves.toEqual(bytes(1, 1, 1));
        expect((await h.files.list()).map((e) => [e.name, e.sizeBytes])).toEqual([['A', 3]]);
        // …and the next write works.
        await h.files.write(manual('A', true), bytes(3));
        await expect(h.files.read(entry.handle)).resolves.toEqual(bytes(3));
      });

      it('a failed first write leaves nothing behind', async () => {
        h.failNextCommit();
        expect(await codeOf(h.files.write({ kind: 'autosave', slotCount: 2 }, bytes(1)))).toBe('io');
        await expect(h.files.list()).resolves.toEqual([]);
      });
    });

    describe('autosave rotation', () => {
      const autosave = (slotCount: number, value: number) =>
        h.files.write({ kind: 'autosave', slotCount }, bytes(value));

      it('fills the slots, then overwrites the oldest', async () => {
        const slots: (number | null)[] = [];
        for (let i = 1; i <= 5; i++) slots.push((await autosave(3, i)).slot);
        expect(slots).toEqual([1, 2, 3, 1, 2]);
        const listed = await h.files.list();
        expect(listed.map((e) => [e.name, e.kind, e.slot])).toEqual(
          expect.arrayContaining([
            ['Autosave 1', 'autosave', 1],
            ['Autosave 2', 'autosave', 2],
            ['Autosave 3', 'autosave', 3],
          ]),
        );
        expect(listed).toHaveLength(3);
        const contents = await Promise.all(
          [1, 2, 3].map(async (slot) => h.files.read(listed.find((e) => e.slot === slot)?.handle ?? '')),
        );
        expect(contents).toEqual([bytes(4), bytes(5), bytes(3)]);
      });

      it('removes slots above a reduced count', async () => {
        for (let i = 1; i <= 3; i++) await autosave(3, i);
        await autosave(2, 4);
        const slots = (await h.files.list()).map((e) => e.slot).sort();
        expect(slots).toEqual([1, 2]);
      });

      it('keeps autosave slots read-only through their handles', async () => {
        const entry = await autosave(2, 1);
        expect(await codeOf(h.files.write({ kind: 'handle', handle: entry.handle }, bytes(2)))).toBe('read-only');
        await expect(h.files.read(entry.handle)).resolves.toEqual(bytes(1));
      });

      it('keeps autosaves and manual saves apart', async () => {
        await autosave(1, 1);
        await h.files.write(manual('Autosave 1'), bytes(2));
        await h.files.write(manual('slot-1'), bytes(3));
        const kinds = (await h.files.list()).map((e) => `${e.kind}:${e.name}`).sort();
        expect(kinds).toEqual(['autosave:Autosave 1', 'manual:Autosave 1', 'manual:slot-1']);
      });
    });

    describe('DialogService', () => {
      it('open: a cancel resolves null', async () => {
        h.nextOpen(null);
        await expect(h.dialogs.open({ fileType: 'ctrl' })).resolves.toBeNull();
      });

      it('open: the picked file becomes a read-only external handle', async () => {
        h.nextOpen({ fileName: 'shared.ctrl', bytes: bytes(7, 8) });
        const entry = await h.dialogs.open({ fileType: 'ctrl' });
        expect(entry).toMatchObject({ name: 'shared.ctrl', kind: 'external', slot: null, sizeBytes: 2 });
        expect(SaveEntrySchema.parse(entry)).toEqual(entry);
        await expect(h.files.read(entry?.handle ?? '')).resolves.toEqual(bytes(7, 8));
        expect(await codeOf(h.files.write({ kind: 'handle', handle: entry?.handle ?? '' }, bytes(1)))).toBe(
          'read-only',
        );
        await expect(h.files.list()).resolves.toEqual([]); // not in the save directory
      });

      it.runIf(picker)('saveAs: a cancel resolves null', async () => {
        h.nextSaveAs(null);
        await expect(h.dialogs.saveAs({ fileType: 'ctrl', suggestedName: 'Workshop' })).resolves.toBeNull();
      });

      it('saveAs: the target is write-only, and writing it saves the file', async () => {
        h.nextSaveAs({ fileName: 'Workshop.ctrl' });
        const target = await h.dialogs.saveAs({ fileType: 'ctrl', suggestedName: 'Workshop' });
        expect(target?.name).toBe('Workshop.ctrl');
        const handle = target?.handle ?? '';
        const entry: SaveEntry = await h.files.write({ kind: 'handle', handle }, bytes(4, 5, 6));
        expect(entry).toMatchObject({ handle, name: 'Workshop.ctrl', kind: 'external', slot: null, sizeBytes: 3 });
        await expect(h.lastSavedAs()).resolves.toEqual({ fileName: 'Workshop.ctrl', bytes: bytes(4, 5, 6) });
        expect(await codeOf(h.files.read(handle))).toBe('write-only');
        await expect(h.files.list()).resolves.toEqual([]);
      });

      it.runIf(picker)('saveAs: adds the .ctrl extension when the player leaves it off', async () => {
        h.nextSaveAs({ fileName: 'bare' });
        const target = await h.dialogs.saveAs({ fileType: 'ctrl', suggestedName: 'Workshop' });
        expect(target?.name).toBe('bare.ctrl');
      });

      it('refuses a malformed dialog request', async () => {
        expect(await codeOf(h.dialogs.saveAs({ fileType: 'ctrl', suggestedName: '../../x' }))).toBe('invalid');
        expect(await codeOf(h.dialogs.open({ fileType: 'exe' as 'ctrl' }))).toBe('invalid');
      });
    });
  });
}
