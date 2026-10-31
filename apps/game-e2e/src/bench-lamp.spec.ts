import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.5, the phase acceptance's in-game demo: a battery, an SPST switch and an incandescent lamp on the
 * workshop bench, joined by test leads. The devices and leads are typed into the in-game console;
 * the switch is closed with the keyboard (E on the selected switch) and opened with the mouse (a
 * double-click on it), and time is stepped from the console. Every action is one logged command, the
 * same ones `apps/sim-cli/scenarios/bench-lamp.console` runs, so the world and snapshot hashes must
 * equal the literals `apps/sim-cli/src/bench-lamp.spec.ts` pins under Node: the D6 cross-runtime
 * golden since F2.5 (the lamp's filament model in Chromium's V8). Change them together, never one
 * alone: a difference here is float drift between V8 builds, not a golden to re-pin.
 *
 * The lamp's drawn glow follows the solved light output (the renderer's scene-graph snapshot).
 */
const BENCH_LAMP_LIT_HASH = 'ed42d957348f2c2f79aad6ed892228a20e59bb543ba3e348399595c37d7b3fbc';
const BENCH_LAMP_LIT_SNAPSHOT_HASH = '475fa520421f1fce6af75b16062692fa94bd8fd1d94686908756314df31b0bb4';
const BENCH_LAMP_HASH = '0b533c942486866c3d8757b94dfdb6c2d891f66ae0401f97a96aac4d1ea6cb28';
const BENCH_LAMP_SNAPSHOT_HASH = '0e4bd06d4b3435e6664c5b26c7080e801381f91d8e563eccdae6d6c707ae103b';

type Hooks = {
  __controlsSession?: {
    hash(): string;
    snapshotHash(): string;
    entries(): ReadonlyArray<{ id: string; tick: number; args: unknown }>;
  };
  __controlsViewport?: {
    select(id: string | null): boolean;
    sceneGraph(): SceneNode | undefined;
  };
};
const session = <T>(page: Page, read: (h: NonNullable<Hooks['__controlsSession']>) => T) =>
  page.evaluate(
    ({ src }) => {
      const h = (window as unknown as Hooks).__controlsSession;
      if (!h) throw new Error('session hook missing');
      return new Function('h', `return (${src})(h)`)(h) as T;
    },
    { src: read.toString() },
  );
type SceneNode = {
  name: string;
  lamp?: { level: number; status: string };
  switch?: { closed: boolean };
  children?: SceneNode[];
};
/** The drawn lamp and switch (the renderer's scene-graph snapshot), by entity id. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const find = (node: SceneNode | undefined, name: string): SceneNode | undefined =>
      node === undefined
        ? undefined
        : node.name === name
          ? node
          : (node.children ?? []).map((c) => find(c, name)).find((n) => n !== undefined);
    const root = (window as unknown as Hooks).__controlsViewport?.sceneGraph();
    return { lamp: find(root, 'entity-3')?.lamp, switch: find(root, 'entity-2')?.switch };
  });
const lastEntry = (page: Page) => session(page, (h) => h.entries().at(-1));
const lastOutput = (page: Page) => page.getByTestId('console-output').locator('.entry').last();

async function openConsole(page: Page): Promise<Locator> {
  await page.keyboard.press('Backquote');
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();
  return input;
}

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.insertText(line);
  await page.keyboard.press('Enter');
}

test('the bench demo: console, keyboard and mouse light the lamp and put it out, at the sim-cli hashes (D6)', async ({
  page,
}) => {
  test.slow(); // the WebGL2 software renderer makes each key round-trip slow on CI runners
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();

  // Place the three devices and connect the three leads from the console.
  const file = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8');
  const lines = file
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const setup = lines.slice(
    0,
    lines.findIndex((line) => line.startsWith('device.operate')),
  );
  expect(setup).toHaveLength(6);
  await openConsole(page);
  for (const line of setup) {
    await typeLine(page, line);
    await expect(lastOutput(page)).toHaveText(/: ok/);
  }
  await page.keyboard.press('Backquote');
  await expect(canvas).toBeFocused();

  // E on the selected switch closes it: one logged device.operate.
  expect(await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.select('entity-2'))).toBe(true);
  await expect(viewport).toHaveAttribute('data-selected', 'entity-2');
  await page.keyboard.press('KeyE');
  await expect
    .poll(() => lastEntry(page))
    .toMatchObject({
      id: 'device.operate',
      tick: 0,
      args: { id: 2, control: 'closed', value: true },
    });

  await openConsole(page);
  await typeLine(page, 'sim.step 1500');
  await typeLine(page, 'world.hash');
  await expect(lastOutput(page)).toHaveText(BENCH_LAMP_LIT_HASH);
  expect(await session(page, (h) => h.snapshotHash())).toBe(BENCH_LAMP_LIT_SNAPSHOT_HASH);
  // Lit: light ≈ 1.25 of rated draws above the rated level (204 of 255); the lever drawn closed.
  await expect.poll(() => drawn(page)).toMatchObject({ lamp: { status: 'solved' }, switch: { closed: true } });
  expect((await drawn(page)).lamp?.level).toBeGreaterThan(204);
  await page.keyboard.press('Backquote');
  await expect(canvas).toBeFocused();

  // A double-click on the (still selected) switch opens it: the same command with the other value.
  await canvas.dispatchEvent('dblclick');
  await expect
    .poll(() => lastEntry(page))
    .toMatchObject({
      id: 'device.operate',
      tick: 1500,
      args: { id: 2, control: 'closed', value: false },
    });

  await openConsole(page);
  await typeLine(page, 'sim.step 500');
  await typeLine(page, 'world.hash');
  await expect(lastOutput(page)).toHaveText(BENCH_LAMP_HASH);
  expect(await session(page, (h) => h.hash())).toBe(BENCH_LAMP_HASH);
  expect(await session(page, (h) => h.snapshotHash())).toBe(BENCH_LAMP_SNAPSHOT_HASH);
  // Out: under one display step, drawn dark (a solved 0, not "unknown").
  await expect
    .poll(() => drawn(page))
    .toMatchObject({ lamp: { status: 'solved', level: 0 }, switch: { closed: false } });
  expect(await session(page, (h) => h.entries().map((e) => `${e.id}@${e.tick}`))).toEqual([
    'entity.place@0',
    'entity.place@0',
    'entity.place@0',
    'lead.connect@0',
    'lead.connect@0',
    'lead.connect@0',
    'device.operate@0',
    'sim.step@0',
    'device.operate@1500',
    'sim.step@1500',
  ]);
});
