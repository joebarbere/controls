/*
 * `.meta()` hints on command `args` schemas for generated forms (the command palette, F1.3). They
 * only add JSON Schema keywords (`z.toJSONSchema` copies `.meta()` fields into its output) and never
 * change what a schema accepts, so adding one to a persisted args shape is not a save-format change.
 * The standard `title` and `description` keywords label and explain a field.
 */

/** JSON Schema keyword (set with `.meta()`) marking an argument as a reference to something in the world. */
export const ARG_REF_KEYWORD = 'x-controls-ref';

/**
 * What a reference argument points at: a world entity, a connection (a lead or a conductor) or a
 * cable (ADR 0015). Each is an integer id, and forms prefill it from the matching selection key.
 */
export type ArgRefKind = 'entity' | 'connection' | 'cable';

/** Every {@link ArgRefKind}, in declaration order. */
export const ARG_REF_KINDS: readonly ArgRefKind[] = ['entity', 'connection', 'cable'];

/** `.meta()` for an integer argument that is a world entity id: forms offer the current selection. */
export const entityRefMeta: Readonly<Record<typeof ARG_REF_KEYWORD, ArgRefKind>> = { [ARG_REF_KEYWORD]: 'entity' };

/** `.meta()` for an integer argument that is a connection id (`wire.*`): forms offer the selected connection. */
export const connectionRefMeta: Readonly<Record<typeof ARG_REF_KEYWORD, ArgRefKind>> = {
  [ARG_REF_KEYWORD]: 'connection',
};

/** `.meta()` for an integer argument that is a cable id (`cable.*`): forms offer the selected cable. */
export const cableRefMeta: Readonly<Record<typeof ARG_REF_KEYWORD, ArgRefKind>> = { [ARG_REF_KEYWORD]: 'cable' };

/**
 * UI context key holding the id (a number) of the selected world entity; absent when no world entity
 * is selected. The viewport publishes it with `Session.setContext`. Forms fill entity-reference
 * arguments from it, and `when` expressions may test it.
 */
export const SELECTION_ENTITY_ID_KEY = 'selection.entityId';

/**
 * UI context key holding the id of the selected connection (a lead or conductor), absent when none
 * is selected. Published by the viewport once connections can be selected (P3); forms fill
 * connection-reference arguments from it when it is present.
 */
export const SELECTION_CONNECTION_ID_KEY = 'selection.connectionId';

/** UI context key holding the id of the selected cable, absent when none is; as {@link SELECTION_CONNECTION_ID_KEY}. */
export const SELECTION_CABLE_ID_KEY = 'selection.cableId';

/** The selection context key each reference kind is prefilled from. */
export const SELECTION_KEYS: Readonly<Record<ArgRefKind, string>> = {
  entity: SELECTION_ENTITY_ID_KEY,
  connection: SELECTION_CONNECTION_ID_KEY,
  cable: SELECTION_CABLE_ID_KEY,
};

/**
 * JSON Schema keyword (set with `.meta()`) offering a form field a list of suggested values drawn from
 * the world and the catalogue (world v4, ADR 0019 "Palette hints"). **Form-only:** it never changes
 * what a command accepts, so the command's own `run` still refuses a value outside the list.
 */
export const ARG_OPTIONS_KEYWORD = 'x-controls-options';

/** Where a field's suggested values come from (ADR 0019). */
export type ArgOptionsSource = 'outlets' | 'colours' | 'directorySpaces' | 'controls';

/** Every {@link ArgOptionsSource}, in declaration order. */
export const ARG_OPTIONS_SOURCES: readonly ArgOptionsSource[] = ['outlets', 'colours', 'directorySpaces', 'controls'];

/**
 * A field's suggestion hint (`x-controls-options`):
 * - `outlets`: the outlet ids of the entity named by the sibling field `entity` (a receptacle);
 * - `colours`: the colour-table ids, less `except`;
 * - `directorySpaces`: the panel spaces (1 … n) of the entity named by the sibling field `entity`
 *   (default `id`);
 * - `controls`: the controls of the entity named by the sibling field `entity` (default `id`), only
 *   those of control type `type` when given.
 */
export interface ArgOptionsHint {
  readonly from: ArgOptionsSource;
  /** The sibling argument key holding the entity id the options belong to. */
  readonly entity?: string;
  /** Values never offered (`bare` is not a tape colour). */
  readonly except?: readonly string[];
  /** A control type (`momentary`) for `controls`. */
  readonly type?: string;
}

/** `.meta()` for a field whose form offers suggestions from `hint` (see {@link ARG_OPTIONS_KEYWORD}). */
export function argOptionsMeta(hint: ArgOptionsHint): Readonly<Record<typeof ARG_OPTIONS_KEYWORD, ArgOptionsHint>> {
  return { [ARG_OPTIONS_KEYWORD]: hint };
}
