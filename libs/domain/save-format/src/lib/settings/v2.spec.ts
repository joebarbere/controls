import fc from 'fast-check';
import { assertNoNegativeZero, rawSettingsV1Arb, rawSettingsV2Arb } from '../../testing/arbitraries';
import { CURRENT_SETTINGS_VERSION, defaultSettings, loadSettings, migrateSettings } from '../documents';
import { defaultSettingsV1 } from './v1';
import { defaultSettingsV2, LastPlayedSave, settingsV1ToV2, SettingsV2 } from './v2';

const valid = (patch: (s: SettingsV2) => void) => {
  const settings = defaultSettingsV2();
  patch(settings);
  return SettingsV2.safeParse(settings).success;
};

/** Deep-freezes a value, so a migration that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('SettingsV2', () => {
  it('defaultSettings() is v2, valid, has no last-played save and is a fresh object each call', () => {
    const a = defaultSettings();
    expect(SettingsV2.parse(a)).toStrictEqual(a);
    expect(a.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(CURRENT_SETTINGS_VERSION).toBe(2);
    expect(a.saves).toStrictEqual({ lastPlayed: null });
    a.console.history.push('mutated');
    expect(defaultSettings().console.history).toStrictEqual([]);
  });

  it('a last-played save is a manual save by name or an autosave slot, never a handle or a path', () => {
    expect(valid((s) => (s.saves.lastPlayed = { kind: 'manual', name: 'Shop' }))).toBe(true);
    expect(valid((s) => (s.saves.lastPlayed = { kind: 'autosave', slot: 10 }))).toBe(true);
    expect(LastPlayedSave.safeParse({ kind: 'autosave', slot: 0 }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'autosave', slot: 11 }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'manual', name: '' }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'manual', name: 'x'.repeat(256) }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'manual', name: '\ud800' }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'external', handle: 'AAAAAAAAAAAAAAAAAAAAAA' }).success).toBe(false);
    expect(LastPlayedSave.safeParse({ kind: 'manual', name: 'Shop', slot: 1 }).success).toBe(false);
  });

  it('migrates v1 → v2 purely and deterministically, adding no last-played save', () => {
    const v1 = deepFreeze(defaultSettingsV1());
    const once = settingsV1ToV2(v1);
    expect(once).toStrictEqual(settingsV1ToV2(v1));
    expect(once).toStrictEqual(defaultSettings());
    expect(migrateSettings(v1)).toStrictEqual({ ok: true, value: defaultSettings(), fromVersion: 1 });
  });

  it('loadSettings falls back to defaults with an error for corrupt, foreign or newer files', () => {
    expect(loadSettings(defaultSettings())).toStrictEqual({ settings: defaultSettings(), error: null });
    for (const [input, kind] of [
      [undefined, 'not-an-object'],
      ['{', 'not-an-object'],
      [{ settingsVersion: 99 }, 'newer-than-build'],
      [{ ...defaultSettings(), audio: null }, 'invalid'],
      [{ ...defaultSettings(), saves: { lastPlayed: { kind: 'autosave', slot: 99 } } }, 'invalid'],
      [{ ...defaultSettingsV1(), saves: { lastPlayed: null } }, 'invalid'], // v1 has no `saves`
    ] as const) {
      const { settings, error } = loadSettings(input);
      expect(settings).toStrictEqual(defaultSettings());
      expect(error?.kind).toBe(kind);
    }
  });

  it('round-trips any valid v2 document losslessly through JSON, and migrates any v1 one (property)', () => {
    fc.assert(
      fc.property(rawSettingsV2Arb, (raw) => {
        const parsed = SettingsV2.parse(raw);
        assertNoNegativeZero(parsed);
        const text = JSON.stringify(parsed);
        expect(migrateSettings(JSON.parse(text))).toStrictEqual({ ok: true, value: parsed, fromVersion: 2 });
      }),
      { numRuns: 50 },
    );
    fc.assert(
      fc.property(rawSettingsV1Arb, (raw) => {
        const migrated = migrateSettings(JSON.parse(JSON.stringify(raw)));
        expect(migrated.ok && migrated.value.saves).toStrictEqual({ lastPlayed: null });
      }),
      { numRuns: 25 },
    );
  });
});
