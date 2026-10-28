import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { defineCommand, NoArgs, SELECTION_ENTITY_ID_KEY, succeed } from '@controls/commands';
import { KEY_PLATFORM, KeybindingService, Session } from '@controls/feature-session';
import { MemorySettingsService, SETTINGS_SERVICE, SettingsStore } from '@controls/feature-settings';
import { defaultSettings } from '@controls/save-format';
import type { World } from '@controls/world-model';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from './command-palette';

@Component({
  selector: 'ctl-palette-host',
  imports: [CommandPalette],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button">Opener</button><ctl-command-palette />`,
})
class Host {}

/** A cheat for the specs: succeeds without changing the world, so only the assisted flag moves. */
const testCheat = defineCommand<NoArgs, World>({
  id: 'test.cheat',
  title: 'Test cheat',
  category: 'Debug',
  args: NoArgs,
  undoable: false,
  cheat: true,
  run: () => succeed(),
});

async function setup(config: { recents?: string[]; cheat?: boolean } = {}) {
  const service = new MemorySettingsService();
  await service.save({ ...defaultSettings(), palette: { recents: config.recents ?? [] } });
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_SERVICE, useValue: service },
      { provide: KEY_PLATFORM, useValue: 'other' },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  await store.loaded;
  const session = TestBed.inject(Session);
  if (config.cheat) session.registry.register(testCheat);
  TestBed.inject(KeybindingService); // the document listener that turns Ctrl+K into palette.open
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'Opener' });
  const stable = () => fixture.whenStable();
  const dialog = () => screen.getByRole('dialog', { name: 'Command palette' });
  const search = () => within(dialog()).getByRole('combobox', { name: 'Search commands' });
  const options = () => within(dialog()).getAllByRole('option');
  const open = async () => {
    opener.focus();
    await user.keyboard('{Control>}k{/Control}');
    await stable();
  };
  return { fixture, store, session, user, opener, stable, dialog, search, options, open, service };
}

const crate = { id: 'prop.crate', version: 1 };

