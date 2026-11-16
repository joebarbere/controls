import type { Catalog } from '@controls/catalog';
import {
  type Cable,
  type CableLabelArgs,
  type CableStripArgs,
  type CatalogRef,
  checkTailReach,
  type Connection,
  defaultTool,
  maxStripAtBoxMm,
  type PositionMm,
  toolCan,
  type WireLabelArgs,
  type World,
} from '@controls/world-model';
import { describeEntry } from './cable-gesture';
import { refKey, type ToolOption, toolsAtHand } from './termination-model';

/*
 * The cable prompts' models (F3.2 part 4), pure so they are unit-tested without Angular:
 *
 * - **Strip** (`cable.strip` per end): the jacket length to strip at each end, bounded by the tail and,
 *   at a box end, by the 6.35 mm of sheath that stays inside the box (`maxStripAtBoxMm`, NFPA 70
 *   Art. 314.17 by number); the stripper is the default-tool rule's (`stripJacket`), changeable. At
 *   Trainee and Apprentice the lengths start at the most a box allows; at Journeyman and Realistic they
 *   start blank. A blank end is left as it is.
 * - **Landing** a cable conductor's free end (`wire.land`): which end a terminal pick lands (the free
 *   end whose stripped tail reaches the terminal, `checkTailReach`), and the conductors left to land.
 * - **Labels** (`wire.label` / `cable.label`) with a label maker: the text and the tool.
 *
 * Every refusal comes from the command's own `run` (`precheck`), never a copy.
 */

/** A form field's problem: which field, and what to tell the player. */
export interface PromptProblem {
  readonly field: string;
  readonly message: string;
}

/** One end of a cable in the strip prompt. */
export interface StripEnd {
  readonly end: 'a' | 'b';
  /** `in 2-gang nonmetallic box #1, entry clamp-top-1` or `free`. */
  readonly place: string;
  readonly tailMm: number;
  readonly strippedMm: number;
  /** The most `cable.strip` accepts here: the tail, less the sheath that stays in a box. */
  readonly maxMm: number;
}

export interface StripDraft {
  /** A stripper key (`id@version`), or `null`. */
  readonly tool: string | null;
  readonly a: string;
  readonly b: string;
}

export interface StripRequest {
  readonly cableId: number;
  readonly cableTitle: string;
  readonly ends: readonly StripEnd[];
  readonly strippers: readonly ToolOption[];
  readonly draft: StripDraft;
}

const cableOf = (world: World, id: number): Cable | undefined => world.cables.find((c) => c.id === id);

/** The cable's conductors in assembly order. */
export function cableConductors(world: World, cableId: number): Connection[] {
  return world.connections
    .filter((c) => c.cable?.id === cableId)
    .sort((p, q) => (p.cable?.conductor ?? 0) - (q.cable?.conductor ?? 0));
}

/** The largest conductor's AWG in a cable (smaller is thicker), or `null` when the catalogue doesn't know them. */
function cableAwg(world: World, catalog: Catalog, cableId: number): number | null {
  const awgs = cableConductors(world, cableId)
    .map((c) => catalog.device(c.ref)?.conductor?.awg)
    .filter((awg): awg is number => awg !== undefined);
  return awgs.length > 0 ? Math.min(...awgs) : null;
}

