import { defaultSettings, MAX_PALETTE_RECENTS, type LoadError } from '@controls/save-format';
import {
  checkSettingsForWrite,
  fallbackReasonFor,
  MAX_SETTINGS_JSON_LENGTH,
  parseStoredSettings,
  serialiseSettings,
  SettingsGetResponseSchema,
} from './settings';

describe('parseStoredSettings', () => {
  it('returns defaults with "missing" when nothing is stored', () => {
    expect(parseStoredSettings(null)).toEqual({ settings: defaultSettings(), fallbackReason: 'missing' });
  });

  it('round-trips serialised settings', () => {
    const settings = {
      ...defaultSettings(),
      gameplay: { defaultDifficulty: 'realistic' as const, region: 'nec' as const },
    };
    expect(parseStoredSettings(serialiseSettings(settings))).toEqual({ settings, fallbackReason: null });
  });

  it.each([
    ['broken JSON', '{', 'corrupt'],
    ['an oversized text', ' '.repeat(MAX_SETTINGS_JSON_LENGTH + 1), 'corrupt'],
    ['a JSON array', '[]', 'corrupt'],
    ['a document with no version', '{}', 'unknown-version'],
    ['a newer version', JSON.stringify({ ...defaultSettings(), settingsVersion: 2 }), 'unknown-version'],
    [
      'too many palette recents',
      JSON.stringify({
        ...defaultSettings(),
        palette: { recents: Array.from({ length: MAX_PALETTE_RECENTS + 1 }, (_, i) => `view.cmd${i}`) },
      }),
      'corrupt',
    ],
  ])('falls back to defaults for %s', (_name, text, reason) => {
    expect(parseStoredSettings(text)).toEqual({ settings: defaultSettings(), fallbackReason: reason });
  });
});

describe('fallbackReasonFor', () => {
  it('maps version problems to unknown-version and the rest to corrupt', () => {
    const base = { document: 'settings', message: 'x' };
    const reason = (error: object) => fallbackReasonFor({ ...base, ...error } as LoadError);
    expect(reason({ kind: 'newer-than-build', found: 2, supported: 1 })).toBe('unknown-version');
    expect(reason({ kind: 'unsupported-version', found: 0, oldest: 1 })).toBe('unknown-version');
    expect(reason({ kind: 'missing-version', versionKey: 'settingsVersion' })).toBe('unknown-version');
    expect(reason({ kind: 'invalid', version: 1, issues: [] })).toBe('corrupt');
    expect(reason({ kind: 'too-deep', limit: 64 })).toBe('corrupt');
  });
});

describe('checkSettingsForWrite', () => {
  it('accepts a current document and returns its canonical JSON', () => {
    const result = checkSettingsForWrite(defaultSettings());
    expect(result).toEqual({ ok: true, settings: defaultSettings(), json: serialiseSettings(defaultSettings()) });
  });

  it('refuses invalid, oversized and unserialisable input with a reason only', () => {
    expect(checkSettingsForWrite({ ...defaultSettings(), workspace: {} })).toEqual({ ok: false, reason: 'invalid' });
    expect(checkSettingsForWrite(() => 1)).toEqual({ ok: false, reason: 'not-serialisable' });
    expect(checkSettingsForWrite(BigInt(1))).toEqual({ ok: false, reason: 'not-serialisable' });
    expect(
      checkSettingsForWrite({ ...defaultSettings(), extensions: { pad: 'x'.repeat(MAX_SETTINGS_JSON_LENGTH) } }),
    ).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('SettingsGetResponseSchema', () => {
  it('requires both fields and a known reason', () => {
    expect(SettingsGetResponseSchema.safeParse({ settings: {}, fallbackReason: null }).success).toBe(true);
    expect(SettingsGetResponseSchema.safeParse({ settings: {}, fallbackReason: 'gone' }).success).toBe(false);
    expect(SettingsGetResponseSchema.safeParse({ settings: {} }).success).toBe(false);
  });
});
