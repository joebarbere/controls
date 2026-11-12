/*
 * Sim events (ADR 0011 §4): what the engine reports as it runs, for the HUD, notifications and
 * `game.on('sim')`. Deterministic in content and order (the same list headless and in the worker),
 * never in any hash, never persisted.
 */

/**
 * The event kinds. Adding one bumps `SIM_PROTOCOL_VERSION`. Protocol 7 (F3.6 part 3, ADR 0018 §6):
 * the connection events `terminationOverheat` (a termination's hot spot crossed ambient + 100 K
 * upwards) and `insulationDamaged` (the step that set a connection's sticky flag).
 */
export const SIM_EVENT_KINDS = Object.freeze([
  'tripped',
  'blown',
  'hiccup',
  'nonConverged',
  'singular',
  'overRated',
  'terminationOverheat',
  'insulationDamaged',
] as const);
export type SimEventKind = (typeof SIM_EVENT_KINDS)[number];

/** Island events (raised on the rising edge of the island's flag, with the island's entities). */
export const ISLAND_EVENT_KINDS: readonly SimEventKind[] = Object.freeze(['nonConverged', 'singular']);

/** Connection events (protocol 7): `connection` set, `entity` null, `end` the hot spot's end or null for the conductor. */
export const CONNECTION_EVENT_KINDS: readonly SimEventKind[] = Object.freeze([
  'terminationOverheat',
  'insulationDamaged',
]);

export interface SimEvent {
  readonly tick: number;
  readonly kind: SimEventKind;
  /** The device, for device events; `null` for island and connection events. */
  readonly entity: number | null;
  /** Island events: the island's entity ids, ascending. Empty for device and connection events. */
  readonly entities: readonly number[];
  /** Protocol 7: the connection, for connection events; `null` for every other event. */
  readonly connection: number | null;
  /**
   * Protocol 7: a connection event's end, `'a'` or `'b'` for a termination's hot spot, `null` for the
   * conductor node (and for every other event).
   */
  readonly end: 'a' | 'b' | null;
  /**
   * Kind-specific detail: hiccup `{ phase: 'off' | 'retry' }`; a connection event `{ temperatureK }`
   * (the node's temperature after the step that raised it); `{}` otherwise.
   */
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

/** The entity an event sorts by: its device, or an island event's smallest entity (−1 for none). */
function sortEntity(event: SimEvent): number {
  return event.entity ?? event.entities[0] ?? -1;
}

/** An end's sort rank: the conductor node (`null`) first, then `a`, then `b`. */
const endRank = (end: SimEvent['end']): number => (end === null ? 0 : end === 'a' ? 1 : 2);

/**
 * The order events are delivered in (ADR 0011 §4): by tick; then device and island events by entity
 * id (an island event by its smallest entity), before connection events (protocol 7) by connection
 * id and end (the conductor, then `a`, then `b`); then kind (code units).
 */
export function compareSimEvents(a: SimEvent, b: SimEvent): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  const ca = a.connection ?? -1;
  const cb = b.connection ?? -1;
  if (ca !== cb) return ca - cb;
  if (ca < 0) {
    const ea = sortEntity(a);
    const eb = sortEntity(b);
    if (ea !== eb) return ea - eb;
  } else if (a.end !== b.end) {
    return endRank(a.end) - endRank(b.end);
  }
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}
