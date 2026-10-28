import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { ToolBeltSelectArgs } from '@controls/commands';
import { Session } from './session';

/** Context key holding the active tool-belt slot (1-9), for `when` expressions. Absent until one is chosen. */
export const TOOL_BELT_SLOT_KEY = 'toolbelt.slot';

/**
 * The active tool-belt slot (plan F1.4). UI state, set only by the `toolbelt.select` view command
 * (keys 1-9, the palette and console) and cleared by {@link clear}. It applies the command through
 * `Session.onCommand` and publishes as the `toolbelt.slot` context key. What each slot holds is a
 * player preference in settings (`toolBelt.slots`); the viewport places the active slot's prop (F1.7).
 */
@Injectable({ providedIn: 'root' })
export class ToolBelt {
  private readonly session = inject(Session);
  private readonly slot = signal<number | null>(null);
  /** The active slot, 1-9, or `null` before any is selected. */
  readonly activeSlot = this.slot.asReadonly();

  constructor() {
    const off = this.session.onCommand('toolbelt.select', (event) => {
      const { slot } = event.command.args as ToolBeltSelectArgs;
      this.slot.set(slot);
      this.session.setContext(TOOL_BELT_SLOT_KEY, slot);
    });
    inject(DestroyRef).onDestroy(off);
  }

  /**
   * Puts the tool away (no active slot). UI state only, so not a command: Escape cancelling a
   * placement (F1.7) calls this. Selecting a slot again re-arms placement.
   */
  clear(): void {
    this.slot.set(null);
    this.session.setContext(TOOL_BELT_SLOT_KEY, null);
  }
}
