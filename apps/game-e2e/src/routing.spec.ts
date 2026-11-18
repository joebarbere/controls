import { expect, type Page, test } from '@playwright/test';
import { expectOnCanvas, terminalOnPage } from './support/aim';
import { expectDrawn, runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.2 part 3, UI half (ADR 0017 §9, ADR 0010's measured design): the routing gesture. A 14 AWG THHN
 * spool in tool-belt slot 4 arms it; two terminal picks log exactly one `wire.add`, with the route the
 * renderer previewed. The same connection (block 1's terminal 1 to block 3's terminal 1, three 4 mm²
 * screw blocks 6 mm apart in front of the workshop backplate, a Trainee sandbox with seed 0) is made
 * three ways, with the mouse, with the keyboard only and with the command palette, and each reaches
 * ROUTED_HASH. Backspace and Escape step the gesture back without logging anything.
 *
 * Trainee, so the gesture lands both ends with `'auto'` terminations and opens no prompt; above
 * Trainee each pick opens a termination prompt (F3.3 part 2), covered by `terminations.spec.ts`.
 */

/** `world.hash` after the one `wire.add` (pinned from this suite; the three surfaces must agree). */
const ROUTED_HASH = '80f130c405242144ae3be6477464c55afc11261c9b52944095055ed4b4f0e6e3';

const THHN = 'conductor.tallowmere-thhn-14-solid';
/**
 * The one `wire.add` every surface logs. Between neighbouring blocks the auto-router runs straight
 * along their tops: no waypoints, and the default cut length of that route (`routeDefaultLengthMm`:
 * 12 mm plus 5 % slack, rounded up). The cutter is the default-tool rule's (`defaultTool`, not on the belt).
 */
const ROUTED_ARGS = {
  ref: { id: THHN, version: 1 },
  a: { entity: 1, terminal: 'a', termination: 'auto' },
  b: { entity: 3, terminal: 'a', termination: 'auto' },
  route: [],
  lengthMm: 13,
  colour: { base: 'black', stripe: null },
  tool: { id: 'tool.veltmark-dc-8', version: 1 },
};
const SPOOL_BUTTON = '4: 14 AWG solid copper THHN/THWN-2 building wire (spool)';
const BLOCK = '--ref.id tb.quennick-st4 --ref.version 1';

type TerminalRef = { entity: number; terminal: string };
type Entry = { id: string; args: Record<string, unknown> };
type Hooks = {
  __controlsViewport?: {
    whenIdle(): Promise<void>;
    projectTerminal(ref: TerminalRef): { x: number; y: number } | null;
    state: { terminal: { hit: TerminalRef | null; zoomSuggested: boolean } | null } | undefined;
  };
  __controlsSession?: { entries(): readonly Entry[]; hash(): Promise<string> };
};

const idle = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.whenIdle());
const entries = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ ...e })));
const wireAdds = async (page: Page) => (await entries(page)).filter((e) => e.id === 'wire.add');
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

/** Page errors and console errors, collected from the start of a test (none are expected). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Settings: Trainee for new games and the THHN spool in slot 4; then a seed-0 sandbox with the three
 * blocks placed from the console, which is closed again with the canvas focused.
 */
async function wiringSandbox(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('trainee');
  await settings
    .getByRole('group', { name: 'Tool belt' })
    .getByRole('combobox', { name: 'Slot 4' })
    .selectOption(`${THHN}@1`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  for (const [seq, x] of [-100, -94, -88].entries()) {
    await runLogged(page, `entity.place ${BLOCK} --positionMm.x ${x} --positionMm.y 0 --positionMm.z 40`, seq);
  }
  await expectDrawn(page, ['entity-1', 'entity-2', 'entity-3']);
  await page.keyboard.press('Backquote'); // close the console; focus returns to the canvas
  await page.locator('ctl-viewport canvas').focus();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

const status = (page: Page) => page.getByTestId('routing-status');

test('the mouse routes a wire with two clicks, after the zoom key frames crowded terminals', async ({ page }) => {
  const errors = collectErrors(page);
  await wiringSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await page.getByRole('toolbar', { name: 'Tool belt' }).getByRole('button', { name: SPOOL_BUTTON }).click();
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  await expect(page.getByTestId('routing-hint')).toContainText('Pick the first terminal');

  // At the default framing the blocks' terminals are a few pixels apart: the HUD offers the zoom.
  const crowded = await terminalOnPage(page, { entity: 2, terminal: 'a' });
  await page.mouse.move(crowded.x, crowded.y);
  await expect(page.getByTestId('routing-hint')).toContainText('Terminals are crowded here: Z zooms in.');
  await page.keyboard.press('KeyZ');
  await expect(viewport).toHaveAttribute('data-focus', 'entity-2');

  const a = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.click(a.x, a.y);
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await expect(status(page)).toContainText(
    'From Screw-clamp feed-through terminal block, 4 mm² class, grey #1, terminal 1',
  );
  const b = await terminalOnPage(page, { entity: 3, terminal: 'a' });
  await page.mouse.move(b.x, b.y);
  await expect(page.getByTestId('routing-hint')).toContainText('click or Enter adds the wire');
  await page.mouse.click(b.x, b.y);
  await expect(status(page)).toContainText('Wire added from');
  await expect(viewport).toHaveAttribute('data-routing', 'armed'); // the spool stays armed

  // Everything logged, in order: the gesture's picks never are, only its one wire.add.
  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'view.focus',
    'wire.add',
  ]);
  expect((await wireAdds(page)).map((e) => e.args)).toStrictEqual([ROUTED_ARGS]);
  expect(await hash(page)).toBe(ROUTED_HASH);
  expect(errors).toStrictEqual([]);
});

