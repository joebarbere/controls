import { computed, DestroyRef, effect, inject, Injectable } from '@angular/core';
import { BUILTIN_CATALOG, type Catalog, type DriveType, type ToolStep } from '@controls/catalog';
import { Session, ToolBelt } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import type { CatalogRef } from '@controls/save-format';
import { beltSlotKind, beltSlotTitle, type DefaultTool, defaultTool } from '@controls/world-model';

/** Context key: what the active slot holds (`placeable`, `tool`, `spool`, `empty`, `unknown`); absent with no slot. */
export const TOOL_BELT_KIND_KEY = 'toolbelt.kind';
/** Context key: the active tool's kind (`stripper`, `torqueDriver`, …); absent unless a tool slot is active. */
export const TOOL_BELT_TOOL_KEY = 'toolbelt.tool';

/** One tool-belt slot as the UI shows it. */
export interface BeltSlotView {
  /** 1-9. */
  readonly slot: number;
  readonly ref: CatalogRef | null;
  readonly title: string;
  readonly kind: ReturnType<typeof beltSlotKind>;
}

/**
 * What the active tool-belt slot holds (F3.4 part 1): `ToolBelt` (feature-session) knows only the
 * slot, chosen by the `toolbelt.select` view command; this joins it with the player's belt (settings
 * `toolBelt.slots`) through world-model's belt rules, so the HUD, the belt bar and the viewport agree:
 *
 * - a **placeable** slot arms placement (`placeable`, read by the viewport);
 * - a **tool** or **spool** slot arms its flow and never placement; the HUD names it, and the
 *   `toolbelt.kind` and `toolbelt.tool` context keys let a flow's commands bind on a `when`;
 * - {@link toolFor} is the default-tool rule for any surface that needs a tool the player didn't pick.
 *
 * UI state only: nothing here is a command, and the world never reads it. `App` injects it, so the
 * context keys are published from start-up.
 */
@Injectable({ providedIn: 'root' })
export class ActiveTool {
  private readonly toolBelt = inject(ToolBelt);
  private readonly settings = inject(SettingsStore);
  private readonly session = inject(Session);
  /** The catalogue the belt resolves against: the built-in one, as the session's commands use. */
  readonly catalog: Catalog = BUILTIN_CATALOG;

  /** The player's nine slots, resolved for display. */
  readonly slots = computed<readonly BeltSlotView[]>(() =>
    this.settings.settings().toolBelt.slots.map((ref, i) => ({
      slot: i + 1,
      ref,
      title: beltSlotTitle(this.catalog, ref),
      kind: beltSlotKind(this.catalog, ref),
    })),
  );
  /** The active slot (1-9) or `null`. */
  readonly activeSlot = this.toolBelt.activeSlot;
  /** The active slot's view, or `null` with no active slot. */
  readonly active = computed<BeltSlotView | null>(() => {
    const slot = this.activeSlot();
    return slot === null ? null : (this.slots()[slot - 1] ?? null);
  });
  /** The active slot's ref when it arms placement (a prop or an entity device), else `null`. */
  readonly placeable = computed<CatalogRef | null>(() => {
    const active = this.active();
    return active?.kind === 'placeable' ? active.ref : null;
  });
  /** The active tool's catalogue entry, or `null` when the active slot isn't a tool. */
  readonly tool = computed(() => {
    const active = this.active();
    return active?.kind === 'tool' && active.ref ? (this.catalog.tool(active.ref) ?? null) : null;
  });
  /** The HUD's line: `4: Wire strippers, …`, or `null` before a slot is chosen. */
  readonly label = computed(() => {
    const active = this.active();
    return active === null ? null : `${active.slot}: ${active.title}`;
  });

  constructor() {
    const published = effect(() => {
      const active = this.active();
      // Context keys are the session's (not signals): an effect is the one place they're written.
      this.session.setContext(TOOL_BELT_KIND_KEY, active?.kind ?? null);
      this.session.setContext(TOOL_BELT_TOOL_KEY, this.tool()?.kind ?? null);
    });
    inject(DestroyRef).onDestroy(() => {
      published.destroy();
      this.session.setContext(TOOL_BELT_KIND_KEY, null);
      this.session.setContext(TOOL_BELT_TOOL_KEY, null);
    });
  }

  /**
   * The tool a surface uses for `step` when the player didn't pick one (ADR 0015): the first matching
   * tool on the belt, else the first catalogue tool with the capability by id (and, for a screw, a tip
   * that fits its `drives`). Show it in the prompt
   * (`describeDefaultTool`), never pick silently.
   */
  toolFor(step: ToolStep, awg: number | null = null, drives: readonly DriveType[] | null = null): DefaultTool | null {
    return defaultTool(this.catalog, this.settings.settings().toolBelt.slots, step, awg, drives);
  }
}
