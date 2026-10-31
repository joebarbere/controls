import { expect, test, type Page } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * F1.2: `world.hash` is identical in Node and Chromium. The golden values below are the SAME
 * literals that `libs/domain/world-model/src/lib/hash.spec.ts` asserts under Node; here the bundled
 * game computes them in Chromium through the `?e2e=1` session hook. Change both or neither.
 */
const GOLDEN = {
  emptySeed0: '2c6dc51770228d8fc23d1c82c0eaafef8caff86c0f7672e32ab0b624a1db022c',
  propsAndExtensionsFixture: 'd66ea791bbf59a366bf4ff6f6aef2511fed79e17f91dc8fb8aea9f0e170241df',
  scenario: 'fc9fa3bd3bc63bc279ba43ce8f5af035f81535191c8e205fd40af23d460e22f9',
  /** `content/levels/workshop.json` (seed 0): the world the game boots with, and New sandbox with seed 0 (F1.9). */
  workshopSeed0: 'e79e76822ed39bdf3e033330dffbacd9115b9506ed40663e80c9fac8a0d3c174',
};

/** `libs/domain/save-format/fixtures/v1/world/empty.json`: `createWorld({ seed: 0 })`. */
const EMPTY_SEED_0 = {
  schemaVersion: 1,
  seed: 0,
  tick: 0,
  nextEntityId: 1,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [],
  entities: [],
  extensions: {},
};

