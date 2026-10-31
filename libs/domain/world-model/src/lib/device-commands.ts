import { BUILTIN_CATALOG, type Catalog, checkControlValue } from '@controls/catalog';
import {
  type AnyCommandDef,
  defineCommand,
  entityRefMeta,
  fail,
  SELECTION_ENTITY_ID_KEY,
  succeed,
  VIEWPORT_FOCUSED_KEY,
} from '@controls/commands';
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
 * UI context key: the selected device's first toggle control (`closed` on a switch), absent when the
 * selection has none. The viewport publishes it with {@link SELECTION_TOGGLE_VALUE_KEY} from the
 * selected entity's catalogue entry and commanded state (F2.5).
 */
export const SELECTION_TOGGLE_CONTROL_KEY = 'selection.toggleControl';
/** UI context key: the value that toggle would take, the opposite of its commanded state now. */
export const SELECTION_TOGGLE_VALUE_KEY = 'selection.toggleValue';
/** Binding id of the operate key: `device.operate` on the selection's toggle, to its other position. */
export const DEVICE_OPERATE_SELECTION_BINDING = 'device.operate.selection';

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
    // E in the viewport flips the selected device's toggle (a switch's contacts, F2.5): all three
    // arguments come from the context, so the log holds the concrete id, control and value.
    bindings: [
      {
        id: DEVICE_OPERATE_SELECTION_BINDING,
        title: 'Operate the selected device (flip its switch)',
        category: 'Device',
        target: {
          kind: 'command',
          command: 'device.operate',
          args: {},
          contextArgs: {
            id: SELECTION_ENTITY_ID_KEY,
            control: SELECTION_TOGGLE_CONTROL_KEY,
            value: SELECTION_TOGGLE_VALUE_KEY,
          },
        },
        defaults: ['E'],
        when: `${VIEWPORT_FOCUSED_KEY} && ${SELECTION_TOGGLE_CONTROL_KEY}`,
      },
    ],
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

/**
 * What the operate key would do to entity `id` (F2.5): its first toggle control and the value that
 * flips it, from the catalogue entry and the entity's **commanded** state only (never its `sim` bag:
 * a tripped breaker's handle is still where the player left it). `null` when the entity doesn't exist,
 * isn't a catalogue device, or has no toggle. The viewport publishes it as the
 * {@link SELECTION_TOGGLE_CONTROL_KEY} and {@link SELECTION_TOGGLE_VALUE_KEY} context keys.
 */
export function selectionToggle(
  world: World,
  id: number,
  catalog: Catalog = BUILTIN_CATALOG,
): { readonly control: string; readonly value: boolean } | null {
  const entity = findEntity(world, id);
  if (!entity) return null;
  const toggle = catalog.device(entity.ref)?.controls.find((c) => c.type === 'toggle');
  if (toggle === undefined) return null;
  return { control: toggle.id, value: entity.state[toggle.id] !== true };
}

/** The device commands, in a fixed order, resolving refs against `catalog`. */
export function deviceCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [deviceOperateCommand(catalog)];
}
