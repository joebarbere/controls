import { expect, type Page, test } from '@playwright/test';
import { terminalOnPage } from './support/aim';
import { expectDrawn, runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.3 part 2 (D9, ADR 0015 "Which command a surface logs"): the termination prompts at Journeyman.
 * The routing gesture of `routing.spec.ts` (block 1's terminal 1 to block 3's terminal 1, three 4 mm²
 * screw blocks 6 mm apart, the THHN spool in slot 4, seed 0), but above Trainee: each terminal pick
 * opens a blank prompt, the player strips in the 14 AWG solid hole to the block's marked 9 mm and
 * tightens to 0.6 N·m with the torque screwdriver in hand, and the route logs exactly one `wire.add`
 * carrying both terminations. A setting beyond the driver's range is refused inside the prompt, with
 * nothing logged. Pixel-aimed, so 1280 × 720 and every click checked with `terminalOnPage`.
 */

/** `world.hash` after the one `wire.add` (pinned from this spec; the console line below reaches it too). */
const LANDED_HASH = 'b22fc26f7307293e13f6ba92eb2f774f804c00b9992327fd5dabe45ad7051e7c';

const THHN = 'conductor.tallowmere-thhn-14-solid';
const TERMINATION = {
  method: 'screw',
  strip: { tool: { id: 'tool.veltmark-ws-1018', version: 1 }, hole: 'sol14', lengthMm: 9 },
  accessory: null,
  clamp: { tool: { id: 'tool.calderyn-ts-03', version: 1 }, torqueNm: 0.6 },
};
const LANDED_ARGS = {
  ref: { id: THHN, version: 1 },
  a: { entity: 1, terminal: 'a', termination: TERMINATION },
  b: { entity: 3, terminal: 'a', termination: TERMINATION },
  route: [],
  lengthMm: 13,
  colour: { base: 'black', stripe: null },
  tool: { id: 'tool.veltmark-dc-8', version: 1 },
};
const SPOOL_BUTTON = '4: 14 AWG solid copper THHN/THWN-2 building wire (spool)';
const BLOCK = '--ref.id tb.quennick-st4 --ref.version 1';

type Entry = { id: string; args: Record<string, unknown> };
type Hooks = {
  __controlsViewport?: { whenIdle(): Promise<void> };
  __controlsSession?: { entries(): readonly Entry[]; hash(): Promise<string> };
};

const entries = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ ...e })));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

/** Settings: Journeyman for new games and the THHN spool in slot 4; a seed-0 sandbox with three blocks. */
async function journeymanSandbox(page: Page): Promise<void> {
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
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  for (const [seq, x] of [-100, -94, -88].entries()) {
    await runLogged(page, `entity.place ${BLOCK} --positionMm.x ${x} --positionMm.y 0 --positionMm.z 40`, seq);
  }
  await expectDrawn(page, ['entity-1', 'entity-2', 'entity-3']);
  await page.keyboard.press('Backquote');
  await page.locator('ctl-viewport canvas').focus();
}

/** Fills one end's blank prompt from the keyboard: hole, strip length, Enter, torque, Enter. */
async function terminate(page: Page, end: 'a' | 'b', torque: string): Promise<void> {
  const strip = page.getByRole('dialog', { name: `End ${end}: strip and finish` });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('combobox', { name: 'Method' })).toBeFocused();
  await expect(strip.getByRole('combobox', { name: 'Strip hole' })).toHaveValue('');
  await strip.getByRole('combobox', { name: 'Strip hole' }).selectOption({ label: '14 AWG solid' });
  await strip.getByRole('textbox', { name: 'Strip length (mm)' }).fill('9');
  await page.keyboard.press('Enter');
  const tighten = page.getByRole('dialog', { name: `End ${end}: tighten` });
  await expect(tighten.getByRole('combobox', { name: 'Screwdriver' })).toBeFocused();
  await expect(tighten.getByRole('combobox', { name: 'Screwdriver' })).toHaveValue('tool.calderyn-ts-03@1');
  await tighten.getByRole('textbox', { name: 'Torque setting (N·m)' }).fill(torque);
  await page.keyboard.press('Enter');
}

