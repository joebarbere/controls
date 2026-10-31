import { BUILTIN_CATALOG, type Catalog, checkBags, checkControlValue } from '@controls/catalog';
import { isBuiltinPropRef, type ValidationIssue } from '@controls/save-format';
import { findEntity } from './entity-commands';
import type { Entity, World } from './types';

/*
 * The load-time device check (ADR 0011 §10 step 1, ADR 0013): the world schema checks each state
 * bag's generic shape; this checks every bag, and every connection, against the device catalogue.
 * A failure is the load error `invalid-device-state`. Run on every world that enters a game: a
 * loaded save (`loadGame`), a level (`loadLevel`) and `createGame({ world })`.
 *
 * - An entity whose ref resolves to a catalogue device has exactly its model kind's keys in each bag,
 *   each valid for its key (`checkBags`), and each control's value inside the entry's control range
 *   (`checkControlValue`, the check `device.operate` applies).
 * - A built-in prop (`prop.*` at version 1) has no device state: both bags are empty.
 * - A ref the catalogue doesn't know (a mod's device, a later catalogue's) is left alone: its bags
 *   round-trip untouched like `extensions`, and the netlist compiler treats it as absent.
 * - A connection's ref, if the catalogue knows it, is a connection kind (a lead); each end's
 *   terminal exists on its entity's device. An end on a built-in prop is refused (props have no
 *   terminals); an end on an unknown device is left alone.
 */

/** At most this many device issues are reported. */
const MAX_ISSUES = 20;

/** Every way `world`'s device state and connections disagree with `catalog`. Empty when they agree. Never echoes values. */
export function checkWorldDevices(world: World, catalog: Catalog = BUILTIN_CATALOG): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  world.entities.forEach((entity, index) => {
    const at = `entities[${index}]`;
    if (isBuiltinPropRef(entity.ref)) {
      for (const bag of ['state', 'sim'] as const) {
        if (Object.keys(entity[bag]).length > 0) {
          issues.push({ path: `${at}.${bag}`, message: 'A built-in prop has no device state' });
        }
      }
      return;
    }
    const kind = catalog.kindOf(entity.ref);
    if (!kind) return;
    if (kind.placement !== 'entity') {
      issues.push({ path: `${at}.ref`, message: `${kind.kind} is a connection kind, not a placed device` });
      return;
    }
    for (const issue of checkBags(kind, entity.state, entity.sim)) {
      issues.push({ path: `${at}.${issue.path}`, message: issue.message });
    }
    // Each control's commanded value must be one `device.operate` could have set: a key's schema is
    // per kind (a setpoint ≥ 0), the control's range per entry (0–30 V), so a crafted save could
    // otherwise load a 1e9 V setpoint (F2.4 save-format review). Keys `checkBags` refused are skipped.
    const device = catalog.device(entity.ref);
    for (const control of device?.controls ?? []) {
      const value = entity.state[control.id];
      if (value === undefined || !kind.keys[control.id]?.schema.safeParse(value).success) continue;
      const check = checkControlValue(control, kind, value);
      if (!check.ok) issues.push({ path: `${at}.state.${control.id}`, message: check.message });
    }
  });
  world.connections.forEach((connection, index) => {
    const at = `connections[${index}]`;
    const kind = catalog.kindOf(connection.ref);
    if (kind && kind.placement !== 'connection') {
      issues.push({ path: `${at}.ref`, message: `${kind.kind} is not a connection kind` });
    }
    for (const end of ['a', 'b'] as const) {
      const entity = findEntity(world, connection[end].entity) as Entity; // the schema guarantees it exists
      const problem = terminalProblem(entity, connection[end].terminal, catalog);
      if (problem === 'prop') {
        issues.push({ path: `${at}.${end}.terminal`, message: 'A built-in prop has no terminals' });
      } else if (problem === 'unknown-terminal') {
        issues.push({ path: `${at}.${end}.terminal`, message: "Not a terminal of the entity's device" });
      }
    }
  });
  return issues.slice(0, MAX_ISSUES);
}

/**
 * Why `terminal` can't be an end of a connection on `entity`: `prop` (built-in props have no
 * terminals), `unknown-terminal` (its device has no such terminal), or `null` (it can, or the
 * catalogue doesn't know the device).
 */
export function terminalProblem(
  entity: Entity,
  terminal: string,
  catalog: Catalog = BUILTIN_CATALOG,
): 'prop' | 'unknown-terminal' | null {
  if (isBuiltinPropRef(entity.ref)) return 'prop';
  const device = catalog.device(entity.ref);
  if (!device) return null;
  return device.terminals.some((t) => t.id === terminal) ? null : 'unknown-terminal';
}
