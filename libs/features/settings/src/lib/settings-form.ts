import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { Difficulty, Settings } from '@controls/save-format';
import { Button } from '@controls/ui';
import { SettingsStore, type SettingsSection } from './settings-store';

const DIFFICULTIES: readonly { value: Difficulty; label: string }[] = [
  { value: 'trainee', label: 'Trainee' },
  { value: 'apprentice', label: 'Apprentice' },
  { value: 'journeyman', label: 'Journeyman' },
  { value: 'realistic', label: 'Realistic' },
];

/** Offered pixel-ratio caps (the schema allows 0.5–4). */
const PIXEL_RATIO_CAPS = [1, 1.5, 2, 3] as const;

type Volume = keyof Settings['audio'];
const VOLUMES: readonly { key: Volume; label: string }[] = [
  { key: 'master', label: 'Master volume' },
  { key: 'effects', label: 'Effects volume' },
  { key: 'ambience', label: 'Ambience volume' },
  { key: 'interface', label: 'Interface volume' },
];

/**
 * Settings sections (F1.1): interface, graphics, audio, controls, units, difficulty and region.
 * Native form controls with visible labels, grouped in fieldsets, so every control is reachable
 * and named for keyboard and screen-reader users without extra ARIA.
 *
 * Sliders show whole percentages; the document stores volumes in [0, 1] and look sensitivity as a
 * multiplier, so values are converted at this edge only.
 */
@Component({
  selector: 'ctl-settings-form',
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-form.html',
  styleUrl: './settings-form.scss',
})
export class SettingsForm {
  protected readonly store = inject(SettingsStore);
  protected readonly s = this.store.settings;
  protected readonly difficulties = DIFFICULTIES;
  protected readonly pixelRatioCaps = PIXEL_RATIO_CAPS;
  protected readonly volumes = VOLUMES;

  protected update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
    this.store.update(section, patch);
  }

  /** A whole-percent slider value as a fraction (35 → 0.35). */
  protected fraction(event: Event): number {
    return Number((event.target as HTMLInputElement).value) / 100;
  }

  protected percent(value: number): number {
    return Math.round(value * 100);
  }

  protected number(event: Event): number {
    return Number((event.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected difficulty(event: Event): Difficulty {
    return (event.target as HTMLSelectElement).value as Difficulty;
  }

  protected setVolume(key: Volume, event: Event): void {
    this.update('audio', { [key]: this.fraction(event) });
  }
}