/** The strip prompt for cable `cableId`, or why there is none (`not-found`). */
export function stripRequest(
  world: World,
  catalog: Catalog,
  belt: readonly (CatalogRef | null)[],
  cableId: number,
):
  | { readonly ok: true; readonly request: StripRequest }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const cable = cableOf(world, cableId);
  if (!cable) return { ok: false, code: 'not-found', message: `No cable with id ${cableId}` };
  const awg = cableAwg(world, catalog, cableId);
  const ends: StripEnd[] = (['a', 'b'] as const).map((end) => {
    const at = cable[end];
    const tailMm = cable.tailsMm[end];
    return {
      end,
      place: at ? `in ${describeEntry(world, catalog, at)}` : 'free',
      tailMm,
      strippedMm: cable.jacketStripMm[end],
      maxMm: at ? Math.max(0, maxStripAtBoxMm(tailMm)) : tailMm,
    };
  });
  const prefill = world.difficulty === 'trainee' || world.difficulty === 'apprentice';
  const start = (e: StripEnd) => (prefill && e.strippedMm < e.maxMm ? String(e.maxMm) : '');
  const tool = defaultTool(catalog, belt, 'stripJacket', awg)?.ref;
  return {
    ok: true,
    request: {
      cableId,
      cableTitle: catalog.cable(cable.ref)?.title ?? cable.ref.id,
      ends,
      strippers: toolsAtHand(catalog, belt).filter((t) => toolCan(t.tool, 'stripJacket', awg)),
      draft: { tool: tool ? refKey(tool) : null, a: start(ends[0]), b: start(ends[1]) },
    },
  };
}

/** The strip draft's blank or malformed fields, in form order. A blank length leaves that end alone. */
export function stripDraftProblems(request: StripRequest, draft: StripDraft): PromptProblem[] {
  const problems: PromptProblem[] = [];
  if (!request.strippers.some((t) => t.key === draft.tool)) {
    problems.push({ field: 'tool', message: 'Choose a cable stripper.' });
  }
  for (const e of request.ends) {
    const text = draft[e.end].trim();
    if (text !== '' && !/^\d{1,4}$/.test(text)) {
      problems.push({ field: e.end, message: `Enter end ${e.end}'s jacket length in whole millimetres.` });
    }
  }
  if (problems.length === 0 && request.ends.every((e) => draft[e.end].trim() === '')) {
    problems.push({ field: 'a', message: 'Enter how much jacket to strip at one end at least.' });
  }
  return problems;
}

/** The draft as one `cable.strip` per filled-in end, or `null` while a field is blank or malformed. */
export function stripArgs(request: StripRequest, draft: StripDraft): CableStripArgs[] | null {
  if (stripDraftProblems(request, draft).length > 0) return null;
  const tool = request.strippers.find((t) => t.key === draft.tool) as ToolOption;
  return request.ends
    .filter((e) => draft[e.end].trim() !== '')
    .map((e) => ({ id: request.cableId, end: e.end, jacketMm: Number(draft[e.end].trim()), tool: { ...tool.ref } }));
}

/** A cable conductor with a free end, as the landing flow holds it. */
export interface LandingTarget {
  readonly conductor: Connection;
  readonly cable: Cable;
  /** Its free ends, `a` first. */
  readonly freeEnds: readonly ('a' | 'b')[];
  /** `black conductor 1 of cable 2 (wire 4)`. */
  readonly title: string;
}

/** Conductor `id` as a landing target, or why it can't be one. */
export function landingTarget(
  world: World,
  id: number,
):
  | { readonly ok: true; readonly target: LandingTarget }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const conductor = world.connections.find((c) => c.id === id);
  if (!conductor) return { ok: false, code: 'not-found', message: `No wire with id ${id}` };
  const cable = conductor.cable && cableOf(world, conductor.cable.id);
  if (!conductor.cable || !cable) {
    return {
      ok: false,
      code: 'not-a-cable-conductor',
      message: `Wire ${id} isn't a cable conductor: route it instead`,
    };
  }
  const freeEnds = (['a', 'b'] as const).filter((end) => conductor[end] === null);
  if (freeEnds.length === 0)
    return { ok: false, code: 'already-landed', message: `Both ends of wire ${id} are landed` };
  const colour = conductor.colour ? conductor.colour.base : 'conductor';
  const title = `${colour} conductor ${conductor.cable.conductor + 1} of cable ${cable.id} (wire ${id})`;
  return { ok: true, target: { conductor, cable, freeEnds, title } };
}

/**
 * Which free end a terminal at `terminalMm` lands: the first free end whose stripped tail reaches it
 * (`checkTailReach`), else the first free end (the command then refuses it, `tail-too-short`).
 */
