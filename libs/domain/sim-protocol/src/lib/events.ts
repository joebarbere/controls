/*
 * Sim events (ADR 0011 §4): what the engine reports as it runs, for the HUD, notifications and
 * `game.on('sim')`. Deterministic in content and order (the same list headless and in the worker),
 * never in any hash, never persisted.
 */

/** The event kinds. Adding one bumps `SIM_PROTOCOL_VERSION`. */
export const SIM_EVENT_KINDS = Object.freeze([
  'tripped',
  'blown',
  'hiccup',
  'nonConverged',
  'singular',
  'overRated',
] as const);
export type SimEventKind = (typeof SIM_EVENT_KINDS)[number];

/** Island events (raised on the rising edge of the island's flag, with the island's entities). */
export const ISLAND_EVENT_KINDS: readonly SimEventKind[] = Object.freeze(['nonConverged', 'singular']);

export interface SimEvent {
  readonly tick: number;
  readonly kind: SimEventKind;
  /** The device, for device events; `null` for island events. */
  readonly entity: number | null;
  /** Island events: the island's entity ids, ascending. Empty for device events. */
  readonly entities: readonly number[];
  /** Kind-specific detail: hiccup `{ phase: 'off' | 'retry' }`; `{}` otherwise. */
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

/** The entity an event sorts by: its device, or an island event's smallest entity (−1 for none). */
function sortEntity(event: SimEvent): number {
  return event.entity ?? event.entities[0] ?? -1;
}

/**
 * The order events are delivered in (ADR 0011 §4): by tick, then entity id (an island event by its
 * smallest entity), then kind (code units).
 */
export function compareSimEvents(a: SimEvent, b: SimEvent): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  const ea = sortEntity(a);
  const eb = sortEntity(b);
  if (ea !== eb) return ea - eb;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}
