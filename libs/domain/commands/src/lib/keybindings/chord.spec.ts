import fc from 'fast-check';
import {
  chordFromEvent,
  chordLabel,
  codeToKeyName,
  eventKeyName,
  formatChord,
  inputChordFromEvent,
  KEY_NAMES,
  keyNameToCode,
  type KeyEventLike,
  type KeyPlatform,
  MAX_CHORD_LENGTH,
  MODIFIERS,
  normaliseChord,
  splitChord,
} from './chord';

const ok = (source: string, platform: KeyPlatform = 'other') => {
  const result = normaliseChord(source, platform);
  if (!result.ok) throw new Error(`${source}: ${result.error}`);
  return result.chord;
};
const error = (source: string, platform: KeyPlatform = 'other') => {
  const result = normaliseChord(source, platform);
  if (result.ok) throw new Error(`${source} parsed as ${result.chord}`);
  return result.error;
};

const event = (init: Partial<KeyEventLike> & Pick<KeyEventLike, 'key' | 'code'>): KeyEventLike => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('normaliseChord', () => {
  it('orders modifiers canonically and accepts any case and aliases', () => {
    expect(ok('shift+mod+z')).toBe('Mod+Shift+Z');
    expect(ok(' Alt + Shift + Mod + p ')).toBe('Mod+Alt+Shift+P');
    expect(ok('CmdOrCtrl+K')).toBe('Mod+K');
    expect(ok('Option+F4')).toBe('Alt+F4');
    expect(ok('esc')).toBe('Escape');
    expect(ok('Up')).toBe('ArrowUp');
    expect(ok(']')).toBe('BracketRight');
    expect(ok('`')).toBe('Backquote');
    expect(ok('1')).toBe('1');
    expect(ok('numpad7')).toBe('Numpad7');
    expect(ok('shiftleft')).toBe('ShiftLeft');
  });

  it('folds the platform command key into Mod: Ctrl on Windows/Linux, Cmd on macOS', () => {
    expect(ok('Ctrl+K', 'other')).toBe('Mod+K');
    expect(ok('Control+K', 'other')).toBe('Mod+K');
    expect(ok('Meta+K', 'other')).toBe('Meta+K');
    expect(ok('Cmd+K', 'mac')).toBe('Mod+K');
    expect(ok('Ctrl+K', 'mac')).toBe('Ctrl+K');
    expect(ok('Ctrl+Cmd+K', 'mac')).toBe('Mod+Ctrl+K');
    expect(ok('Ctrl+Meta+K', 'other')).toBe('Mod+Meta+K');
    expect(error('Mod+Ctrl+K', 'other')).toMatch(/Mod already means Ctrl/);
    expect(error('Mod+Cmd+K', 'mac')).toMatch(/Mod already means Meta/);
  });

  it('rejects malformed chords with a reason', () => {
    expect(error('')).toMatch(/Empty/);
    expect(error('x'.repeat(MAX_CHORD_LENGTH + 1))).toMatch(/Longer/);
    expect(error('Mod+')).toMatch(/Missing key/);
    expect(error('Hyper+K')).toMatch(/Unknown modifier/);
    expect(error('Mod+Mod+K')).toMatch(/Repeated/);
    expect(error('Ctrl+Control+K')).toMatch(/Repeated/);
    expect(error('Mod+Banana')).toMatch(/Unknown key/);
    expect(error('Shift+ShiftLeft')).toMatch(/on its own/);
    expect(error('toString')).toMatch(/Unknown key/); // lookup tables use hasOwnProperty
    expect(error('constructor+K')).toMatch(/Unknown modifier/);
  });

  it('is idempotent: a canonical chord normalises to itself on its platform', () => {
    const modifiers = fc.subarray([...MODIFIERS]);
    const key = fc.constantFrom(...KEY_NAMES);
    fc.assert(
      fc.property(modifiers, key, fc.constantFrom<KeyPlatform>('mac', 'other'), (mods, k, platform) => {
        const first = normaliseChord([...mods, k].join('+'), platform);
        if (!first.ok) return; // e.g. Mod with the native key, or a modifier key with modifiers
        expect(ok(first.chord, platform)).toBe(first.chord);
        expect(ok(first.chord.toLowerCase(), platform)).toBe(first.chord);
      }),
    );
  });
});

describe('splitChord and formatChord', () => {
  it('round-trip canonical chords and refuse anything else', () => {
    const chord = splitChord('Mod+Shift+Z');
    expect(chord && formatChord(chord)).toBe('Mod+Shift+Z');
    expect(splitChord('Mod+Nope')).toBeUndefined();
    expect(splitChord('ctrl+Z')).toBeUndefined();
  });
});

