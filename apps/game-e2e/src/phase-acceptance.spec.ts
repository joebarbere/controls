import { workspaceRoot } from '@nx/devkit';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * The P1 phase acceptance: place, move and delete objects with undo and redo through the mouse,
 * the palette and the console, with the same resulting `world.hash` on every surface. One scenario,
 * `apps/sim-cli/scenarios/phase-acceptance.console`; the fourth driver is `sim-cli`
 * (`apps/sim-cli/src/phase-acceptance.spec.ts` runs the file and a snapping script). Every test
 * here starts New sandbox with seed 0 (the workshop level), must log exactly the file's command ids
 * and must end at PHASE_ACCEPTANCE_HASH, the literal the sim-cli spec asserts (e2e projects can't
 * import workspace code: change both or neither).
 *
 * The mouse is aimed at integer-mm world points through the `?e2e=1` hook's `projectMm` (view
 * state only), and snapping turns each into the file's exact positions, as in `placement.spec.ts`.
 * Forced WebGL2, the backend CI exercises on GPU-less runners.
 */
const PHASE_ACCEPTANCE_HASH = '253c755de38cf6f4693ce718232ef1029ed1f95212fea553979d86cb08aaf151';

const SCENARIO_FILE = 'phase-acceptance.console';
const SCENARIO = readFileSync(join(workspaceRoot, 'apps/sim-cli/scenarios', SCENARIO_FILE), 'utf8');

/** Command ids of the console-line file, in order (comments, blank lines and `world.hash` dropped). */
const SCENARIO_IDS = SCENARIO.split('\n')
  .map((line) => line.replace(/#.*$/, '').trim())
  .filter((line) => line !== '' && line !== 'world.hash')
  .map((line) => line.split(/\s+/)[0]);

// The hooks are typed in viewport.spec.ts and world-hash.spec.ts (global Window augmentations);
// this file reads them through a local cast so the declarations don't clash.
interface Hooks {
  __controlsViewport?: {
    projectMm(p: { x: number; y: number; z: number }): { x: number; y: number } | undefined;
  };
  __controlsSession?: {
    hash(): string;
    entries(): ReadonlyArray<{ id: string }>;
  };
}

const logged = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => e.id));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

/** Page coordinates of an integer-mm world point on the canvas. */
async function screen(page: Page, canvas: Locator, x: number, y: number, z: number) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const p = await page.evaluate((mm) => (window as unknown as Hooks).__controlsViewport?.projectMm(mm), { x, y, z });
  if (!p) throw new Error('viewport not started');
  return { x: box.x + p.x, y: box.y + p.y };
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  const canvas = page.locator('ctl-viewport canvas');
  await expect(canvas).toBeFocused();
  return { viewport, canvas };
}

/** Every driver ends the same way: the file's commands in its order, and the golden hash. */
async function expectScenarioDone(page: Page) {
  await expect.poll(() => logged(page)).toEqual(SCENARIO_IDS);
  expect(await hash(page)).toBe(PHASE_ACCEPTANCE_HASH);
}

