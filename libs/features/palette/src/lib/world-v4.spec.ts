import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { argOptionChoices, createWorldBus, createWorldRegistry, worldHash } from '@controls/world-model';
import { RESIDENTIAL_TEST_CATALOG, residentialBench } from '@controls/world-model/testing';
import {
  type ArgForm,
  type ArgValues,
  argsFromValues,
  buildArgForm,
  initialValues,
  siblingValues,
  type StringField,
  validateArgs,
} from './arg-form';
import { type FieldSuggestions, PaletteArgForm } from './palette-arg-form';

/*
 * The world v4 commands through the palette's generated forms (P4 PR 8; ADR 0019 "Palette hints"):
 * every new command's form renders, its suggestion hints read the world, only the first entity
 * reference takes the selection, and typing the same steps as the console file and the script in
 * `libs/domain/scripting-api/src/lib/world-v4.spec.ts` reaches the same pinned `world.hash`. TEST-ONLY
 * content (`RESIDENTIAL_TEST_CATALOG`'s residential bench).
 */

/** Pinned in `libs/domain/scripting-api/src/lib/world-v4.spec.ts` too: change both together. */
const HASH = 'e8f60acef5e3286c1b60457d11204573b5e614e0221d8eb7434ed976a58ddad3';

const registry = createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG });

function formFor(id: string): ArgForm {
  const command = registry.get(id);
  if (!command) throw new Error(`${id} missing`);
  const built = buildArgForm(command.args);
  if (!built.ok) throw new Error(built.reason);
  return built.form;
}

describe('the world v4 commands in the palette', () => {
  it('builds a form for each, with suggestion hints on the outlet, tape, space and button fields', () => {
    const hint = (id: string, key: string) =>
      (formFor(id).fields.find((f) => f.key === key) as StringField | undefined)?.options ?? null;
    expect(hint('plug.insert', 'outlet')).toStrictEqual({ from: 'outlets', entity: 'receptacle' });
    expect(hint('wire.mark', 'colour')).toStrictEqual({ from: 'colours', except: ['bare'] });
    expect(hint('panel.directory', 'space')).toStrictEqual({ from: 'directorySpaces', entity: 'id' });
    expect(hint('device.press', 'control')).toStrictEqual({ from: 'controls', entity: 'id', type: 'momentary' });
    expect(hint('plug.remove', 'appliance')).toBeNull();
    expect(formFor('wire.mark').fields.find((f) => f.key === 'colour')).toMatchObject({
      kind: 'string',
      nullable: true,
    });
  });

  it('prefills only the first entity reference from the selection (plug.insert’s appliance)', () => {
    expect(initialValues(formFor('plug.insert'), { selectedEntityId: 2 })).toStrictEqual({
      appliance: '2',
      receptacle: '',
      outlet: '',
    });
    const lead = initialValues(formFor('lead.connect'), { selectedEntityId: 7 });
    expect([lead['a.entity'], lead['b.entity']]).toStrictEqual(['7', '']);
  });

  it('suggests the outlets of the receptacle typed beside the outlet field', () => {
    const world = residentialBench().state;
    const form = formFor('plug.insert');
    const outlet = form.fields.find((f) => f.key === 'outlet') as StringField;
    const values: ArgValues = { appliance: '2', receptacle: '1', outlet: '' };
    expect(siblingValues(outlet, values)).toStrictEqual(values);
    const options = outlet.options;
    if (options === null) throw new Error('no hint');
    expect(
      argOptionChoices(world, options, siblingValues(outlet, values), RESIDENTIAL_TEST_CATALOG).map((o) => o.value),
    ).toStrictEqual(['top', 'bottom']);
  });

  it('typing the console file’s steps into the forms reaches the same world.hash', () => {
    const bus = createWorldBus(residentialBench().state, registry);
    const steps: [string, Record<string, string>][] = [
      ['plug.insert', { appliance: '2', receptacle: '1', outlet: 'top' }],
      ['wire.mark', { id: '1', end: '1', colour: 'red' }], // `end` is a select: option 1 is "b"
      ['panel.directory', { id: '4', space: '3', text: 'KITCHEN COUNTER' }],
      ['panel.directory', { id: '4', space: '4', text: 'null' }], // typed text "null" is text
      ['panel.directory', { id: '4', space: '3', text: '' }], // blank clears (null)
      ['panel.directory', { id: '4', space: '1', text: 'BATH' }],
      ['device.press', { id: '6', control: 'test' }],
      ['device.press', { id: '6', control: 'test' }],
      ['plug.remove', { appliance: '2' }],
      ['plug.insert', { appliance: '3', receptacle: '1', outlet: 'bottom' }],
      ['edit.undo', {}],
      ['edit.redo', {}],
    ];
    for (const [id, typed] of steps) {
      const form = formFor(id);
      const values = { ...initialValues(form, { selectedEntityId: null }), ...typed };
      const command = registry.get(id);
      if (!command) throw new Error(`${id} missing`);
      const checked = validateArgs(command.args, form, argsFromValues(form, values), values);
      if (!checked.ok) throw new Error(`${id}: ${JSON.stringify(checked.errors)}`);
      expect([id, bus.exec(id, checked.args).ok]).toStrictEqual([id, true]);
    }
    expect(worldHash(bus.state)).toBe(HASH);
  });
});

@Component({
  selector: 'ctl-world-v4-form-host',
  imports: [PaletteArgForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-palette-arg-form
    commandTitle="Plug in an appliance"
    [form]="form"
    [(values)]="values"
    [suggestions]="suggestions"
  />`,
})
class Host {
  readonly form = formFor('plug.insert');
  readonly values = signal<ArgValues>({ appliance: '2', receptacle: '1', outlet: '' });
  readonly suggestions: FieldSuggestions = (field, values) =>
    (field.kind === 'string' || field.kind === 'number') && field.options !== null
      ? argOptionChoices(
          residentialBench().state,
          field.options,
          siblingValues(field, values),
          RESIDENTIAL_TEST_CATALOG,
        )
      : [];
}

describe('PaletteArgForm suggestions', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  it('offers a hinted field’s suggestions as a datalist the text field lists', async () => {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector<HTMLInputElement>('input[id$="-outlet"]');
    const listId = input?.getAttribute('list');
    expect(listId).toBeTruthy();
    const options = [...(root.querySelector(`datalist[id="${listId}"]`)?.querySelectorAll('option') ?? [])];
    expect(options.map((o) => o.value)).toStrictEqual(['top', 'bottom']);
    // No receptacle typed: nothing to suggest, and the field lists nothing.
    fixture.componentInstance.values.set({ appliance: '2', receptacle: '', outlet: '' });
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('input[id$="-outlet"]')?.getAttribute('list')).toBeNull();
  });
});
