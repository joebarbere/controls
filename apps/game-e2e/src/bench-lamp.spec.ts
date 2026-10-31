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
 * golden since F2.5 (the lamp's filament model in Chromium's V8, in the sim worker). Change them
 * together, never one alone: a difference here is float drift between V8 builds, not a golden to
 * re-pin. Both transports run it: the shared buffer and the `?sab=0` fallback give the same bytes.
 *
 * The lamp's drawn glow follows the solved light output, read from each snapshot the worker publishes
 * (the renderer's scene-graph snapshot), so a warming filament is drawn while time runs, with no
 * command in between.
 */
// Pixel aim is part of the contract (a real double-click on the switch), so 1280 × 720 like the other
// aimed specs (docs/caveats/ui.md): at the suite's 960 × 540 the framed switch sits under the sim-time
// HUD, which takes the click (`pointOver` only returns points where the canvas does).
test.use({ viewport: { width: 1280, height: 720 } });

const BENCH_LAMP_LIT_HASH = 'ed42d957348f2c2f79aad6ed892228a20e59bb543ba3e348399595c37d7b3fbc';
const BENCH_LAMP_LIT_SNAPSHOT_HASH = '52010da7436ce267029b58a73aadc43c6e3ddb4ca0db17f1c3a3bf695b9fd517';
const BENCH_LAMP_HASH = '0b533c942486866c3d8757b94dfdb6c2d891f66ae0401f97a96aac4d1ea6cb28';
const BENCH_LAMP_SNAPSHOT_HASH = 'd5bbbaaf731e59d67fd7a1e459504f9198a7d5d563d0ef0f1a52cb7e010ac11f';

type Hooks = {
  __controlsSession?: {
    hash(): Promise<string>;
    snapshotHash(): Promise<string>;
    waitForTick(tick: number): Promise<void>;
    simStats(): { misses: number; transport: string | null };
    entries(): ReadonlyArray<{ id: string; tick: number; args: unknown }>;
  };
  __controlsViewport?: {
    select(id: string | null): boolean;
    focus(id: string): boolean;
    sceneGraph(): SceneNode | undefined;
    projectMm(p: { x: number; y: number; z: number }): { x: number; y: number } | undefined;
    pickAt(ndcX: number, ndcY: number): { id: string } | null;
    whenIdle(): Promise<void>;
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
/**
 * Page coordinates over `entity` (`entity-2`), or over the bench beside it when `entity` is null: the
 * first of a few world points on and around the device whose pick is what we want.
 */
async function pointOver(page: Page, canvas: Locator, entity: string | null): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const found = await page.evaluate(
    ({ entity, width, height }) => {
      const h = (window as unknown as Hooks).__controlsViewport;
      if (!h) throw new Error('viewport hook missing');
      // The switch is placed at (1100, -300, 200) mm; its body is 60 × 40 × 45 mm.
      const points = [];
      for (const dx of [30, 15, 45, -150, -250, 250])
        for (const dz of [22, 10, 35, 0]) points.push({ x: 1100 + dx, y: -280, z: 200 + dz });
      const canvas = document.querySelector('ctl-viewport canvas') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      for (const p of points) {
        const s = h.projectMm(p);
        if (!s || s.x < 1 || s.y < 1 || s.x > width - 1 || s.y > height - 1) continue;
        // Only where the canvas itself takes the click: the HUD overlays (sim time, status) don't count.
        if (document.elementFromPoint(rect.left + s.x, rect.top + s.y) !== canvas) continue;
        const picked = h.pickAt((2 * s.x) / width - 1, 1 - (2 * s.y) / height)?.id ?? null;
        if (entity === null ? picked === null || !picked.startsWith('entity-') : picked === entity) return s;
      }
      return null;
    },
    { entity, width: box.width, height: box.height },
  );
  if (!found) throw new Error(`no point over ${entity ?? 'empty space'}`);
  return { x: box.x + found.x, y: box.y + found.y };
}

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

/** The scenario's lines, comments stripped, and the setup before its first `device.operate`. */
function scenario(): { lines: string[]; setup: string[] } {
  const file = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8');
  const lines = file
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return {
    lines,
    setup: lines.slice(
      0,
      lines.findIndex((line) => line.startsWith('device.operate')),
    ),
  };
}

/** Starts a sandbox and types the scenario's setup (three devices, three leads) into the console. */
async function benchSetup(page: Page, query: string): Promise<{ viewport: Locator; canvas: Locator }> {
  await page.goto(`/?e2e=1&renderer=webgl2${query}`);
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  const { setup } = scenario();
  expect(setup).toHaveLength(6);
  await openConsole(page);
  for (const line of setup) {
    await typeLine(page, line);
    await expect(lastOutput(page)).toHaveText(/: ok/);
  }
  return { viewport, canvas };
}

for (const { transport, query } of [
  { transport: 'sab', query: '' },
  // The postMessage fallback (ADR 0011 §8): the same bytes, so the same hashes.
  { transport: 'message', query: '&sab=0' },
] as const) {
  test(`the bench demo (${transport}): console, keyboard and mouse light the lamp and put it out, at the sim-cli hashes (D6)`, async ({
    page,
  }) => {
    test.slow(); // the WebGL2 software renderer makes each key round-trip slow on CI runners
    const { viewport, canvas } = await benchSetup(page, query);
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
    await session(page, (h) => h.waitForTick(1500)); // the worker has published the lit tick
    // Lit: light ≈ 1.25 of rated draws above the rated level (204 of 255); the lever drawn closed.
    await expect.poll(async () => (await drawn(page)).lamp?.level ?? 0).toBeGreaterThan(204);
    expect(await drawn(page)).toMatchObject({ lamp: { status: 'solved' }, switch: { closed: true } });
    await page.keyboard.press('Backquote');
    await expect(canvas).toBeFocused();

    // A real mouse double-click on the switch opens it: the same command with the other value. First
    // deselect it and frame the bench (view state only, nothing logged), so the first click of the pair
    // is what selects it again; a double-click on the bench beside it logs nothing.
    await page.keyboard.press('Escape');
    await expect(viewport).not.toHaveAttribute('data-selected', 'entity-2');
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.focus('bench'))).toBe(true);
    await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.whenIdle());
    const before = await session(page, (h) => h.entries().length);
    const beside = await pointOver(page, canvas, null);
    await page.mouse.dblclick(beside.x, beside.y);
    await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.whenIdle());
    expect(await session(page, (h) => h.entries().length)).toBe(before);
    const over = await pointOver(page, canvas, 'entity-2');
    await page.mouse.dblclick(over.x, over.y);
    await expect(viewport).toHaveAttribute('data-selected', 'entity-2');
    await expect.poll(() => session(page, (h) => h.entries().length)).toBe(before + 1);
    expect(await lastEntry(page)).toMatchObject({
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
    await session(page, (h) => h.waitForTick(2000));
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
    expect(await session(page, (h) => h.simStats())).toMatchObject({ misses: 0, transport });
  });
}