test('at Journeyman each end is stripped and torqued in its prompt, and the route logs one wire.add', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await journeymanSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await page.getByRole('toolbar', { name: 'Tool belt' }).getByRole('button', { name: SPOOL_BUTTON }).click();
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  // The blocks' terminals are a few pixels apart at the default framing: frame block 2 first.
  const crowded = await terminalOnPage(page, { entity: 2, terminal: 'a' });
  await page.mouse.move(crowded.x, crowded.y);
  await expect(page.getByTestId('routing-hint')).toContainText('Z zooms in.');
  await page.keyboard.press('KeyZ');
  await expect(viewport).toHaveAttribute('data-focus', 'entity-2');

  const a = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.click(a.x, a.y);
  await expect(page.getByRole('dialog', { name: 'End a: strip and finish' })).toBeVisible();
  // Shown modally (showModal): the rest of the page is inert while it is open.
  expect(await page.evaluate(() => document.querySelector('ctl-termination-prompt dialog')?.matches(':modal'))).toBe(
    true,
  );
  // The command's own check refuses 3 N·m on a 0.3–1.2 N·m driver, inside the prompt: nothing logged.
  await terminate(page, 'a', '3');
  const tighten = page.getByRole('dialog', { name: 'End a: tighten' });
  await expect(tighten.getByRole('alert')).toContainText('(beyond-tool-capacity)');
  await tighten.getByRole('textbox', { name: 'Torque setting (N·m)' }).fill('0.6');
  await page.keyboard.press('Enter');
  await expect(tighten).toBeHidden();
  await expect(viewport).toHaveAttribute('data-routing', 'started');
  await expect(page.locator('ctl-viewport canvas')).toBeFocused(); // focus returns to the canvas
  await expect(page.getByTestId('routing-status')).toContainText('(screw clamp). Pick the second terminal.');

  const b = await terminalOnPage(page, { entity: 3, terminal: 'a' });
  await page.mouse.click(b.x, b.y);
  await terminate(page, 'b', '0.6');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('routing-status')).toContainText('Wire added from');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');

  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'view.focus',
    'wire.add',
  ]);
  expect((await entries(page)).filter((e) => e.id === 'wire.add').map((e) => e.args)).toStrictEqual([LANDED_ARGS]);
  expect(await hash(page)).toBe(LANDED_HASH);
  expect(errors).toStrictEqual([]);
});

