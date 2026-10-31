import { BUILTIN_CATALOG, catalogOrThrow, MODEL_KINDS, type ModelKindDef } from '@controls/catalog';
import { createWorld, FiniteNumber } from '@controls/save-format';
import { stateBagArb } from '@controls/save-format/testing';
import fc from 'fast-check';
import { z } from 'zod';
import { bindingArgs, defaultBindingDecls, SELECTION_ENTITY_ID_KEY } from '@controls/commands';
import {
  DEVICE_OPERATE_SELECTION_BINDING,
  deviceOperateCommand,
  SELECTION_TOGGLE_CONTROL_KEY,
  SELECTION_TOGGLE_VALUE_KEY,
  selectionToggle,
} from './device-commands';
import { createWorldBus, createWorldRegistry } from './session';

const SPST = { id: 'switch.tessaline-spst-toggle', version: 1 };
const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const origin = { x: 0, y: 0, z: 0 };

function withSwitch() {
  const bus = createWorldBus(createWorldWithSeed());
  bus.exec('entity.place', { ref: SPST, positionMm: origin });
  bus.exec('entity.place', { ref: BATTERY, positionMm: origin });
  bus.exec('entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: origin });
  return bus;
}

const createWorldWithSeed = () => createWorld({ seed: 11 });

describe('device.operate', () => {
  it('sets a commanded control; undo restores it; the sim bag is untouched', () => {
    const bus = withSwitch();
    const before = bus.state;
    expect(bus.exec('device.operate', { id: 1, control: 'closed', value: true })).toMatchObject({
      ok: true,
      entry: { id: 'device.operate', args: { id: 1, control: 'closed', value: true } },
    });
    expect(bus.state.entities[0].state).toStrictEqual({ closed: true });
    expect(bus.state.entities[0].sim).toBe(before.entities[0].sim);
    expect(bus.state.entities[1]).toBe(before.entities[1]);
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
  });

  it('setting the value it already has succeeds and is logged (it records intent)', () => {
    const bus = withSwitch();
    expect(bus.exec('device.operate', { id: 1, control: 'closed', value: false }).ok).toBe(true);
    expect(bus.entries.at(-1)?.id).toBe('device.operate');
  });

  it.each([
    ['a missing entity', { id: 9, control: 'closed', value: true }, 'not-found'],
    ['a prop', { id: 3, control: 'closed', value: true }, 'not-a-device'],
    ['a device without that control', { id: 1, control: 'open', value: true }, 'unknown-control'],
    ['a device with no controls', { id: 2, control: 'closed', value: true }, 'unknown-control'],
    ['a value the control doesn’t take', { id: 1, control: 'closed', value: 1 }, 'invalid-value'],
    ['a string for a toggle', { id: 1, control: 'closed', value: 'on' }, 'invalid-value'],
  ])('refuses %s', (_name, args, code) => {
    const bus = withSwitch();
    const before = bus.state;
    expect(bus.exec('device.operate', args)).toMatchObject({ ok: false, error: { kind: 'rejected', code } });
    expect(bus.state).toBe(before);
  });

  it('names the device’s controls when the control is unknown', () => {
    const bus = withSwitch();
    expect(bus.exec('device.operate', { id: 1, control: 'open', value: true })).toMatchObject({
      error: { message: 'SPST toggle switch on a base has no control "open" (controls: closed)' },
    });
    expect(bus.exec('device.operate', { id: 2, control: 'x', value: true })).toMatchObject({
      error: { message: '12 V 7 Ah sealed lead-acid battery has no control "x" (controls: none)' },
    });
  });

  it('refuses malformed args: values are a boolean, a finite number or a short string', () => {
    const bus = withSwitch();
    for (const value of [null, [true], { on: true }, '', 'x'.repeat(33), Number.NaN]) {
      expect(bus.exec('device.operate', { id: 1, control: 'closed', value })).toMatchObject({
        ok: false,
        error: { kind: 'invalid-args' },
      });
    }
  });

  it('never reads sim-owned state: the result doesn’t depend on the sim bag (ADR 0011 §1, property)', () => {
    fc.assert(
      fc.property(stateBagArb, fc.boolean(), (simBag, value) => {
        const base = withSwitch().state;
        const tampered = { ...base, entities: base.entities.map((e) => (e.id === 1 ? { ...e, sim: simBag } : e)) };
        const plain = createWorldBus(base);
        const odd = createWorldBus(tampered as typeof base);
        const a = plain.exec('device.operate', { id: 1, control: 'closed', value });
        const b = odd.exec('device.operate', { id: 1, control: 'closed', value });
        expect(b).toStrictEqual(a);
        expect(odd.state.entities[0].state).toStrictEqual(plain.state.entities[0].state);
        expect(odd.state.entities[0].sim).toBe(tampered.entities[0].sim);
      }),
    );
  });

  it('checks setpoints and selectors against the control (synthetic catalogue)', () => {
    const kinds: Record<string, ModelKindDef> = {
      ...MODEL_KINDS,
      'supply.test': {
        kind: 'supply.test',
        placement: 'entity',
        terminals: ['neg', 'pos'],
        params: z.strictObject({}),
        keys: {
          setpointV: {
            owner: 'commanded',
            type: 'number',
            schema: FiniteNumber.min(0).max(30),
            initial: 0,
            values: null,
            description: 'test',
          },
          handle: {
            owner: 'commanded',
            type: 'enum',
            schema: z.enum(['off', 'on']),
            initial: 'off',
            values: ['off', 'on'],
            description: 'test',
          },
        },
        description: 'test',
      },
    };
    const supply = {
      id: 'supply.test-bench',
      version: 1,
      title: 'Test supply',
      brand: 'Testbrand',
      modelName: 'S-1',
      category: 'source',
      sizeMm: { widthMm: 10, heightMm: 10, depthMm: 10 },
      terminals: [
        { id: 'neg', label: '-', positionMm: origin },
        { id: 'pos', label: '+', positionMm: origin },
      ],
      model: { kind: 'supply.test', params: {} },
      controls: [
        { id: 'setpointV', label: 'Voltage', type: 'setpoint', unit: 'V', min: 0, max: 20, step: 0.1 },
        { id: 'handle', label: 'Handle', type: 'selector', options: ['off', 'on'] },
      ],
      sources: [{ id: 's', kind: 'game-design', citation: 'test', covers: ['sizeMm', 'terminals'] }],
      extensions: {},
    };
    const catalog = catalogOrThrow(1, [...BUILTIN_CATALOG.devices, supply], kinds);
    const bus = createWorldBus(createWorldWithSeed(), createWorldRegistry({ catalog }));
    bus.exec('entity.place', { ref: { id: 'supply.test-bench', version: 1 }, positionMm: origin });
    expect(bus.state.entities[0].state).toStrictEqual({ handle: 'off', setpointV: 0 });
    expect(bus.exec('device.operate', { id: 1, control: 'setpointV', value: 12.5 }).ok).toBe(true);
    expect(bus.exec('device.operate', { id: 1, control: 'setpointV', value: 25 })).toMatchObject({
      error: { code: 'invalid-value', message: 'Voltage takes a number from 0 to 20 V' },
    });
    expect(bus.exec('device.operate', { id: 1, control: 'handle', value: 'on' }).ok).toBe(true);
    expect(bus.state.entities[0].state).toStrictEqual({ handle: 'on', setpointV: 12.5 });
    expect(deviceOperateCommand(catalog).id).toBe('device.operate');
  });
});

describe('the operate key (F2.5): device.operate on the selection, one logged command', () => {
  it('selectionToggle names the first toggle and the value that flips it, from commanded state only', () => {
    const bus = withSwitch();
    expect(selectionToggle(bus.state, 1)).toStrictEqual({ control: 'closed', value: true });
    bus.exec('device.operate', { id: 1, control: 'closed', value: true });
    expect(selectionToggle(bus.state, 1)).toStrictEqual({ control: 'closed', value: false });
    expect(selectionToggle(bus.state, 2)).toBeNull(); // a battery has no toggle
    expect(selectionToggle(bus.state, 3)).toBeNull(); // a prop is not a device
    expect(selectionToggle(bus.state, 9)).toBeNull();
    // The sim bag never decides it.
    const withSim = { ...bus.state, entities: bus.state.entities.map((e) => ({ ...e, sim: { closed: false } })) };
    expect(selectionToggle(withSim, 1)).toStrictEqual({ control: 'closed', value: false });
  });

  it('E in the viewport runs device.operate with the id, control and value from the context keys', () => {
    const decls = defaultBindingDecls(createWorldRegistry()).filter((d) => d.id === DEVICE_OPERATE_SELECTION_BINDING);
    expect(decls).toHaveLength(1);
    const [decl] = decls;
    expect(decl.defaults).toStrictEqual(['E']);
    expect(decl.when).toBe(`viewport.focused && ${SELECTION_TOGGLE_CONTROL_KEY}`);
    const bus = withSwitch();
    const context = {
      'viewport.focused': true,
      [SELECTION_ENTITY_ID_KEY]: 1,
      [SELECTION_TOGGLE_CONTROL_KEY]: 'closed',
      [SELECTION_TOGGLE_VALUE_KEY]: true,
    };
    const args = bindingArgs(decl.target, context);
    expect(args).toStrictEqual({ id: 1, control: 'closed', value: true });
    const entries = bus.entries.length;
    expect(bus.exec('device.operate', args).ok).toBe(true);
    expect(bus.entries.length).toBe(entries + 1);
    expect(bus.state.entities[0].state['closed']).toBe(true);
  });
});