describe('CommandPalette', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  it('opens on Ctrl+K and Ctrl+Shift+P (palette.open) and closes on Escape, restoring focus', async () => {
    const { session, user, opener, stable, search, open } = await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    await open();
    expect(document.activeElement).toBe(search());
    expect(session.entries()).toEqual([]); // palette.open is UI chrome: never logged

    await user.keyboard('{Escape}');
    await stable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    await stable();
    expect(document.activeElement).toBe(search());
  });

  it('is an ARIA combobox controlling a listbox, driven by the arrow keys', async () => {
    const { user, stable, search, options, open, dialog } = await setup();
    await open();
    const box = search();
    const listbox = within(dialog()).getByRole('listbox', { name: 'Commands' });
    expect(box.getAttribute('aria-controls')).toBe(listbox.id);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(box.getAttribute('aria-autocomplete')).toBe('list');
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{ArrowDown}');
    await stable();
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(options()[0].getAttribute('aria-selected')).toBe('false');
    await user.keyboard('{ArrowUp}{ArrowUp}'); // wraps to the last option
    await stable();
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[options().length - 1].id);
  });

  it('fuzzy-filters, and lists unavailable commands last with the reason', async () => {
    const { user, stable, options, open, session } = await setup();
    await open();
    await user.keyboard('rst lay');
    await stable();
    expect(options().map((o) => o.getAttribute('data-command'))).toEqual(['view.resetLayout']);

    await user.clear(screen.getByRole('combobox', { name: 'Search commands' }));
    await user.keyboard('do');
    await stable();
    const undo = options().find((o) => o.getAttribute('data-command') === 'edit.undo');
    expect(undo?.getAttribute('aria-disabled')).toBe('true');
    expect(undo?.textContent).toContain('Not available now (needs history.canUndo)');
    expect(undo?.textContent).toContain('Ctrl+Z');
    expect(options().at(-1)?.getAttribute('aria-disabled')).toBe('true');

    // Enter on an unavailable command announces why and runs nothing.
    const index = options().indexOf(undo as HTMLElement);
    for (let i = 0; i < index; i++) await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    await stable();
    expect(screen.getByRole('status').textContent).toBe('Undo: Not available now (needs history.canUndo)');
    expect(session.entries()).toEqual([]); // palette.open is UI chrome: never logged
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });

  it('places an object through a generated form with inline errors, then undoes it', async () => {
    const { user, stable, open, session, opener, store, options } = await setup();
    await open();
    await user.keyboard('place');
    await stable();
    await user.keyboard('{Enter}');
    await stable();
    const form = screen.getByRole('form', { name: 'Arguments for Place object' });
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'ID' }));

    // Running it empty shows the schema's errors inline and focuses the first invalid field.
    await user.keyboard('{Enter}');
    await stable();
    const id = within(form).getByRole('textbox', { name: 'ID' });
    expect(id.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(id);
    // ref.version, x, y and z are missing; an empty catalogue id is a string that fails the id pattern.
    expect(within(form).getAllByText('Required').length).toBe(4);
    expect(session.world().entities).toEqual([]);

    // Errors update live once shown: a bad catalogue id is the schema's pattern error.
    await user.type(id, 'Not An Id');
    await stable();
    expect(id.getAttribute('aria-invalid')).toBe('true');
    await user.clear(id);
    await user.type(id, 'prop.crate');
    for (const [name, value] of [
      ['Version', '1'],
      ['X', '100'],
      ['Y', '0'],
      ['Z', '-200'],
    ]) {
      await user.type(within(form).getByRole('textbox', { name }), value);
    }
    await stable();
    expect(id.getAttribute('aria-invalid')).toBe('false');
    expect(within(form).getByRole('textbox', { name: 'Yaw' })).toHaveProperty('value', '0'); // default
    await user.keyboard('{Enter}');
    await stable();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(session.world().entities).toMatchObject([
      { id: 1, ref: crate, transform: { positionMm: { x: 100, z: -200 } } },
    ]);
    expect(store.settings().palette.recents).toEqual(['entity.place']);

    // Recent commands come first; undo is now available.
    await open();
    expect(options()[0].getAttribute('data-command')).toBe('entity.place');
    expect(options()[0].textContent).toContain('Recent');
    await user.keyboard('undo{Enter}');
    await stable();
    expect(session.world().entities).toEqual([]);
    expect(store.settings().palette.recents).toEqual(['edit.undo', 'entity.place']);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'edit.undo']); // palette.open isn't logged
  });

  it('Escape in a form goes back to the list with the query kept', async () => {
    const { user, stable, open, search } = await setup();
    await open();
    await user.keyboard('move{Enter}');
    await stable();
    expect(screen.getByRole('form', { name: 'Arguments for Move object' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await stable();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(search()).toHaveProperty('value', 'move');
  });

  it('offers the selected entity to entity references', async () => {
    const { user, stable, open, session } = await setup();
    session.exec('entity.place', { ref: crate, positionMm: { x: 0, y: 0, z: 0 } });
    session.setContext(SELECTION_ENTITY_ID_KEY, 1);
    await open();
    await user.keyboard('delete{Enter}');
    await stable();
    const entity = screen.getByRole('combobox', { name: 'Entity' });
    expect(entity).toHaveProperty('value', '1');
    expect(screen.getByText(/Selected: 1 \(prop\.crate\)/)).toBeTruthy();
    await user.keyboard('{Enter}');
    await stable();
    expect(session.world().entities).toEqual([]);
  });

  it('reopens on the command with the message when the command is refused', async () => {
    const { user, stable, open, session } = await setup();
    await open();
    await user.keyboard('delete{Enter}');
    await stable();
    // No entities, so no suggestion list: a plain text field.
    await user.type(screen.getByRole('textbox', { name: 'Entity' }), '9');
    await user.keyboard('{Enter}');
    await stable();
    const form = screen.getByRole('form', { name: 'Arguments for Delete object' });
    expect(within(form).getByRole('alert').textContent).toContain('No entity with id 9');
    expect(screen.getByRole('textbox', { name: 'Entity' })).toHaveProperty('value', '9');
    expect(session.entries()).toEqual([]); // palette.open is UI chrome: never logged
  });

  it('asks before a cheat, then marks the world assisted (and stops asking)', async () => {
    const { user, stable, open, session, opener } = await setup({ cheat: true });
    await open();
    await user.keyboard('test cheat');
    await stable();
    expect(screen.getAllByRole('option')[0].textContent).toContain('Cheat');
    await user.keyboard('{Enter}');
    await stable();
    expect(screen.getByRole('heading', { name: 'Run a cheat?' })).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Run and mark assisted' });
    expect(document.activeElement).toBe(confirm);

    // Arrows move between the two buttons; Escape backs out without running anything.
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await stable();
    expect(screen.getByRole('combobox', { name: 'Search commands' })).toHaveProperty('value', 'test cheat');
    expect(session.world().assisted).toBe(false);

    await user.keyboard('{Enter}');
    await stable();
    await user.keyboard('{Enter}');
    await stable();
    expect(session.world().assisted).toBe(true);
    expect(document.activeElement).toBe(opener);

    // Already assisted: nothing more to lose, so it runs straight away.
    await open();
    await user.keyboard('test cheat{Enter}');
    await stable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(session.entries().filter((e) => e.id === 'test.cheat')).toHaveLength(2);
  });

  it('ignores recents this build does not know and keeps the list capped', async () => {
    const recents = Array.from({ length: 20 }, (_, i) => `old.command${i}`);
    const { user, stable, open, store } = await setup({ recents });
    await open();
    await user.keyboard('reset layout{Enter}');
    await stable();
    const next = store.settings().palette.recents;
    expect(next).toHaveLength(20);
    expect(next[0]).toBe('view.resetLayout');
    expect(next).not.toContain('old.command19');
  });

  it('chooses an option with the mouse too', async () => {
    const { user, stable, open, session } = await setup();
    await open();
    await user.click(screen.getByRole('option', { name: /^Reset layout/ }));
    await stable();
    expect(session.entries().map((e) => e.id)).toEqual(['view.resetLayout']);
  });
});
