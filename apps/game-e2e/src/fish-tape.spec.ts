import { expect, type Page, test } from '@playwright/test';
import { expectDrawn, runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.4 part 2's acceptance: one conduit pull with the keyboard (D10). At Journeyman, a seed-0 sandbox
 * gets the `drill-and-pull` scenario's conduit run from the console: the DIN panel on the stud faces,
 * its 3/4 in drill site cut with the 1-1/8 in hole saw, a connector in the hole, a 600 mm stick up from
 * it, a 90° elbow and a 400 mm stick along +x. The THHN 12 AWG spool is on belt slot 4, so it is the
 * prompt's first conductor. Keyboard only from there:
 *
 * - the palette's "Fish tape: pull wires through conduit…" on the stick (Conduit 3) opens the
 *   fish tape prompt (the catalogue's 50 ft tape: none on the belt);
 * - the first row is the spool's black; Add conductor copies it and type-ahead makes the second white;
 *   Feed the tape starts the game;
 * - F feeds, F again jams against the elbow (1 of 2 at Journeyman), T twists round it, F is through,
 *   P pulls: exactly one `wire.pull` is logged, and nothing for any key of the game.
 *
 * The full logged entry list and `world.hash` are pinned, and the logged `wire.pull` typed into the
 * console of a fresh sandbox (with the same setup) reaches the same hash. Hashes re-pin when world v3
 * changes before its freeze (F3.4 part 2 note 4: `EntityV3.inEntry`).
 */

/** `world.hash` after the pull (pinned from this spec; the console twin reaches it too). */
const PULL_HASH = '8b01204e11ccc61aeaaf817dbcd5f496f5d25479c3a59dbfde765d928fb23308';

const THHN = 'conductor.tallowmere-thhn-12-solid';
const UPRIGHT = '--orientationMdeg.yaw 0 --orientationMdeg.pitch 0 --orientationMdeg.roll 0';
const ROLLED = '--orientationMdeg.yaw 0 --orientationMdeg.pitch 0 --orientationMdeg.roll 90000';
const place = (id: string, x: number, y: number, z: number, turn = UPRIGHT) =>
  `entity.place --ref.id ${id} --ref.version 1 --positionMm.x ${x} --positionMm.y ${y} --positionMm.z ${z} ${turn} --mountedOn null`;
const SETUP = [
  place('panel.pellmoor-din-400x500', -1010, 800, -21),
  'enclosure.openEntry --id 1 --entry drill-top-1 --tool.id tool.corriden-hs-18 --tool.version 1',
  place('connector.stavenor-emt-075', -863, 1300, 62, ROLLED),
  place('emt.stavenor-075', -868, 1325, 67, ROLLED),
  'raceway.cut --id 3 --lengthMm 600',
  place('elbow.stavenor-emt-075', -892, 1925, 67),
  place('emt.stavenor-075', -702, 2091, 67),
  'raceway.cut --id 5 --lengthMm 400',
];

const ref = (id: string) => JSON.stringify({ id, version: 1 });
const waypoint = (kind: 'free' | 'conduit', x: number, y: number, z: number, entity: number | null = null) =>
  JSON.stringify({ kind, positionMm: { x, y, z }, entity, fixture: null, tool: null });
const thhn = (base: string) => JSON.stringify({ ref: { id: THHN, version: 1 }, colour: { base, stripe: null } });
/**
 * The one logged `wire.pull`, as a console line: 200 mm into the panel, the connector's two ends, the
 * elbow's two ports (so `pullRun` measures its centreline), the far stick's end, 200 mm past it; the
 * default cut (`routeDefaultLengthMm`: the polyline plus 5 %); the black, then the white; the tape.
 */
const PULL_LINE =
  'wire.pull --route [' +
  [
    waypoint('free', -880, 1100, 79),
    waypoint('conduit', -880, 1300, 79, 2),
    waypoint('conduit', -880, 1325, 79, 2),
    waypoint('conduit', -880, 1925, 79, 4),
    waypoint('conduit', -702, 2103, 79, 4),
    waypoint('conduit', -302, 2103, 79, 5),
    waypoint('free', -102, 2103, 79),
  ].join(',') +
  `] --lengthMm 1761 --conductors [${thhn('black')},${thhn('white')}] --tool ${ref('tool.veltmark-fr-1524')}`;

type Entry = { id: string; args: Record<string, unknown> };
type Hooks = { __controlsSession?: { entries(): readonly Entry[]; hash(): Promise<string> } };
const entries = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ ...e })));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