test('the lamp warms up on screen while time runs, with no command after the resume (F2.5 on F2.3b)', async ({
  page,
}) => {
  test.slow();
  const { canvas } = await benchSetup(page, '');
  // Closed while paused (a new game starts paused): solved, the filament still cold, drawn dark.
  await typeLine(page, 'device.operate 2 closed true');
  await expect(lastOutput(page)).toHaveText(/: ok/);
  await expect
    .poll(() => drawn(page))
    .toMatchObject({ lamp: { status: 'solved', level: 0 }, switch: { closed: true } });
  await page.keyboard.press('Backquote');
  await expect(canvas).toBeFocused();
  // Sample the drawn level every animation frame from here on (view state only).
  await page.evaluate(() => {
    const w = window as unknown as Hooks & { __lampLevels: number[] };
    w.__lampLevels = [];
    const find = (node: SceneNode | undefined): SceneNode | undefined =>
      node === undefined
        ? undefined
        : node.name === 'entity-3'
          ? node
          : (node.children ?? []).map(find).find((n) => n !== undefined);
    const sample = () => {
      w.__lampLevels.push(find(w.__controlsViewport?.sceneGraph())?.lamp?.level ?? -1);
      if (w.__lampLevels.length < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // 1× real time: the one command after the operate. Nothing else is logged while the lamp lights.
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => lastEntry(page)).toMatchObject({ id: 'sim.setSpeed', args: { speed: 1 } });
  const logged = await session(page, (h) => h.entries().length);
  await expect.poll(async () => (await drawn(page)).lamp?.level ?? 0, { timeout: 10_000 }).toBeGreaterThan(204);
  expect(await session(page, (h) => h.entries().length)).toBe(logged);
  const levels = await page.evaluate(() => (window as unknown as { __lampLevels: number[] }).__lampLevels);
  // Drawn from snapshots as time ran: dark at the resume, lit later.
  expect(levels[0]).toBe(0);
  expect(Math.max(...levels)).toBeGreaterThan(204);
  expect(await drawn(page)).toMatchObject({ lamp: { status: 'solved' } });
});