describe('key names and codes', () => {
  it('maps names to KeyboardEvent.code and back', () => {
    expect(keyNameToCode('W')).toBe('KeyW');
    expect(keyNameToCode('1')).toBe('Digit1');
    expect(keyNameToCode('ArrowUp')).toBe('ArrowUp');
    expect(codeToKeyName('KeyW')).toBe('W');
    expect(codeToKeyName('Digit0')).toBe('0');
    expect(codeToKeyName('ShiftLeft')).toBe('ShiftLeft');
    expect(codeToKeyName('Lang1')).toBeNull();
    for (const name of KEY_NAMES) expect(codeToKeyName(keyNameToCode(name))).toBe(name);
  });
});

describe('eventKeyName', () => {
  it('matches letters by the typed character on Latin layouts', () => {
    expect(eventKeyName({ key: 'z', code: 'KeyZ' })).toBe('Z');
    expect(eventKeyName({ key: 'Z', code: 'KeyZ' })).toBe('Z'); // Shift held
    expect(eventKeyName({ key: 'z', code: 'KeyW' })).toBe('Z'); // AZERTY: Z sits where QWERTY has W
    expect(eventKeyName({ key: 'm', code: 'Semicolon' })).toBe('M'); // AZERTY M
  });

  it('falls back to the physical letter when the key types no ASCII character', () => {
    expect(eventKeyName({ key: 'я', code: 'KeyZ' })).toBe('Z'); // Cyrillic
    expect(eventKeyName({ key: 'Ω', code: 'KeyZ' })).toBe('Z'); // macOS Option
    expect(eventKeyName({ key: 'Dead', code: 'KeyU' })).toBe('U');
    expect(eventKeyName({ key: 'ı', code: 'KeyI' })).toBe('I'); // Turkish dotless i is not ASCII
  });

  it('uses punctuation a letter position types (Dvorak), or nothing if outside the grammar', () => {
    expect(eventKeyName({ key: "'", code: 'KeyQ' })).toBe('Quote');
    expect(eventKeyName({ key: '!', code: 'KeyQ' })).toBeNull();
  });

  it('is positional for digits and everything else', () => {
    expect(eventKeyName({ key: '!', code: 'Digit1' })).toBe('1');
    expect(eventKeyName({ key: '&', code: 'Digit1' })).toBe('1'); // AZERTY top row
    expect(eventKeyName({ key: 'Enter', code: 'Enter' })).toBe('Enter');
    expect(eventKeyName({ key: '+', code: 'BracketRight' })).toBe('BracketRight');
    expect(eventKeyName({ key: 'Unidentified', code: '' })).toBeNull();
  });
});

describe('chordFromEvent', () => {
  it('maps Ctrl to Mod off macOS and Cmd to Mod on macOS', () => {
    expect(chordFromEvent(event({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'other')).toBe('Mod+Z');
    expect(chordFromEvent(event({ key: 'z', code: 'KeyZ', metaKey: true }), 'other')).toBe('Meta+Z');
    expect(chordFromEvent(event({ key: 'z', code: 'KeyZ', metaKey: true }), 'mac')).toBe('Mod+Z');
    expect(chordFromEvent(event({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'mac')).toBe('Ctrl+Z');
    expect(
      chordFromEvent(event({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true, altKey: true }), 'other'),
    ).toBe('Mod+Alt+Shift+Z');
  });

  it('ignores bare modifier keys and keys outside the grammar', () => {
    expect(chordFromEvent(event({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'other')).toBeNull();
    expect(chordFromEvent(event({ key: 'Unidentified', code: 'Lang1' }), 'other')).toBeNull();
  });

  it('produces chords that normalise to themselves', () => {
    const chord = chordFromEvent(event({ key: '1', code: 'Digit1', ctrlKey: true, metaKey: true }), 'mac');
    expect(chord).toBe('Mod+Ctrl+1');
    expect(ok(chord as string, 'mac')).toBe(chord);
  });
});

describe('inputChordFromEvent', () => {
  it('is positional and bare, and accepts modifier keys', () => {
    expect(inputChordFromEvent({ code: 'KeyW' })).toBe('W');
    expect(inputChordFromEvent({ code: 'ShiftRight' })).toBe('ShiftRight');
    expect(inputChordFromEvent({ code: 'Lang1' })).toBeNull();
  });
});

describe('chordLabel', () => {
  it('names modifiers for the platform', () => {
    expect(chordLabel('Mod+Shift+Z', 'other')).toBe('Ctrl+Shift+Z');
    expect(chordLabel('Mod+Alt+Z', 'mac')).toBe('Cmd+Option+Z');
    expect(chordLabel('Meta+K', 'other')).toBe('Meta+K');
    expect(chordLabel('Ctrl+K', 'mac')).toBe('Ctrl+K');
    expect(chordLabel('BracketRight', 'other')).toBe(']');
    expect(chordLabel('ShiftLeft', 'other')).toBe('Left Shift');
    expect(chordLabel('Escape', 'mac')).toBe('Esc');
    expect(chordLabel('not a chord', 'other')).toBe('not a chord');
  });
});