test('Escape dismisses a prompt: the pick is not taken and nothing is logged', async ({ page }) => {
  await journeymanSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await page.keyboard.press('Digit4');
  await expect(viewport).toHaveAttribute('data-routing', 'armed');
  const crowded = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.move(crowded.x, crowded.y);
  await expect(page.getByTestId('routing-hint')).toContainText('Z zooms in.');
  await page.keyboard.press('KeyZ');
  await expect(viewport).toHaveAttribute('data-focus', 'entity-1');
  const a = await terminalOnPage(page, { entity: 1, terminal: 'a' });
  await page.mouse.click(a.x, a.y);
  await expect(page.getByRole('dialog', { name: 'End a: strip and finish' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  await expect(page.getByTestId('routing-status')).toHaveText('Termination cancelled. Pick the first terminal.');
  await expect(viewport).toHaveAttribute('data-routing', 'armed'); // Escape closed the prompt, not the spool
  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'view.focus',
  ]);
});

test('the keyboard alone routes and lands the wire; Escape on end b keeps the route started', async ({ page }) => {
  await journeymanSandbox(page);
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  const status = page.getByTestId('routing-status');
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
  /** One end's prompt, from the keyboard only: Tab between fields, arrows in the hole list, typing, Enter. */
  const fillByKeyboard = async (end: 'a' | 'b') => {
    const strip = page.getByRole('dialog', { name: `End ${end}: strip and finish` });
    await expect(strip).toBeVisible();
    // The picking Enter didn't leak into the prompt: still the first step, first field, nothing flagged.
    await expect(strip.getByRole('combobox', { name: 'Method' })).toBeFocused();
    await expect(strip.getByRole('alert')).toHaveText('');
    await expect(strip.getByRole('combobox', { name: 'Strip hole' })).toHaveValue('');
    await page.keyboard.press('Tab'); // Stripper
    await page.keyboard.press('Tab'); // Strip hole
    const hole = strip.getByRole('combobox', { name: 'Strip hole' });
    await expect(hole).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown'); // Choose… → 10 → 12 → 14 AWG solid
    await expect(hole).toHaveValue('sol14');
    await page.keyboard.press('Tab');
    await expect(strip.getByRole('textbox', { name: 'Strip length (mm)' })).toBeFocused();
    await page.keyboard.type('9');
    await page.keyboard.press('Enter');
    const tighten = page.getByRole('dialog', { name: `End ${end}: tighten` });
    await expect(tighten.getByRole('combobox', { name: 'Screwdriver' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tighten.getByRole('textbox', { name: 'Torque setting (N·m)' })).toBeFocused();
    await page.keyboard.type('0.6');
    await page.keyboard.press('Enter');
    await expect(tighten).toBeHidden();
    await expect(canvas).toBeFocused();
  };

  await selectEntity(1);
  await page.keyboard.press('Tab'); // block 1's terminal 1
  await expect(status).toContainText('#1, terminal 1. Enter picks it.');
  await page.keyboard.press('Enter');
  await fillByKeyboard('a');
  await expect(viewport).toHaveAttribute('data-routing', 'started');

  await selectEntity(3);
  await page.keyboard.press('Tab'); // block 3's terminal 1
  await expect(status).toContainText('#3, terminal 1. Enter picks it.');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'End b: strip and finish' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(canvas).toBeFocused();
  await expect(viewport).toHaveAttribute('data-routing', 'started'); // the route and end a are kept
  await expect(status).toHaveText('Termination cancelled. Pick the second terminal.');

  await page.keyboard.press('Enter'); // the keyboard terminal again
  await fillByKeyboard('b');
  await expect(status).toContainText('Wire added from');
  expect((await entries(page)).map((e) => e.id)).toStrictEqual([
    'entity.place',
    'entity.place',
    'entity.place',
    'toolbelt.select',
    'wire.add',
  ]);
  expect((await entries(page)).filter((e) => e.id === 'wire.add').map((e) => e.args)).toStrictEqual([LANDED_ARGS]);
  expect(await hash(page)).toBe(LANDED_HASH);
});

test('the console logs the same wire.add with the same terminations and reaches the same hash', async ({ page }) => {
  await journeymanSandbox(page);
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  const end = (name: 'a' | 'b', entity: number) =>
    [
      `--${name}.entity ${entity} --${name}.terminal a --${name}.termination.method screw`,
      `--${name}.termination.strip.tool.id tool.veltmark-ws-1018 --${name}.termination.strip.tool.version 1`,
      `--${name}.termination.strip.hole sol14 --${name}.termination.strip.lengthMm 9`,
      `--${name}.termination.accessory null`,
      `--${name}.termination.clamp.tool.id tool.calderyn-ts-03 --${name}.termination.clamp.tool.version 1`,
      `--${name}.termination.clamp.torqueNm 0.6`,
    ].join(' ');
  await runLogged(
    page,
    [
      `wire.add --ref.id ${THHN} --ref.version 1`,
      end('a', 1),
      end('b', 3),
      '--route [] --lengthMm 13 --colour.base black --colour.stripe null',
      '--tool.id tool.veltmark-dc-8 --tool.version 1',
    ].join(' '),
    3,
  );
  expect((await entries(page)).filter((e) => e.id === 'wire.add').map((e) => e.args)).toStrictEqual([LANDED_ARGS]);
  expect(await hash(page)).toBe(LANDED_HASH);
});
