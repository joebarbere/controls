/*
 * `.meta()` hints on command `args` schemas for generated forms (the command palette, F1.3). They
 * only add JSON Schema keywords (`z.toJSONSchema` copies `.meta()` fields into its output) and never
 * change what a schema accepts, so adding one to a persisted args shape is not a save-format change.
 * The standard `title` and `description` keywords label and explain a field.
 */

/** JSON Schema keyword (set with `.meta()`) marking an argument as a reference to something in the world. */
export const ARG_REF_KEYWORD = 'x-controls-ref';

/** What a reference argument points at. */
export type ArgRefKind = 'entity';

/** `.meta()` for an integer argument that is a world entity id: forms offer the current selection. */
export const entityRefMeta: Readonly<Record<typeof ARG_REF_KEYWORD, ArgRefKind>> = { [ARG_REF_KEYWORD]: 'entity' };

/**
 * UI context key holding the id (a number) of the selected world entity; absent when no world entity
 * is selected. The viewport publishes it with `Session.setContext`. Forms fill entity-reference
 * arguments from it, and `when` expressions may test it.
 */
export const SELECTION_ENTITY_ID_KEY = 'selection.entityId';
