import { expect, test, type Page } from '@playwright/test';

/**
 * F1.8b part 2: the web harness stores saves in the origin-private file system (ADR 0009). This
 * drives `Platform.files` directly through the `?e2e=1` platform hook, on the real page (COOP/COEP,
 * crossOriginIsolated), and proves a save survives a reload. The bytes are the world document as
 * JSON: opaque to the store, and hashable on the way back. The game's own save and load UI (part 3)
 * is `load-ui.spec.ts`.
 */

interface Hooks {
  files: {
    list(): Promise<{ handle: string; name: string; kind: string; slot: number | null; sizeBytes: number }[]>;
    read(handle: string): Promise<Uint8Array>;
    write(
      target: unknown,
      bytes: Uint8Array,
    ): Promise<{ handle: string; name: string; kind: string; slot: number | null }>;
  };
}
interface SessionHook {
  hash(): string;
  world(): unknown;
  hashWorld(json: unknown): string | null;
}
type Scope = { __controlsPlatform: Hooks; __controlsSession: SessionHook };

async function open(page: Page): Promise<void> {
  await page.goto('/?e2e=1');
  await page.waitForFunction(() => '__controlsPlatform' in globalThis && '__controlsSession' in globalThis);
}

test('a save written to OPFS survives a reload and reads back to the same world hash', async ({ page }) => {
  await open(page);
  const written = await page.evaluate(async () => {
    const { __controlsPlatform: platform, __controlsSession: session } = globalThis as unknown as Scope;
    const bytes = new TextEncoder().encode(JSON.stringify(session.world()));
    const entry = await platform.files.write({ kind: 'manual', name: 'Workshop', overwrite: false }, bytes);
    return { entry, hash: session.hash(), isolated: globalThis.crossOriginIsolated };
  });
  expect(written.isolated).toBe(true);
  expect(written.entry).toMatchObject({ name: 'Workshop', kind: 'manual' });

  await page.reload();
  await open(page);
  const reread = await page.evaluate(async () => {
    const { __controlsPlatform: platform, __controlsSession: session } = globalThis as unknown as Scope;
    const listed = await platform.files.list();
    const bytes = await platform.files.read(listed[0]?.handle ?? '');
    return {
      listed: listed.map((e) => [e.name, e.kind]),
      hash: session.hashWorld(JSON.parse(new TextDecoder().decode(bytes))),
    };
  });
  expect(reread.listed).toEqual([['Workshop', 'manual']]);
  expect(reread.hash).toBe(written.hash);
});

test('the web store refuses forged handles and rotates autosave slots', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { files } = (globalThis as unknown as Scope).__controlsPlatform;
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: { code?: string }) => error.code ?? 'no code',
      );
    const slots: (number | null)[] = [];
    for (let i = 1; i <= 4; i++)
      slots.push((await files.write({ kind: 'autosave', slotCount: 2 }, new Uint8Array([i]))).slot);
    return {
      slots,
      listed: (await files.list()).map((e) => e.slot).sort(),
      forged: await codeOf(files.read('AAAAAAAAAAAAAAAAAAAAAA')),
      traversal: await codeOf(files.read('../../saves/Workshop.ctrl')),
      badName: await codeOf(files.write({ kind: 'manual', name: '../evil', overwrite: true }, new Uint8Array([1]))),
    };
  });
  expect(result).toEqual({
    slots: [1, 2, 1, 2],
    listed: [1, 2],
    forged: 'unknown-handle',
    traversal: 'invalid',
    badName: 'invalid',
  });
});
