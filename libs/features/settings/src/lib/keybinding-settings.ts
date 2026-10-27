import { computed, inject, type Provider } from '@angular/core';
import { KEYBINDING_OVERRIDES, type KeybindingOverridesStore } from '@controls/feature-session';
import { SettingsStore } from './settings-store';

/**
 * Stores the player's keybinding overrides in the settings document (`controls.keybindings`), so
 * they persist through the platform's settings service like every other preference. The record's
 * keys are binding ids: command ids, fixed-argument bindings (`toolbelt.select.slot3`) and input
 * actions (`input.moveForward`); see ADR 0006 "Keybindings".
 */
export const provideKeybindingOverridesFromSettings = (): Provider => ({
  provide: KEYBINDING_OVERRIDES,
  useFactory: (): KeybindingOverridesStore => {
    const store = inject(SettingsStore);
    return {
      overrides: computed(() => store.settings().controls.keybindings),
      set: (keybindings) => store.update('controls', { keybindings: { ...keybindings } }),
    };
  },
});
