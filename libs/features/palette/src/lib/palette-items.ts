import type { AnyCommandDef, CommandRegistry, ContextKeys } from '@controls/commands';
import { fuzzyScore } from './fuzzy';

/** A command as the palette lists it. */
export interface PaletteItem<S = unknown> {
  readonly def: AnyCommandDef<S>;
  /** Whether its `when` holds in the current context. Disabled items stay listed, with the reason. */
  readonly enabled: boolean;
  /** Why it is disabled (`null` when enabled). */
  readonly reason: string | null;
  /** Position in the recents list (0 = most recent), or -1. */
  readonly recentRank: number;
  readonly score: number;
}

/** Ids the palette never lists: opening the palette from the palette does nothing useful. */
export const PALETTE_HIDDEN_COMMANDS: ReadonlySet<string> = new Set(['palette.open']);

/** How much being recent adds to a fuzzy score, so recents lead among comparable matches. */
export const RECENT_BOOST = 6;

/** Field weights: a title match counts most, then the id, then the category. */
const TITLE_WEIGHT = 1;
const ID_WEIGHT = 0.8;
const CATEGORY_WEIGHT = 0.6;

/** The reason a command whose `when` is false is unavailable, for the palette. */
export function disabledReason(def: AnyCommandDef<unknown>): string {
  return def.when === undefined ? 'Not available' : `Not available now (needs ${def.when})`;
}

/**
 * The palette's list for a query (plan F1.3):
 * - fuzzy search over title, category and id (every query word must match one of them);
 * - commands whose `when` is false are kept, after the enabled ones, with the reason;
 * - recent commands come first: with an empty query in recency order, with a query as a score boost;
 * - ties fall back to category, title and then id, so the order never depends on registration.
 */
export function paletteItems<S>(
  registry: CommandRegistry<S>,
  context: ContextKeys,
  query: string,
  recents: readonly string[],
): PaletteItem<S>[] {
  const searching = query.trim() !== '';
  const items: PaletteItem<S>[] = [];
  for (const def of registry.list()) {
    if (PALETTE_HIDDEN_COMMANDS.has(def.id)) continue;
    const score = fuzzyScore(query, [
      { text: def.title, weight: TITLE_WEIGHT },
      { text: def.id, weight: ID_WEIGHT },
      { text: def.category, weight: CATEGORY_WEIGHT },
    ]);
    if (score === null) continue;
    const enabled = registry.isEnabled(def.id, context);
    const recentRank = recents.indexOf(def.id);
    items.push({
      def,
      enabled,
      reason: enabled ? null : disabledReason(def as AnyCommandDef<unknown>),
      recentRank,
      score: searching && recentRank >= 0 ? score + RECENT_BOOST : score,
    });
  }
  const recentOrder = (i: PaletteItem<S>) => (i.recentRank < 0 ? Number.MAX_SAFE_INTEGER : i.recentRank);
  return items.sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      (searching ? b.score - a.score : recentOrder(a) - recentOrder(b)) ||
      compare(a.def.category, b.def.category) ||
      compare(a.def.title, b.def.title) ||
      compare(a.def.id, b.def.id),
  );
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