/** A logged command as one console line (top-level values as words, objects and lists as JSON words). */
function consoleLine(entry: Entry): string {
  const words = Object.entries(entry.args).map(
    ([k, v]) => `--${k} ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
  );
  return [entry.id, ...words].join(' ');
}

/** A seed-0 sandbox with the console open and the conduit run built from it. */
async function runSandbox(page: Page): Promise<void> {
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  for (const [seq, line] of SETUP.entries()) await runLogged(page, line, seq);
  await expectDrawn(page, ['entity-1', 'entity-2', 'entity-3', 'entity-4', 'entity-5']);
}

test('one conduit pull with the keyboard: the palette opens the fish tape, the game logs one wire.pull', async ({
  page,
}) => {
  test.slow(); // the played pull, then a second page replaying it
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('journeyman');
  await settings
    .getByRole('group', { name: 'Tool belt' })
    .getByRole('combobox', { name: 'Slot 4' })
    .selectOption(`${THHN}@1`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await runSandbox(page);
  await page.keyboard.press('Backquote');
  const canvas = page.locator('ctl-viewport canvas');
  await canvas.focus();
  const logBefore = (await entries(page)).length;

  // The palette: the fish tape on the stick (entity 3), by number.
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Control+K');
  await expect(palette.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.type('Fish tape');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'wiring.pull');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: /^Arguments for Fish tape: pull wires/ });
  await expect(form.getByRole('combobox', { name: 'Conduit' })).toBeFocused();
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();

  // The prompt: the run against the tape, the spool's black first.
  const prompt = page.getByRole('dialog', { name: 'Fish tape: pull conductors' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId('pull-run')).toHaveText('Run: 1333 mm of conduit, 1 elbow (90° of bends).');
  await expect(prompt.getByTestId('pull-tape')).toContainText('Steel fish tape, 1/8 in x 50 ft (not on the belt)');
  const conductor1 = prompt.getByRole('combobox', { name: 'Conductor 1' });
  await expect(conductor1).toBeFocused();
  await expect(conductor1).toHaveValue(`${THHN}@1`);
  await page.keyboard.press('Tab'); // Colour 1: black
  await expect(prompt.getByRole('combobox', { name: 'Colour 1' })).toHaveValue('black');
  await page.keyboard.press('Tab'); // Remove
  await page.keyboard.press('Tab');
  await expect(prompt.getByRole('button', { name: 'Add conductor' })).toBeFocused();
  await page.keyboard.press('Enter');
  const colour2 = prompt.getByRole('combobox', { name: 'Colour 2' });
  await expect(colour2).toHaveValue('black'); // a copy of the row above
  await page.keyboard.press('Shift+Tab'); // Remove conductor 2
  await page.keyboard.press('Shift+Tab');
  await expect(colour2).toBeFocused();
  await page.keyboard.type('white'); // type-ahead on the closed select (every platform, see the UI caveats)
  await expect(colour2).toHaveValue('white');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const feedTheTape = prompt.getByRole('button', { name: 'Feed the tape' });
  await expect(feedTheTape).toBeFocused();
  await page.keyboard.press('Enter');

  // The game, by its keys; every step is said in the prompt's own status.
  const status = prompt.getByTestId('tape-status');
  await expect(prompt.getByRole('button', { name: 'Feed (F)' })).toBeFocused();
  await page.keyboard.press('KeyF');
  await expect(status).toHaveText('Fed: station 1 of 3.');
  await page.keyboard.press('KeyF');
  await expect(status).toHaveText('The tape is jammed against a bend (1 jam of 2). Twist (T), or pull back (R).');
  await page.keyboard.press('KeyT');
  await expect(status).toHaveText('Round elbow 1: station 2 of 3.');
  await page.keyboard.press('KeyF');
  await expect(status).toHaveText('The tape is through at end b. Pull the conductors back (P).');
  await expect(prompt.getByRole('button', { name: 'Pull the conductors (P)' })).toBeFocused();
  expect((await entries(page)).length).toBe(logBefore); // nothing logged by the game
  await page.keyboard.press('KeyP');
  await expect(prompt).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(page.getByTestId('routing-status')).toHaveText(
    'Pulled 2 conductors through the 3/4 in conduit run of 4 parts (connector #2 to stick #5): wires 1–2, both ends free.',
  );

  const logged = await entries(page);
  const lines = logged.map(consoleLine);
  expect(lines.slice(SETUP.length)).toStrictEqual([PULL_LINE]);
  expect(await hash(page)).toBe(PULL_HASH);
  expect(errors).toStrictEqual([]);

  // The console twin: the same setup and the logged wire.pull in a fresh sandbox reach the same hash.
  const twin = await page.context().newPage();
  await page.close();
  await twin.setViewportSize({ width: 1280, height: 720 });
  await twin.goto('/?e2e=1&renderer=webgl2');
  await runSandbox(twin);
  await runLogged(twin, PULL_LINE, SETUP.length);
  expect(await hash(twin)).toBe(PULL_HASH);
});
