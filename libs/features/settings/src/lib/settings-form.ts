import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { SettingsDocument } from '@controls/platform-api';
import { Button } from '@controls/ui';
import { SettingsStore } from './settings-store';

type Difficulty = SettingsDocument['difficulty']['default'];

const DIFFICULTIES: readonly { value: Difficulty; label: string }[] = [
  { value: 'trainee', label: 'Trainee' },
  { value: 'apprentice', label: 'Apprentice' },
  { value: 'journeyman', label: 'Journeyman' },
  { value: 'realistic', label: 'Realistic' },
];

const PIXEL_RATIO_CAPS = [100, 150, 200, 300] as const;

/**
 * Settings sections (F1.1): interface, graphics, audio, controls, units, difficulty and region.
 * Native form controls with visible labels, grouped in fieldsets, so every control is reachable
 * and named for keyboard and screen-reader users without extra ARIA.
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

  protected update<S extends keyof SettingsDocument>(section: S, patch: Partial<SettingsDocument[S]>): void {
    this.store.update(section, patch);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected number(event: Event): number {
    return Number((event.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected difficulty(event: Event): Difficulty {
    return this.value(event) as Difficulty;
  }
}
