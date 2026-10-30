import { TestBed } from '@angular/core/testing';
import { KEY_PLATFORM, KeybindingService, Session } from '@controls/feature-session';
import { defaultSettings } from '@controls/save-format';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { provideKeybindingOverridesFromSettings } from './keybinding-settings';
import { KeybindingsEditor } from './keybindings-editor';
import { MemorySettingsService, SETTINGS_SERVICE } from './settings-service';
import { SettingsStore } from './settings-store';

async function setup(keybindings: Record<string, string | null> = {}) {
  const service = new MemorySettingsService();
  await service.save({ ...defaultSettings(), controls: { ...defaultSettings().controls, keybindings } });
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_SERVICE, useValue: service },
      { provide: KEY_PLATFORM, useValue: 'other' },
      provideKeybindingOverridesFromSettings(),
    ],
  });
  const store = TestBed.inject(SettingsStore);
  await store.loaded;
  const fixture = TestBed.createComponent(KeybindingsEditor);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const user = userEvent.setup();
  // Find a row by its row header's text, not getByRole('row', { name }): a row's accessible name is
  // computed from its whole subtree for every row in the table, which is slow in jsdom (ui caveats).
  const row = (title: string) => {
    const header = screen.getByText(new RegExp(`^${title}`), { selector: 'th[scope="row"]' });
    const tr = header.closest('tr');
    if (!tr) throw new Error(`no row for ${title}`);
    return tr as HTMLElement;
  };
  return { fixture, store, user, row, keys: TestBed.inject(KeybindingService), session: TestBed.inject(Session) };
}

