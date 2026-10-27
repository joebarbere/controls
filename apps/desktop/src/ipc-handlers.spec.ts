import { MAX_SETTINGS_JSON_LENGTH, serialiseSettings, type SettingsLoadResult } from '@controls/ipc-contract';
import { defaultSettings, MAX_CONSOLE_HISTORY } from '@controls/save-format';
import { assertTrustedSender, createIpcHandlers } from './ipc-handlers';

const trusted = { senderFrame: { url: 'app://game/index.html' } };
const untrusted = [
  { senderFrame: { url: 'https://evil.example/' } },
  { senderFrame: { url: 'app://gamex/index.html' } },
  { senderFrame: { url: 'file:///etc/passwd' } },
  { senderFrame: null },
  {},
];

function setup() {
  const loaded: SettingsLoadResult = { settings: defaultSettings(), fallbackReason: null };
  const settingsFile = { read: vi.fn(async () => loaded), write: vi.fn(async (_json: string) => undefined) };
  const quit = vi.fn();
  return { handlers: createIpcHandlers({ settingsFile, quit }), settingsFile, quit, loaded };
}

describe('assertTrustedSender', () => {
  it('accepts only the app:// origin', () => {
    expect(() => assertTrustedSender(trusted)).not.toThrow();
    for (const event of untrusted) expect(() => assertTrustedSender(event)).toThrow(/untrusted origin/);
  });
});

describe('IPC handlers', () => {
  it('settings:get returns the file result to a trusted sender only', async () => {
    const { handlers, settingsFile, loaded } = setup();
    await expect(handlers.getSettings(trusted)).resolves.toBe(loaded);
    for (const event of untrusted) await expect(handlers.getSettings(event)).rejects.toThrow();
    expect(settingsFile.read).toHaveBeenCalledOnce();
  });

  it('settings:set writes canonical JSON for a valid current document', async () => {
    const { handlers, settingsFile } = setup();
    const settings = { ...defaultSettings(), graphics: { backend: 'webgl2' as const, pixelRatioCap: 1.5 } };
    await handlers.setSettings(trusted, settings);
    expect(settingsFile.write).toHaveBeenCalledWith(serialiseSettings(settings));
  });

  it.each([
    ['an invalid document', { ...defaultSettings(), audio: { master: 2 } }, 'invalid'],
    ['a newer version', { ...defaultSettings(), settingsVersion: 2 }, 'invalid'],
    ['a non-object', 'settings please', 'invalid'],
    ['an over-cap console history', overCapHistory(), 'invalid'],
    [
      'an oversized payload',
      { ...defaultSettings(), extensions: { pad: 'x'.repeat(MAX_SETTINGS_JSON_LENGTH) } },
      'too-large',
    ],
    ['a cyclic object', cyclic(), 'not-serialisable'],
    ['undefined', undefined, 'not-serialisable'],
  ])('settings:set refuses %s without echoing it, and writes nothing', async (_name, payload, reason) => {
    const { handlers, settingsFile } = setup();
    const error = await handlers.setSettings(trusted, payload).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`settings:set refused (${reason}).`);
    expect(settingsFile.write).not.toHaveBeenCalled();
  });

  it('settings:set refuses a "__proto__" key smuggled in through structured clone', async () => {
    const { handlers, settingsFile } = setup();
    const payload = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(defaultSettings()).slice(1)}`);
    await expect(handlers.setSettings(trusted, payload)).rejects.toThrow('refused (invalid)');
    expect(settingsFile.write).not.toHaveBeenCalled();
  });

  it('settings:set and app:quit refuse untrusted senders', async () => {
    const { handlers, settingsFile, quit } = setup();
    for (const event of untrusted) {
      await expect(handlers.setSettings(event, defaultSettings())).rejects.toThrow(/untrusted/);
      expect(() => handlers.quit(event)).toThrow(/untrusted/);
    }
    expect(settingsFile.write).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    handlers.quit(trusted);
    expect(quit).toHaveBeenCalledOnce();
  });
});

function overCapHistory() {
  const s = defaultSettings();
  return { ...s, console: { history: Array.from({ length: MAX_CONSOLE_HISTORY + 1 }, () => 'help') } };
}

function cyclic() {
  const o: Record<string, unknown> = { ...defaultSettings() };
  o['self'] = o;
  return o;
}
