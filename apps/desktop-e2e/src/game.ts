import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Places a crate at a fixed spot, as a console line (the desktop app has no test hook). */
export const PLACE =
  'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200';

/**
 * F2.5, decision D6 in the shipped runtime: the bench demo's world hashes, lit (switch closed, 1.5 s)
 * and then out (switch opened, 0.5 s more), the literals `apps/sim-cli/src/bench-lamp.spec.ts` pins
 * under Node and `apps/game-e2e/src/bench-lamp.spec.ts` in Chromium (engine 6). Change all of them
 * together, never one: a difference in Electron is float drift between V8 builds, not a golden to re-pin.
 */
export const BENCH_LAMP_LIT_HASH = 'b94f50ce3682363951da92ebfc36c31ee3f31ee38a446d06fb4f6d2a1f3281d2';
export const BENCH_LAMP_HASH = '38784069e9d2d06e15b96a958dd19c8c1af8aaf6ec1ff1254018016907aed947';

/**
 * `apps/sim-cli/scenarios/bench-lamp.console`, comments stripped, split at its `world.hash` lines:
 * `lit` builds the bench, closes the switch and steps to the lit hash; `out` opens it and steps on.
 */
export function benchLampScenario(): { lit: string[]; out: string[] } {
  const lines = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const lit = lines.indexOf('world.hash');
  expect(lit).toBe(8);
  return { lit: lines.slice(0, lit), out: lines.slice(lit + 1, lines.lastIndexOf('world.hash')) };
}

/** New sandbox from the main menu with `seed`, keyboard only once the dialog is open. */
export async function newSandbox(window: Page, seed: number): Promise<void> {
  await window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'New sandbox' }).click();
  await expect(window.getByRole('textbox', { name: 'Seed' })).toBeFocused();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(String(seed));
  await window.keyboard.press('Enter');
  await expect(window.locator('ctl-viewport canvas')).toBeFocused();
}

/**
 * Runs console lines and returns `world.hash` after them. The console is the way into the world here:
 * the desktop app has no test hook. Leaves focus in the console.
 */
export async function hashAfter(window: Page, ...lines: string[]): Promise<string> {
  await expect(window.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  const input = window.getByRole('textbox', { name: 'Console input' });
  if (!(await input.evaluate((el) => el.contains(el.ownerDocument.activeElement)))) {
    await window.keyboard.press('Backquote');
  }
  await expect(input).toBeFocused();
  const entries = window.getByTestId('console-output').locator('.entry');
  for (const line of lines) {
    await window.keyboard.insertText(line);
    await window.keyboard.press('Enter');
  }
  const before = await entries.count();
  await window.keyboard.insertText('world.hash');
  await window.keyboard.press('Enter');
  await expect.poll(() => entries.count()).toBeGreaterThan(before);
  await expect(entries.last()).toHaveText(/^[0-9a-f]{64}$/);
  return (await entries.last().textContent()) ?? '';
}
