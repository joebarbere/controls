import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Session } from '@controls/feature-session';
import { createGame } from '@controls/scripting-api';
import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { MemorySaveIo } from '../testing/memory-save-io';
import { formatSaveSize, LoadGameDialog } from './load-game-dialog';
import { SaveGameDialog, saveNameError } from './save-game-dialog';
import { SAVE_DIALOGS, SAVE_FILES } from './save-io';
import { SaveGames } from './save-games';

@Component({
  selector: 'ctl-saves-host',
  imports: [LoadGameDialog, SaveGameDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" (click)="load.set(true)">Open load</button>
    <button type="button" (click)="save.set(true)">Open save</button>
    <ctl-load-game-dialog [(open)]="load" />
    <ctl-save-game-dialog [(open)]="save" />
  `,
})
class Host {
  readonly load = signal(false);
  readonly save = signal(false);
}

function savedGame(seed: number) {
  const game = createGame({ seed });
  game.exec('entity.place', { ref: { id: 'prop.box', version: 1 }, positionMm: { x: seed, y: 0, z: 0 } });
  return { bytes: game.save(), hash: game.hash() };
}

async function setup(io = new MemorySaveIo()) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SAVE_FILES, useValue: io.files },
      { provide: SAVE_DIALOGS, useValue: io.dialogs },
    ],
  });
  const saves = TestBed.inject(SaveGames);
  await saves.ready;
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, io, saves, session: TestBed.inject(Session), user: userEvent.setup() };
}

describe('LoadGameDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('lists the saves newest first, each a button named by the save and described by kind, time and size', async () => {
    const io = new MemorySaveIo();
    io.seed({ kind: 'manual', name: 'Shop' }, savedGame(1).bytes);
    io.seed({ kind: 'autosave', name: 'Autosave 1', slot: 1 }, savedGame(2).bytes);
    const { fixture, user } = await setup(io);
    const opener = screen.getByRole('button', { name: 'Open load' });
    await user.click(opener);
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Load game' });
    const list = within(dialog).getByRole('list', { name: 'Saved games' });
    const entries = within(list).getAllByRole('button');
    expect(entries.map((b) => b.querySelector('.name')?.textContent)).toEqual(['Autosave 1', 'Shop']);
    expect(within(list).getByRole('button', { name: 'Shop', description: /^Saved game · .+ · \d/ })).toBeTruthy();
    expect(document.activeElement).toBe(entries[0]); // the newest save has focus

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(entries[1]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(entries[0]); // wraps
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(entries[1]);

    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('loads the chosen save after closing and returning focus', async () => {
    const io = new MemorySaveIo();
    const shop = savedGame(7);
    io.seed({ kind: 'manual', name: 'Shop' }, shop.bytes);
    const { fixture, session, user } = await setup(io);
    await user.click(screen.getByRole('button', { name: 'Open load' }));
    await fixture.whenStable();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(session.hash()).toBe(shop.hash));
  });

  it('says when there are no saves, and Open file… keeps the dialog open if the picker is cancelled', async () => {
    const { fixture, io, session, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Open load' }));
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Load game' });
    expect(within(dialog).getByText(/No saved games yet/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Open file…' }));

    io.nextOpen(null);
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(screen.getByRole('dialog', { name: 'Load game' })).toBeTruthy();

    const shared = savedGame(11);
    io.nextOpen({ name: 'shared.ctrl', bytes: shared.bytes });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(session.hash()).toBe(shared.hash));
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('formats sizes in decimal units', () => {
    expect([formatSaveSize(512), formatSaveSize(12_345), formatSaveSize(3_400_000)]).toEqual([
      '512 bytes',
      '12.3 KB',
      '3.4 MB',
    ]);
  });
});

describe('SaveGameDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  async function openSave(io?: MemorySaveIo) {
    const ctx = await setup(io);
    ctx.session.newSandbox({ seed: 42 });
    await ctx.user.click(screen.getByRole('button', { name: 'Open save' }));
    await ctx.fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'Save game' });
    const field = within(dialog).getByRole('textbox', { name: 'Save name' }) as HTMLInputElement;
    return { ...ctx, dialog, field };
  }

  it('offers a name, focused, and Enter saves it after the dialog closes', async () => {
    const { fixture, io, saves, field, user } = await openSave();
    expect(field.value).toBe('Sandbox 42');
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, 'Shop{Enter}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open save' }));
    await waitFor(() => expect(io.names()).toEqual(['Shop']));
    expect(saves.saveName()).toBe('Shop');
  });

  it('explains a name it cannot use, without closing', async () => {
    const { dialog, field, io, user } = await openSave();
    await user.clear(field);
    await user.type(field, '../etc{Enter}');
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Start with a letter or digit/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await user.clear(field);
    await user.type(field, 'CON{Enter}');
    expect(within(dialog).getByRole('alert').textContent).toMatch(/reserved by Windows/);
    expect(screen.getByRole('dialog', { name: 'Save game' })).toBeTruthy();
    expect(io.calls).not.toContain('write');
  });

  it('asks before replacing another save (the button becomes Replace)', async () => {
    const io = new MemorySaveIo();
    io.seed({ kind: 'manual', name: 'Shop' }, savedGame(1).bytes);
    const { dialog, field, fixture, saves, user } = await openSave(io);
    await saves.refresh();
    await user.clear(field);
    await user.type(field, 'shop{Enter}');
    await fixture.whenStable();
    expect(within(dialog).getByRole('alert').textContent).toBe('A save named “shop” exists. Replace it?');
    expect(within(dialog).getByRole('button', { name: 'Replace' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(io.calls.filter((c) => c === 'write')).toHaveLength(1));
  });

  it('validates names like the save directory does', () => {
    expect(saveNameError('Shop (2) #1')).toBeNull();
    expect(saveNameError('')).toBe('Enter a name for the save.');
    expect(saveNameError(' lead')).toMatch(/Start with a letter/);
    expect(saveNameError('a/b')).toMatch(/Start with a letter/);
    expect(saveNameError('x'.repeat(65))).toBe('Use at most 64 characters.');
  });
});
