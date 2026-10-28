/*
 * Key chords (plan F1.4, ADR 0006 "Keybindings"). A chord is zero or more modifiers and exactly one
 * key, joined with `+`: `Mod+Shift+Z`, `Alt+F4`, `1`, `ShiftLeft`.
 *
 *   chord    := ( modifier '+' )* key
 *   modifier := Mod | Ctrl | Meta | Alt | Shift       (case-insensitive; aliases below)
 *   key      := a key name (case-insensitive; aliases below)
 *
 * `Mod` is the platform's command modifier: Ctrl on Windows and Linux, Cmd (Meta) on macOS. The
 * **canonical form** is platform-relative and is what settings store and what a key event resolves
 * to: modifiers in the order `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, then the key's canonical name,
 * with the platform's own command key folded into `Mod` (so `Ctrl+K` is `Mod+K` on Linux, and
 * `Cmd+K` is `Mod+K` on macOS). A canonical chord therefore never contains both `Mod` and the key it
 * stands for. No `eval`, no regex built from user text.
 *
 * Key names follow `KeyboardEvent.code` (positional), except that the `Key` and `Digit` prefixes
 * are dropped (`KeyW` → `W`, `Digit1` → `1`). Command chords match letters by the character they
 * type on Latin layouts (see {@link chordFromEvent}); input actions are always positional.
 */

export type KeyPlatform = 'mac' | 'other';

export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';
/** Canonical modifier order. */
export const MODIFIERS: readonly Modifier[] = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

/** Longest chord accepted (the settings schema's `KeyChord` bound). */
export const MAX_CHORD_LENGTH = 64;

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  mod: 'Mod',
  cmdorctrl: 'Mod',
  commandorcontrol: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');

/** Keys that are modifiers themselves. They can be bound bare (input actions such as sprint), never combined. */
export const MODIFIER_KEYS: readonly string[] = [
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
];

const NAMED_KEYS: readonly string[] = [
  'Escape',
  'Enter',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'ContextMenu',
  'CapsLock',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...DIGITS.map((d) => `Numpad${d}`),
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEnter',
  ...MODIFIER_KEYS,
];

/** Every canonical key name. */
export const KEY_NAMES: readonly string[] = [...LETTERS, ...DIGITS, ...NAMED_KEYS];

/** Lower-cased name or alias → canonical key name. */
const KEY_LOOKUP: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {};
  for (const name of KEY_NAMES) table[name.toLowerCase()] = name;
  const aliases: Record<string, string> = {
    esc: 'Escape',
    return: 'Enter',
    del: 'Delete',
    ins: 'Insert',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    pgup: 'PageUp',
    pgdn: 'PageDown',
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
  };
  for (const [alias, name] of Object.entries(aliases)) table[alias] = name;
  return table;
})();

/** ASCII punctuation as typed (`KeyboardEvent.key`) → key name, for letter keys on non-QWERTY Latin layouts. */
const PUNCTUATION: Readonly<Record<string, string>> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

export interface Chord {
  readonly modifiers: ReadonlySet<Modifier>;
  readonly key: string;
}

export type ChordParseResult =
  { readonly ok: true; readonly chord: string } | { readonly ok: false; readonly error: string };

/** Whether `key` is a modifier key bound on its own (`ShiftLeft`, …). */
export const isModifierKey = (key: string): boolean => MODIFIER_KEYS.includes(key);

/**
 * Parses a chord and returns its canonical form for `platform`. Accepts aliases (`Cmd`, `Control`,
 * `Option`, `Esc`, `Up`, `]`, …) and any letter case. Never throws.
 */
export function normaliseChord(source: string, platform: KeyPlatform): ChordParseResult {
  if (source.length === 0) return { ok: false, error: 'Empty chord' };
  if (source.length > MAX_CHORD_LENGTH) return { ok: false, error: `Longer than ${MAX_CHORD_LENGTH} characters` };
  const parts = source.split('+').map((p) => p.trim());
  const keyPart = parts[parts.length - 1];
  if (keyPart === '') return { ok: false, error: 'Missing key after "+"' };
  const modifiers = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (!has(MODIFIER_ALIASES, lower)) return { ok: false, error: `Unknown modifier "${part}"` };
    const modifier = MODIFIER_ALIASES[lower];
    if (modifiers.has(modifier)) return { ok: false, error: `Repeated modifier "${part}"` };
    modifiers.add(modifier);
  }
  const lowerKey = keyPart.toLowerCase();
  if (!has(KEY_LOOKUP, lowerKey)) return { ok: false, error: `Unknown key "${keyPart}"` };
  const key = KEY_LOOKUP[lowerKey];
  if (isModifierKey(key) && modifiers.size > 0) {
    return { ok: false, error: `A modifier key (${key}) can only be bound on its own` };
  }
  return foldMod(modifiers, key, platform);
}