/** `libs/domain/save-format/fixtures/v1/world/props-and-extensions.json` (unicode, floats, extensions). */
const PROPS_AND_EXTENSIONS = {
  schemaVersion: 1,
  seed: 4294967295,
  tick: 0,
  nextEntityId: 6,
  regionId: 'nec',
  difficulty: 'realistic',
  assisted: true,
  fixtures: [
    {
      id: 'bench',
      ref: { id: 'prop.bench', version: 1 },
      transform: { positionMm: { x: 700, y: -1200, z: 80 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      extensions: {},
    },
    {
      id: 'stud-wall-2',
      ref: { id: 'prop.stud-wall', version: 1 },
      transform: { positionMm: { x: -2500, y: -1200, z: 3000 }, orientationMdeg: { yaw: 90000, pitch: 0, roll: 0 } },
      extensions: { 'mod.example.paint': 'primer' },
    },
  ],
  entities: [
    {
      id: 1,
      ref: { id: 'prop.bench', version: 1 },
      transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      extensions: {},
    },
    {
      id: 2,
      ref: { id: 'prop.crate', version: 1 },
      transform: { positionMm: { x: -1250, y: 0, z: 610 }, orientationMdeg: { yaw: 90000, pitch: 0, roll: 0 } },
      extensions: {},
    },
    {
      id: 4,
      ref: { id: 'prop.spool', version: 1 },
      transform: {
        positionMm: { x: 300, y: 915, z: -10000000 },
        orientationMdeg: { yaw: 359999, pitch: 270000, roll: 12345 },
      },
      extensions: { 'mod.example.tint': '#c0ffee', 'mod.example.wear': [0.25, -1e-7, 6.02e23] },
    },
  ],
  extensions: {
    'mod.example.notes': 'Entities 3 and 5 were deleted, so ids skip and are never reused; unicode: é 中 🔌',
    'mod.example.nested': { a: [true, false, null, { b: { c: [] } }] },
  },
};

/** The scenario `hash.spec.ts` runs from the workshop level at seed 0 (the world the game boots with). */
const SCENARIO: ReadonlyArray<readonly [string, object]> = [
  ['entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 100, y: 0, z: -200 } }],
  [
    'entity.place',
    {
      ref: { id: 'prop.spool', version: 1 },
      positionMm: { x: -450, y: 915, z: 30 },
      orientationMdeg: { yaw: 90000, pitch: 0, roll: 0 },
    },
  ],
  ['entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } }],
  ['entity.rotate', { id: 2, deltaMdeg: { yaw: -135000, pitch: 0, roll: 12345 } }],
  ['view.resetLayout', {}],
  ['entity.delete', { id: 1 }],
  ['edit.undo', {}],
  ['entity.place', { ref: { id: 'prop.box', version: 1 }, positionMm: { x: 0, y: 0, z: 0 } }],
];

/** The slice of `Session` the hook exposes (e2e projects may not import workspace libs). */
interface SessionHook {
  exec(id: string, args?: unknown): { ok: boolean };
  hash(): Promise<string>;
  entries(): ReadonlyArray<{ seq: number; id: string }>;
  hashWorld(json: unknown): string | null;
}

declare global {
  interface Window {
    __controlsSession?: SessionHook;
  }
}

async function session<T>(page: Page, fn: (hook: SessionHook, arg: unknown) => T, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ src, arg }) => {
      const hook = window.__controlsSession;
      if (!hook) throw new Error('session hook missing');
      return new Function('hook', 'arg', `return (${src})(hook, arg)`)(hook, arg) as T;
    },
    { src: fn.toString(), arg },
  );
}

test('world.hash in Chromium matches the Node golden values', async ({ page }) => {
  await page.goto('/?e2e=1');
  await expect.poll(() => page.evaluate(() => typeof window.__controlsSession)).toBe('object');

  // Behind the main menu the game shows the workshop level as it is (seed 0).
  expect(await session(page, (h) => h.hash())).toBe(GOLDEN.workshopSeed0);
  expect(await session(page, (h, world) => h.hashWorld(world), EMPTY_SEED_0)).toBe(GOLDEN.emptySeed0);
  expect(await session(page, (h, world) => h.hashWorld(world), PROPS_AND_EXTENSIONS)).toBe(
    GOLDEN.propsAndExtensionsFixture,
  );

  const results = await session(
    page,
    (h, steps) => (steps as [string, object][]).map(([id, args]) => h.exec(id, args).ok),
    SCENARIO,
  );
  expect(results).toEqual(SCENARIO.map(() => true));
  expect(await session(page, (h) => h.hash())).toBe(GOLDEN.scenario);
});

test('New sandbox with seed 0 is the workshop level unchanged; another seed changes only the seed', async ({
  page,
}) => {
  await page.goto('/?e2e=1');
  await startSandbox(page, 0);
  await expect.poll(() => session(page, (h) => h.hash())).toBe(GOLDEN.workshopSeed0);
  await page.keyboard.press('Escape'); // back to the menu
  await startSandbox(page, 7);
  const seven = await session(page, (h) => h.hash());
  expect(seven).not.toBe(GOLDEN.workshopSeed0);
  await page.keyboard.press('Escape');
  await startSandbox(page, 7);
  expect(await session(page, (h) => h.hash())).toBe(seven); // the same seed, the same world
  expect(await session(page, (h) => h.entries())).toEqual([]); // a fresh log every time
});

test('Reset layout runs view.resetLayout: logged, world hash unchanged', async ({ page }) => {
  await page.goto('/?e2e=1');
  await startSandbox(page);
  await expect.poll(() => page.evaluate(() => typeof window.__controlsSession)).toBe('object');
  const before = await session(page, (h) => h.hash());

  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Layout reset.' })).toBeVisible();
  expect(await session(page, (h) => h.entries().map((e) => `${e.seq}:${e.id}`))).toEqual(['0:view.resetLayout']);
  expect(await session(page, (h) => h.hash())).toBe(before);

  // The same command from another surface (here the hook, standing in for the palette) has the same effect.
  const splitter = page.getByRole('separator', { name: 'Resize inspector' });
  await splitter.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '384');
  expect(await session(page, (h) => h.exec('view.resetLayout').ok)).toBe(true);
  await expect(splitter).toHaveAttribute('aria-valuenow', '320');
});