export function landingEnd(world: World, catalog: Catalog, target: LandingTarget, terminalMm: PositionMm): 'a' | 'b' {
  for (const end of target.freeEnds) {
    if (checkTailReach(world, catalog, target.cable, end, terminalMm) === null) return end;
  }
  return target.freeEnds[0];
}

/**
 * The next conductor of the same cable with end `end` still free after `id` (assembly order, wrapping),
 * or `null`: landing goes on at the same end of the cable.
 */
export function nextToLand(world: World, cableId: number, id: number, end: 'a' | 'b'): number | null {
  const conductors = cableConductors(world, cableId);
  const index = conductors.findIndex((c) => c.id === id);
  for (let i = 1; i <= conductors.length; i++) {
    const c = conductors[(index + i) % conductors.length];
    if (c.id !== id && c[end] === null) return c.id;
  }
  return null;
}

/** What the label prompt labels. */
export type LabelTarget =
  { readonly kind: 'connection'; readonly id: number } | { readonly kind: 'cable'; readonly id: number };

export interface LabelRequest {
  readonly target: LabelTarget;
  /** `Wire 4` / `Cable 1, NM-B 14/2 …`. */
  readonly title: string;
  readonly current: string | null;
  readonly makers: readonly ToolOption[];
  readonly draft: LabelDraft;
}

export interface LabelDraft {
  readonly tool: string | null;
  readonly text: string;
}

/** The label prompt for `target`, or why there is none (`not-found`). */
export function labelRequest(
  world: World,
  catalog: Catalog,
  belt: readonly (CatalogRef | null)[],
  target: LabelTarget,
):
  | { readonly ok: true; readonly request: LabelRequest }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  let title: string;
  let current: string | null;
  if (target.kind === 'cable') {
    const cable = cableOf(world, target.id);
    if (!cable) return { ok: false, code: 'not-found', message: `No cable with id ${target.id}` };
    title = `Cable ${cable.id}, ${catalog.cable(cable.ref)?.title ?? cable.ref.id}`;
    current = cable.label;
  } else {
    const wire = world.connections.find((c) => c.id === target.id);
    if (!wire) return { ok: false, code: 'not-found', message: `No wire with id ${target.id}` };
    const colour = wire.colour ? `${wire.colour.base} ` : '';
    title = wire.cable ? `Wire ${wire.id}, the ${colour}conductor of cable ${wire.cable.id}` : `Wire ${wire.id}`;
    current = wire.label;
  }
  const tool = defaultTool(catalog, belt, 'label', null)?.ref;
  return {
    ok: true,
    request: {
      target,
      title,
      current,
      makers: toolsAtHand(catalog, belt).filter((t) => toolCan(t.tool, 'label', null)),
      draft: { tool: tool ? refKey(tool) : null, text: current ?? '' },
    },
  };
}

/**
 * The draft as the logged command (`wire.label` or `cable.label`), or the field problem. Empty text
 * removes the label (`text: null`); the text's own rules (printable ASCII, 1 to 32 characters) are
 * the command schema's, checked by `precheck`.
 */
export function labelCommand(
  request: LabelRequest,
  draft: LabelDraft,
):
  | { readonly ok: true; readonly id: 'wire.label' | 'cable.label'; readonly args: WireLabelArgs | CableLabelArgs }
  | { readonly ok: false; readonly problem: PromptProblem } {
  const tool = request.makers.find((t) => t.key === draft.tool);
  if (!tool) return { ok: false, problem: { field: 'tool', message: 'Choose a label maker.' } };
  const text = draft.text === '' ? null : draft.text;
  if (text === null && request.current === null) {
    return { ok: false, problem: { field: 'text', message: 'Type the label text.' } };
  }
  const args = { id: request.target.id, text, tool: { ...tool.ref } };
  return { ok: true, id: request.target.kind === 'cable' ? 'cable.label' : 'wire.label', args };
}
