import type { Catalog } from '@controls/catalog';
import { findEntity } from '../entity-commands';
import { entityPointMm, rotateQuarterTurns } from '../snap/quarter-turn';
import type { EntityId, PositionMm, World } from '../types';
import { UNIT } from './vec';

/*
 * Where a route starts and ends (ADR 0017): a terminal's method entry point (`entryMm`, in the world
 * through the exact quarter-turn helper) and the direction a conductor leaves it (`exitAxis`, turned
 * with the device). The command, `routeDefaultLengthMm`'s surfaces, the router and the bake all read
 * the same point, so a proposed route's floor is exactly the one the command checks.
 */

/** A terminal a route runs from or to: an end argument's entity and terminal, and the method it lands by. */
export interface RouteTerminal {
  readonly entity: EntityId;
  readonly terminal: string;
  /** `'auto'` (or absent): the terminal's first method, as `'auto'` lands it; else the named method. */
  readonly termination?: 'auto' | { readonly method: string };
}

/** A terminal's place in the world. */
export interface TerminalPlace {
  readonly entity: EntityId;
  /** The method's entry point, world integer mm (the route's end point). */
  readonly point: PositionMm;
  /** The integer unit vector the conductor leaves along. */
  readonly exit: PositionMm;
}

export type TerminalPlaceResult =
  | ({ readonly ok: true } & TerminalPlace)
  | {
      readonly ok: false;
      readonly code: 'not-found' | 'unknown-terminal' | 'wrong-method' | 'not-axis-aligned';
      readonly message: string;
    };

/** The place of `end` in `world`, or why it has none (the codes the command would refuse with). */
export function terminalPlace(world: World, catalog: Catalog, end: RouteTerminal): TerminalPlaceResult {
  const entity = findEntity(world, end.entity);
  if (!entity) return { ok: false, code: 'not-found', message: `No entity with id ${end.entity}` };
  const terminal = catalog.device(entity.ref)?.terminals.find((t) => t.id === end.terminal);
  if (!terminal) {
    return { ok: false, code: 'unknown-terminal', message: `Entity ${end.entity} has no terminal "${end.terminal}"` };
  }
  const termination = end.termination ?? 'auto';
  const spec =
    termination === 'auto' ? terminal.methods[0] : terminal.methods.find((m) => m.method === termination.method);
  if (!spec) {
    return {
      ok: false,
      code: 'wrong-method',
      message: `Terminal "${end.terminal}" of entity ${end.entity} takes no such termination`,
    };
  }
  const point = entityPointMm(entity.transform, spec.entryMm);
  const exit = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT[spec.exitAxis]);
  if (point === null || exit === null) {
    return { ok: false, code: 'not-axis-aligned', message: `Entity ${end.entity} isn't at quarter-turns` };
  }
  return { ok: true, entity: entity.id, point, exit };
}
