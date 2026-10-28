import { MAX_SAVE_BYTES } from '@controls/ipc-contract';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaveHandleTable } from './save-handles';
import { createSaveHandlers, type SaveDialogs, type SaveIpcEvent } from './save-handlers';
import { SaveStore } from './save-store';

const window1: SaveIpcEvent = { senderFrame: { url: 'app://game/index.html' }, sender: { id: 1 } };
const window2: SaveIpcEvent = { senderFrame: { url: 'app://game/index.html' }, sender: { id: 2 } };
const untrusted: SaveIpcEvent[] = [
  { senderFrame: { url: 'https://evil.example/' }, sender: { id: 1 } },
  { senderFrame: { url: 'app://gamex/index.html' }, sender: { id: 1 } },
  { senderFrame: { url: 'file:///etc/passwd' }, sender: { id: 1 } },
  { senderFrame: null, sender: { id: 1 } },
];
const bytes = (...values: number[]) => new Uint8Array(values);
const SECRET = 'do-not-echo';

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controls-save-ipc-'));
  root = join(dir, 'saves');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(dialogs: Partial<SaveDialogs> = {}, store = new SaveStore(join(dir, 'saves'))) {
  const log = vi.fn();
  const handlers = createSaveHandlers({
    store,
    handles: new SaveHandleTable(),
    dialogs: { showOpen: async () => null, showSaveAs: async () => null, ...dialogs },
    log,
  });
  return { handlers, log };
}

const messageOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message,
  );

describe('save handlers: sender checks', () => {
  it('refuses every channel from an untrusted sender, before touching the payload', async () => {
    const { handlers } = setup({ showOpen: vi.fn(), showSaveAs: vi.fn() });
    for (const event of untrusted) {
      const calls = [
        handlers.list(event),
        handlers.read(event, { handle: SECRET }),
        handlers.write(event, { target: { kind: 'manual', name: 'A', overwrite: false }, bytes: bytes(1) }),
        handlers.dialogOpen(event, { fileType: 'ctrl' }),
        handlers.dialogSaveAs(event, { fileType: 'ctrl', suggestedName: 'A' }),
      ];
      for (const call of calls) expect(await messageOf(call)).toMatch(/untrusted origin/);
    }
    await expect(fsp.readdir(dir)).resolves.toEqual([]); // nothing was created
  });
});

describe('save handlers: validation', () => {
  it.each([
    ['save:list', (h: ReturnType<typeof setup>['handlers']) => h.list(window1, { path: SECRET })],
    ['save:read', (h: ReturnType<typeof setup>['handlers']) => h.read(window1, { handle: `../${SECRET}` })],
    [
      'save:write',
      (h: ReturnType<typeof setup>['handlers']) =>
        h.write(window1, { target: { kind: 'manual', name: `../${SECRET}`, overwrite: true }, bytes: bytes(1) }),
    ],
    [
      'save:write',
      (h: ReturnType<typeof setup>['handlers']) =>
        h.write(window1, { target: { kind: 'path', path: `/tmp/${SECRET}` }, bytes: bytes(1) }),
    ],
    ['dialog:open', (h: ReturnType<typeof setup>['handlers']) => h.dialogOpen(window1, { fileType: SECRET })],
    [
      'dialog:saveAs',
      (h: ReturnType<typeof setup>['handlers']) =>
        h.dialogSaveAs(window1, { fileType: 'ctrl', suggestedName: `/${SECRET}` }),
    ],
  ])('%s refuses a malformed payload as invalid, without echoing it', async (channel, call) => {
    const { handlers } = setup();
    expect(await messageOf(call(handlers))).toBe(`${channel} refused (invalid).`);
  });

  it('refuses oversized bytes as too-large and writes nothing', async () => {
    const { handlers } = setup();
    const payload = {
      target: { kind: 'manual', name: 'Big', overwrite: false },
      bytes: new Uint8Array(MAX_SAVE_BYTES + 1),
    };
    expect(await messageOf(handlers.write(window1, payload))).toBe('save:write refused (too-large).');
    await expect(handlers.list(window1)).resolves.toEqual([]);
  });
});

