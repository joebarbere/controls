import { type Catalog, ENTRY_TYPES, type ToolDefinition, type ToolStep } from '@controls/catalog';
import {
  type CatalogRef,
  entityPointMm,
  entryOpen,
  findEntity,
  type PositionMm,
  type World,
} from '@controls/world-model';

/*
 * Cutting and opening enclosure entries with the tool in hand (F3.4 part 2), pure: which tools arm
 * the click flow, each entry of an enclosure with whether the tool would open it now (the
 * `enclosure.openEntry` command's own refusal: `wrong-tool`, `wrong-size`, `wrong-drive`,
 * `already-open`), and which entry a click picks. Nothing here touches the world.
 */

/**
 * The steps that make a tool in hand arm the entry flow: every step an entry type opens by
 * (`ENTRY_TYPES`: `drive` for knockouts, pryouts and clamps, `openEntry` for a punch or hole saw), and
 * `bore`, so a wood bit's click on a drill site says why it can't (`wrong-tool`).
 */
export const ENTRY_TOOL_STEPS: ReadonlySet<ToolStep> = new Set<ToolStep>([
  ...Object.values(ENTRY_TYPES).flatMap((t) => t.opens),
  'bore',
]);

/** Whether `tool` in hand arms the entry flow (see {@link ENTRY_TOOL_STEPS}). */
export function opensEntries(tool: ToolDefinition | null): boolean {
  return tool !== null && tool.capabilities.some((c) => ENTRY_TOOL_STEPS.has(c.step));
}

/** One entry of an enclosure, where it is, and what `enclosure.openEntry` with the tool would say. */
export interface CutOption {
  readonly entity: number;
  readonly entry: string;
  /** The entry's catalogue type (`knockout`, `drillSite`, …) and trade size (`3/4`), for the player. */
  readonly type: string;
  readonly tradeSize: string | null;
  readonly positionMm: PositionMm;
  readonly open: boolean;
  /** `null` when the command would open it with this tool; else its refusal. */
  readonly problem: { readonly code: string; readonly message: string } | null;
}

/**
 * Every entry of enclosure `entity` in catalogue order, each with `check` (the command's own pre-check
 * of `enclosure.openEntry {id, entry, tool}`), or `null` when the entity isn't an enclosure.
 */
export function cutOptions(
  world: World,
  catalog: Catalog,
  entity: number,
  tool: CatalogRef,
  check: (args: { id: number; entry: string; tool: CatalogRef }) => { code: string; message: string } | null,
): CutOption[] | null {
  const found = findEntity(world, entity);
  const enclosure = found ? catalog.device(found.ref)?.enclosure : undefined;
  if (!found || !enclosure) return null;
  const options: CutOption[] = [];
  for (const [index, entry] of enclosure.entries.entries()) {
    const positionMm = entityPointMm(found.transform, entry.positionMm);
    if (positionMm === null) continue;
    options.push({
      entity,
      entry: entry.id,
      type: entry.type,
      tradeSize: entry.tradeSize,
      positionMm,
      open: entryOpen(found, index),
      problem: check({ id: entity, entry: entry.id, tool: { ...tool } }),
    });
  }
  return options;
}

const distance2 = (p: PositionMm, q: PositionMm): number => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;

/**
 * The entry a click at `atMm` on an enclosure means: the nearest **closed** entry (ties by catalogue
 * order), whether or not this tool can open it, so the refusal is about the hole the player aimed at
 * (`wrong-size` on a drill site, not some other knockout the tool fits). `null` when every entry is open.
 */
export function nearestClosedEntry(options: readonly CutOption[], atMm: PositionMm): CutOption | null {
  let best: CutOption | null = null;
  let bestD = Infinity;
  for (const o of options) {
    if (o.open) continue;
    const d = distance2(o.positionMm, atMm);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

/** `drill site drill-top-1 (3/4 in)`: an entry as the player reads it. */
export function describeCutOption(o: Pick<CutOption, 'entry' | 'type' | 'tradeSize'>): string {
  const type = o.type === 'drillSite' ? 'drill site' : o.type;
  return `${type} ${o.entry}${o.tradeSize === null ? '' : ` (${o.tradeSize} in)`}`;
}
