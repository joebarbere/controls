import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Session } from '@controls/feature-session';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { allFields, type ArgErrors, type ArgForm, buildArgForm, initialValues } from './arg-form';
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
  readonly values = signal<Readonly<Record<string, string | boolean>>>({});
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
      for (const field of allFields(form.fields)) {
        if (field.kind === 'object') expect(root.getByRole('group', { name: field.label })).toBeTruthy();
        else expect(root.getAllByLabelText(field.label).length, `${command.id} ${field.id}`).toBeGreaterThan(0);
      }
      expect(root.getByRole('button', { name: 'Run' })).toBeTruthy();
      fixture.destroy();
      document.body.replaceChildren();
    }
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
