import fc from 'fast-check';
import { assertNoNegativeZero, rawSettingsV1Arb } from '../../testing/arbitraries';
import { CURRENT_SETTINGS_VERSION, defaultSettings, loadSettings, migrateSettings } from '../documents';
import { MAX_CONSOLE_HISTORY, MAX_PALETTE_RECENTS, SettingsV1, TOOL_BELT_SLOTS } from './v1';

const valid = (patch: (s: ReturnType<typeof defaultSettings>) => void) => {
  const settings = defaultSettings();
  patch(settings);
  return SettingsV1.safeParse(settings).success;
};

describe('SettingsV1', () => {
  it('defaultSettings() is valid, current and a fresh object each call', () => {
    const a = defaultSettings();
    expect(SettingsV1.parse(a)).toStrictEqual(a);
    expect(a.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    a.console.history.push('mutated');
    expect(defaultSettings().console.history).toStrictEqual([]);
  });

  it('defaults: imperial, system theme, NEC, apprentice, three built-in props on the tool belt', () => {
    const s = defaultSettings();
    expect(s.display).toStrictEqual({ units: 'imperial', theme: 'system', reducedMotion: 'system' });
    expect(s.gameplay).toStrictEqual({ defaultDifficulty: 'apprentice', region: 'nec' });
    expect(s.toolBelt.slots).toHaveLength(TOOL_BELT_SLOTS);
    expect(s.toolBelt.slots.slice(0, 3).map((slot) => slot?.id)).toStrictEqual([
      'prop.box',
      'prop.crate',
      'prop.spool',
    ]);
  });

  it('accepts overrides, including an explicit unbind', () => {
    expect(
      valid((s) => {
        s.controls.keybindings = { 'palette.open': 'Mod+K', 'edit.redo': null };
        s.workspace.layout = { panels: [{ id: 'inspector', size: 0.25 }] };
        s.palette.recents = ['entity.place', 'edit.undo'];
      }),
    ).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(valid((s) => (s.audio.master = 1.01))).toBe(false);
    expect(valid((s) => (s.graphics.pixelRatioCap = 0.25))).toBe(false);
    expect(valid((s) => (s.controls.lookSensitivity = Number.NaN))).toBe(false);
    expect(valid((s) => (s.autosave.slotCount = 0))).toBe(false);
    expect(valid((s) => (s.autosave.intervalSeconds = 30))).toBe(false);
    expect(valid((s) => (s.controls.keybindings = { 'palette.open': '' }))).toBe(false);
    expect(valid((s) => (s.controls.keybindings = { Palette: 'Mod+K' }))).toBe(false);
  });

  it('caps palette recents and console history, and refuses repeated recents', () => {
    expect(valid((s) => (s.palette.recents = ['edit.undo', 'edit.undo']))).toBe(false);
    expect(
      valid((s) => (s.palette.recents = Array.from({ length: MAX_PALETTE_RECENTS + 1 }, (_, i) => `cmd.n${i}`))),
    ).toBe(false);
    expect(valid((s) => (s.console.history = Array.from({ length: MAX_CONSOLE_HISTORY }, () => 'help')))).toBe(true);
    expect(valid((s) => (s.console.history = Array.from({ length: MAX_CONSOLE_HISTORY + 1 }, () => 'help')))).toBe(
      false,
    );
  });

  it('the tool belt has exactly nine slots', () => {
    expect(valid((s) => s.toolBelt.slots.pop())).toBe(false);
    expect(valid((s) => s.toolBelt.slots.push(null))).toBe(false);
  });

  it('loadSettings falls back to defaults with an error for corrupt, foreign or newer files', () => {
    expect(loadSettings(defaultSettings())).toStrictEqual({ settings: defaultSettings(), error: null });
    for (const [input, kind] of [
      [undefined, 'not-an-object'],
      ['{', 'not-an-object'],
      [{ settingsVersion: 99 }, 'newer-than-build'],
      [{ ...defaultSettings(), audio: null }, 'invalid'],
    ] as const) {
      const { settings, error } = loadSettings(input);
      expect(settings).toStrictEqual(defaultSettings());
      expect(error?.kind).toBe(kind);
    }
  });

  it('round-trips any valid settings document losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawSettingsV1Arb, (raw) => {
        const parsed = SettingsV1.parse(raw);
        assertNoNegativeZero(parsed);
        const text = JSON.stringify(parsed);
        expect(SettingsV1.parse(JSON.parse(text))).toStrictEqual(parsed);
        expect(migrateSettings(JSON.parse(text))).toStrictEqual({ ok: true, value: parsed, fromVersion: 1 });
      }),
      { numRuns: 50 },
    );
  });
});
