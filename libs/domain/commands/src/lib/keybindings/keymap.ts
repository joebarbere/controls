import { CommandId } from '@controls/save-format';
import type { AnyCommandDef } from '../command';
import { type ContextKeys, evaluateWhen, parseWhen, type WhenExpr } from '../when';
import { isModifierKey, keyNameToCode, type KeyPlatform, normaliseChord, splitChord } from './chord';
import { provablyDisjoint } from './disjoint';
import { INPUT_ACTION_PREFIX, INPUT_ACTIONS, VIEWPORT_FOCUSED_KEY } from './input-actions';

/*
 * The keymap (plan F1.4, ADR 0006 "Keybindings"): binding declarations plus the player's overrides,
 * resolved into chords, conflicts and a deterministic resolution order. Framework-free, so the
 * Angular `KeybindingService`, the rebinding UI and tests share one implementation.
 *
 * A **binding** has an id, which is the key of the settings record `controls.keybindings`:
 * - an argument-less command binds under its command id (`edit.undo`);
 * - a command bound with fixed arguments gets its own id (`toolbelt.select.slot3` runs
 *   `toolbelt.select {slot: 3}`);
 * - an input action binds under `input.<action>` (`input.moveForward`).
 * All three match the replay log's command-id grammar, so the v1 settings schema holds them as is.
 */

export type BindingTarget =
  | {
      readonly kind: 'command';
      readonly command: string;
      /** Arguments `exec` receives. `{}` for argument-less commands. */
      readonly args: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'input'; readonly action: string; readonly held: boolean };

export interface BindingDecl {
  /** Settings key; unique across commands, fixed-argument bindings and input actions. */
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly target: BindingTarget;
  /** Default chords, in any spelling `normaliseChord` accepts. May be empty (unbound by default). */
  readonly defaults: readonly string[];
  /** The command's `when`. Input actions get `viewport.focused` implicitly. */
  readonly when?: string;
  /** Also fires while typing (text fields, code editors) and inside dialogs: palette, console toggle. */
  readonly global?: boolean;
}

/** `controls.keybindings` in settings: binding id → chord, or `null` for "unbound by the player". */
export type KeybindingOverrides = Readonly<Record<string, string | null>>;

export interface ResolvedBinding {
  readonly id: string;
  readonly decl: BindingDecl;
  /** Effective chords, canonical. Empty when unbound. */
  readonly chords: readonly string[];
  /** Default chords, canonical. */
  readonly defaults: readonly string[];
  /** `user` when a valid override is in effect (including an explicit unbind). */
  readonly source: 'default' | 'user';
  /** Effective `when` (input actions: `viewport.focused`). */
  readonly when: WhenExpr | null;
}

/**
 * Two bindings on one chord whose `when`s may both be true. `first` comes earlier in resolution
 * order: for commands it runs when both are enabled; for input actions it keeps the key.
 */
export interface KeyConflict {
  readonly chord: string;
  readonly first: string;
  readonly second: string;
}

/** A stored override that can't be used. The binding keeps its defaults; the settings entry is left alone. */
export interface InvalidOverride {
  readonly id: string;
  readonly chord: string;
  readonly reason: string;
}

/** Thrown by {@link Keymap.create} for a malformed declaration: a programming error, like a bad command. */
export class KeymapError extends Error {
  constructor(
    readonly bindingId: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeymapError';
  }
}

/**
 * Chords the player may not take: Tab and Shift+Tab move focus (binding them would trap keyboard
 * users), and Escape is the shell's fixed "back" key (dialogs, menu). Defaults may still use Escape
 * (the viewport's clear-selection action falls through to the menu when there is nothing to clear).
 */
export const RESERVED_CHORDS: readonly string[] = ['Tab', 'Shift+Tab', 'Escape'];

/** Options for {@link Keymap.resolve}. */
export interface ResolveOptions {
  /**
   * Focus is in a text field, a code editor or a dialog: only `global` bindings fire, so typing
   * never runs commands.
   */
  readonly restricted?: boolean;
}

const VIEWPORT_WHEN: WhenExpr = { type: 'key', key: VIEWPORT_FOCUSED_KEY };

/**
 * Resolution order, fixed and documented: bindings the player chose come before defaults, then by
 * binding id (code-unit order). Never registration or object-key order.
 */
