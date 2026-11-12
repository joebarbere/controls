import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Session } from '@controls/feature-session';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import * as z from 'zod';
import { type ArgErrors, type ArgForm, type ArgValues, buildArgForm, initialValues, visibleFields } from './arg-form';
import { type EntityChoice, PaletteArgForm } from './palette-arg-form';

@Component({
  selector: 'ctl-arg-form-host',
  imports: [PaletteArgForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-palette-arg-form
      [commandTitle]="title()"
      [form]="form()"
      [(values)]="values"
      [errors]="errors()"
      [selectedEntity]="selected()"
      [entities]="entities()"
      (runCommand)="runs = runs + 1"
      (goBack)="backs = backs + 1"
    />
  `,
})
class Host {
  readonly title = signal('Test');
  readonly form = signal<ArgForm>({ fields: [] });
  readonly values = signal<ArgValues>({});
  readonly errors = signal<ArgErrors>({ fields: {}, form: [] });
  readonly selected = signal<EntityChoice | null>(null);
  readonly entities = signal<readonly EntityChoice[]>([]);
  runs = 0;
  backs = 0;
}

function formOf(schema: z.ZodType): ArgForm {
  const result = buildArgForm(schema);
  if (!result.ok) throw new Error(result.reason);
  return result.form;
}

async function mount(form: ArgForm, setup: (host: Host) => void = () => undefined) {
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.form.set(form);
  host.values.set(initialValues(form, { selectedEntityId: null }));
  setup(host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host, user: userEvent.setup() };
}

describe('PaletteArgForm', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  it('renders a labelled control for every field of every registered command', async () => {
    // With the buildArgForm check in arg-form.spec.ts, this proves every command can be run from
    // the palette: a field the template can't show would have no labelled control here.
    const commands = TestBed.inject(Session).registry.list();
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const form = formOf(command.args);
      const { fixture } = await mount(form, (h) => h.title.set(command.title));
      const root = within(fixture.nativeElement as HTMLElement);
      expect(root.getByRole('form', { name: `Arguments for ${command.title}` })).toBeTruthy();
      // Every visible field: a choice's chosen object and a list's items included.
      for (const field of visibleFields(form.fields, initialValues(form, { selectedEntityId: null }))) {
        if (field.kind === 'object' || field.kind === 'choice' || field.kind === 'list') {
          // A list item's fieldset is "Waypoint 2 of 3".
          const name = /\.\d+$/.test(field.id) ? new RegExp(`^${field.label} \\d+ of \\d+$`) : field.label;
          expect(root.getAllByRole('group', { name }).length, `${command.id} ${field.id}`).toBeGreaterThan(0);
        } else {
          expect(root.getAllByLabelText(field.label).length, `${command.id} ${field.id}`).toBeGreaterThan(0);
        }
      }
      expect(root.getByRole('button', { name: 'Run' })).toBeTruthy();
      fixture.destroy();
      document.body.replaceChildren();
    }
  });

  it('shows a scalar union (device.operate value) as one text field with a typing hint', async () => {
    const form = formOf(z.strictObject({ value: z.union([z.boolean(), z.number(), z.string()]) }));
    const { host, user } = await mount(form);
    const field = screen.getByRole('textbox', { name: 'Value' });
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('true or false, a number, or text')).toBeTruthy();
    await user.type(field, 'true');
    expect(host.values()).toStrictEqual({ value: 'true' });
  });

  it('renders each kind of control with its hints and edits values', async () => {
    const form = formOf(
      z.strictObject({
        name: z.string().meta({ description: 'A name' }),
        slot: z.int().min(1).max(9),
        on: z.boolean(),
        size: z.enum(['s', 'm']).default('m'),
        note: z.string().optional(),
        extra: z.strictObject({ x: z.int() }).optional(),
      }),
    );
    const { fixture, host, user } = await mount(form);
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name.getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('A name').id).toBe(name.getAttribute('aria-describedby'));
    const slot = screen.getByRole('textbox', { name: 'Slot' });
    expect(slot.getAttribute('inputmode')).toBe('numeric');
    expect(screen.getByText('Whole number, 1 to 9')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Size' }) as HTMLSelectElement).value).toBe('1');
    expect(screen.getByText('Optional')).toBeTruthy();

    await user.type(name, 'crate');
    await user.click(screen.getByRole('checkbox', { name: 'On' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 's');
    expect(screen.queryByRole('textbox', { name: 'X' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Include Extra' }));
    await fixture.whenStable();
    await user.type(screen.getByRole('textbox', { name: 'X' }), '4');
    expect(host.values()).toMatchObject({ name: 'crate', on: true, size: '0', extra: true, 'extra.x': '4' });
  });

  it('shows errors inline, marks the field invalid and can focus it', async () => {
    const form = formOf(z.strictObject({ a: z.string(), b: z.int() }));
    const { fixture, host } = await mount(form);
    const component = fixture.debugElement.query(
      (d) => d.componentInstance instanceof PaletteArgForm,
    ).componentInstance;
    expect(component.focusFirstInvalid()).toBe(false);
    host.errors.set({ fields: { b: ['Too big'] }, form: ['Refused'] });
    await fixture.whenStable();
    const b = screen.getByRole('textbox', { name: 'B' });
    expect(b.getAttribute('aria-invalid')).toBe('true');
    expect(b.getAttribute('aria-describedby')).toContain(screen.getByText('Too big').closest('p')?.id ?? 'missing');
    expect(document.activeElement).not.toBe(b); // live errors never move focus
    expect(component.focusFirstInvalid()).toBe(true);
    expect(document.activeElement).toBe(b);
    expect(screen.getByRole('alert').textContent).toContain('Refused');
    expect(screen.getByRole('textbox', { name: 'A' }).getAttribute('aria-invalid')).toBe('false');
  });

  it('offers the selection and the world entities to entity references', async () => {
    const form = formOf(z.strictObject({ id: z.int().min(1).meta({ 'x-controls-ref': 'entity', title: 'Entity' }) }));
    await mount(form, (h) => {
      h.selected.set({ id: 2, label: 'prop.crate' });
      h.entities.set([
        { id: 1, label: 'prop.box' },
        { id: 2, label: 'prop.crate' },
      ]);
    });
    const input = screen.getByRole('combobox', { name: 'Entity' }); // a text input with a datalist
    expect(screen.getByText(/Selected: 2 \(prop\.crate\)/)).toBeTruthy();
    const list = document.getElementById(input.getAttribute('list') ?? '');
    expect(Array.from(list?.querySelectorAll('option') ?? []).map((o) => o.value)).toEqual(['1', '2']);
  });

  it('runs on Enter, moves with the arrows, toggles checkboxes with Enter and goes back on Escape', async () => {
    const form = formOf(z.strictObject({ a: z.string(), on: z.boolean(), b: z.string() }));
    const { fixture, host, user } = await mount(form);
    fixture.debugElement.query((d) => d.componentInstance instanceof PaletteArgForm).componentInstance.focusFirst();
    const a = screen.getByRole('textbox', { name: 'A' });
    expect(document.activeElement).toBe(a);
    await user.keyboard('{ArrowDown}');
    const on = screen.getByRole('checkbox', { name: 'On' });
    expect(document.activeElement).toBe(on);
    await user.keyboard('{Enter}');
    expect(host.values()['on']).toBe(true);
    expect(host.runs).toBe(0);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'B' }));
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}'); // wraps past the top to the Run button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run' }));
    a.focus();
    await user.keyboard('{Enter}');
    expect(host.runs).toBe(1);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    a.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(host.backs).toBe(1);
  });

  it('runs on Enter from a select', async () => {
    const form = formOf(z.strictObject({ size: z.enum(['s', 'm']) }));
    const { host, user } = await mount(form);
    screen.getByRole('combobox', { name: 'Size' }).focus();
    await user.keyboard('{Enter}');
    expect(host.runs).toBe(1);
  });
});

describe('PaletteArgForm choices, nullable fields and lists (ADR 0015)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  const Termination = z
    .strictObject({ method: z.string(), torqueNm: z.number().nullable() })
    .meta({ title: 'Termination' });

  it('renders a nullable object as a radio group whose fields show only when chosen', async () => {
    const form = formOf(
      z.strictObject({
        mountedOn: z
          .strictObject({ entity: z.int().meta({ 'x-controls-ref': 'entity' }), mount: z.string() })
          .nullable(),
      }),
    );
    const { fixture, host, user } = await mount(form, (h) => h.selected.set({ id: 2, label: 'enclosure' }));
    const group = screen.getByRole('group', { name: 'Mounted on' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent?.trim())).toEqual(['Specify', 'None']);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(group).queryByRole('textbox', { name: 'Mount' })).toBeNull();

    await user.click(within(group).getByRole('radio', { name: 'Specify' }));
    await fixture.whenStable();
    expect(host.values()['mountedOn']).toBe('0');
    expect(within(group).getByRole('textbox', { name: 'Mount' })).toBeTruthy();
    expect(within(group).getByText(/Selected: 2 \(enclosure\)/)).toBeTruthy();

    await user.click(within(group).getByRole('radio', { name: 'None' }));
    await fixture.whenStable();
    expect(within(group).queryByRole('textbox', { name: 'Mount' })).toBeNull();
  });

  it("renders an 'auto' or object union, and a nullable scalar whose blank means none", async () => {
    const form = formOf(
      z.strictObject({ termination: z.union([z.literal('auto'), Termination]), label: z.string().nullable() }),
    );
    const { fixture, host, user } = await mount(form);
    const group = screen.getByRole('group', { name: 'Termination' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent?.trim()),
    ).toEqual(['auto', 'Termination']);
    await user.click(within(group).getByRole('radio', { name: 'Termination' }));
    await fixture.whenStable();
    const method = within(group).getByRole('textbox', { name: 'Method' });
    await user.type(method, 'screw');
    const torque = within(group).getByRole('textbox', { name: 'Torque (N·m)' });
    expect(torque.getAttribute('aria-required')).toBe('false'); // blank means null
    expect(screen.getAllByText(/Leave blank for none/).length).toBe(2); // torque and label
    expect(host.values()).toMatchObject({ termination: '1', 'termination.method': 'screw' });

    // An error on the choice marks its radios, so a failed Run can focus the group.
    const component = fixture.debugElement.query(
      (d) => d.componentInstance instanceof PaletteArgForm,
    ).componentInstance;
    host.errors.set({ fields: { termination: ['Required'] }, form: [] });
    await fixture.whenStable();
    expect(component.focusFirstInvalid()).toBe(true);
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: 'auto' }));
  });

  it('edits a list by keyboard: add, move, remove, with limits, announcements and focus that follows', async () => {
    const Waypoint = z.strictObject({ x: z.int() }).meta({ title: 'Waypoint' });
    const form = formOf(z.strictObject({ route: z.array(Waypoint).min(1).max(3) }));
    const { fixture, host, user } = await mount(form);
    const list = screen.getByRole('group', { name: 'Route' });
    const status = screen.getByRole('status');
    expect(within(list).getByText('1 to 3 waypoints')).toBeTruthy();
    const item = (n: number, of: number) => within(list).getByRole('group', { name: `Waypoint ${n} of ${of}` });
    const button = (group: HTMLElement, name: string) => within(group).getByRole('button', { name });

    // One item to start (minItems): it can't move or be removed.
    const first = item(1, 1);
    expect(button(first, 'Move up').getAttribute('aria-disabled')).toBe('true');
    expect(button(first, 'Move down').getAttribute('aria-disabled')).toBe('true');
    expect(button(first, 'Remove').getAttribute('aria-disabled')).toBe('true');
    within(first).getByRole('textbox', { name: 'X' }).focus();
    await user.keyboard('1');

    // Tab to Add (past the item's three buttons) and press Enter: focus goes to the new item.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    const add = within(list).getByRole('button', { name: 'Add waypoint' });
    expect(document.activeElement).toBe(add);
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(status.textContent).toContain('Waypoint 2 added.');
    expect(document.activeElement).toBe(within(item(2, 2)).getByRole('textbox', { name: 'X' }));
    await user.keyboard('2');
    expect(host.values()).toMatchObject({ route: 2, 'route.0.x': '1', 'route.1.x': '2' });

    // Move the second item up with the keyboard: the values swap and focus follows it.
    await user.tab(); // Move up
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(host.values()).toMatchObject({ 'route.0.x': '2', 'route.1.x': '1' });
    expect(status.textContent).toContain('Waypoint moved to 1 of 2.');
    expect(document.activeElement).toBe(button(item(1, 2), 'Move up'));
    // At the top, Move up is aria-disabled: Enter only says so.
    await user.keyboard('{Enter}');
    expect(status.textContent).toContain('Waypoint 1 is already first.');
    expect(host.values()['route.0.x']).toBe('2');

    // Fill to the maximum: Add is then aria-disabled.
    add.focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(add.getAttribute('aria-disabled')).toBe('true');
    add.focus();
    await user.keyboard('{Enter}');
    expect(status.textContent).toContain('No more waypoints: at most 3.');
    expect(host.values()['route']).toBe(3);

    // Remove the first item: focus goes to the item that took its place.
    button(item(1, 3), 'Remove').focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(status.textContent).toContain('Waypoint 1 removed. 2 left.');
    expect(host.values()).toMatchObject({ route: 2, 'route.0.x': '1' });
    expect(document.activeElement).toBe(within(item(1, 2)).getByRole('textbox', { name: 'X' }));
    // Removing the last item focuses the one before it.
    button(item(2, 2), 'Remove').focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(document.activeElement).toBe(within(item(1, 1)).getByRole('textbox', { name: 'X' }));
    expect(button(item(1, 1), 'Remove').getAttribute('aria-disabled')).toBe('true');
  });

  it('labels scalar list items by their number and maps their errors by index', async () => {
    const form = formOf(z.strictObject({ tags: z.array(z.string()).max(2) }));
    const { fixture, host, user } = await mount(form);
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await fixture.whenStable();
    await user.type(screen.getByRole('textbox', { name: 'Item 1' }), 'a');
    host.errors.set({ fields: { 'tags.0': ['Too long'] }, form: [] });
    await fixture.whenStable();
    expect(screen.getByRole('textbox', { name: 'Item 1' }).getAttribute('aria-invalid')).toBe('true');
    expect(host.values()).toMatchObject({ tags: 1, 'tags.0': 'a' });
  });
});
