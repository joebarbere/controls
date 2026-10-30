import { BUILTIN_CATALOG, type Catalog, checkControlValue } from '@controls/catalog';
import { type AnyCommandDef, defineCommand, entityRefMeta, fail, succeed } from '@controls/commands';
import { DeviceStateKey, FiniteNumber, Int, MAX_DEVICE_STATE_STRING, SafeString } from '@controls/save-format';
import { z } from 'zod';
import { findEntity } from './entity-commands';
import type { World } from './types';

/*
 * Operating a device (plan P2, ADR 0011 §1, ADR 0013): `device.operate {id, control, value}` sets one
 * of the device's controls, which is one of its commanded state keys (a switch's `closed`, from F2.4
 * a supply's setpoint, from F2.5 a breaker's handle). It records intent only: `run` reads the
 * device's commanded `state` and the catalogue, **never its sim-owned `sim` bag** (tripped, blown,
 * charge), and the simulator resolves the effect at the command's tick. So `exec` stays synchronous
 * and replay stays exact. A property test checks that the result doesn't depend on the `sim` bag.
 *
 * The id and argument shape are save format; the JSON Schema is frozen in `json-schema/command-args/`.
 */

/**
 * A control's value: `true`/`false` for a toggle, a number for a setpoint, an option for a selector.
 * One JSON scalar; the palette's form offers a text field for it, and the console types the word.
 */
export const DeviceControlValue = z
  .union([z.boolean(), FiniteNumber, SafeString.min(1).max(MAX_DEVICE_STATE_STRING)])
  .meta({
    title: 'Value',
    description: 'true or false for a switch; a number for a setpoint; an option for a selector',
  });
export type DeviceControlValue = z.infer<typeof DeviceControlValue>;

export const DeviceOperateArgs = z.strictObject({
  id: Int.min(1).meta({ ...entityRefMeta, title: 'Device' }),
  control: DeviceStateKey.meta({ title: 'Control', description: 'The control to set (a switch has closed)' }),
  value: DeviceControlValue,
});
export type DeviceOperateArgs = z.infer<typeof DeviceOperateArgs>;

/**
 * `device.operate {id, control, value}`: sets a device's control. Undo restores the previous value.
 * Refused: a missing entity (`not-found`), an entity that isn't a catalogue device (`not-a-device`), a
 * control the device doesn't have (`unknown-control`), and a value the control doesn't take
 * (`invalid-value`). Setting a control to the value it already has succeeds (and is logged): it
 * records the player's intent.
 */
export function deviceOperateCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<DeviceOperateArgs, World>({
    id: 'device.operate',
    title: 'Operate a device',
    category: 'Device',
    args: DeviceOperateArgs,
    undoable: true,
    run: ({ state }, { id, control, value }) => {
      const entity = findEntity(state, id);
      if (!entity) return fail('not-found', `No entity with id ${id}`);
      const device = catalog.device(entity.ref);
      const kind = catalog.kindOf(entity.ref);
      if (!device || !kind) return fail('not-a-device', `Entity ${id} is not a device with controls`);
      const def = device.controls.find((c) => c.id === control);
      if (!def) {
        const names = device.controls.map((c) => c.id).join(', ') || 'none';
        return fail('unknown-control', `${device.title} has no control "${control}" (controls: ${names})`);
      }
      const check = checkControlValue(def, kind, value);
      if (!check.ok) return fail('invalid-value', check.message);
      // Only the commanded bag changes; the entity's `sim` bag stays the same object (ADR 0011 §1).
      const before = entity.state;
      const after = { ...before, [control]: value };
      const setState = (bag: typeof before) => (w: World) => ({
        ...w,
        entities: w.entities.map((e) => (e.id === id ? { ...e, state: bag } : e)),
      });
      return succeed({ apply: setState(after), invert: setState(before) });
    },
  });
}

/** The device commands, in a fixed order, resolving refs against `catalog`. */
export function deviceCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [deviceOperateCommand(catalog)];
}
