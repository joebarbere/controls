import { expect, test, type Page } from '@playwright/test';
import { expectVisibleFocus, tabTo } from './support/focus';
import { startSandbox } from './support/sandbox';

/**
 * F3.4 part 1: the tool belt holds tools as well as props. A tool is put on the belt in Settings,
 * picked with its number key or from the belt bar over the viewport (keyboard or mouse), and the HUD
 * names it. Every pick is the same `toolbelt.select` view command; a tool slot never arms placement.
 */

type Hooks = { __controlsSession?: { entries(): ReadonlyArray<{ id: string; args: Record<string, unknown> }> } };

const entries = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ id: e.id, args: e.args })),
  );

const STRIPPERS = 'Wire strippers, 10–18 AWG solid / 12–20 AWG stranded';

/** Puts the wire strippers in slot 4 and the torque screwdriver in slot 5 from Settings, then starts a sandbox. */
async function beltWithTools(page: Page): Promise<void> {
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const belt = settings.getByRole('group', { name: 'Tool belt' });
  await belt.getByRole('combobox', { name: 'Slot 4' }).selectOption('tool.veltmark-ws-1018@1');
  await belt.getByRole('combobox', { name: 'Slot 5' }).selectOption('tool.calderyn-ts-15@1');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

test('number keys and the belt bar pick tools; the HUD names the active one, and a tool never arms placement', async ({
  page,
}) => {
  await beltWithTools(page);
  const hud = page.getByTestId('hud-tool');
  const viewport = page.locator('ctl-viewport');
  const toolbar = page.getByRole('toolbar', { name: 'Tool belt' });
  await expect(hud).toHaveText('None');
  await expect(toolbar.getByRole('button', { name: `4: ${STRIPPERS} (tool)` })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // The number key on the canvas: the strippers are held, nothing is armed for placement.
  await page.keyboard.press('Digit4');
  await expect(hud).toHaveText(`4: ${STRIPPERS}`);
  await expect(toolbar.getByRole('button', { name: `4: ${STRIPPERS} (tool)` })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);

  // A prop slot still arms placement.
  await page.keyboard.press('Digit1');
  await expect(hud).toHaveText('1: Box');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.box');

  // Keyboard on the belt bar: one tab stop (the active slot), arrows move, Enter picks.
  const box = toolbar.getByRole('button', { name: '1: Box (to place)' });
  await tabTo(page, box, 25);
  await expectVisibleFocus(page, box);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const torque = toolbar.getByRole('button', { name: '5: Torque screwdriver, 1–5 N·m (tool)' });
  await expectVisibleFocus(page, torque);
  await expect(hud).toHaveText('1: Box'); // moving focus picks nothing
  await page.keyboard.press('Enter');
  await expect(hud).toHaveText('5: Torque screwdriver, 1–5 N·m');
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);

  // The mouse: a click on slot 4.
  await toolbar.getByRole('button', { name: `4: ${STRIPPERS} (tool)` }).click();
  await expect(hud).toHaveText(`4: ${STRIPPERS}`);

  // Every surface ran the one view command.
  expect(await entries(page)).toEqual([4, 1, 5, 4].map((slot) => ({ id: 'toolbelt.select', args: { slot } })));
});
