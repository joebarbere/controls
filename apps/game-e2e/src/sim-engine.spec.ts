import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.3a, decision D6: the sim engine gives byte-identical snapshots in Chromium's V8 and in Node's.
 * The game runs `apps/sim-cli/scenarios/sim-step.console` through the in-game console's `run`, with the
 * engine in the page (in-process until F2.3b moves it to the sim worker), and its world and snapshot
 * hashes must equal the literals `apps/sim-cli/src/sim-step.spec.ts` pins under Node. Change them
 * together, never one alone: a difference here is cross-runtime float drift (ADR 0014), not a golden
 * to re-pin.
 */
const SIM_STEP_HASH = 'df471c07cfccd0ab4807ceca52700d4176a4953a8b4d84b049a71d952157b48a';
const SIM_STEP_SNAPSHOT_HASH = 'eb20079b8a1efe00ac453b628550c8e650fe03a1cb85aef66651ae6e847c16ff';

type Hooks = {
  __controlsSession?: {
    hash(): string;
    snapshotHash(): string;
    world(): { tick: number };
    entries(): ReadonlyArray<{ id: string; tick: number }>;
  };
};
const hook = <T>(page: Page, read: (h: NonNullable<Hooks['__controlsSession']>) => T) =>
  page.evaluate(
    ({ src }) => {
      const session = (window as unknown as Hooks).__controlsSession;
      if (!session) throw new Error('session hook missing');
      return new Function('h', `return (${src})(h)`)(session) as T;
    },
    { src: read.toString() },
  );

test('a console file steps sim time in the game, and the hashes match sim-cli in Node (D6)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/sim-step.console'));
  await (await chooser).setFiles({ name: 'sim-step.console', mimeType: 'text/plain', buffer: text });
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
    'Ran 7 commands from sim-step.console.',
  );

  expect(await hook(page, (h) => h.world().tick)).toBe(1234);
  expect(await hook(page, (h) => h.entries().map((e) => `${e.id}@${e.tick}`))).toEqual([
    'entity.place@0',
    'entity.place@0',
    'entity.place@0',
    'lead.connect@0',
    'lead.connect@0',
    'device.operate@0',
    'sim.step@0',
  ]);
  expect(await hook(page, (h) => h.hash())).toBe(SIM_STEP_HASH);
  expect(await hook(page, (h) => h.snapshotHash())).toBe(SIM_STEP_SNAPSHOT_HASH);
});

/**
 * F2.4: the power sources' state across runtimes. `apps/sim-cli/scenarios/sources.console` (a DIN PSU
 * hiccuping into a short for two cycles, a bench supply in its current limit, a battery discharging)
 * must reach the hashes `apps/sim-cli/src/sources.spec.ts` pins under Node: the CV/CC mode, the hiccup
 * ticks and the coulomb counting, byte for byte.
 */
const SOURCES_HASH = 'df6f7c64ec79a1d3109dcb6e66373db929cae4da711af4810d2e6079261c29b1';
const SOURCES_SNAPSHOT_HASH = '153b26d1a977fda513661e938672c4d53502ffc583078c4bb28d7f8f856b7a24';

test('the sources scenario reaches the same hashes in the game as sim-cli in Node (D6, F2.4)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/sources.console'));
  await (await chooser).setFiles({ name: 'sources.console', mimeType: 'text/plain', buffer: text });
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
    'Ran 10 commands from sources.console.',
  );

  expect(await hook(page, (h) => h.world().tick)).toBe(2345);
  expect(await hook(page, (h) => h.hash())).toBe(SOURCES_HASH);
  expect(await hook(page, (h) => h.snapshotHash())).toBe(SOURCES_SNAPSHOT_HASH);
});

/**
 * F2.4 part 2: the split-phase service's series-inductance phasors across runtimes.
 * `apps/sim-cli/scenarios/mains.console` must reach the hashes `apps/sim-cli/src/mains.spec.ts` pins.
 */
const MAINS_HASH = '9d4d91f1172c61bfadb578c2bebfd63938261a07326820dbf43f8fb931c2cc8b';
const MAINS_SNAPSHOT_HASH = '3283a86c3478dff172fb2ea286970803496055710dc9d3e66824c08f43205a62';

test('the mains scenario reaches the same hashes in the game as sim-cli in Node (D6, F2.4)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/mains.console'));
  await (await chooser).setFiles({ name: 'mains.console', mimeType: 'text/plain', buffer: text });
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
    'Ran 4 commands from mains.console.',
  );

  expect(await hook(page, (h) => h.world().tick)).toBe(100);
  expect(await hook(page, (h) => h.hash())).toBe(MAINS_HASH);
  expect(await hook(page, (h) => h.snapshotHash())).toBe(MAINS_SNAPSHOT_HASH);
});
