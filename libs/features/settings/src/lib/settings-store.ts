import { DOCUMENT } from '@angular/common';
import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { NotificationService } from '@controls/feature-shell';
import { defaultSettings, type Settings } from '@controls/save-format';
import { SETTINGS_SERVICE } from './settings-service';

/** Quiet period before a change is written, so dragging a slider doesn't write on every step. */
export const SAVE_DEBOUNCE_MS = 300;

/** The object-valued sections of the settings document. */
export type SettingsSection = Exclude<keyof Settings, 'settingsVersion' | 'extensions'>;

type Patch = (settings: Settings) => Settings;

/**
 * The settings document (`Settings` from `@controls/save-format`) as a signal. Settings are player
 * preferences, not world state, so they are edited directly rather than through Commands.
 *
 * - Loads once from {@link SETTINGS_SERVICE}. A corrupt, foreign or newer stored document falls
 *   back to defaults (the service decides) and the player is warned.
 * - Changes made **before** the load finishes are kept: they are replayed on top of the loaded
 *   document instead of being overwritten by it.
 * - Saves are debounced by {@link SAVE_DEBOUNCE_MS}; a failed save is reported.
 * - Theme and motion are reflected on `<html>` as `data-theme` / `data-motion` for the design tokens.
 *
 * Writers of capped lists (palette recents ≤ 20, no repeats; console history ≤ 200 × 2000 chars)
 * must trim before calling `update`: one over-cap field makes the whole file fall back on load.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly service = inject(SETTINGS_SERVICE);
  private readonly notifications = inject(NotificationService);
  private readonly state = signal<Settings>(defaultSettings());
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Edits made while loading; `null` once loaded. */
  private pending: Patch[] | null = [];

  readonly settings = this.state.asReadonly();
  /** Resolves once the stored settings have been applied. */
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.load();
    const root = inject(DOCUMENT).documentElement;
    effect(() => {
      const { theme, reducedMotion } = this.state().display;
      if (theme === 'system') delete root.dataset['theme'];
      else root.dataset['theme'] = theme;
      if (reducedMotion === 'system') delete root.dataset['motion'];
      else root.dataset['motion'] = reducedMotion;
    });
    inject(DestroyRef).onDestroy(() => void this.flush());
  }

  /** Replaces part of one section, e.g. `update('audio', { master: 0.5 })`. */
  update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
    this.apply((s) => ({ ...s, [section]: { ...s[section], ...patch } }));
  }

  /** Restores the defaults of everything on the settings screen; layout, bindings, history and the tool belt are kept. */
  resetToDefaults(): void {
    this.apply((s) => {
      const d = defaultSettings();
      return {
        ...s,
        graphics: d.graphics,
        audio: d.audio,
        controls: { ...d.controls, keybindings: s.controls.keybindings },
        display: d.display,
        gameplay: d.gameplay,
      };
    });
  }

  /** Writes any pending change now. */
  flush(): Promise<void> {
    if (this.saveTimer === undefined) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    return this.save();
  }

  private apply(patch: Patch): void {
    this.pending?.push(patch);
    this.state.update(patch);
    this.scheduleSave();
  }

  private async load(): Promise<void> {
    let loaded: Settings;
    try {
      const { settings, fallbackReason } = await this.service.load();
      loaded = settings;
      if (fallbackReason === 'corrupt' || fallbackReason === 'unknown-version') {
        this.notifications.notify('Your settings could not be read, so the defaults are in use.', { level: 'warning' });
      }
    } catch {
      loaded = defaultSettings();
      this.notifications.notify('Settings could not be loaded, so the defaults are in use.', { level: 'warning' });
    }
    const edits = this.pending ?? [];
    this.pending = null;
    this.state.set(edits.reduce((s, patch) => patch(s), loaded));
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    // Never write before the stored document is known: that would overwrite it with defaults.
    await this.loaded;
    try {
      await this.service.save(this.state());
    } catch {
      this.notifications.notify('Settings could not be saved.', { level: 'error' });
    }
  }
}