/** Folds the platform's command key into `Mod` and formats the canonical string. */
function foldMod(modifiers: Set<Modifier>, key: string, platform: KeyPlatform): ChordParseResult {
  const native: Modifier = platform === 'mac' ? 'Meta' : 'Ctrl';
  if (modifiers.has(native)) {
    if (modifiers.has('Mod')) return { ok: false, error: `Mod already means ${native} on this platform` };
    modifiers.delete(native);
    modifiers.add('Mod');
  }
  return { ok: true, chord: formatChord({ modifiers, key }) };
}

/** Formats a chord in canonical modifier order. Does no platform folding. */
export function formatChord(chord: Chord): string {
  return [...MODIFIERS.filter((m) => chord.modifiers.has(m)), chord.key].join('+');
}

/** Splits a **canonical** chord. Undefined if it isn't one (callers normalise first). */
export function splitChord(canonical: string): Chord | undefined {
  const parts = canonical.split('+');
  const key = parts.pop() as string;
  if (!KEY_NAMES.includes(key)) return undefined;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    if (!(MODIFIERS as readonly string[]).includes(part)) return undefined;
    modifiers.add(part as Modifier);
  }
  return { modifiers, key };
}

/** The `KeyboardEvent.code` for a key name (`W` → `KeyW`, `1` → `Digit1`, `ArrowUp` → `ArrowUp`). */
export function keyNameToCode(key: string): string {
  if (LETTERS.includes(key)) return `Key${key}`;
  if (DIGITS.includes(key)) return `Digit${key}`;
  return key;
}

/** The key name for a `KeyboardEvent.code`, or `null` for a code outside the grammar. */
export function codeToKeyName(code: string): string | null {
  const match = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (match) return match[1] ?? match[2];
  return NAMED_KEYS.includes(code) ? code : null;
}

/** The parts of a `KeyboardEvent` the resolver reads (so tests and headless callers can pass plain objects). */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const isAsciiLetter = (s: string): boolean => /^[A-Za-z]$/.test(s);
const isPrintableAscii = (s: string): boolean => s.length === 1 && s >= ' ' && s <= '~';

/**
 * The key name a **command** chord sees for this event. Letters are layout-aware: on a Latin
 * layout the letter the key types wins (`Mod+Z` is the key labelled Z on AZERTY too). Where the
 * key types no ASCII character (Cyrillic or Greek layouts, macOS Option combinations, dead keys) the
 * physical letter is used. Where a letter position types ASCII punctuation (Dvorak) the punctuation
 * is used. Everything else, digits included, is positional, so `Shift+1` stays `1` and the tool
 * belt keys stay on the top row on every layout.
 */
export function eventKeyName(event: Pick<KeyEventLike, 'key' | 'code'>): string | null {
  const physical = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (isAsciiLetter(event.key)) return event.key.toUpperCase();
  if (physical !== undefined) {
    if (!isPrintableAscii(event.key)) return physical;
    return has(PUNCTUATION, event.key) ? PUNCTUATION[event.key] : null;
  }
  return codeToKeyName(event.code);
}

/**
 * The canonical **command** chord for a key event, or `null` when it can't be one: a modifier key
 * pressed on its own (commands bind a key, not a bare modifier) or a key outside the grammar.
 */
export function chordFromEvent(event: KeyEventLike, platform: KeyPlatform): string | null {
  if (isModifierKey(event.code)) return null;
  const key = eventKeyName(event);
  if (key === null || isModifierKey(key)) return null;
  const modifiers = new Set<Modifier>();
  if (event.ctrlKey) modifiers.add(platform === 'mac' ? 'Ctrl' : 'Mod');
  if (event.metaKey) modifiers.add(platform === 'mac' ? 'Mod' : 'Meta');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  return formatChord({ modifiers, key });
}

/**
 * The canonical **input-action** chord for a key event: always positional and always a bare key
 * (input actions ignore modifiers; a modifier key itself, such as `ShiftLeft`, is a valid key).
 * `null` for a code outside the grammar.
 */
export function inputChordFromEvent(event: Pick<KeyEventLike, 'code'>): string | null {
  return codeToKeyName(event.code);
}

const MAC_LABELS: Readonly<Record<Modifier, string>> = {
  Mod: 'Cmd',
  Ctrl: 'Ctrl',
  Meta: 'Cmd',
  Alt: 'Option',
  Shift: 'Shift',
};
const OTHER_LABELS: Readonly<Record<Modifier, string>> = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Meta: 'Meta',
  Alt: 'Alt',
  Shift: 'Shift',
};
const KEY_LABELS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Left Meta',
  MetaRight: 'Right Meta',
};

/** A human label for a canonical chord on `platform`: `Mod+Shift+Z` → `Ctrl+Shift+Z` or `Cmd+Shift+Z`. */
export function chordLabel(canonical: string, platform: KeyPlatform): string {
  const chord = splitChord(canonical);
  if (!chord) return canonical;
  const labels = platform === 'mac' ? MAC_LABELS : OTHER_LABELS;
  const key = has(KEY_LABELS, chord.key) ? KEY_LABELS[chord.key] : chord.key;
  return [...MODIFIERS.filter((m) => chord.modifiers.has(m)).map((m) => labels[m]), key].join('+');
}
