import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { ToolBeltSelectArgs } from '@controls/commands';
import { Session } from './session';

/** Context key holding the active tool-belt slot (1-9), for `when` expressions. Absent until one is chosen. */
export const TOOL_BELT_SLOT_KEY = 'toolbelt.slot';

/**
 * The active tool-belt slot (plan F1.4). UI state, changed only by the `toolbelt.select` view
 * command (keys 1-9, and later the palette and console), which it applies through
 * `Session.onCommand` and publishes as the `toolbelt.slot` context key. What each slot holds is a
 * player preference in settings (`toolBelt.slots`); placing from the active slot arrives with F1.7.
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
}