test('the keyboard alone routes the same wire: number key, selection cycling, Tab and Enter', async ({ page }) => {
  const errors = collectErrors(page);
  await wiringSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await page.keyboard.press('Digit4');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');

  /** `]` until `entity-<n>` is selected (fixtures come first in the cycle). */
  const selectEntity = async (n: number) => {
    for (let i = 0; i < 40; i++) {
      const before = await viewport.getAttribute('data-selected');
      if (before === `entity-${n}`) return;
      await page.keyboard.press('BracketRight');
      await expect.poll(() => viewport.getAttribute('data-selected')).not.toBe(before);
    }
    throw new Error(`entity-${n} was never selected`);
  };

  await selectEntity(1);
  await page.keyboard.press('Tab'); // the first terminal in reading order: terminal 1 (a), the top one
  await expect(status(page)).toContainText(
    'Terminal: Screw-clamp feed-through terminal block, 4 mm² class, grey #1, terminal 1',
  );
  await expect(page.locator('ctl-viewport canvas')).toBeFocused(); // Tab didn't leave the canvas
  await page.keyboard.press('Enter');
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await selectEntity(3);
  await page.keyboard.press('Tab'); // block 3's terminal 1 (a)
  await page.keyboard.press('Tab'); // its terminal 2 (b)
  await page.keyboard.press('Shift+Tab'); // back to terminal 1
  await expect(status(page)).toContainText('#3, terminal 1. Enter picks it.');
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText('Wire added from');

  // Everything logged, in order: selection cycling, Tab and Enter never are, only the one wire.add.
  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'wire.add',
  ]);
  expect((await wireAdds(page)).map((e) => e.args)).toStrictEqual([ROUTED_ARGS]);
  expect(await hash(page)).toBe(ROUTED_HASH);
  // Not routing any more (the spool put away with Escape): Tab moves focus off the canvas again.
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-routing', /.*/);
  await page.keyboard.press('Tab');
  await expect(page.locator('ctl-viewport canvas')).not.toBeFocused();
  expect(errors).toStrictEqual([]);
});

test('Backspace removes the last waypoint, then the first terminal; Escape cancels, then puts the spool away', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await wiringSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await page.keyboard.press('Digit4');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  const crowded = await terminalOnPage(page, { entity: 2, terminal: 'a' });
  await page.mouse.move(crowded.x, crowded.y);
  await expect(page.getByTestId('routing-hint')).toContainText('Z zooms in');
  await page.keyboard.press('KeyZ');
  await expect(viewport).toHaveAttribute('data-focus', 'entity-2');

  const a = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.click(a.x, a.y);
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  // A click on the backplate, off every terminal: a waypoint.
  const box = (await page.locator('ctl-viewport canvas').boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const plate = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 };
  await expectOnCanvas(page, plate, 'the backplate point');
  await page.mouse.click(plate.x, plate.y);
  await expect(status(page)).toHaveText(/Waypoint 1 added \(\w+ waypoint\)\./);
  await page.keyboard.press('Backspace');
  await expect(status(page)).toHaveText('Waypoint removed; 0 left.');
  await page.keyboard.press('Backspace');
  await expect(status(page)).toHaveText('First terminal cleared. Pick the first terminal.');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');

  await page.mouse.click(a.x, a.y);
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveText('Route cancelled.');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveText('Spool put away.');
  await expect(viewport).not.toHaveAttribute('data-routing', /.*/);
  await expect(page.getByTestId('hud-tool')).toHaveText('None');
  // Nothing about the gesture was logged: the placements, the slot pick and the zoom only.
  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'view.focus',
  ]);
  expect(errors).toStrictEqual([]);
});

test('the palette can express the same wire: Add a wire with the same arguments reaches the same hash', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await wiringSandbox(page);
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.type('add a wire');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'wire.add');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: 'Arguments for Add a wire' });
  await expect(form).toBeVisible();

  const group = (name: string) => form.getByRole('group', { name, exact: true });
  await group('Conductor').getByRole('textbox', { name: 'ID' }).fill(THHN);
  await group('Conductor').getByRole('textbox', { name: 'Version' }).fill('1');
  for (const [end, entity] of [
    ['End a', '1'],
    ['End b', '3'],
  ] as const) {
    await group(end).getByRole('radio', { name: 'Specify' }).check();
    await group(end).getByRole('combobox', { name: 'Entity' }).fill(entity);
    await group(end).getByRole('textbox', { name: 'Terminal' }).fill('a');
    await group(end).getByRole('group', { name: 'Termination' }).getByRole('radio', { name: 'auto' }).check();
  }
  // ROUTED_ARGS: no route waypoints (the Route list stays empty) and the gesture's length.
  await form.getByRole('textbox', { name: 'Length (mm)' }).fill('13');
  await group('Colour').getByRole('textbox', { name: 'Base' }).fill('black');
  await group('Cutter').getByRole('textbox', { name: 'ID' }).fill('tool.veltmark-dc-8');
  await group('Cutter').getByRole('textbox', { name: 'Version' }).fill('1');
  await form.getByRole('button', { name: 'Run' }).click();
  await expect(palette).toBeHidden();

  expect((await wireAdds(page)).map((e) => e.args)).toStrictEqual([ROUTED_ARGS]);
  expect(await hash(page)).toBe(ROUTED_HASH);
  expect(errors).toStrictEqual([]);
});
