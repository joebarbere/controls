import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
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

/** Offered autosave intervals in seconds (the schema allows 60–3600; a stored other value is shown too). */
const AUTOSAVE_INTERVALS = [60, 120, 300, 600, 900, 1800, 3600] as const;
/** Autosave slot counts: every value the schema allows (1–10). */
const AUTOSAVE_SLOT_COUNTS = Array.from({ length: 10 }, (_, i) => i + 1);

/** `300` → `5 minutes`, `3600` → `60 minutes`, `90` → `1.5 minutes`. */
export function autosaveIntervalLabel(seconds: number): string {
  const minutes = seconds / 60;
  return minutes === 1 ? '1 minute' : `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
}

/**
 * Settings sections (F1.1): interface, graphics, audio, controls, units, difficulty, saves (F1.8b)
 * and region.
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
  protected readonly autosaveSlotCounts = AUTOSAVE_SLOT_COUNTS;
  /** The offered intervals, plus the stored one if it isn't among them (so the select never shows a blank). */
  protected readonly autosaveIntervals = computed(() =>
    [...new Set<number>([...AUTOSAVE_INTERVALS, this.s().autosave.intervalSeconds])].sort((a, b) => a - b),
  );
  protected readonly intervalLabel = autosaveIntervalLabel;
  /** Key bindings… was chosen; the owner opens the rebinding dialog (F1.4). */
  readonly openKeybindings = output<void>();

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
