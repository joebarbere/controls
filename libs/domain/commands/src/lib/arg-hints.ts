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
