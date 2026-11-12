import { type Catalog, type DriveType, drivesFit, type ToolDefinition, type ToolStep } from '@controls/catalog';
import { BUILTIN_PROP_VERSION, BUILTIN_PROPS, builtinProp } from '../props';
import type { CatalogRef } from '../types';

/*
 * The tool belt's rules (F3.4 part 1, D10, ADR 0015 "Consequences" for the UI). The belt is a player
 * preference (settings `toolBelt.slots`, nine `CatalogRef | null`), and every surface reads it through
 * these helpers, so none of them encodes what a slot means or which tool is picked for a step:
 *
 * - **What a slot arms** ({@link beltSlotKind}): a placeable (a built-in prop or an entity device)
 *   arms placement; a tool or a spool (a conductor, cable or lead: anything laid as a connection)
 *   arms its flow and **never placement**; anything else arms nothing.
 * - **The default-tool rule** ({@link defaultTool}): a tool the player didn't pick is the first tool on
 *   the belt (slot order) with the step's capability, else the first catalogue tool with it by id
 *   (newest version of that id). A surface always shows the tool it picked in its prompt, with where
 *   it came from, so the player sees what will be logged.
 *
 * Pure and framework-free: the game's tool belt, the palette and the termination prompts (F3.3 part 2)
 * call the same functions, and `sim-cli` scripts may too.
 */

/** What a tool-belt slot holds, and so what selecting it arms. */
export type BeltSlotKind = 'empty' | 'placeable' | 'tool' | 'spool' | 'unknown';

/** What `ref` is as a belt slot (`null` is an empty slot). Decided by what the ref resolves to, never its spelling. */
export function beltSlotKind(catalog: Catalog, ref: CatalogRef | null): BeltSlotKind {
  if (ref === null) return 'empty';
  if (builtinProp(ref)) return 'placeable';
  switch (catalog.family(ref)) {
    case 'tool':
      return 'tool';
    case 'cable':
      return 'spool';
    case 'device': {
      const placement = catalog.kindOf(ref)?.placement;
      if (placement === 'connection') return 'spool';
      return placement === 'entity' ? 'placeable' : 'unknown';
    }
    default:
      return 'unknown';
  }
}

/** Whether a slot arms placement: only a placeable does (a tool or spool slot arms its flow instead). */
export function armsPlacement(catalog: Catalog, ref: CatalogRef | null): boolean {
  return beltSlotKind(catalog, ref) === 'placeable';
}

/** What the player sees for a belt slot: the entry's title, the prop's, `Empty`, or the raw id when unknown. */
export function beltSlotTitle(catalog: Catalog, ref: CatalogRef | null): string {
  if (ref === null) return 'Empty';
  const prop = builtinProp(ref);
  if (prop) return prop.title;
  const entry = catalog.tool(ref) ?? catalog.device(ref) ?? catalog.cable(ref) ?? catalog.accessory(ref);
  return entry?.title ?? `${ref.id} v${ref.version}`;
}

/** Something the player may put on the belt. */
export interface BeltChoice {
  readonly ref: CatalogRef;
  readonly title: string;
  /** For grouping in a picker. */
  readonly group: 'Props' | 'Tools';
}

/**
 * What a belt editor offers (F3.4 part 1): the built-in props, then every catalogue tool (newest
 * version of each id), each sorted by id. Conductor spools and cables join with F3.1 part 2, catalogue
 * devices with mouse placement of them (F3.5 part 1).
 */
export function beltChoices(catalog: Catalog): BeltChoice[] {
  const props = BUILTIN_PROPS.map((p) => ({
    ref: { id: p.id, version: BUILTIN_PROP_VERSION },
    title: p.title,
    group: 'Props' as const,
  }));
  const newest = new Map<string, ToolDefinition>();
  for (const tool of catalog.tools) newest.set(tool.id, tool); // sorted by id, then version
  const tools = [...newest.values()].map((t) => ({
    ref: { id: t.id, version: t.version },
    title: t.title,
    group: 'Tools' as const,
  }));
  return [...props, ...tools];
}

/**
 * Whether `tool` can perform `step` on a conductor of size `awg` (an integer AWG designation, or `null`
 * when no conductor is involved). The same rule the commands check (`checkTool`): a capability with no
 * size limit reaches every size; otherwise it reaches sizes up to its `maxAwg` (smaller is thicker).
 */
export function toolCan(tool: ToolDefinition, step: ToolStep, awg: number | null = null): boolean {
  return tool.capabilities.some((c) => c.step === step && (awg === null || c.maxAwg === null || awg >= c.maxAwg));
}

/** A tool picked for a step the player didn't pick one for, and where it came from. */
export interface DefaultTool {
  readonly tool: ToolDefinition;
  readonly ref: CatalogRef;
  /** The belt slot (1-9) it was found in, or `null` when it came from the catalogue (not on the belt). */
  readonly slot: number | null;
}

/**
 * The default-tool rule (ADR 0015): the first tool in `belt` (slot order) that can do `step` for `awg`,
 * else the first catalogue tool that can, by id (the newest version of that id), else `null` when no
 * tool in the catalogue can. `belt` is settings `toolBelt.slots` (index 0 is slot 1). For a step that
 * turns a screw, pass the screw's `drives`: only a tool whose drive types fit one counts (`wrong-drive`
 * otherwise).
 */
export function defaultTool(
  catalog: Catalog,
  belt: readonly (CatalogRef | null)[],
  step: ToolStep,
  awg: number | null = null,
  drives: readonly DriveType[] | null = null,
): DefaultTool | null {
  const suits = (tool: ToolDefinition) =>
    toolCan(tool, step, awg) && (drives === null || drivesFit(tool.drives, drives));
  for (let i = 0; i < belt.length; i++) {
    const ref = belt[i];
    const tool = ref && catalog.family(ref) === 'tool' ? catalog.tool(ref) : undefined;
    if (tool && suits(tool)) return { tool, ref: { id: tool.id, version: tool.version }, slot: i + 1 };
  }
  // `catalog.tools` is sorted by id, then version: the first matching id, at its newest matching version.
  let found: ToolDefinition | null = null;
  for (const tool of catalog.tools) {
    if (found !== null && tool.id !== found.id) break;
    if (suits(tool)) found = tool;
  }
  return found && { tool: found, ref: { id: found.id, version: found.version }, slot: null };
}

/** `Torque screwdriver, 1–5 N·m (belt slot 4)` or `… (not on the belt)`: how a prompt names a default tool. */
export function describeDefaultTool(choice: DefaultTool): string {
  return `${choice.tool.title} (${choice.slot === null ? 'not on the belt' : `belt slot ${choice.slot}`})`;
}