describe('save handlers: handles', () => {
  it('a handle from another window is unknown, as is a forged one', async () => {
    const { handlers } = setup();
    const entry = await handlers.write(window1, {
      target: { kind: 'manual', name: 'Shop', overwrite: false },
      bytes: bytes(1),
    });
    await expect(handlers.read(window1, { handle: entry.handle })).resolves.toEqual(bytes(1));
    expect(await messageOf(handlers.read(window2, { handle: entry.handle }))).toBe(
      'save:read refused (unknown-handle).',
    );
    expect(
      await messageOf(handlers.write(window2, { target: { kind: 'handle', handle: entry.handle }, bytes: bytes(2) })),
    ).toBe('save:write refused (unknown-handle).');
    expect(await messageOf(handlers.read(window1, { handle: 'AAAAAAAAAAAAAAAAAAAAAA' }))).toBe(
      'save:read refused (unknown-handle).',
    );
    // window2 gets its own handle for the same save by listing.
    const [listed] = await handlers.list(window2);
    expect(listed?.handle).not.toBe(entry.handle);
    await expect(handlers.read(window2, { handle: listed?.handle })).resolves.toEqual(bytes(1));
  });

  it('a file-system error is reported as io, with only its errno code logged', async () => {
    const store = new SaveStore(root, {
      ...fsp,
      rename: async () =>
        Promise.reject(Object.assign(new Error(`EACCES: permission denied, '${root}/${SECRET}'`), { code: 'EACCES' })),
    });
    const { handlers, log } = setup({}, store);
    const message = await messageOf(
      handlers.write(window1, { target: { kind: 'manual', name: 'Shop', overwrite: false }, bytes: bytes(1) }),
    );
    expect(message).toBe('save:write refused (io).');
    expect(log).toHaveBeenCalledWith('save:write failed (EACCES).');
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});

describe('save handlers: dialogs', () => {
  it('opens one dialog per window at a time', async () => {
    let release: (path: string | null) => void = () => undefined;
    const showOpen = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    const { handlers } = setup({ showOpen });
    const first = handlers.dialogOpen(window1, { fileType: 'ctrl' });
    await vi.waitFor(() => expect(showOpen).toHaveBeenCalledOnce());
    expect(await messageOf(handlers.dialogOpen(window1, { fileType: 'ctrl' }))).toBe('dialog:open refused (busy).');
    expect(await messageOf(handlers.dialogSaveAs(window1, { fileType: 'ctrl', suggestedName: 'A' }))).toBe(
      'dialog:saveAs refused (busy).',
    );
    release(null);
    await expect(first).resolves.toBeNull();
    // Free again once the first one closed.
    const again = handlers.dialogOpen(window1, { fileType: 'ctrl' });
    await vi.waitFor(() => expect(showOpen).toHaveBeenCalledTimes(2));
    release(null);
    await expect(again).resolves.toBeNull();
  });

  it('opens in the save directory, suggests <name>.ctrl, and returns no path', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'mine.ctrl'), 'abc');
    const showOpen = vi.fn(async () => join(outside, 'mine.ctrl'));
    const showSaveAs = vi.fn(async () => join(outside, 'out'));
    const { handlers } = setup({ showOpen, showSaveAs });
    const opened = await handlers.dialogOpen(window1, { fileType: 'ctrl' });
    expect(showOpen).toHaveBeenCalledWith(window1, { defaultPath: root });
    expect(opened).toMatchObject({ name: 'mine.ctrl', kind: 'external', sizeBytes: 3 });
    const target = await handlers.dialogSaveAs(window1, { fileType: 'ctrl', suggestedName: 'Shop' });
    expect(showSaveAs).toHaveBeenCalledWith(window1, { defaultPath: join(root, 'Shop.ctrl') });
    expect(target).toEqual({ handle: expect.any(String), name: 'out.ctrl' });
    expect(JSON.stringify([opened, target])).not.toContain(dir);
  });
});
