import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { BENCH_LAMP_HASH, BENCH_LAMP_LIT_HASH, benchLampScenario, hashAfter, newSandbox, PLACE } from './game';
import { createProfile, launchControls, removeProfile, type LaunchedControls } from './launch';

/**
 * F1.8b: save I/O over the real bridge, against the real main process and file system (ADR 0009,
 * part 2), and saving and loading a game through the UI (part 3), also mid-sim (the P2 bench lamp,
 * lit, saved and loaded, then run on to its pinned hashes). One launch for the file, so it
 * also runs against a packaged build (the release smoke procedure); the dialog test stubs
 * Electron's `dialog` through the Node inspector, so it runs on the dev build only.
 */

interface Bridge {
  listSaves(): Promise<{ handle: string; name: string; kind: string; slot: number | null; sizeBytes: number }[]>;
  readSave(request: unknown): Promise<Uint8Array>;
  writeSave(
    request: unknown,
  ): Promise<{ handle: string; name: string; kind: string; slot: number | null; sizeBytes: number }>;
  deleteSave(request: unknown): Promise<void>;
  readSaveThumbnail(request: unknown): Promise<Uint8Array | null>;
  showOpenDialog(request: unknown): Promise<{ handle: string; name: string; kind: string } | null>;
  showSaveAsDialog(request: unknown): Promise<{ handle: string; name: string } | null>;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

/**
 * A one-entry ZIP holding `thumbnail.png`, stored (as the game writes it). Not a loadable save, but
 * `save:thumbnail` reads only the ZIP's directory and that entry, so it is all main needs.
 */
function zipWithThumbnail(png: readonly number[]): number[] {
  const name = Buffer.from('thumbnail.png', 'ascii');
  const data = Buffer.from(png);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(10, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralStart = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return [...Buffer.concat([local, name, data, central, name, end])];
}

test.describe.serial('desktop saves', () => {
  let app: LaunchedControls | undefined;
  let profile = '';
  const running = (): LaunchedControls => {
    if (!app) throw new Error('app did not launch');
    return app;
  };

  test.beforeAll(async () => {
    profile = createProfile();
    app = await launchControls({ userDataDir: profile });
  });

  test.afterAll(async () => {
    await app?.close();
    removeProfile(profile);
  });

  test('writes a save to userData/saves and reads it back through the bridge', async () => {
    const result = await running().window.evaluate(async () => {
      const bridge = (globalThis as unknown as { controls: Bridge }).controls;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
      const entry = await bridge.writeSave({ target: { kind: 'manual', name: 'E2E save', overwrite: false }, bytes });
      const listed = await bridge.listSaves();
      const back = await bridge.readSave({ handle: entry.handle });
      return { entry, listed, back: [...back], isUint8: back instanceof Uint8Array };
    });
    expect(result.entry).toMatchObject({ name: 'E2E save', kind: 'manual', sizeBytes: 7 });
    expect(result.listed).toEqual([expect.objectContaining({ handle: result.entry.handle, name: 'E2E save' })]);
    expect(result.back).toEqual([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(result.isUint8).toBe(true);
    // Main put it where ADR 0009 says, with no temp file left over, and the renderer never saw that path.
    expect(readdirSync(join(profile, 'saves'))).toEqual(['E2E save.ctrl']);
    expect(JSON.stringify(result)).not.toContain(profile);
  });

  test('refuses forged handles, traversal and bad payloads without echoing them', async () => {
    const messages = await running().window.evaluate(async () => {
      const bridge = (globalThis as unknown as { controls: Bridge }).controls;
      const attempt = (call: () => Promise<unknown>) =>
        call().then(
          () => 'accepted',
          (error: Error) => error.message,
        );
      return {
        forged: await attempt(() => bridge.readSave({ handle: 'AAAAAAAAAAAAAAAAAAAAAA' })),
        forgedWrite: await attempt(() =>
          bridge.writeSave({
            target: { kind: 'handle', handle: 'AAAAAAAAAAAAAAAAAAAAAA' },
            bytes: new Uint8Array([1]),
          }),
        ),
        traversalHandle: await attempt(() => bridge.readSave({ handle: '../../do-not-echo/settings.json' })),
        traversalName: await attempt(() =>
          bridge.writeSave({
            target: { kind: 'manual', name: '../do-not-echo', overwrite: true },
            bytes: new Uint8Array([1]),
          }),
        ),
        rawPath: await attempt(() =>
          bridge.writeSave({ target: { kind: 'path', path: '/tmp/do-not-echo' }, bytes: new Uint8Array([1]) }),
        ),
        notBytes: await attempt(() =>
          bridge.writeSave({ target: { kind: 'autosave', slotCount: 2 }, bytes: 'do-not-echo' }),
        ),
      };
    });
    expect(messages).toEqual({
      forged: expect.stringContaining('save:read refused (unknown-handle).'),
      forgedWrite: expect.stringContaining('save:write refused (unknown-handle).'),
      traversalHandle: expect.stringContaining('save:read refused (invalid).'),
      traversalName: expect.stringContaining('save:write refused (invalid).'),
      rawPath: expect.stringContaining('save:write refused (invalid).'),
      notBytes: expect.stringContaining('save:write refused (invalid).'),
    });
    expect(JSON.stringify(messages)).not.toContain('do-not-echo');
    expect(readdirSync(join(profile, 'saves'))).toEqual(['E2E save.ctrl']);
  });

  test('rotates autosave slots in main', async () => {
    const slots = await running().window.evaluate(async () => {
      const bridge = (globalThis as unknown as { controls: Bridge }).controls;
      const out: (number | null)[] = [];
      for (let i = 1; i <= 3; i++)
        out.push(
          (await bridge.writeSave({ target: { kind: 'autosave', slotCount: 2 }, bytes: new Uint8Array([i]) })).slot,
        );
      return out;
    });
    expect(slots).toEqual([1, 2, 1]);
    expect(readdirSync(join(profile, 'saves', 'autosave')).sort()).toEqual(['slot-1.ctrl', 'slot-2.ctrl']);
  });

  test('save:thumbnail and save:delete work on save-directory handles only, never echoing a payload (P4)', async () => {
    const result = await running().window.evaluate(async (zip) => {
      const bridge = (globalThis as unknown as { controls: Bridge }).controls;
      const attempt = (call: () => Promise<unknown>) =>
        call().then(
          () => 'accepted',
          (error: Error) => error.message,
        );
      const pictured = await bridge.writeSave({
        target: { kind: 'manual', name: 'Pictured', overwrite: false },
        bytes: new Uint8Array(zip),
      });
      const thumbnail = await bridge.readSaveThumbnail({ handle: pictured.handle });
      const junk = (await bridge.listSaves()).find((e) => e.name === 'E2E save');
      const none = await bridge.readSaveThumbnail({ handle: junk?.handle });
      const refusals = {
        forged: await attempt(() => bridge.deleteSave({ handle: 'AAAAAAAAAAAAAAAAAAAAAA' })),
        traversal: await attempt(() => bridge.deleteSave({ handle: '../../do-not-echo/settings.json' })),
        path: await attempt(() => bridge.deleteSave({ path: '/tmp/do-not-echo' })),
        thumbnailPath: await attempt(() => bridge.readSaveThumbnail({ handle: pictured.handle, path: '/do-not-echo' })),
      };
      await bridge.deleteSave({ handle: pictured.handle });
      const again = await attempt(() => bridge.deleteSave({ handle: pictured.handle }));
      return {
        thumbnail: thumbnail === null ? null : [...thumbnail],
        isUint8: thumbnail instanceof Uint8Array,
        none,
        refusals,
        again,
        after: (await bridge.listSaves()).map((e) => e.name).sort(),
      };
    }, zipWithThumbnail(PNG));
    expect(result.thumbnail).toEqual(PNG);
    expect(result.isUint8).toBe(true);
    expect(result.none).toBeNull(); // not a ZIP: no thumbnail, and no error
    expect(result.refusals).toEqual({
      forged: expect.stringContaining('save:delete refused (unknown-handle).'),
      traversal: expect.stringContaining('save:delete refused (invalid).'),
      path: expect.stringContaining('save:delete refused (invalid).'),
      thumbnailPath: expect.stringContaining('save:thumbnail refused (invalid).'),
    });
    expect(result.again).toContain('save:delete refused (not-found).');
    expect(result.after).toEqual(['Autosave 1', 'Autosave 2', 'E2E save']);
    expect(readdirSync(join(profile, 'saves')).sort()).toEqual(['E2E save.ctrl', 'autosave']);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
    expect(JSON.stringify(result)).not.toContain(profile);
  });

  test('Save As and Open hand out handles for the picked files, never their paths', async () => {
    test.skip(!running().evaluateMain, 'stubs Electron dialogs through the Node inspector (dev build only)');
    const outside = mkdtempSync(join(tmpdir(), 'controls-e2e-picked-'));
    try {
      const exportPath = join(outside, 'export'); // no extension: main adds .ctrl
      const openPath = join(outside, 'shared.ctrl');
      writeFileSync(openPath, Buffer.from([9, 8, 7]));
      await running().evaluateMain?.(
        ({ dialog }, paths) => {
          const d = dialog as unknown as Record<string, unknown>;
          d['showSaveDialog'] = async () => ({ canceled: false, filePath: paths.exportPath });
          d['showOpenDialog'] = async () => ({ canceled: false, filePaths: [paths.openPath] });
        },
        { exportPath, openPath },
      );
      const result = await running().window.evaluate(async () => {
        const bridge = (globalThis as unknown as { controls: Bridge }).controls;
        const target = await bridge.showSaveAsDialog({ fileType: 'ctrl', suggestedName: 'Workshop' });
        const written = await bridge.writeSave({
          target: { kind: 'handle', handle: target?.handle },
          bytes: new Uint8Array([4, 5, 6]),
        });
        const writeOnly = await bridge.readSave({ handle: target?.handle }).then(
          () => 'accepted',
          (error: Error) => error.message,
        );
        const opened = await bridge.showOpenDialog({ fileType: 'ctrl' });
        const read = [...(await bridge.readSave({ handle: opened?.handle }))];
        const readOnly = await bridge
          .writeSave({ target: { kind: 'handle', handle: opened?.handle }, bytes: new Uint8Array([1]) })
          .then(
            () => 'accepted',
            (error: Error) => error.message,
          );
        return { target, written, writeOnly, opened, read, readOnly };
      });
      expect(result.target?.name).toBe('export.ctrl');
      expect(result.written).toMatchObject({ name: 'export.ctrl', kind: 'external', sizeBytes: 3 });
      expect([...readFileSync(`${exportPath}.ctrl`)]).toEqual([4, 5, 6]);
      expect(existsSync(exportPath)).toBe(false);
      expect(result.writeOnly).toContain('save:read refused (write-only).');
      expect(result.opened).toMatchObject({ name: 'shared.ctrl', kind: 'external' });
      expect(result.read).toEqual([9, 8, 7]);
      expect(result.readOnly).toContain('save:write refused (read-only).');
      expect([...readFileSync(openPath)]).toEqual([9, 8, 7]);
      expect(JSON.stringify(result)).not.toContain(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('saves a game from the menu and loads it back from the Load list (F1.8b part 3)', async () => {
    const { window } = running();
    const menu = window.getByRole('navigation', { name: 'Controls' });
    await newSandbox(window, 0);
    const saved = await hashAfter(window, PLACE);

    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Save game' }).click();
    await expect(window.getByRole('textbox', { name: 'Save name' })).toBeFocused();
    await window.keyboard.insertText('Desktop E2E'); // replaces the selected suggestion
    await window.keyboard.press('Enter');
    await expect(window.getByText('Saved “Desktop E2E”.')).toBeVisible();
    expect(readdirSync(join(profile, 'saves'))).toContain('Desktop E2E.ctrl');

    await newSandbox(window, 1);
    expect(await hashAfter(window)).not.toBe(saved);

    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Load' }).click();
    const load = window.getByRole('dialog', { name: 'Load game' });
    await load.getByRole('button', { name: 'Desktop E2E', exact: true }).click();
    await expect(load).toBeHidden();
    await expect(window.getByText('Loaded “Desktop E2E”.')).toBeVisible();
    expect(await hashAfter(window)).toBe(saved);
  });

  test('saves mid-sim with the bench lamp lit, loads it into another sandbox and runs on to the same hashes (P2)', async () => {
    test.slow(); // 2000 ticks of the filament model in the sim worker, on a CI runner
    const { window } = running();
    const menu = window.getByRole('navigation', { name: 'Controls' });
    const simTime = window.getByTestId('sim-time');
    await window.getByRole('button', { name: 'Menu' }).click();
    await newSandbox(window, 0);
    const { lit, out } = benchLampScenario();
    expect(await hashAfter(window, ...lit)).toBe(BENCH_LAMP_LIT_HASH);
    await expect(simTime).toHaveText('0:00:01.500');

    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Save game' }).click();
    await expect(window.getByRole('textbox', { name: 'Save name' })).toBeFocused();
    await window.keyboard.insertText('Bench lamp lit');
    await window.keyboard.press('Enter');
    await expect(window.getByText('Saved “Bench lamp lit”.')).toBeVisible();
    expect(readdirSync(join(profile, 'saves'))).toContain('Bench lamp lit.ctrl');

    // Another game in between, so the load has to replace a running sim worker and its world.
    await newSandbox(window, 1);
    expect(await hashAfter(window)).not.toBe(BENCH_LAMP_LIT_HASH);
    await expect(simTime).toHaveText('0:00:00.000');

    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Load' }).click();
    const load = window.getByRole('dialog', { name: 'Load game' });
    await load.getByRole('button', { name: 'Bench lamp lit', exact: true }).click();
    await expect(load).toBeHidden();
    await expect(window.getByText('Loaded “Bench lamp lit”.')).toBeVisible();
    // The save resumes where it was taken: mid-sim, lit, and on to the same dark hash as a straight run.
    expect(await hashAfter(window)).toBe(BENCH_LAMP_LIT_HASH);
    await expect(simTime).toHaveText('0:00:01.500');
    expect(await hashAfter(window, ...out)).toBe(BENCH_LAMP_HASH);
    await expect(simTime).toHaveText('0:00:02.000');
  });

  test('the Load list shows each save’s thumbnail and deletes a save after a confirmation (P4)', async () => {
    const { window } = running();
    const menu = window.getByRole('navigation', { name: 'Controls' });
    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Load' }).click();
    const load = window.getByRole('dialog', { name: 'Load game' });
    const row = load
      .getByTestId('load-row')
      .filter({ has: window.getByRole('button', { name: 'Desktop E2E', exact: true }) });
    // The viewport PNG saved with it, read from the ZIP by main and drawn from a blob: URL.
    await expect
      .poll(() =>
        row.getByTestId('load-thumbnail').evaluate((img) => {
          const { naturalWidth: w, naturalHeight: h } = img as HTMLImageElement;
          return w > 0 && w <= 320 && h > 0 && h <= 180; // at most 320 × 180, the viewport's aspect
        }),
      )
      .toBe(true);
    expect(await row.getByTestId('load-thumbnail').getAttribute('src')).toMatch(/^blob:app:\/\/game\//);

    await row.getByRole('button', { name: 'Delete Desktop E2E' }).click();
    const question = load.getByRole('group', { name: 'Delete “Desktop E2E”? This can’t be undone.' });
    await expect(question.getByRole('button', { name: 'Keep' })).toBeFocused();
    await question.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(window.getByText('Deleted “Desktop E2E”.')).toBeVisible();
    await expect(load.getByRole('button', { name: 'Desktop E2E', exact: true })).toHaveCount(0);
    expect(readdirSync(join(profile, 'saves'))).not.toContain('Desktop E2E.ctrl');
    expect(readdirSync(join(profile, 'saves'))).toContain('Bench lamp lit.ctrl');
    await window.keyboard.press('Escape');
    await expect(load).toBeHidden();
  });
});
