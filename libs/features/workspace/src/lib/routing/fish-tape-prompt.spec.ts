import { TestBed } from '@angular/core/testing';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { KEY_PLATFORM } from '@controls/feature-session';
import { createWorld, type Difficulty } from '@controls/save-format';
import { createWorldBus, createWorldRegistry, defaultTool, type WirePullArgs } from '@controls/world-model';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { precheck } from './cable-gesture';
import { FishTapePromptDialog, type PullPrompt } from './fish-tape-prompt';
import { pullRequest } from './pull-model';
import { FISH_TAPE, PULL_RUN_STEPS, THHN_12 } from './pull-world.fakes';

/*
 * F3.4 part 2: the fish tape prompt, keyboard first. The setup step (rows, the reach refusal, the
 * command's check), the minigame's keys and buttons, its announcements in the dialog's own status,
 * the kink, Trainee's skip and reduced motion. Rendered on `pull-world.fakes`' run (one elbow).
 */

const registry = createWorldRegistry();
const THHN = `${THHN_12.id}@1`;

async function mount(
  difficulty: Difficulty = 'journeyman',
  options: { refusal?: string | null; reducedMotion?: boolean; shortTape?: boolean } = {},
) {
  TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
  const bus = createWorldBus(createWorld({ seed: 0, difficulty }), registry);
  for (const [id, args] of PULL_RUN_STEPS) expect(bus.exec(id, args).ok).toBe(true);
  const world = bus.state;
  const tape = defaultTool(BUILTIN_CATALOG, [], 'pull');
  const chosen =
    options.shortTape && tape ? { ...tape, tool: { ...tape.tool, pull: { lengthMm: 1000, maxBendDeg: 360 } } } : tape;
  const built = pullRequest(world, BUILTIN_CATALOG, [THHN_12], 3, chosen);
  if (!built.ok) throw new Error(built.message);
  const fixture = TestBed.createComponent(FishTapePromptDialog);
  const confirmed: WirePullArgs[] = [];
  let dismissed = 0;
  fixture.componentInstance.confirm.subscribe((a) => confirmed.push(a));
  fixture.componentInstance.dismissed.subscribe(() => dismissed++);
  const checks: WirePullArgs[] = [];
  fixture.componentRef.setInput('check', (args: WirePullArgs) => {
    checks.push(args);
    const r = precheck(registry.get('wire.pull'), world, args);
    return r && `${r.message} (${r.code})`;
  });
  fixture.componentRef.setInput('reducedMotion', options.reducedMotion ?? false);
  const prompt: PullPrompt = { request: built.request, refusal: options.refusal ?? null };
  fixture.componentRef.setInput('prompt', prompt);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, prompt, confirmed, checks, dismissed: () => dismissed, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Fish tape: pull conductors' });
const status = () => screen.getByTestId('tape-status').textContent?.trim();

describe('FishTapePromptDialog (F3.4 part 2)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
  });

  it('shows the run against the tape; the belt’s spool is the first row; Add makes a second row', async () => {
    const { user, fixture } = await mount();
    const d = dialog();
    expect(within(d).getByTestId('pull-run').textContent).toBe('Run: 1333 mm of conduit, 1 elbow (90° of bends).');
    expect(within(d).getByTestId('pull-tape').textContent).toBe(
      'Tape: Steel fish tape, 1/8 in x 50 ft (not on the belt): reaches 15240 mm and 360° of bends.',
    );
    expect((within(d).getByRole('combobox', { name: 'Conductor 1' }) as HTMLSelectElement).value).toBe(THHN);
    expect((within(d).getByRole('combobox', { name: 'Colour 1' }) as HTMLSelectElement).value).toBe('black');
    // Keyboard first: the first control has focus when the dialog opens.
    expect(document.activeElement).toBe(within(d).getByRole('combobox', { name: 'Conductor 1' }));
    await user.click(within(d).getByRole('button', { name: 'Add conductor' }));
    await fixture.whenStable();
    await user.selectOptions(within(d).getByRole('combobox', { name: 'Colour 2' }), 'white');
    expect(status()).toBe('Conductor 2 added.');
    expect(within(d).queryByRole('button', { name: 'Pull without feeding' })).toBeNull(); // Journeyman
  });

  it('the game: F feeds, the elbow jams, T twists round it, P pulls: one confirm with the setup’s arguments', async () => {
    const { user, fixture, confirmed, checks } = await mount('journeyman');
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Add conductor' }));
    await fixture.whenStable();
    await user.selectOptions(within(d).getByRole('combobox', { name: 'Colour 2' }), 'white');
    await user.click(within(d).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    expect(checks).toHaveLength(1); // the command's own check before any play
    expect(status()).toMatch(/^Feeding the tape in at end a \(box #1, entry drill-top-1\): 3 stations/);
    const feed = within(d).getByRole('button', { name: 'Feed (F)' });
    expect(document.activeElement).toBe(feed);
    expect(within(d).queryByRole('list', { name: /The run/ })).toBeNull(); // Journeyman: no map of the elbows
    await user.keyboard('f');
    expect(status()).toBe('Fed: station 1 of 3.');
    await user.keyboard('f'); // into the elbow
    // Journeyman hides the elbows: a jam says neither "bend" nor where.
    expect(status()).toBe('The tape binds (1 jam here of 3). Feed (F), twist (T) or pull back (R).');
    expect(within(d).getByTestId('tape-position').textContent).toBe(
      'Station 1 of 3; round 0 of 1 elbows; jams 1 of 3 here before it kinks, 1 in all.',
    );
    await user.keyboard('t');
    expect(status()).toBe('Round elbow 1: station 2 of 3.');
    await user.keyboard('{ArrowUp}');
    await fixture.whenStable();
    expect(status()).toBe('The tape is through at end b. Pull the conductors back (P).');
    expect(confirmed).toHaveLength(0);
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Pull the conductors (P)' }));
    await user.keyboard('p');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toStrictEqual(checks[0]);
    expect(confirmed[0].conductors.map((c) => c.colour.base)).toStrictEqual(['black', 'white']);
    expect(confirmed[0].tool).toStrictEqual(FISH_TAPE);
  });

  it('at Realistic a second jam at one spot kinks the tape: an alert, nothing confirmed; Try again starts over', async () => {
    const { user, fixture, confirmed } = await mount('realistic');
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    await user.keyboard('t'); // a twist on the straight binds, worded as a push into a bend would be
    expect(status()).toBe('The tape binds (1 jam here of 2). Feed (F), twist (T) or pull back (R).');
    await user.keyboard('f'); // past the straight (its jam stays there)
    await user.keyboard('ff'); // two pushes into the elbow
    await fixture.whenStable();
    expect(within(d).getByTestId('tape-alert').textContent).toBe(
      'The tape kinked after 2 jams at one spot. Nothing was pulled. Try again, or Cancel.',
    );
    expect(within(d).queryByRole('button', { name: 'Feed (F)' })).toBeNull();
    await user.keyboard('ftp'); // the game's keys do nothing once kinked
    expect(confirmed).toHaveLength(0);
    const retry = within(d).getByRole('button', { name: 'Try again' });
    expect(document.activeElement).toBe(retry);
    await user.click(retry);
    await fixture.whenStable();
    expect(within(d).getByTestId('tape-position').textContent).toMatch(/^Station 0 of 3;/);
    expect(within(d).getByTestId('tape-alert').textContent).toBe('');
  });

  it('Apprentice shows where the elbows are and names the twist before the push; R pulls back', async () => {
    const { user, fixture } = await mount('apprentice');
    const d = dialog();
    await user.click(within(d).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    const track = within(d).getByRole('list', { name: 'The run, end a to end b' });
    expect(
      within(track)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.trim()),
    ).toStrictEqual(['Straight: next', 'Elbow 1 (90°)', 'Straight']);
    await user.keyboard('f');
    expect(status()).toBe('Fed: station 1 of 3. Elbow 1 ahead: twist (T) to get round it.');
    await user.keyboard('r');
    expect(status()).toBe('Pulled back: station 0 of 3.');
    await user.keyboard('{ArrowDown}');
    expect(status()).toBe('The tape is all the way out.');
  });

  it('a held key feeds once: auto-repeat is swallowed', async () => {
    const { user, fixture } = await mount('journeyman');
    await user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    await user.keyboard('{f>3/}');
    expect(status()).toBe('Fed: station 1 of 3.');
    expect(within(dialog()).getByTestId('tape-position').textContent).toMatch(/^Station 1 of 3;/);
  });

  it('confirms at most once: P twice, and P while still feeding, emit one confirm', async () => {
    const { user, fixture, confirmed } = await mount('apprentice');
    await user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    await user.keyboard('fp'); // P before the tape is through does nothing
    expect(confirmed).toHaveLength(0);
    await user.keyboard('tf');
    await fixture.whenStable();
    await user.keyboard('pp');
    expect(confirmed).toHaveLength(1);
  });

  it('a refusal from the flow returns to setup with focus on the first conductor', async () => {
    const { user, fixture, prompt } = await mount('journeyman');
    await user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Feed (F)');
    fixture.componentRef.setInput('prompt', { ...prompt, refusal: 'No entity with id 5 (not-found)' });
    await fixture.whenStable();
    const d = dialog();
    expect(within(d).getByTestId('pull-message').textContent).toBe('Refused: No entity with id 5 (not-found)');
    expect(document.activeElement).toBe(within(d).getByRole('combobox', { name: 'Conductor 1' }));
  });

  it('only Trainee offers the skip; Trainee never kinks however often the tape is pushed', async () => {
    for (const difficulty of ['apprentice', 'realistic'] as const) {
      await mount(difficulty);
      expect(within(dialog()).queryByRole('button', { name: 'Pull without feeding' })).toBeNull();
      document.body.innerHTML = '';
      TestBed.resetTestingModule();
    }
    const { user, fixture } = await mount('trainee');
    await user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    await user.keyboard('ffffffff');
    await fixture.whenStable();
    expect(within(dialog()).getByTestId('tape-position').textContent).toBe(
      'Station 1 of 3; round 0 of 1 elbows; jams 7 here (it never kinks at Trainee), 7 in all.',
    );
    expect(within(dialog()).getByTestId('tape-alert').textContent).toBe('');
    expect(within(dialog()).getByRole('button', { name: 'Feed (F)' })).toBeDefined();
  });

  it('Trainee can pull without feeding: the same arguments, checked first', async () => {
    const { user, confirmed, checks } = await mount('trainee');
    await user.click(within(dialog()).getByRole('button', { name: 'Pull without feeding' }));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toStrictEqual(checks[0]);
  });

  it('refusals: the tape’s reach before any play, a command refusal until the rows change, an unfilled row', async () => {
    const short = await mount('trainee', { shortTape: true });
    const d = dialog();
    expect(within(d).getByTestId('pull-message').textContent).toBe(
      'Refused: Steel fish tape, 1/8 in x 50 ft reaches 1000 mm; this conduit run is 1333 mm (beyond-tool-capacity)',
    );
    await short.user.click(within(d).getByRole('button', { name: 'Feed the tape' }));
    await short.user.click(within(d).getByRole('button', { name: 'Pull without feeding' }));
    expect(short.confirmed).toHaveLength(0);
    expect(short.checks).toHaveLength(0);
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const { user, fixture } = await mount('journeyman', { refusal: 'Entity 5 not found (not-found)' });
    const e = dialog();
    expect(within(e).getByRole('alert', { name: '' })).toBeDefined();
    expect(within(e).getByTestId('pull-message').textContent).toBe('Refused: Entity 5 not found (not-found)');
    await user.selectOptions(within(e).getByRole('combobox', { name: 'Conductor 1' }), '');
    await fixture.whenStable();
    expect(within(e).getByTestId('pull-message').textContent).toBe('');
    await user.click(within(e).getByRole('button', { name: 'Feed the tape' }));
    await fixture.whenStable();
    expect(within(e).getByTestId('pull-message').textContent).toBe('Conductor 1: choose a conductor.');
    expect(within(e).queryByRole('button', { name: 'Feed (F)' })).toBeNull();
  });

  it('Escape dismisses with nothing confirmed; reduced motion makes the tape bar jump', async () => {
    const plain = await mount('journeyman');
    await plain.user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await plain.fixture.whenStable();
    expect(document.querySelector('.fill')?.classList.contains('still')).toBe(false);
    await plain.user.keyboard('{Escape}');
    await plain.fixture.whenStable();
    expect(plain.dismissed()).toBe(1);
    expect(plain.confirmed).toHaveLength(0);
    document.body.innerHTML = '';
    TestBed.resetTestingModule();

    const still = await mount('journeyman', { reducedMotion: true });
    await still.user.click(within(dialog()).getByRole('button', { name: 'Feed the tape' }));
    await still.fixture.whenStable();
    expect(document.querySelector('.fill')?.classList.contains('still')).toBe(true);
    await still.user.keyboard('f');
    await still.fixture.whenStable();
    expect((document.querySelector('.fill') as HTMLElement).style.width).toMatch(/^33\.3/);
  });
});