test('mouse: place, drag and delete, with undo and redo on the keyboard', async ({ page }) => {
  const { viewport, canvas } = await open(page);

  // Key 1 arms the box from the tool belt; the ghost snaps to the backplate and a click commits.
  await page.keyboard.press('Digit1');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.box');
  const a = await screen(page, canvas, -150, 300, 0);
  await page.mouse.move(a.x, a.y);
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(a.x, a.y);
  await expect.poll(() => logged(page)).toHaveLength(2);

  await page.keyboard.press('Digit2');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.crate');
  const b = await screen(page, canvas, 100, -200, 0);
  await page.mouse.move(b.x, b.y);
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => logged(page)).toHaveLength(4);
  await page.keyboard.press('Escape'); // put the tool away (no command)
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);

  // Drag the box onto DIN rail 1: one entity.move on release.
  const grab = await screen(page, canvas, -150, 300, 60);
  const drop = await screen(page, canvas, -10, 150, 7);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 12 });
  await expect(viewport).toHaveAttribute('data-placement-target', 'din-rail-1');
  await page.mouse.up();
  await expect.poll(() => logged(page)).toHaveLength(5);

  // Click the crate, Delete, then Ctrl+Z, Ctrl+Shift+Z, Ctrl+Z. The project emulates Desktop Chrome
  // on Windows, so the app's Mod is Ctrl on every host OS.
  const crate = await screen(page, canvas, 100, -200, 200);
  await page.mouse.click(crate.x, crate.y);
  await expect(viewport).toHaveAttribute('data-selected', 'entity-2');
  await page.keyboard.press('Delete');
  await expect.poll(() => logged(page)).toHaveLength(6);
  for (const [chord, length] of [
    ['Control+Z', 7],
    ['Control+Shift+Z', 8],
    ['Control+Z', 9],
  ] as const) {
    await page.keyboard.press(chord);
    await expect.poll(() => logged(page)).toHaveLength(length);
  }

  await expectScenarioDone(page);
});

test('palette: the same scenario, keyboard only, through generated argument forms', async ({ page }) => {
  const { canvas } = await open(page);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox', { name: 'Search commands' });

  /** Ctrl+Shift+P, type the title, Enter on the top match; fills the form (if any) and runs it. */
  async function run(title: string, command: string, fields: ReadonlyArray<readonly [string, string]> = []) {
    await page.keyboard.press('Control+Shift+P');
    await expect(search).toBeFocused();
    await page.keyboard.type(title);
    await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', command);
    await page.keyboard.press('Enter');
    if (fields.length > 0) {
      const form = palette.getByRole('form', { name: `Arguments for ${title}` });
      await expect(form).toBeVisible();
      for (const [i, [label, value]] of fields.entries()) {
        // Entity ids are a combobox (a text field with the world's entities as suggestions).
        const field = form.getByLabel(label, { exact: true });
        await expect(field).toBeFocused();
        await page.keyboard.type(value);
        // ArrowDown moves to the next field. Past the last field it would reach the Back button, so
        // Enter is pressed in the last field typed (the rest keep their schema defaults).
        if (i < fields.length - 1) await page.keyboard.press('ArrowDown');
      }
      await page.keyboard.press('Enter');
    }
    await expect(palette).toBeHidden();
    await expect(canvas).toBeFocused();
  }

  const place = (id: string, x: string, y: string) =>
    run('Place object', 'entity.place', [
      ['ID', id],
      ['Version', '1'],
      ['X', x],
      ['Y', y],
      ['Z', '0'],
    ]);

  await run('Select tool-belt slot', 'toolbelt.select', [['Slot', '1']]);
  await place('prop.box', '-210', '260');
  await run('Select tool-belt slot', 'toolbelt.select', [['Slot', '2']]);
  await place('prop.crate', '-50', '-300');
  await run('Move object', 'entity.move', [
    ['Entity', '1'],
    ['X', '-75'],
    ['Y', '110'],
    ['Z', '0'],
  ]);
  await run('Delete object', 'entity.delete', [['Entity', '2']]);
  await run('Undo', 'edit.undo');
  await run('Redo', 'edit.redo');
  await run('Undo', 'edit.undo');

  await expectScenarioDone(page);
});

test('console: `run` of the scenario file reaches the same hash', async ({ page }) => {
  await open(page);
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: SCENARIO_FILE, mimeType: 'text/plain', buffer: Buffer.from(SCENARIO) });
  const log = page.getByRole('log', { name: 'Console output' });
  await expect(log).toContainText(`Ran ${SCENARIO_IDS.length} commands from ${SCENARIO_FILE}.`);
  await expect(log).toContainText(PHASE_ACCEPTANCE_HASH); // the file's own `world.hash` line
  await expectScenarioDone(page);
});
