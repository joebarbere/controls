import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { BUILTIN_CATALOG } from '@controls/catalog';
import type { CatalogRef, Difficulty, Settings } from '@controls/save-format';
import { type BeltChoice, beltChoices, beltSlotTitle } from '@controls/world-model';
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

/** A belt slot's `<select>` value: `id@version`, or `''` for an empty slot. */
export function beltRefValue(ref: CatalogRef | null): string {
  return ref === null ? '' : `${ref.id}@${ref.version}`;
}

/** The inverse of {@link beltRefValue}. */
export function parseBeltRefValue(value: string): CatalogRef | null {
  const at = value.lastIndexOf('@');
  return at <= 0 ? null : { id: value.slice(0, at), version: Number(value.slice(at + 1)) };
}

const BELT_CHOICES: readonly BeltChoice[] = beltChoices(BUILTIN_CATALOG);
const BELT_GROUPS = (['Props', 'Tools'] as const).map((label) => ({
  label,
  choices: BELT_CHOICES.filter((c) => c.group === label).map((c) => ({ value: beltRefValue(c.ref), title: c.title })),
}));
const BELT_VALUES = new Set(BELT_CHOICES.map((c) => beltRefValue(c.ref)));

/** `300` → `5 minutes`, `3600` → `60 minutes`, `90` → `1.5 minutes`. */
export function autosaveIntervalLabel(seconds: number): string {
  const minutes = seconds / 60;
  return minutes === 1 ? '1 minute' : `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
}

/**
 * Settings sections (F1.1): interface, graphics, audio, controls, units, difficulty, saves (F1.8b),
 * the tool belt (F3.4 part 1: what each of the nine slots holds, a prop or a tool) and region.
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
  protected readonly beltGroups = BELT_GROUPS;
  /** Each slot's select value, and a title for a stored ref the picker doesn't offer (so it isn't shown blank). */
  protected readonly beltSlots = computed(() =>
    this.s().toolBelt.slots.map((ref, i) => {
      const value = beltRefValue(ref);
      return {
        slot: i + 1,
        value,
        other: value === '' || BELT_VALUES.has(value) ? null : beltSlotTitle(BUILTIN_CATALOG, ref),
      };
    }),
  );
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

  /** A slot's picker changed: store the new ref (a player preference, not a command). */
  protected setBeltSlot(slot: number, event: Event): void {
    const slots = [...this.s().toolBelt.slots];
    slots[slot - 1] = parseBeltRefValue((event.target as HTMLSelectElement).value);
    this.update('toolBelt', { slots });
  }

  protected setVolume(key: Volume, event: Event): void {
    this.update('audio', { [key]: this.fraction(event) });
  }
}