function compareBindings(a: ResolvedBinding, b: ResolvedBinding): number {
  if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class Keymap {
  private readonly byId = new Map<string, ResolvedBinding>();
  private readonly byChord = new Map<string, ResolvedBinding[]>();

  private constructor(
    /** Every binding, in declaration order. */
    readonly bindings: readonly ResolvedBinding[],
    readonly invalid: readonly InvalidOverride[],
    readonly platform: KeyPlatform,
  ) {
    for (const binding of bindings) {
      this.byId.set(binding.id, binding);
      for (const chord of binding.chords) {
        const list = this.byChord.get(chord) ?? [];
        list.push(binding);
        this.byChord.set(chord, list);
      }
    }
    for (const list of this.byChord.values()) list.sort(compareBindings);
    this.conflicts = this.findConflicts();
  }

  /** Every conflict, sorted by chord, then by the pair's resolution order. */
  readonly conflicts: readonly KeyConflict[];

  /**
   * Builds a keymap. Throws {@link KeymapError} for a malformed declaration (duplicate or bad id,
   * unparseable default chord or `when`, a command in the reserved `input.` namespace). Bad
   * overrides never throw: they are listed in {@link invalid} and the defaults stay in effect.
   * Overrides for unknown ids are ignored.
   */
  static create(decls: readonly BindingDecl[], overrides: KeybindingOverrides, platform: KeyPlatform): Keymap {
    const seen = new Set<string>();
    const invalid: InvalidOverride[] = [];
    const bindings = decls.map((decl): ResolvedBinding => {
      checkDecl(decl, seen);
      seen.add(decl.id);
      const isInput = decl.target.kind === 'input';
      const defaults = unique(decl.defaults.map((c) => defaultChord(decl, c, platform)));
      const when = isInput ? VIEWPORT_WHEN : parseDeclWhen(decl);
      const base = { id: decl.id, decl, defaults, when };
      if (!Object.prototype.hasOwnProperty.call(overrides, decl.id))
        return { ...base, chords: defaults, source: 'default' };
      const stored = overrides[decl.id];
      if (stored === null) return { ...base, chords: [], source: 'user' };
      const checked = checkOverride(decl, stored, platform);
      if (!checked.ok) {
        invalid.push({ id: decl.id, chord: stored, reason: checked.reason });
        return { ...base, chords: defaults, source: 'default' };
      }
      return { ...base, chords: [checked.chord], source: 'user' };
    });
    return new Keymap(bindings, invalid, platform);
  }

  get(id: string): ResolvedBinding | undefined {
    return this.byId.get(id);
  }

  /** Bindings on `chord` (canonical), in resolution order. */
  on(chord: string): readonly ResolvedBinding[] {
    return this.byChord.get(chord) ?? [];
  }

  /** Conflicts involving binding `id`. */
  conflictsOf(id: string): KeyConflict[] {
    return this.conflicts.filter((c) => c.first === id || c.second === id);
  }

  /**
   * The command binding a key press runs: the first, in resolution order, whose `when` holds and
   * that the focus rules allow. Input actions are never returned (the renderer handles them on the
   * viewport, and a key it acts on never reaches the command layer).
   */
  resolve(chord: string, context: ContextKeys, options: ResolveOptions = {}): ResolvedBinding | null {
    for (const binding of this.on(chord)) {
      if (binding.decl.target.kind !== 'command') continue;
      if (options.restricted && !binding.decl.global) continue;
      if (binding.when === null || evaluateWhen(binding.when, context)) return binding;
    }
    return null;
  }

  /**
   * Input action → `KeyboardEvent.code`s for the renderer. Each code goes to one action only: when
   * two actions share a key, the first in resolution order keeps it (the clash is in
   * {@link conflicts}). Actions in `INPUT_ACTIONS` order; codes in binding order.
   */
  inputCodes(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const binding of this.bindings) {
      const target = binding.decl.target;
      if (target.kind !== 'input') continue;
      out[target.action] = binding.chords
        .filter((chord) => this.on(chord).find((b) => b.decl.target.kind === 'input') === binding)
        .map((chord) => keyCode(chord));
    }
    return out;
  }

  private findConflicts(): KeyConflict[] {
    const conflicts: KeyConflict[] = [];
    const chords = [...this.byChord.keys()].sort();
    for (const chord of chords) {
      const list = this.on(chord);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (!provablyDisjoint(list[i].when, list[j].when)) {
            conflicts.push({ chord, first: list[i].id, second: list[j].id });
          }
        }
      }
    }
    return conflicts;
  }
}