describe('KeybindingsEditor', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.replaceChildren();
  });

  it('lists command bindings and input actions by category with their keys', async () => {
    const { row } = await setup();
    for (const name of ['Edit', 'Tool belt', 'Movement and viewport'])
      expect(screen.getByRole('table', { name })).toBeTruthy();
    expect(within(row('Undo')).getByText('Ctrl+Z')).toBeTruthy();
    expect(within(row('Redo')).getByText('Ctrl+Shift+Z')).toBeTruthy();
    expect(within(row('Tool-belt slot 3')).getByText('3')).toBeTruthy();
    expect(screen.getByTestId('keys-input.moveForward').textContent).toMatch(/W\s*Up/);
    expect(screen.getByTestId('keybinding-conflicts').textContent).toContain('No conflicts.');
  });

  it('captures a new chord from the keyboard and saves it in settings', async () => {
    const { fixture, store, user, row } = await setup();
    const change = within(row('Undo')).getByRole('button', { name: 'Change Undo' });
    change.focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(change.getAttribute('aria-pressed')).toBe('true');
    expect(change.getAttribute('aria-label')).toBe('Press new keys for Undo');
    await user.keyboard('{Control>}'); // a modifier alone waits for the key
    await user.keyboard('u{/Control}');
    await fixture.whenStable();
    expect(store.settings().controls.keybindings).toEqual({ 'edit.undo': 'Mod+U' });
    expect(within(row('Undo')).getByText('Ctrl+U')).toBeTruthy();
    expect(document.activeElement).toBe(change);
    expect(screen.getByRole('status').textContent).toBe('Undo: Ctrl+U.');
  });

  it('Escape cancels a capture without closing anything; Tab leaves it', async () => {
    const { fixture, store, user, row } = await setup();
    const escapes: Event[] = [];
    document.addEventListener('keydown', (e) => e.key === 'Escape' && escapes.push(e));
    const change = within(row('Undo')).getByRole('button', { name: 'Change Undo' });
    await user.click(change);
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(escapes).toEqual([]); // stopped at the button
    expect(change.getAttribute('aria-pressed')).toBe('false');
    expect(store.settings().controls.keybindings).toEqual({});

    await user.click(change);
    await user.tab();
    await fixture.whenStable();
    expect(change.getAttribute('aria-pressed')).toBe('false');
    expect(store.settings().controls.keybindings).toEqual({});
  });

  it('captures input actions positionally and accepts a bare modifier key', async () => {
    const { fixture, store, user, row } = await setup();
    await user.click(within(row('Sprint')).getByRole('button', { name: /^Change/ }));
    await user.keyboard('{Control>}');
    await fixture.whenStable();
    expect(store.settings().controls.keybindings).toEqual({ 'input.sprint': 'ControlLeft' });
    await user.keyboard('{/Control}');
  });

  it('reports a key it cannot bind and keeps capturing', async () => {
    const { fixture, user, row } = await setup();
    const change = within(row('Undo')).getByRole('button', { name: 'Change Undo' });
    await user.click(change);
    change.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Unidentified', code: 'Lang1', bubbles: true, cancelable: true }),
    );
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toBe('That key can’t be bound.');
    expect(change.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows conflicts on every binding involved and in the summary', async () => {
    const { fixture, user, row } = await setup();
    await user.click(within(row('Tool-belt slot 2')).getByRole('button', { name: /^Change/ }));
    await user.keyboard('w');
    await fixture.whenStable();
    expect(screen.getByTestId('keybinding-conflicts').textContent).toContain('1 conflict:');
    expect(row('Tool-belt slot 2').textContent).toContain('Conflicts with Walk forward on W');
    expect(row('Walk forward').textContent).toContain('Conflicts with Tool-belt slot 2 on W');
    const change = within(row('Walk forward')).getByRole('button', { name: 'Change Walk forward' });
    expect(change.getAttribute('aria-describedby')).toBe('ctl-kb-problem-input.moveForward');
    expect(screen.getByRole('status').textContent).toContain('conflicts with another binding');
  });

  it('unbinds, resets one and resets all, with inactive buttons marked aria-disabled', async () => {
    const { fixture, store, user, row } = await setup({ 'input.moveForward': 'I' });
    const resetAll = screen.getByRole('button', { name: 'Reset all bindings' });
    expect(resetAll.getAttribute('aria-disabled')).toBe('false');
    expect(within(row('Undo')).getByRole('button', { name: 'Reset Undo' }).getAttribute('aria-disabled')).toBe('true');

    await user.click(within(row('Undo')).getByRole('button', { name: 'Unbind Undo' }));
    await fixture.whenStable();
    expect(within(row('Undo')).getByText('Unbound')).toBeTruthy();
    expect(store.settings().controls.keybindings).toEqual({ 'input.moveForward': 'I', 'edit.undo': null });
    const unbind = within(row('Undo')).getByRole('button', { name: 'Unbind Undo' });
    expect(unbind.getAttribute('aria-disabled')).toBe('true');
    await user.click(unbind); // inactive: nothing happens

    await user.click(within(row('Undo')).getByRole('button', { name: 'Reset Undo' }));
    await fixture.whenStable();
    expect(store.settings().controls.keybindings).toEqual({ 'input.moveForward': 'I' });
    await user.click(within(row('Undo')).getByRole('button', { name: 'Reset Undo' })); // inactive

    await user.click(resetAll);
    await fixture.whenStable();
    expect(store.settings().controls.keybindings).toEqual({});
    expect(resetAll.getAttribute('aria-disabled')).toBe('true');
    await user.click(resetAll); // inactive
    expect(screen.getByRole('status').textContent).toBe('Every binding is back to its default.');
  });

  it('flags a stored binding it has to ignore, and Reset clears it', async () => {
    const { fixture, store, user, row } = await setup({ 'edit.undo': 'Shift+Tab' });
    expect(row('Undo').textContent).toContain('Saved keys ignored: Shift+Tab is reserved');
    expect(within(row('Undo')).getByText('Ctrl+Z')).toBeTruthy();
    await user.click(within(row('Undo')).getByRole('button', { name: 'Reset Undo' }));
    await fixture.whenStable();
    expect(store.settings().controls.keybindings).toEqual({});
  });
});
