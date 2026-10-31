import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { CONSOLE_AVAILABLE_KEY, defineCommand, NoArgs, succeed } from '@controls/commands';
import { Session } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import type { World } from '@controls/world-model';
import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { DevConsoleComponent } from './dev-console';
import { DevConsole, MAX_CONSOLE_FILE_BYTES } from './dev-console.service';

const PLACE =
  'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200';

@Component({
  selector: 'ctl-console-test-host',
  imports: [DevConsoleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-dev-console [available]="available()" />`,
})
class Host {
  readonly available = signal(true);
}

/** A cheat to drive the banner: the world registry has none yet. */
const cheat = defineCommand<NoArgs, World>({
  id: 'cheat.test',
  title: 'Test cheat',
  category: 'Cheats',
  args: NoArgs,
  undoable: false,
  cheat: true,
  run: () => succeed<World>(),
});

async function setup(available = true) {
  const session = TestBed.inject(Session);
  session.registry.register(cheat);
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.available.set(available);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, session, user: userEvent.setup() };
}

/** Waits for the lazily loaded CodeMirror input and returns helpers around it. */
async function editor() {
  await waitFor(() => expect(document.querySelector('[data-editor="ready"]')).toBeTruthy());
  const content = screen.getByRole('textbox', { name: 'Console input' });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('no editor');
  view.focus();
  return {
    content,
    text: () => view.state.doc.toString(),
    set: (text: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      }),
    type: (text: string) =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: 'input.type',
      }),
  };
}

const output = () => screen.getByRole('log', { name: 'Console output' });
const lastEntry = () => [...output().querySelectorAll('.entry')].at(-1)?.textContent?.trim();

describe('DevConsoleComponent', () => {
  // jsdom has no layout: CodeMirror measures text with Range rects, which jsdom lacks (ui caveats).
  beforeAll(() => {
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    // jsdom's Blob has no text(); FileReader does the same job here.
    Blob.prototype.text ??= function (this: Blob) {
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(this);
      });
    };
  });
  afterEach(() => (document.body.innerHTML = ''));

  it('is hidden (with a note) and leaves console.available unset when not available', async () => {
    const { fixture, session } = await setup(false);
    expect(screen.queryByRole('textbox', { name: 'Console input' })).toBeNull();
    expect(screen.getByText('The developer console is available in Sandbox and in dev builds.')).toBeTruthy();
    expect(session.contextKeys()[CONSOLE_AVAILABLE_KEY]).toBeUndefined();
    expect(session.isEnabled('console.toggle')).toBe(false);
    fixture.componentInstance.available.set(true);
    await fixture.whenStable();
    expect(session.isEnabled('console.toggle')).toBe(true);
    fixture.destroy();
    expect(session.contextKeys()[CONSOLE_AVAILABLE_KEY]).toBeUndefined();
  });

  it('runs a command line through Session.exec, saves it in history and clears the input', async () => {
    const { session, user } = await setup();
    const input = await editor();
    input.set(PLACE);
    await user.keyboard('{Enter}');
    expect(session.world().entities).toHaveLength(1);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place']);
    expect(lastEntry()).toBe('entity.place: ok (log #0)');
    expect(input.text()).toBe('');
    expect(TestBed.inject(SettingsStore).settings().console.history).toEqual([PLACE]);
  });

  it('marks a parse error at its column and keeps the line until it is edited', async () => {
    const { session, user } = await setup();
    const input = await editor();
    input.set('entity.place --idd 1');
    await user.keyboard('{Enter}');
    expect(screen.getByText('Column 14: Unknown argument --idd', { selector: '.hint' })).toBeTruthy();
    expect(input.content.getAttribute('aria-invalid')).toBe('true');
    expect(input.content.querySelector('.cm-console-error')?.textContent).toBe('--idd');
    expect(input.text()).toBe('entity.place --idd 1');
    expect(within(output()).getByText('^', { exact: false }).textContent).toBe(`${' '.repeat(13)}^`);
    expect(session.entries()).toEqual([]);
    input.type('x');
    await waitFor(() => expect(input.content.getAttribute('aria-invalid')).toBe('false'));
  });

  it('recalls history with the arrow keys and completes with Tab', async () => {
    const { fixture, user } = await setup();
    TestBed.inject(SettingsStore).update('console', { history: ['help', 'world.hash'] });
    const input = await editor();
    input.set('draft');
    await user.keyboard('{ArrowUp}');
    expect(input.text()).toBe('world.hash');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input.text()).toBe('help');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.text()).toBe('draft');

    input.set('entity.pl');
    await user.keyboard('{Tab}');
    expect(input.text()).toBe('entity.place ');
    input.set('entity.');
    await user.keyboard('{Tab}');
    await fixture.whenStable();
    expect(input.text()).toBe('entity.delete');
    expect(screen.getByText(/4 matches: \[entity\.delete] entity\.move/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('4 matches, entity.delete inserted.');
    await user.keyboard('{Tab}');
    expect(input.text()).toBe('entity.move');
  });

  it('lets Tab leave an empty input, so the keyboard is never trapped', async () => {
    await setup();
    const input = await editor();
    const event = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true });
    input.content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('prints world.hash and help without logging anything', async () => {
    const { session, user } = await setup();
    const input = await editor();
    input.set('world.hash');
    await user.keyboard('{Enter}');
    // A round trip to the sim (ADR 0011 §9.4): a placeholder, then the hash fills in.
    const hash = await session.hashAt();
    await waitFor(() => expect(lastEntry()).toBe(hash));
    input.set('help');
    await user.keyboard('{Enter}');
    expect(output().textContent).toContain('entity.place');
    expect(output().textContent).toContain('cheat.test');
    input.set('clear');
    await user.keyboard('{Enter}');
    expect(output().querySelectorAll('.entry')).toHaveLength(0);
    expect(session.entries()).toEqual([]);
  });

  it('warns before a cheat runs, and runs it only when confirmed', async () => {
    const { session, user } = await setup();
    const input = await editor();
    input.set('cheat.test');
    await user.keyboard('{Enter}');
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('cheat.test is a cheat: running it marks this save as assisted');
    expect(session.entries()).toEqual([]);
    expect(input.text()).toBe('cheat.test');

    await user.keyboard('{Escape}'); // cancel
    expect(screen.queryByRole('alert')).toBeNull();
    expect(session.world().assisted).toBe(false);

    await user.keyboard('{Enter}{Enter}'); // warn, then confirm with Enter on the same line
    expect(session.entries().map((e) => e.id)).toEqual(['cheat.test']);
    expect(session.world().assisted).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();

    input.set('cheat.test'); // already assisted: no second warning
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(session.entries()).toHaveLength(2);
  });

  it('runs a picked console-line file, warning first if it holds a cheat', async () => {
    const { session, user } = await setup();
    await editor();
    const field = screen.getByLabelText<HTMLInputElement>('Console-line file to run');
    const file = new File([`${PLACE}\nworld.hash\ncheat.test\n`], 'demo.console', { type: 'text/plain' });
    await user.upload(field, file);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('demo.console runs a cheat (cheat.test)'),
    );
    expect(session.entries()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Run cheat' }));
    await waitFor(() => expect(output().textContent).toContain('Ran 2 commands from demo.console.'));
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'cheat.test']);

    const broken = new File(['edit.undo\nnope.cmd\n'], 'broken.console');
    await user.upload(field, broken);
    await waitFor(() => expect(lastEntry()).toContain('broken.console, line 2, column 1: Unknown command "nope.cmd"'));
    expect(session.entries()).toHaveLength(2); // nothing ran: every line is parsed first
  });

  it('refuses oversized files and Escape closes the console through console.toggle', async () => {
    const { fixture, session, user } = await setup();
    await editor();
    await TestBed.inject(DevConsole).runFile({
      name: 'big.console',
      size: MAX_CONSOLE_FILE_BYTES + 1,
      text: async () => '',
    });
    await fixture.whenStable();
    expect(lastEntry()).toBe('big.console is larger than 1024 KiB');
    const toggled = vi.fn();
    session.onCommand('console.toggle', toggled);
    await user.keyboard('{Escape}');
    expect(toggled).toHaveBeenCalledOnce(); // through the command (whether it is logged is the command's business)
  });

  it('holds the sim and refuses input while a file runs, then lets go (ADR 0011 §9.4)', async () => {
    const { fixture, session, user } = await setup();
    const input = await editor();
    const hold = vi.spyOn(session.sim, 'hold');
    let finish!: (hash: string) => void;
    vi.spyOn(session, 'hashAt').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const run = TestBed.inject(DevConsole).runFile({
      name: 'slow.console',
      size: 20,
      text: async () => 'world.hash\n',
    });
    await waitFor(() => expect(output().getAttribute('aria-busy')).toBe('true'));
    expect(hold).toHaveBeenCalledOnce();
    input.set(PLACE);
    await user.keyboard('{Enter}');
    expect(session.entries()).toEqual([]); // refused while busy
    expect(input.text()).toBe(PLACE); // and kept in the input
    finish('ab'.repeat(32));
    await run;
    await fixture.whenStable();
    expect(output().getAttribute('aria-busy')).toBeNull();
    expect(output().textContent).toContain('ab'.repeat(32));
    expect(output().textContent).toContain('Ran 0 commands from slow.console.');
  });

  it('says so when the sim does not answer a world.hash', async () => {
    const { fixture, session, user } = await setup();
    const input = await editor();
    vi.spyOn(session, 'hashAt').mockRejectedValue(new Error('crashed'));
    input.set('world.hash');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(lastEntry()).toContain('the simulation didn’t answer'));
    await TestBed.inject(DevConsole).runFile({ name: 'h.console', size: 11, text: async () => 'world.hash\n' });
    await fixture.whenStable();
    expect(lastEntry()).toContain('h.console: the simulation didn’t answer');
  });
});
