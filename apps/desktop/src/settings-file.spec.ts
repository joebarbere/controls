import { serialiseSettings } from '@controls/ipc-contract';
import { defaultSettings } from '@controls/save-format';
import * as fsp from 'node:fs/promises';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsFile, writeFileAtomic, type SettingsFs } from './settings-file';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controls-settings-'));
  path = join(dir, 'settings.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Real fs, except that the file handle's `sync` (or `rename`) fails: a crash midway through a write. */
function failingFs(step: 'sync' | 'rename'): SettingsFs {
  return {
    ...fsp,
    rename: step === 'rename' ? async () => Promise.reject(new Error('rename failed')) : fsp.rename,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      const handle = await fsp.open(...args);
      if (step === 'sync') handle.sync = async () => Promise.reject(new Error('EIO: fsync failed'));
      return handle;
    }) as typeof fsp.open,
  };
}

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp files behind', async () => {
    await writeFileAtomic(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('creates the directory if needed', async () => {
    const nested = join(dir, 'a', 'b', 'settings.json');
    await writeFileAtomic(nested, 'x');
    expect(readFileSync(nested, 'utf8')).toBe('x');
  });

  it.each(['sync', 'rename'] as const)(
    'a write that fails at %s leaves the old file intact and cleans up',
    async (step) => {
      writeFileSync(path, 'old contents');
      await expect(writeFileAtomic(path, 'new contents', failingFs(step))).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe('old contents');
      expect(readdirSync(dir)).toEqual(['settings.json']);
    },
  );
});

describe('SettingsFile', () => {
  it('reports missing (no warning) on first run', async () => {
    await expect(new SettingsFile(path).read()).resolves.toEqual({
      settings: defaultSettings(),
      fallbackReason: 'missing',
    });
  });

  it('round-trips a written document', async () => {
    const file = new SettingsFile(path);
    const settings = {
      ...defaultSettings(),
      display: { units: 'metric', theme: 'dark', reducedMotion: 'reduce' },
    } as const;
    await file.write(serialiseSettings(settings));
    await expect(file.read()).resolves.toEqual({ settings, fallbackReason: null });
  });

  it.each([
    ['not JSON', '{ nope', 'corrupt'],
    ['a foreign document', JSON.stringify({ hello: 'world' }), 'unknown-version'],
    ['an invalid field', JSON.stringify({ ...defaultSettings(), audio: { master: 7 } }), 'corrupt'],
    ['a newer settingsVersion', JSON.stringify({ ...defaultSettings(), settingsVersion: 99 }), 'unknown-version'],
  ])('falls back to defaults for %s', async (_name, text, reason) => {
    writeFileSync(path, text);
    await expect(new SettingsFile(path).read()).resolves.toEqual({
      settings: defaultSettings(),
      fallbackReason: reason,
    });
  });

  it('treats an unreadable path as corrupt', async () => {
    await fsp.mkdir(path); // a directory where the file should be
    await expect(new SettingsFile(path).read()).resolves.toMatchObject({ fallbackReason: 'corrupt' });
  });

  it('refuses an oversized file without reading it', async () => {
    writeFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1));
    const readFile = vi.fn(fsp.readFile);
    await expect(
      new SettingsFile(path, { ...fsp, readFile: readFile as unknown as typeof fsp.readFile }).read(),
    ).resolves.toMatchObject({
      fallbackReason: 'corrupt',
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('serialises writes so the last call wins, and a failed write does not block later ones', async () => {
    const file = new SettingsFile(path);
    const first = file.write('1');
    const second = file.write('2');
    await Promise.all([first, second]);
    expect(readFileSync(path, 'utf8')).toBe('2');

    const flaky = new SettingsFile(path, failingFs('rename'));
    await expect(flaky.write('3')).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('2');
  });
});