function keyCode(chord: string): string {
  return keyNameToCode((splitChord(chord) as { key: string }).key);
}

function unique(chords: string[]): string[] {
  return [...new Set(chords)];
}

function checkDecl(decl: BindingDecl, seen: ReadonlySet<string>): void {
  const fail = (message: string): never => {
    throw new KeymapError(decl.id, `Binding "${decl.id}": ${message}`);
  };
  if (!CommandId.safeParse(decl.id).success) fail('the id must match the command-id grammar');
  if (seen.has(decl.id)) fail('duplicate binding id');
  const isInputId = decl.id.startsWith(INPUT_ACTION_PREFIX);
  if (decl.target.kind === 'input' && !isInputId) fail(`input actions must use the "${INPUT_ACTION_PREFIX}" namespace`);
  if (decl.target.kind === 'command') {
    if (isInputId || decl.target.command.startsWith(INPUT_ACTION_PREFIX)) {
      fail(`"${INPUT_ACTION_PREFIX}" is reserved for input actions`);
    }
  }
}

function defaultChord(decl: BindingDecl, source: string, platform: KeyPlatform): string {
  const result = checkChordFor(decl, source, platform);
  if (!result.ok) throw new KeymapError(decl.id, `Binding "${decl.id}": default "${source}" ${result.reason}`);
  return result.chord;
}

function parseDeclWhen(decl: BindingDecl): WhenExpr | null {
  if (decl.when === undefined) return null;
  const parsed = parseWhen(decl.when);
  if (!parsed.ok) throw new KeymapError(decl.id, `Binding "${decl.id}": malformed when: ${parsed.error.message}`);
  return parsed.expr;
}

type Checked = { readonly ok: true; readonly chord: string } | { readonly ok: false; readonly reason: string };

/** A chord valid for this kind of binding (commands: a key with optional modifiers; input actions: a bare key). */
function checkChordFor(decl: BindingDecl, source: string, platform: KeyPlatform): Checked {
  const parsed = normaliseChord(source, platform);
  if (!parsed.ok) return { ok: false, reason: `is not a valid chord (${parsed.error})` };
  const chord = splitChord(parsed.chord) as { key: string; modifiers: ReadonlySet<string> };
  if (decl.target.kind === 'input' && chord.modifiers.size > 0) {
    return { ok: false, reason: 'has modifiers; input actions take a single key' };
  }
  if (decl.target.kind === 'command' && isModifierKey(chord.key)) {
    return { ok: false, reason: 'is a modifier key on its own; commands need a non-modifier key' };
  }
  return { ok: true, chord: parsed.chord };
}

function checkOverride(decl: BindingDecl, stored: string, platform: KeyPlatform): Checked {
  const checked = checkChordFor(decl, stored, platform);
  if (!checked.ok) return { ok: false, reason: `"${stored}" ${checked.reason}` };
  if (RESERVED_CHORDS.includes(checked.chord)) return { ok: false, reason: `${checked.chord} is reserved` };
  return checked;
}

/** Category of the input-action bindings in listings. */
export const INPUT_ACTION_CATEGORY = 'Movement and viewport';

/** Binding declarations for every command with a default `keybinding`. */
export function commandBindingDecls<S>(defs: readonly AnyCommandDef<S>[]): BindingDecl[] {
  return defs
    .filter((d) => d.keybinding !== undefined)
    .map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      target: { kind: 'command', command: d.id, args: {} },
      defaults: typeof d.keybinding === 'string' ? [d.keybinding] : [...(d.keybinding ?? [])],
      when: d.when,
      global: d.globalKeybinding === true,
    }));
}

/** Binding declarations for the input actions. */
export function inputActionDecls(): BindingDecl[] {
  return INPUT_ACTIONS.map((a) => ({
    id: a.id,
    title: a.title,
    category: INPUT_ACTION_CATEGORY,
    target: { kind: 'input', action: a.action, held: a.held },
    defaults: a.keys,
  }));
}
