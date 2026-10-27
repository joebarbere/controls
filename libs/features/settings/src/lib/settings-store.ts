import { DOCUMENT } from '@angular/common';
import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { NotificationService } from '@controls/feature-shell';
import type { SettingsDocument } from '@controls/platform-api';
import { PLACEHOLDER_DEFAULT_SETTINGS } from './defaults';
import { SETTINGS_SERVICE } from './settings-service';

/** Quiet period before a change is written, so dragging a slider doesn't write on every step. */
export const SAVE_DEBOUNCE_MS = 300;

type Section = keyof SettingsDocument;

/**
 * The settings document as a signal. Settings are player preferences, not world state, so they are
 * edited directly rather than through Commands (plan §4.6 covers the world and replayable actions).
 *
 * Loads once from {@link SETTINGS_SERVICE}; an unusable stored document falls back to defaults with
 * a notification. Changes are saved after {@link SAVE_DEBOUNCE_MS}. Theme and motion preferences are
 * reflected on `<html>` as `data-theme` / `data-motion`, which the design tokens read.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly service = inject(SETTINGS_SERVICE);
  private readonly notifications = inject(NotificationService);
  private readonly state = signal<SettingsDocument>(PLACEHOLDER_DEFAULT_SETTINGS);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  readonly settings = this.state.asReadonly();
  /** Resolves once the stored settings have been applied. */
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.load();
    const root = inject(DOCUMENT).documentElement;
    effect(() => {
      const { theme, motion } = this.state().interface;
      if (theme === 'system') delete root.dataset['theme'];
      else root.dataset['theme'] = theme;
      if (motion === 'system') delete root.dataset['motion'];
      else root.dataset['motion'] = motion;
    });
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  /** Replaces part of one section, e.g. `update('audio', { master: 50 })`. */
  update<S extends Section>(section: S, patch: Partial<SettingsDocument[S]>): void {
    this.state.update((s) => ({ ...s, [section]: { ...s[section], ...patch } }));
    this.scheduleSave();
  }

  /** Restores every default except the workspace layout (which has its own Reset layout). */
  resetToDefaults(): void {
    this.state.update((s) => ({ ...PLACEHOLDER_DEFAULT_SETTINGS, workspace: s.workspace }));
    this.scheduleSave();
  }

  /** Writes any pending change now. */
  flush(): Promise<void> {
    if (this.saveTimer === undefined) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    return this.service.save(this.state());
  }

  private async load(): Promise<void> {
    try {
      const { settings, fallbackReason } = await this.service.load();
      this.state.set(settings);
      if (fallbackReason === 'corrupt' || fallbackReason === 'unknown-version') {
        this.notifications.notify('Your settings could not be read, so the defaults are in use.', { level: 'warning' });
      }
    } catch {
      this.notifications.notify('Settings could not be loaded, so the defaults are in use.', { level: 'warning' });
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.service.save(this.state()).catch(() => {
        this.notifications.notify('Settings could not be saved.', { level: 'error' });
      });
    }, SAVE_DEBOUNCE_MS);
  }
}
