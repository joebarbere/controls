import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, InjectionToken, signal, type Signal } from '@angular/core';
import {
  type BindingDecl,
  chordFromEvent,
  chordLabel,
  defaultBindingDecls,
  type KeybindingOverrides,
  Keymap,
  type KeyPlatform,
  normaliseChord,
  RESERVED_CHORDS,
  type ResolvedBinding,
} from '@controls/commands';
import { Session } from './session';

/** The platform for `Mod` (Cmd on macOS, Ctrl elsewhere). Detected from the browser; override in tests. */
export const KEY_PLATFORM = new InjectionToken<KeyPlatform>('KEY_PLATFORM', {
  providedIn: 'root',
  factory: () => detectKeyPlatform(inject(DOCUMENT).defaultView?.navigator),
});

/** `macOS` → `mac`. Uses `userAgentData` where available, else `navigator.platform`, else the user agent. */
export function detectKeyPlatform(nav: Navigator | undefined): KeyPlatform {
  if (!nav) return 'other';
  const data = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const name = data?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

/**
 * Where the player's binding overrides live: the settings document's `controls.keybindings`
 * (`provideKeybindingOverridesFromSettings()` in `@controls/feature-settings`). The default keeps
 * them in memory, for tests and hosts without settings.
 */
export interface KeybindingOverridesStore {
  readonly overrides: Signal<KeybindingOverrides>;
  set(next: KeybindingOverrides): void;
}

export const KEYBINDING_OVERRIDES = new InjectionToken<KeybindingOverridesStore>('KEYBINDING_OVERRIDES', {
  providedIn: 'root',
  factory: () => {
    const overrides = signal<KeybindingOverrides>({});
    return { overrides: overrides.asReadonly(), set: (next) => overrides.set(next) };
  },
});

/** Input types that don't take text, so bindings stay live while they have focus. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/**
 * Whether a key event's target is somewhere bindings must not fire (only `global` ones do): a text
 * field, a `<select>`, `contenteditable`, a CodeMirror editor (`.cm-editor`) or an open dialog.
 */
export function isRestrictedTarget(target: EventTarget | null): boolean {
  if (!target || !(target as Partial<Element>).closest) return false;
  const el = target as HTMLElement;
  if (el.closest('.cm-editor, dialog[open]')) return true;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
}

export type SetBindingResult =
  { readonly ok: true; readonly chord: string | null } | { readonly ok: false; readonly error: string };

/**
 * Keyboard → commands (plan F1.4). One document-level `keydown` listener resolves the pressed chord
 * against the keymap built from the registry's defaults (`CommandDef.keybinding`, the tool-belt
 * keys, the input actions) and the player's overrides, then runs the winner with `Session.exec`.
 * It owns no command list of its own, so the palette and console see the same bindings.
 *
 * - **Inner handlers win:** an event something else already handled (`defaultPrevented`: a
 *   dialog's Escape, the viewport's input actions) is ignored. Escape, Tab and Shift+Tab are never
 *   bindings (`RESERVED_CHORDS`); the shell handles Escape.
 * - **Typing is safe:** in a text field, a code editor or a dialog only `global` bindings fire.
 * - **Auto-repeat doesn't run commands** (a held key would flood the replay log), but the repeat's
 *   default action is still suppressed.
 * - **Input actions** (WASD, …) are rebindable here but run in the renderer: {@link inputBindings}
 *   feeds `ViewportRenderer.setBindings`. They never reach `exec` or the replay log.
 */
@Injectable({ providedIn: 'root' })
export class KeybindingService {
  private readonly session = inject(Session);
  private readonly store = inject(KEYBINDING_OVERRIDES);
  readonly platform = inject(KEY_PLATFORM);
  private readonly decls: readonly BindingDecl[] = defaultBindingDecls(this.session.registry);

  /** Every binding with the player's overrides applied, plus conflicts and unusable overrides. */
  readonly keymap = computed(() => Keymap.create(this.decls, this.store.overrides(), this.platform));
  /** Input action → `KeyboardEvent.code`s, for the renderer. */
  readonly inputBindings = computed(() => this.keymap().inputCodes());
  /** Whether any binding differs from its default. */
  readonly customised = computed(() => Object.keys(this.store.overrides()).some((id) => this.keymap().get(id)));

  constructor() {
    const doc = inject(DOCUMENT);
    const listener = (event: KeyboardEvent) => this.onKeydown(event);
    doc.addEventListener('keydown', listener);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('keydown', listener));
  }

  /** A chord as the player reads it on this platform (`Mod+Z` → `Ctrl+Z` or `Cmd+Z`). */
  label(chord: string): string {
    return chordLabel(chord, this.platform);
  }

  /** The effective chords of binding `id` (for menus, the palette and tooltips). */
  chordsOf(id: string): readonly string[] {
    return this.keymap().get(id)?.chords ?? [];
  }

  /**
   * Binds `id` to `chord` (any accepted spelling), or unbinds it with `null`. A chord equal to the
   * only default clears the override instead, so settings hold real changes only. Refuses unknown
   * ids, unparseable or reserved chords and chords the binding kind can't take; conflicts are
   * allowed (and shown).
   */
  setBinding(id: string, chord: string | null): SetBindingResult {
    const binding = this.keymap().get(id);
    if (!binding) return { ok: false, error: `Unknown binding "${id}"` };
    if (chord === null) return this.write(id, binding, null);
    const parsed = normaliseChord(chord, this.platform);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (RESERVED_CHORDS.includes(parsed.chord)) return { ok: false, error: `${this.label(parsed.chord)} is reserved` };
    const trial = Keymap.create([binding.decl], { [id]: parsed.chord }, this.platform);
    if (trial.invalid.length > 0) return { ok: false, error: trial.invalid[0].reason };
    return this.write(id, binding, parsed.chord);
  }

  /** Restores the default of one binding. */
  reset(id: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.store.overrides(), id)) return;
    const rest = { ...this.store.overrides() };
    delete rest[id];
    this.store.set(rest);
  }

  /** Restores every default. Overrides for bindings this build doesn't know are dropped too. */
  resetAll(): void {
    this.store.set({});
  }

  private write(id: string, binding: ResolvedBinding, chord: string | null): SetBindingResult {
    const isDefault =
      chord === null ? binding.defaults.length === 0 : binding.defaults.length === 1 && binding.defaults[0] === chord;
    if (isDefault) this.reset(id);
    else this.store.set({ ...this.store.overrides(), [id]: chord });
    return { ok: true, chord };
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const chord = chordFromEvent(event, this.platform);
    if (chord === null) return;
    const binding = this.keymap().resolve(chord, this.session.contextKeys(), {
      restricted: isRestrictedTarget(event.target),
    });
    if (!binding || binding.decl.target.kind !== 'command') return;
    event.preventDefault();
    if (event.repeat) return;
    this.session.exec(binding.decl.target.command, binding.decl.target.args);
  }
}
