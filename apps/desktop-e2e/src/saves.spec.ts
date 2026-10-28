import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, launchControls, removeProfile, type LaunchedControls } from './launch';

/**
 * F1.8b: save I/O over the real bridge, against the real main process and file system (ADR 0009,
 * part 2), and saving and loading a game through the UI (part 3). One launch for the file, so it
 * also runs against a packaged build (the release smoke procedure); the dialog test stubs
 * Electron's `dialog` through the Node inspector, so it runs on the dev build only.
 */

const PLACE =
  'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200';

/** New sandbox from the main menu with `seed`, keyboard only once the dialog is open. */
async function newSandbox(window: Page, seed: number): Promise<void> {
  await window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'New sandbox' }).click();
  await expect(window.getByRole('textbox', { name: 'Seed' })).toBeFocused();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(String(seed));
  await window.keyboard.press('Enter');
  await expect(window.locator('ctl-viewport canvas')).toBeFocused();
}

/**
 * Runs console lines and returns `world.hash` after them. The console is the way into the world here:
 * the desktop app has no test hook. Leaves focus in the console.
 */
async function hashAfter(window: Page, ...lines: string[]): Promise<string> {
  await expect(window.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  const input = window.getByRole('textbox', { name: 'Console input' });
  if (!(await input.evaluate((el) => el.contains(el.ownerDocument.activeElement)))) {
    await window.keyboard.press('Backquote');
  }
  await expect(input).toBeFocused();
  const entries = window.getByTestId('console-output').locator('.entry');
  for (const line of lines) {
    await window.keyboard.insertText(line);
    await window.keyboard.press('Enter');
  }
  const before = await entries.count();
  await window.keyboard.insertText('world.hash');
  await window.keyboard.press('Enter');
  await expect.poll(() => entries.count()).toBeGreaterThan(before);
  await expect(entries.last()).toHaveText(/^[0-9a-f]{64}$/);
  return (await entries.last().textContent()) ?? '';
}

interface Bridge {
  listSaves(): Promise<{ handle: string; name: string; kind: string; slot: number | null; sizeBytes: number }[]>;
  readSave(request: unknown): Promise<Uint8Array>;
  writeSave(
    request: unknown,
  ): Promise<{ handle: string; name: string; kind: string; slot: number | null; sizeBytes: number }>;
  showOpenDialog(request: unknown): Promise<{ handle: string; name: string; kind: string } | null>;
  showSaveAsDialog(request: unknown): Promise<{ handle: string; name: string } | null>;
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
});
