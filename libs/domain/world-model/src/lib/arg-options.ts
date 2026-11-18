import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import type { ArgOptionsHint } from '@controls/commands';
import { findEntity } from './entity-commands';
import type { World } from './types';

/*
 * What a form offers for a field with an `x-controls-options` hint (world v4, ADR 0019 "Palette
 * hints"): suggestions read from the world and the catalogue. **Form-only:** a command never reads
 * them, and its own `run` still refuses a value outside them, so a suggestion list that is stale or
 * wrong changes nothing a log replays.
 */

/** One suggested value and what the form shows beside it. */
export interface ArgOptionChoice {
  /** The value as the player would type it (a number as decimal text). */
  readonly value: string;
  readonly label: string;
}

/**
 * The suggestions `hint` offers, given the form's sibling arguments `args` (the entity a `outlets`,
 * `directorySpaces` or `controls` hint belongs to is read from `args[hint.entity]`, default `id`).
 * Empty when that entity is missing or offers nothing. Deterministic: catalogue order, or ascending.
 */
export function argOptionChoices(
  world: Pick<World, 'entities'>,
  hint: ArgOptionsHint,
  args: Readonly<Record<string, unknown>>,
  catalog: Catalog = BUILTIN_CATALOG,
): ArgOptionChoice[] {
  if (hint.from === 'colours') {
    const except = new Set(hint.except ?? []);
    return catalog.colourIds
      .filter((id) => !except.has(id))
      .map((id) => ({ value: id, label: catalog.colour(id)?.name ?? id }));
  }
  const key = hint.entity ?? 'id';
  const raw = Object.prototype.hasOwnProperty.call(args, key) ? args[key] : undefined;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  const entity = id === null ? undefined : findEntity(world, id);
  const device = entity && catalog.device(entity.ref);
  if (!device) return [];
  switch (hint.from) {
    case 'outlets':
      return device.outlets.map((o) => ({ value: o.id, label: `${o.id} (${o.config})` }));
    case 'directorySpaces':
      return (device.enclosure?.spaces ?? []).map((_, i) => {
        const text = entity.state[`directory${i + 1}`];
        return { value: String(i + 1), label: typeof text === 'string' ? `${i + 1}: ${text}` : `${i + 1}` };
      });
    case 'controls':
      return device.controls
        .filter((c) => hint.type === undefined || c.type === hint.type)
        .map((c) => ({ value: c.id, label: c.label }));
  }
}
